import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Node не знает встроенный модуль Cloudflare, поэтому для unit-тестов заменяем
// только этот import заглушкой. Остальной код Worker загружается без изменений.
const source = await readFile(new URL("./worker.js", import.meta.url), "utf8");
const testableSource = source.replace(
  'import { connect } from "cloudflare:sockets";',
  'const connect = () => { throw new Error("Unexpected TCP connection in test"); };',
);
assert.notEqual(testableSource, source, "Cloudflare import must be replaced");

const moduleUrl = `data:text/javascript;base64,${Buffer.from(testableSource).toString("base64")}`;
const { probeOriginOnce, runWatchdogCheck } = await import(moduleUrl);

function httpConfig(status) {
  return {
    probeUrl: "https://health.example.com/healthz",
    probeTimeoutMs: 1000,
    fetchFn: async () => new Response(null, { status }),
  };
}

test("HTTP health-check accepts only 2xx", async (t) => {
  const cases = [
    [200, true],
    [204, true],
    [301, false],
    [404, false],
    [502, false],
    [503, false],
    [504, false],
  ];

  for (const [status, expected] of cases) {
    await t.test(`HTTP ${status}`, async () => {
      const result = await probeOriginOnce(httpConfig(status));
      assert.equal(result.ok, expected);
      assert.equal(result.probeType, "http");
      assert.equal(result.detail, `HTTP ${status}`);
    });
  }
});

test("three failed HTTP health-checks switch normal DNS to failover", async () => {
  const env = {
    CF_API_TOKEN: "test-token",
    CF_ZONE_ID: "zone-id",
    DOMAIN: "example.com",
    ORIGIN_IP: "192.0.2.10",
    FALLBACK_TARGET: "fallback.github.io",
    PROBE_URL: "https://health.example.com/healthz",
    DNS_TTL: "60",
  };
  const calls = [];

  const fetchFn = async (input, options = {}) => {
    const url = String(input);
    calls.push({ url, options });

    if (url === env.PROBE_URL) {
      return new Response(null, { status: 503 });
    }

    const parsed = new URL(url);
    const recordsPath = "/client/v4/zones/zone-id/dns_records";
    const recordPath = `${recordsPath}/record-id`;

    if (parsed.pathname === recordsPath && !options.method) {
      return Response.json({
        success: true,
        result: [
          {
            id: "record-id",
            type: "A",
            name: "example.com",
            content: "192.0.2.10",
            proxied: false,
            ttl: 1,
          },
        ],
      });
    }

    if (parsed.pathname === recordPath && options.method === "PUT") {
      return Response.json({
        success: true,
        result: { id: "record-id", ...JSON.parse(options.body) },
      });
    }

    throw new Error(`Unexpected request: ${options.method || "GET"} ${url}`);
  };

  const result = await runWatchdogCheck(env, {
    fetchFn,
    failRetryDelayMs: 0,
  });

  assert.equal(result.action, "switched_to_failover");
  assert.equal(result.mode, "failover");
  assert.equal(result.originReachable, false);
  assert.equal(result.probe.detail, "HTTP 503");
  assert.equal(
    calls.filter(({ url }) => url === env.PROBE_URL).length,
    3,
    "the initial probe and two confirmation probes must run",
  );

  const update = calls.find(({ options }) => options.method === "PUT");
  assert.ok(update, "the existing root DNS record must be updated");
  assert.deepEqual(JSON.parse(update.options.body), {
    type: "CNAME",
    name: "example.com",
    content: "fallback.github.io",
    proxied: false,
    ttl: 60,
  });
});
