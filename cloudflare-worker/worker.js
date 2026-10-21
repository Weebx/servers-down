/**
 * Auto-Failover DNS Watchdog (Cloudflare Cron Worker)
 *
 * Все чувствительные параметры (токен API, IP сервера, домен, пароль статуса)
 * хранятся ТОЛЬКО в приватных Secrets внутри панели Cloudflare Worker —
 * в коде репозитория нет ни IP-адресов, ни токенов, ни открытых эндпоинтов.
 *
 * Как работает:
 *   1. Запускается по Cron-расписанию (например, раз в 3 минуты: каждые 3 мин).
 *   2. Делает 1 лёгкую проверку TCP-порта основного сервера (без нагрузки на сайт/БД).
 *   3. Если 3 проверки подряд с паузой 5 сек не прошли — переключает корневую запись `@`
 *      на CNAME резервной страницы (DNS only / серое облачко, TTL 60 сек).
 *   4. Пока сервер выключен — ничего лишнего не трогает и не спамит уведомлениями.
 *   5. Когда сервер включился и прошёл 2 проверки подряд с паузой 8 сек —
 *      автоматически возвращает запись `A` на IP основного сервера.
 *   6. Без секрета `ADMIN_SECRET` любые HTTP-запросы к URL воркера получают пустой `404`,
 *      чтобы никто снаружи не мог узнать ни домен, ни статус сервера, ни вызвать проверку.
 */

import { connect } from "cloudflare:sockets";

const CF_API_BASE = "https://api.cloudflare.com/client/v4";
const STATUS_CACHE_TTL_MS = 15_000;

let cachedZoneId = null;
let lastStatusSnapshot = null;
let lastStatusCheckedAt = 0;

function getConfig(env, overrides = {}) {
  return {
    cfApiToken: (env.CF_API_TOKEN || "").trim(),
    cfZoneId: (env.CF_ZONE_ID || "").trim(),
    domain: (env.DOMAIN || "").trim().toLowerCase(),
    originIp: (env.ORIGIN_IP || "").trim(),
    originPort: Number.parseInt(env.ORIGIN_PORT || "443", 10) || 443,
    fallbackTarget: (env.FALLBACK_TARGET || "").trim().toLowerCase(),
    probeUrl: (env.PROBE_URL || "").trim(),
    dnsTtl: Number.parseInt(env.DNS_TTL || "60", 10) || 60,
    probeTimeoutMs: Number.parseInt(env.PROBE_TIMEOUT_MS || "4500", 10) || 4500,
    failConfirmAttempts: Math.max(
      1,
      Number.parseInt(env.FAIL_CONFIRM_RETRIES || "3", 10) || 3
    ),
    failRetryDelayMs:
      overrides.failRetryDelayMs ??
      (Number.parseInt(env.FAIL_RETRY_DELAY_MS || "5000", 10) || 5000),
    recoverConfirmChecks: Math.max(
      1,
      Number.parseInt(env.RECOVER_CONFIRM_CHECKS || "2", 10) || 2
    ),
    recoverDelayMs:
      overrides.recoverDelayMs ??
      (Number.parseInt(env.RECOVER_DELAY_MS || "8000", 10) || 8000),
    forceMaintenance:
      String(env.FORCE_MAINTENANCE || "false").trim().toLowerCase() === "true",
    tgBotToken: (env.TG_BOT_TOKEN || "").trim(),
    tgChatId: (env.TG_CHAT_ID || "").trim(),
    adminSecret: (env.ADMIN_SECRET || "").trim(),
    connectFn: overrides.connectFn || connect,
    fetchFn: overrides.fetchFn || globalThis.fetch.bind(globalThis),
  };
}

function validateRequiredConfig(cfg) {
  const missing = [];
  if (!cfg.cfApiToken) missing.push("CF_API_TOKEN");
  if (!cfg.domain) missing.push("DOMAIN");
  if (!cfg.originIp) missing.push("ORIGIN_IP");
  if (!cfg.fallbackTarget) missing.push("FALLBACK_TARGET");
  if (missing.length > 0) {
    throw new Error(
      `Не заданы обязательные секреты/переменные в Settings -> Variables and Secrets: ${missing.join(", ")}`
    );
  }
}

/**
 * Постоянное по времени сравнение секрета (защита от перебора по таймингу).
 */
function timingSafeMatch(expected, actual) {
  if (!expected || !actual || expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Разовая лёгкая проверка доступности основного сервера.
 * По умолчанию открывает TCP-соединение к ORIGIN_IP:ORIGIN_PORT и сразу закрывает сокет.
 */
export async function probeOriginOnce(cfg) {
  const startedAt = Date.now();

  if (cfg.probeUrl) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.probeTimeoutMs);
    try {
      const res = await cfg.fetchFn(cfg.probeUrl, {
        method: "HEAD",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": "Failover-Watchdog/1.0" },
      });
      const ok = res.status > 0 && res.status < 520;
      return {
        ok,
        latencyMs: Date.now() - startedAt,
        detail: `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        ok: false,
        latencyMs: Date.now() - startedAt,
        error: err?.message || String(err),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  let socket;
  let timer;
  try {
    socket = cfg.connectFn({
      hostname: cfg.originIp,
      port: cfg.originPort,
    });

    const opened = socket.opened;
    opened.catch(() => {});
    if (socket.closed) {
      socket.closed.catch(() => {});
    }

    await Promise.race([
      opened,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timeout after ${cfg.probeTimeoutMs}ms`)),
          cfg.probeTimeoutMs
        );
      }),
    ]);

    return {
      ok: true,
      latencyMs: Date.now() - startedAt,
      detail: "TCP port open",
    };
  } catch (err) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: err?.message || String(err),
    };
  } finally {
    clearTimeout(timer);
    if (socket) {
      try {
        await socket.close();
      } catch {
        // Сокет уже закрыт — игнорируем
      }
    }
  }
}

async function cfRequest(cfg, path, options = {}) {
  const res = await cfg.fetchFn(`${CF_API_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${cfg.cfApiToken}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });

  const data = await res.json().catch(() => null);
  if (!res.ok || !data?.success) {
    const reason =
      data?.errors?.map((e) => `${e.code}: ${e.message}`).join("; ") ||
      `HTTP ${res.status}`;
    const err = new Error(`Cloudflare API error: ${reason}`);
    err.status = res.status;
    throw err;
  }

  return data.result;
}

async function resolveZoneId(cfg) {
  if (cfg.cfZoneId) return cfg.cfZoneId;
  if (cachedZoneId) return cachedZoneId;

  const zones = await cfRequest(
    cfg,
    `/zones?name=${encodeURIComponent(cfg.domain)}&status=active`
  );
  if (!Array.isArray(zones) || zones.length === 0 || !zones[0].id) {
    throw new Error(
      "Зона не найдена через API. Проверь права токена (Zone -> DNS -> Edit) или задай секрет CF_ZONE_ID."
    );
  }

  cachedZoneId = zones[0].id;
  return cachedZoneId;
}

/**
 * Читает A / CNAME записи строго только для корневого домена `cfg.domain`.
 * Все поддомены, а также MX / TXT / CAA / NS никогда не затрагиваются.
 */
async function getRootDnsState(cfg, zoneId) {
  const records = await cfRequest(
    cfg,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(cfg.domain)}&per_page=100`
  );

  const managed = (records || []).filter(
    (r) =>
      r.name?.toLowerCase() === cfg.domain &&
      (r.type === "A" || r.type === "CNAME")
  );

  const isNormal =
    managed.length === 1 &&
    managed[0].type === "A" &&
    managed[0].content.trim() === cfg.originIp &&
    managed[0].proxied === false;

  const isFailover =
    managed.length === 1 &&
    managed[0].type === "CNAME" &&
    managed[0].content.trim().toLowerCase() === cfg.fallbackTarget &&
    managed[0].proxied === false;

  let mode = "custom";
  if (isNormal) mode = "normal";
  else if (isFailover) mode = "failover";

  return { mode, records: managed };
}

async function putOrCreateWithTtlFallback(cfg, method, path, payload) {
  try {
    return await cfRequest(cfg, path, {
      method,
      body: JSON.stringify({ ...payload, ttl: cfg.dnsTtl }),
    });
  } catch (err) {
    if (cfg.dnsTtl !== 1) {
      return await cfRequest(cfg, path, {
        method,
        body: JSON.stringify({ ...payload, ttl: 1 }),
      });
    }
    throw err;
  }
}

async function setRootDnsTarget(cfg, zoneId, existingRecords, targetMode) {
  const desired =
    targetMode === "normal"
      ? {
          type: "A",
          name: cfg.domain,
          content: cfg.originIp,
          proxied: false,
        }
      : {
          type: "CNAME",
          name: cfg.domain,
          content: cfg.fallbackTarget,
          proxied: false,
        };

  if (existingRecords.length === 1) {
    try {
      return await putOrCreateWithTtlFallback(
        cfg,
        "PUT",
        `/zones/${zoneId}/dns_records/${existingRecords[0].id}`,
        desired
      );
    } catch {
      // Если Cloudflare не разрешил сменить тип записи через PUT — делаем DELETE + POST
    }
  }

  for (const rec of existingRecords) {
    await cfRequest(cfg, `/zones/${zoneId}/dns_records/${rec.id}`, {
      method: "DELETE",
    });
  }

  return await putOrCreateWithTtlFallback(
    cfg,
    "POST",
    `/zones/${zoneId}/dns_records`,
    desired
  );
}

async function sendTelegramAlert(cfg, text) {
  if (!cfg.tgBotToken || !cfg.tgChatId) return;
  try {
    await cfg.fetchFn(
      `https://api.telegram.org/bot${cfg.tgBotToken}/sendMessage`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: cfg.tgChatId,
          text,
          disable_web_page_preview: true,
        }),
      }
    );
  } catch {
    // Ошибка уведомления не должна влиять на переключение DNS
  }
}

export async function runWatchdogCheck(env, overrides = {}) {
  const cfg = getConfig(env, overrides);
  validateRequiredConfig(cfg);

  const zoneId = await resolveZoneId(cfg);
  const dns = await getRootDnsState(cfg, zoneId);

  if (cfg.forceMaintenance) {
    if (dns.mode !== "failover") {
      await setRootDnsTarget(cfg, zoneId, dns.records, "failover");
      await sendTelegramAlert(
        cfg,
        `🟠 Включён ручной режим техработ (FORCE_MAINTENANCE=true).\nДомен ${cfg.domain} переведён на резервную заглушку.`
      );
      return { action: "switched_to_failover_forced", mode: "failover" };
    }
    return { action: "none_forced_maintenance", mode: "failover" };
  }

  const firstProbe = await probeOriginOnce(cfg);

  if (firstProbe.ok) {
    if (dns.mode === "normal") {
      return {
        action: "none",
        mode: "normal",
        originReachable: true,
        probe: firstProbe,
      };
    }

    for (let i = 1; i < cfg.recoverConfirmChecks; i++) {
      await sleep(cfg.recoverDelayMs);
      const confirmProbe = await probeOriginOnce(cfg);
      if (!confirmProbe.ok) {
        return {
          action: "recovery_pending_unstable",
          mode: dns.mode,
          originReachable: false,
          probe: confirmProbe,
        };
      }
    }

    await setRootDnsTarget(cfg, zoneId, dns.records, "normal");
    await sendTelegramAlert(
      cfg,
      `🟢 Основной сервер снова в сети!\nDNS для ${cfg.domain} автоматически возвращён в штатный режим.`
    );

    return {
      action: "switched_to_normal",
      mode: "normal",
      originReachable: true,
      probe: firstProbe,
    };
  }

  if (dns.mode === "failover") {
    return {
      action: "none",
      mode: "failover",
      originReachable: false,
      probe: firstProbe,
    };
  }

  let lastFailedProbe = firstProbe;
  for (let attempt = 2; attempt <= cfg.failConfirmAttempts; attempt++) {
    await sleep(cfg.failRetryDelayMs);
    const retryProbe = await probeOriginOnce(cfg);
    if (retryProbe.ok) {
      return {
        action: "none_recovered_on_retry",
        mode: dns.mode,
        originReachable: true,
        probe: retryProbe,
      };
    }
    lastFailedProbe = retryProbe;
  }

  await setRootDnsTarget(cfg, zoneId, dns.records, "failover");
  await sendTelegramAlert(
    cfg,
    `🔴 Основной сервер не отвечает (${lastFailedProbe.error || lastFailedProbe.detail}).\nЗаглушка для ${cfg.domain} включена автоматически.`
  );

  return {
    action: "switched_to_failover",
    mode: "failover",
    originReachable: false,
    probe: lastFailedProbe,
  };
}

export default {
  // Автоматический запуск по расписанию Cron (например, раз в 3 минуты)
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(
      runWatchdogCheck(env)
        .then((res) => {
          console.log("[Watchdog]", JSON.stringify({ action: res.action, mode: res.mode }));
        })
        .catch((err) => {
          console.error("[Watchdog Error]", err?.message || err);
        })
    );
  },

  // Закрытый HTTP-обработчик: без секрета ADMIN_SECRET отвечает пустым 404 (ничего не раскрывает снаружи)
  async fetch(request, env, _ctx) {
    const url = new URL(request.url);
    const cfg = getConfig(env);

    const authHeader = request.headers.get("Authorization") || "";
    const providedSecret =
      authHeader.replace(/^Bearer\s+/i, "").trim() ||
      (url.searchParams.get("secret") || "").trim();

    if (!cfg.adminSecret || !timingSafeMatch(cfg.adminSecret, providedSecret)) {
      return new Response("Not Found", { status: 404 });
    }

    if (url.pathname === "/trigger" && request.method === "POST") {
      try {
        const result = await runWatchdogCheck(env);
        return Response.json({ ok: true, action: result.action, mode: result.mode });
      } catch (err) {
        return Response.json(
          { ok: false, error: err?.message || String(err) },
          { status: 500 }
        );
      }
    }

    if (url.pathname !== "/" && url.pathname !== "/status") {
      return new Response("Not Found", { status: 404 });
    }

    const now = Date.now();
    if (lastStatusSnapshot && now - lastStatusCheckedAt < STATUS_CACHE_TTL_MS) {
      return Response.json({ ...lastStatusSnapshot, cached: true });
    }

    try {
      validateRequiredConfig(cfg);
      const zoneId = await resolveZoneId(cfg);
      const [dns, probe] = await Promise.all([
        getRootDnsState(cfg, zoneId),
        probeOriginOnce(cfg),
      ]);

      // В ответе статуса не возвращаем ни IP сервера, ни токены — только безопасную сводку
      lastStatusSnapshot = {
        ok: true,
        mode: dns.mode,
        forceMaintenance: cfg.forceMaintenance,
        originCheck: probe,
        telegramConfigured: Boolean(cfg.tgBotToken && cfg.tgChatId),
        checkedAt: new Date(now).toISOString(),
      };
      lastStatusCheckedAt = now;

      return Response.json(lastStatusSnapshot);
    } catch (err) {
      return Response.json(
        {
          ok: false,
          error: err?.message || String(err),
          checkedAt: new Date(now).toISOString(),
        },
        { status: 500 }
      );
    }
  },
};
