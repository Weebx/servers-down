/*
 * RALLY — псевдо-3D раллийный спецучасток на canvas.
 * Работает и в браузере, и внутри APK (WebView, assets/www).
 * Управление: экранные кнопки (◀ ▶ / ТОРМОЗ / ГАЗ), на клавиатуре — стрелки или WASD.
 */
(function () {
  'use strict';

  // ============================ утилиты ============================
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const lerp = (a, b, t) => a + (b - a) * t;
  const easeIn = (a, b, p) => a + (b - a) * p * p;
  const easeInOut = (a, b, p) => a + (b - a) * (-Math.cos(p * Math.PI) / 2 + 0.5);
  const fogAt = (d, density) => 1 / Math.pow(Math.E, d * d * density);
  const round = Math.round;

  // детерминированный ПСЧ (mulberry32) — трасса одинаковая при каждом запуске
  function makeRng(seed) {
    let s = seed >>> 0;
    return function () {
      s = (s + 0x6d2b79f5) | 0;
      let t = Math.imul(s ^ (s >>> 15), 1 | s);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // ============================ трассы ============================
  const STAGES = [
    {
      id: 'forest',
      code: 'СУ-1',
      title: 'ЛЕСНАЯ ГРЯДА',
      hint: 'быстрый гравий, плавные дуги',
      seed: 20260401,
      targetSegments: 2400,
      curveScale: 1.0,
      hillScale: 1.0,
      sky: ['#0a1626', '#20556b', '#f0b172'],
      sun: '#ffdca8',
      clouds: 'rgba(255, 214, 160, 0.20)',
      hills: ['#20505f', '#173d4a'],
      grass: ['#33532f', '#2b4828'],
      road: ['#7b7063', '#6f655a'],
      rumble: ['#d4572c', '#f0e9dd'],
      rut: 'rgba(60, 50, 42, 0.55)',
      tree: ['#17301f', '#102619'],
      treeTrunk: '#241c14',
      rock: '#4c5155',
      fog: '#2f6373',
      night: false
    },
    {
      id: 'ridge',
      code: 'СУ-2',
      title: 'КАМЕННЫЙ ХРЕБЕТ',
      hint: 'закат, узкие повороты, перепады',
      seed: 771209,
      targetSegments: 2650,
      curveScale: 1.35,
      hillScale: 1.6,
      sky: ['#1a1023', '#7c3450', '#ff9a52'],
      sun: '#ffb36b',
      clouds: 'rgba(255, 150, 110, 0.22)',
      hills: ['#6b3049', '#46202f'],
      grass: ['#5b3f34', '#4d362d'],
      road: ['#8a7767', '#7d6c5e'],
      rumble: ['#f2673a', '#ffe8d6'],
      rut: 'rgba(70, 45, 35, 0.5)',
      tree: ['#3a2a2c', '#2a1e20'],
      treeTrunk: '#1d1414',
      rock: '#6b5a52',
      fog: '#8a4055',
      night: false
    },
    {
      id: 'night',
      code: 'СУ-3',
      title: 'НОЧНАЯ ТРАССА',
      hint: 'фары, темнота, максимум адреналина',
      seed: 908007,
      targetSegments: 2250,
      curveScale: 1.15,
      hillScale: 0.8,
      sky: ['#03040a', '#0a1020', '#17253f'],
      sun: '#cfe0ff',
      clouds: 'rgba(120, 160, 220, 0.12)',
      hills: ['#101a2c', '#0a1220'],
      grass: ['#16201a', '#121a16'],
      road: ['#3a3a40', '#333338'],
      rumble: ['#c8471f', '#d8dce6'],
      rut: 'rgba(15, 15, 20, 0.6)',
      tree: ['#0d1a13', '#091209'],
      treeTrunk: '#0c0a08',
      rock: '#2b2f36',
      fog: '#0a1120',
      night: true
    }
  ];

  // ============================ геометрия мира ============================
  const SEG_LEN = 200;          // длина сегмента дороги
  const RUMBLE_LEN = 3;         // сегментов на одну полосу обочины
  const ROAD_W = 2000;          // полуширина дороги в мировых единицах
  const LANES = 3;
  const CAM_H = 1000;
  const FOV = 100;
  const CAM_DEPTH = 1 / Math.tan(((FOV / 2) * Math.PI) / 180);
  const PLAYER_Z = CAM_H * CAM_DEPTH;
  const DRAW_DIST = 220;
  const FOG_DENSITY = 4.5;

  const MAX_SPEED = SEG_LEN * 60;          // 12000 ед/с
  const ACCEL = MAX_SPEED / 5.5;
  const BRAKING = -MAX_SPEED / 2.0;
  const DECEL = -MAX_SPEED / 8;
  const OFF_DECEL = -MAX_SPEED / 1.7;
  const OFF_LIMIT = MAX_SPEED / 3.4;
  const CENTRIFUGAL = 0.26;

  // ============================ canvas ============================
  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d', { alpha: false });
  let W = 0, H = 0, DPR = 1;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const cssW = Math.max(320, rect.width || window.innerWidth);
    const cssH = Math.max(240, rect.height || window.innerHeight);
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = round(cssW);
    H = round(cssH);
    canvas.width = round(cssW * DPR);
    canvas.height = round(cssH * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    buildSky();
  }

  // ============================ состояние ============================
  const state = {
    mode: 'menu',          // menu | countdown | race | finish | paused
    stageIndex: 0,
    stage: STAGES[0],
    segments: [],
    trackLength: 1,
    position: 0,
    playerX: 0,
    speed: 0,
    time: 0,
    countdown: 0,
    lastCheckpoint: -1,
    bestTime: null,
    shake: 0,
    steer: 0,
    tick: 0
  };

  const input = { left: false, right: false, gas: false, brake: false };

  // ============================ генерация трассы ============================
  function buildTrack(cfg) {
    const rng = makeRng(cfg.seed);
    const segments = [];
    let lastY = 0;

    function addSegment(curve, y) {
      const n = segments.length;
      segments.push({
        index: n,
        p1: { world: { x: 0, y: lastY, z: n * SEG_LEN }, camera: {}, screen: {} },
        p2: { world: { x: 0, y: y, z: (n + 1) * SEG_LEN }, camera: {}, screen: {} },
        curve: curve,
        sprites: [],
        clip: 0,
        fog: 1
      });
      lastY = y;
    }

    function addRoad(enter, hold, leave, curve, hills) {
      const startY = lastY;
      const endY = startY + hills * SEG_LEN;
      const total = enter + hold + leave;
      for (let n = 0; n < enter; n++)
        addSegment(easeIn(0, curve, n / enter), easeInOut(startY, endY, n / total));
      for (let n = 0; n < hold; n++)
        addSegment(curve, easeInOut(startY, endY, (enter + n) / total));
      for (let n = 0; n < leave; n++)
        addSegment(easeInOut(curve, 0, n / leave), easeInOut(startY, endY, (enter + hold + n) / total));
    }

    // стартовая прямая
    addRoad(20, 40, 20, 0, 0);

    // набираем секции, пока не получим нужную длину спецучастка
    for (let guard = 0; guard < 400 && segments.length < cfg.targetSegments; guard++) {
      const r = rng();
      const len = 30 + Math.floor(rng() * 50);
      const dir = rng() < 0.5 ? -1 : 1;
      const strength = cfg.curveScale * lerp(2, 6.5, rng());
      const hill = cfg.hillScale * (((rng() < 0.5) ? -1 : 1) * Math.floor(rng() * 40));
      if (r < 0.28) {
        addRoad(len, 40 + Math.floor(rng() * 60), len, 0, hill);          // прямая
      } else if (r < 0.62) {
        addRoad(len, 20 + Math.floor(rng() * 30), len, dir * strength, hill); // дуга
      } else if (r < 0.85) {
        addRoad(len, 10, len, dir * strength, hill);
        addRoad(len, 10, len, -dir * strength, -hill);                     // S-образный
      } else {
        addRoad(20, 20, 20, dir * strength * 1.35, hill);                  // шпилька
      }
    }
    // финишная прямая
    addRoad(20, 60, 20, 0, 0);

    // обочины/разукраска
    for (let n = 0; n < segments.length; n++) {
      const seg = segments[n];
      seg.light = Math.floor(n / RUMBLE_LEN) % 2 === 0;
      seg.startLine = n < 12;
    }

    // деревья, камни, флаги
    const spriteRng = makeRng(cfg.seed ^ 0x5f3759df);
    for (let n = 8; n < segments.length - 10; n++) {
      const seg = segments[n];
      if (spriteRng() < 0.45) {
        const side = spriteRng() < 0.5 ? -1 : 1;
        const offset = side * lerp(1.35, 3.6, spriteRng());
        const huge = spriteRng() < 0.25;
        seg.sprites.push({
          type: 'tree',
          offset: offset,
          h: huge ? lerp(2600, 3600, spriteRng()) : lerp(1600, 2400, spriteRng()),
          w: lerp(0.55, 0.9, spriteRng())
        });
      }
      if (spriteRng() < 0.05) {
        const side = spriteRng() < 0.5 ? -1 : 1;
        seg.sprites.push({ type: 'rock', offset: side * lerp(1.15, 1.9, spriteRng()), h: lerp(280, 520, spriteRng()) });
      }
      if (n % 90 === 40) {
        seg.sprites.push({ type: 'flag', offset: -1.22, h: 900 });
        seg.sprites.push({ type: 'flag', offset: 1.22, h: 900 });
      }
    }

    // финишная арка + разметка
    const finishIndex = segments.length - 40;
    segments[finishIndex - 6].sprites.push({ type: 'arch', offset: 0, h: 0 });
    for (let i = 0; i < 8; i++) segments[finishIndex + i].finishLine = true;

    return { segments: segments, trackLength: segments.length * SEG_LEN, finishIndex: finishIndex };
  }

  function findSegment(z) {
    const segs = state.segments;
    return segs[Math.floor(z / SEG_LEN) % segs.length];
  }

  // ============================ фон ============================
  let skyGradient = null;
  let bgOffset = 0;
  let stars = [];
  let mountainLayers = [];

  function buildSky() {
    const pal = state.stage;
    skyGradient = ctx.createLinearGradient(0, 0, 0, H);
    skyGradient.addColorStop(0, pal.sky[0]);
    skyGradient.addColorStop(0.55, pal.sky[1]);
    skyGradient.addColorStop(1, pal.sky[2]);
  }

  function buildMountains(cfg) {
    const rng = makeRng(cfg.seed ^ 0x9e3779b9);
    mountainLayers = [];
    for (let l = 0; l < 2; l++) {
      const pts = [];
      const cnt = 26;
      for (let i = 0; i <= cnt; i++) {
        pts.push(0.25 + rng() * (l === 0 ? 0.5 : 0.75));
      }
      pts[cnt] = pts[0];
      mountainLayers.push({ pts: pts, parallax: l === 0 ? 0.35 : 0.7, color: cfg.hills[l], base: l === 0 ? 0.62 : 0.72 });
    }
    stars = [];
    if (cfg.night) {
      for (let i = 0; i < 70; i++) stars.push({ x: rng(), y: rng() * 0.45, r: 0.4 + rng() * 1.1, a: 0.25 + rng() * 0.6 });
    }
  }

  function renderBackground(baseCurve) {
    const pal = state.stage;
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, W, H);

    // звёзды
    if (pal.night) {
      ctx.fillStyle = '#dce8ff';
      for (let i = 0; i < stars.length; i++) {
        const s = stars[i];
        ctx.globalAlpha = s.a * (0.7 + 0.3 * Math.sin(state.tick * 0.02 + i));
        ctx.beginPath();
        ctx.arc(s.x * W, s.y * H, s.r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    // солнце / луна
    const sunX = W * 0.5 - Math.sin(bgOffset * 1.4) * W * 0.16;
    const sunY = H * 0.42;
    const sunR = Math.min(W, H) * 0.055;
    const g = ctx.createRadialGradient(sunX, sunY, sunR * 0.4, sunX, sunY, sunR * 2.6);
    g.addColorStop(0, pal.sun);
    g.addColorStop(0.34, pal.sun);
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.globalAlpha = pal.night ? 0.42 : 0.7;
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR * 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = pal.night ? 0.95 : 1;
    ctx.fillStyle = pal.sun;
    ctx.beginPath();
    ctx.arc(sunX, sunY, sunR, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // горы
    for (let l = 0; l < mountainLayers.length; l++) {
      const layer = mountainLayers[l];
      const off = (bgOffset * layer.parallax * W * 0.5) % W;
      const top = H * layer.base;
      ctx.fillStyle = layer.color;
      for (let k = -1; k <= 1; k++) {
        const startX = -off + k * W;
        ctx.beginPath();
        ctx.moveTo(startX, H);
        const pts = layer.pts;
        const step = W / (pts.length - 1);
        for (let i = 0; i < pts.length; i++) {
          const px = startX + i * step;
          const py = top - pts[i] * H * 0.28;
          if (i === 0) ctx.lineTo(px, py);
          else {
            const prevX = startX + (i - 1) * step;
            const prevY = top - pts[i - 1] * H * 0.28;
            ctx.lineTo((px + prevX) / 2, py);
          }
        }
        ctx.lineTo(startX + W, H);
        ctx.closePath();
        ctx.fill();
      }
    }

    // дымка у горизонта
    const hz = ctx.createLinearGradient(0, H * 0.4, 0, H * 0.78);
    hz.addColorStop(0, 'rgba(0,0,0,0)');
    hz.addColorStop(0.55, pal.fog);
    hz.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.globalAlpha = pal.night ? 0.5 : 0.35;
    ctx.fillStyle = hz;
    ctx.fillRect(0, H * 0.4, W, H * 0.4);
    ctx.globalAlpha = 1;
  }

  // ============================ проекция ============================
  function project(p, camX, camY, camZ) {
    p.camera.x = (p.world.x || 0) - camX;
    p.camera.y = (p.world.y || 0) - camY;
    p.camera.z = (p.world.z || 0) - camZ;
    p.screen.scale = CAM_DEPTH / p.camera.z;
    p.screen.x = round(W / 2 + (p.screen.scale * p.camera.x * W) / 2);
    p.screen.y = round(H / 2 - (p.screen.scale * p.camera.y * H) / 2);
    p.screen.w = round((p.screen.scale * ROAD_W * W) / 2);
  }

  function poly(x1, y1, x2, y2, x3, y3, x4, y4, color) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.lineTo(x3, y3);
    ctx.lineTo(x4, y4);
    ctx.closePath();
    ctx.fill();
  }

  function renderSegment(seg, alt) {
    const pal = state.stage;
    const p1 = seg.p1.screen, p2 = seg.p2.screen;
    const y1 = p1.y + 1;                 // на 1px вниз: перекрываем шов между сегментами
    const rumble1 = (p1.w / LANES) * 0.7;
    const rumble2 = (p2.w / LANES) * 0.7;

    // трава
    ctx.fillStyle = seg.light ? pal.grass[0] : pal.grass[1];
    ctx.fillRect(0, p2.y, W, y1 - p2.y);

    // обочина
    const rumbleColor = seg.light ? pal.rumble[0] : pal.rumble[1];
    poly(p1.x - p1.w - rumble1, y1, p1.x - p1.w, y1, p2.x - p2.w, p2.y, p2.x - p2.w - rumble2, p2.y, rumbleColor);
    poly(p1.x + p1.w + rumble1, y1, p1.x + p1.w, y1, p2.x + p2.w, p2.y, p2.x + p2.w + rumble2, p2.y, rumbleColor);

    // полотно
    poly(p1.x - p1.w, y1, p1.x + p1.w, y1, p2.x + p2.w, p2.y, p2.x - p2.w, p2.y, seg.light ? pal.road[0] : pal.road[1]);

    // колеи
    if (p1.w > 3) {
      const c1 = p1.w * 0.12, c2 = p2.w * 0.12;
      poly(p1.x - c1 * 3.6, y1, p1.x - c1 * 2.4, y1, p2.x - c2 * 2.4, p2.y, p2.x - c2 * 3.6, p2.y, pal.rut);
      poly(p1.x + c1 * 2.4, y1, p1.x + c1 * 3.6, y1, p2.x + c2 * 3.6, p2.y, p2.x + c2 * 2.4, p2.y, pal.rut);
    }

    // финишная «шахматка»
    if (seg.finishLine) {
      const cells = 8;
      const cw1 = (p1.w * 2) / cells;
      const cw2 = (p2.w * 2) / cells;
      for (let i = 0; i < cells; i++) {
        const color = (i + seg.index) % 2 ? '#f4f4f6' : '#17171c';
        poly(
          p1.x - p1.w + i * cw1, y1, p1.x - p1.w + (i + 1) * cw1, y1,
          p2.x - p2.w + (i + 1) * cw2, p2.y, p2.x - p2.w + i * cw2, p2.y,
          color
        );
      }
    }
  }

  function renderSprite(seg, sprite) {
    const p = seg.p1.screen;
    if (p.scale <= 0) return;
    const pal = state.stage;
    const spriteX = p.x + (p.scale * sprite.offset * ROAD_W * W) / 2;
    const spriteY = p.y;
    const alpha = Math.min(1, seg.fog * 1.35);
    if (alpha < 0.04) return;
    if (!seg.rendered) return;               // сегмент скрыт за холмом
    if (seg.clip && sprite.type !== 'arch' && p.y > seg.clip + 2) return;
    ctx.globalAlpha = alpha;
    if (sprite.type === 'tree') {
      const h = (p.scale * sprite.h * H) / 2;
      const w = h * 0.42 * sprite.w;
      if (h < 3 || h > H * 3) return;
      // ствол
      ctx.fillStyle = pal.treeTrunk;
      ctx.fillRect(spriteX - w * 0.07, spriteY - h * 0.22, w * 0.14, h * 0.22);
      // кроны (три треугольника)
      ctx.fillStyle = seg.light ? pal.tree[0] : pal.tree[1];
      for (let i = 0; i < 3; i++) {
        const top = spriteY - h + (h * 0.22) * i;
        const half = (w / 2) * (0.55 + i * 0.22);
        const bottom = top + h * 0.42;
        ctx.beginPath();
        ctx.moveTo(spriteX, top);
        ctx.lineTo(spriteX + half, bottom);
        ctx.lineTo(spriteX - half, bottom);
        ctx.closePath();
        ctx.fill();
      }
    } else if (sprite.type === 'rock') {
      const h = (p.scale * sprite.h * H) / 2;
      const w = h * 1.3;
      if (h < 2) return;
      ctx.fillStyle = pal.rock;
      ctx.beginPath();
      ctx.ellipse(spriteX, spriteY - h * 0.4, w / 2, h / 2, 0, 0, Math.PI * 2);
      ctx.fill();
    } else if (sprite.type === 'flag') {
      const h = (p.scale * sprite.h * H) / 2;
      if (h < 3) return;
      ctx.strokeStyle = '#e8e8e8';
      ctx.lineWidth = Math.max(1, h * 0.03);
      ctx.beginPath();
      ctx.moveTo(spriteX, spriteY);
      ctx.lineTo(spriteX, spriteY - h);
      ctx.stroke();
      ctx.fillStyle = '#f97316';
      ctx.beginPath();
      ctx.moveTo(spriteX, spriteY - h);
      ctx.lineTo(spriteX + h * 0.35, spriteY - h * 0.82);
      ctx.lineTo(spriteX, spriteY - h * 0.64);
      ctx.closePath();
      ctx.fill();
    } else if (sprite.type === 'arch') {
      const h = (p.scale * 2400 * H) / 2;
      const w = (p.scale * ROAD_W * 2.15 * W) / 2;
      if (h < 6 || h > H * 4) return;
      const barH = Math.max(2, h * 0.16);
      const postW = Math.max(2, w * 0.045);
      // стойки
      ctx.fillStyle = '#cfd2da';
      ctx.fillRect(spriteX - w / 2, spriteY - h, postW, h);
      ctx.fillRect(spriteX + w / 2 - postW, spriteY - h, postW, h);
      // шахматная перекладина
      const cells = 16;
      const cw = w / cells;
      for (let i = 0; i < cells; i++) {
        ctx.fillStyle = i % 2 ? '#1d1d24' : '#f2f2f4';
        ctx.fillRect(spriteX - w / 2 + i * cw, spriteY - h, cw + 0.5, barH);
      }
      ctx.fillStyle = '#f97316';
      ctx.fillRect(spriteX - w / 2, spriteY - h + barH, w, Math.max(1, barH * 0.2));
    }

    ctx.globalAlpha = 1;
  }

  // ============================ машина игрока ============================
  const dust = [];

  function spawnDust(amount) {
    const carW = Math.min(W * 0.30, H * 0.55);
    for (let i = 0; i < amount; i++) {
      dust.push({
        x: W / 2 + (Math.random() - 0.5) * carW * 0.9,
        y: H * 0.93 + Math.random() * 10,
        vx: (Math.random() - 0.5) * 60,
        vy: -20 - Math.random() * 60,
        r: 5 + Math.random() * 12,
        life: 1
      });
    }
  }

  function renderDust(dt) {
    for (let i = dust.length - 1; i >= 0; i--) {
      const d = dust[i];
      d.life -= dt * 1.6;
      if (d.life <= 0) {
        dust.splice(i, 1);
        continue;
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.r += dt * 26;
      ctx.globalAlpha = Math.max(0, d.life) * 0.5;
      ctx.fillStyle = state.stage.night ? '#5d6472' : '#d8c9a8';
      ctx.beginPath();
      ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function rrect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
    ctx.fill();
  }

  function renderCar() {
    const pal = state.stage;
    const speedPercent = state.speed / MAX_SPEED;
    const carW = Math.min(W * 0.25, H * 0.46);
    const carH = carW * 0.60;
    const bob = Math.sin(state.tick * 0.4) * 1.6 * speedPercent;
    const cx = W / 2;
    const cy = H * 0.965 + bob;
    const tilt = state.steer * 0.06;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(tilt);

    const w = carW, h = carH;

    // тень
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.ellipse(0, -h * 0.02, w * 0.56, h * 0.13, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // колёса
    ctx.fillStyle = '#0f1015';
    rrect(-w * 0.51, -h * 0.32, w * 0.13, h * 0.32, w * 0.045);
    rrect(w * 0.38, -h * 0.32, w * 0.13, h * 0.32, w * 0.045);

    // кузов
    const bodyGrad = ctx.createLinearGradient(0, -h * 0.78, 0, 0);
    bodyGrad.addColorStop(0, '#ffb066');
    bodyGrad.addColorStop(0.35, '#f97316');
    bodyGrad.addColorStop(1, '#a83a0c');
    ctx.fillStyle = bodyGrad;
    ctx.beginPath();
    ctx.moveTo(-w * 0.42, -h * 0.62);
    ctx.lineTo(-w * 0.47, -h * 0.30);
    ctx.lineTo(-w * 0.45, -h * 0.04);
    ctx.lineTo(w * 0.45, -h * 0.04);
    ctx.lineTo(w * 0.47, -h * 0.30);
    ctx.lineTo(w * 0.42, -h * 0.62);
    ctx.closePath();
    ctx.fill();

    // крыша
    ctx.fillStyle = '#22252c';
    ctx.beginPath();
    ctx.moveTo(-w * 0.33, -h * 0.64);
    ctx.lineTo(-w * 0.29, -h * 0.93);
    ctx.lineTo(w * 0.29, -h * 0.93);
    ctx.lineTo(w * 0.33, -h * 0.64);
    ctx.closePath();
    ctx.fill();

    // заднее стекло
    ctx.fillStyle = pal.night ? 'rgba(80, 120, 180, 0.55)' : 'rgba(150, 190, 225, 0.6)';
    ctx.beginPath();
    ctx.moveTo(-w * 0.27, -h * 0.66);
    ctx.lineTo(-w * 0.24, -h * 0.89);
    ctx.lineTo(w * 0.24, -h * 0.89);
    ctx.lineTo(w * 0.27, -h * 0.66);
    ctx.closePath();
    ctx.fill();

    // антикрыло
    ctx.fillStyle = '#191b21';
    ctx.fillRect(-w * 0.44, -h * 0.72, w * 0.88, h * 0.055);
    ctx.fillRect(-w * 0.36, -h * 0.78, w * 0.05, h * 0.09);
    ctx.fillRect(w * 0.31, -h * 0.78, w * 0.05, h * 0.09);

    // стоп-сигналы
    const brake = input.brake ? 1 : 0.4;
    ctx.fillStyle = `rgba(255, 66, 44, ${brake})`;
    ctx.fillRect(-w * 0.40, -h * 0.40, w * 0.19, h * 0.09);
    ctx.fillRect(w * 0.21, -h * 0.40, w * 0.19, h * 0.09);

    // задний бампер + номер
    ctx.fillStyle = 'rgba(20, 16, 14, 0.85)';
    ctx.fillRect(-w * 0.45, -h * 0.16, w * 0.90, h * 0.09);
    ctx.fillStyle = '#f2f2f4';
    rrect(-w * 0.10, -h * 0.33, w * 0.20, h * 0.16, h * 0.02);
    ctx.fillStyle = '#101216';
    ctx.font = `700 ${Math.max(7, h * 0.11)}px "Roboto Mono", monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('07', 0, -h * 0.248);

    ctx.restore();

    // фары ночью
    if (pal.night) {
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      const lightGrad = ctx.createLinearGradient(0, cy, 0, cy - H * 0.62);
      lightGrad.addColorStop(0, 'rgba(255, 240, 200, 0.22)');
      lightGrad.addColorStop(0.45, 'rgba(255, 235, 190, 0.08)');
      lightGrad.addColorStop(1, 'rgba(255, 235, 190, 0)');
      ctx.fillStyle = lightGrad;
      ctx.beginPath();
      ctx.moveTo(cx - carW * 0.3, cy - carH * 0.5);
      ctx.lineTo(cx + carW * 0.3, cy - carH * 0.5);
      ctx.lineTo(cx + W * 0.5, cy - H * 0.58);
      ctx.lineTo(cx - W * 0.5, cy - H * 0.58);
      ctx.closePath();
      ctx.fill();
      ctx.restore();
    }
  }

  // ============================ рендер кадра ============================
  function render(dt) {
    const pal = state.stage;
    const segments = state.segments;
    const baseSegment = findSegment(state.position);
    const basePercent = (state.position % SEG_LEN) / SEG_LEN;
    const playerSegment = findSegment(state.position + PLAYER_Z);
    const playerPercent = ((state.position + PLAYER_Z) % SEG_LEN) / SEG_LEN;
    const playerY = lerp(playerSegment.p1.world.y, playerSegment.p2.world.y, playerPercent);

    let maxy = H;
    let x = 0;
    let dx = -(baseSegment.curve * basePercent);

    bgOffset += baseSegment.curve * 0.004 + (state.playerX * dt * 0.05);

    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    renderBackground(baseSegment.curve);

    for (let n = 0; n < DRAW_DIST; n++) {
      const seg = segments[(baseSegment.index + n) % segments.length];
      const looped = seg.index < baseSegment.index;
      seg.fog = fogAt(n / DRAW_DIST, FOG_DENSITY);
      seg.clip = maxy;
      seg.rendered = false;

      const camZ = state.position - (looped ? state.trackLength : 0);
      const camX = state.playerX * ROAD_W;
      project(seg.p1, camX - x, playerY + CAM_H, camZ);
      project(seg.p2, camX - x - dx, playerY + CAM_H, camZ);

      x += dx;
      dx += seg.curve;

      if (seg.p1.camera.z <= CAM_DEPTH) continue;
      if (seg.p2.screen.y >= seg.p1.screen.y) continue;
      if (seg.p2.screen.y >= maxy) continue;

      renderSegment(seg, seg.light);
      seg.rendered = true;

      // дымка
      const f = seg.fog;
      if (f < 1) {
        ctx.globalAlpha = 1 - f;
        ctx.fillStyle = pal.fog;
        ctx.fillRect(0, seg.p2.screen.y, W, seg.p1.screen.y - seg.p2.screen.y + 1);
        ctx.globalAlpha = 1;
      }

      maxy = seg.p2.screen.y;
    }

    // спрайты (дальние → ближние)
    for (let n = DRAW_DIST - 1; n > 0; n--) {
      const seg = segments[(baseSegment.index + n) % segments.length];
      if (!seg.sprites.length) continue;
      for (let i = 0; i < seg.sprites.length; i++) {
        if (seg.p1.camera.z > CAM_DEPTH) renderSprite(seg, seg.sprites[i]);
      }
    }

    // пыль из-под колёс
    const offRoad = Math.abs(state.playerX) > 1;
    if (state.mode === 'race' && (offRoad || state.speed > MAX_SPEED * 0.5)) {
      spawnDust(offRoad ? 3 : 1);
    }
    renderDust(dt);

    if (state.mode !== 'menu') renderCar();

    // тряска на обочине / ударе
    if (state.shake > 0) {
      const s = state.shake;
      ctx.setTransform(DPR, 0, 0, DPR, (Math.random() - 0.5) * s * DPR, (Math.random() - 0.5) * s * DPR);
      state.shake = Math.max(0, state.shake - dt * 3);
    } else {
      ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
    }

    // виньетка скорости
    const sp = state.speed / MAX_SPEED;
    if (sp > 0.55 && state.mode === 'race') {
      const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.3, W / 2, H / 2, Math.max(W, H) * 0.75);
      vg.addColorStop(0, 'rgba(0,0,0,0)');
      vg.addColorStop(1, `rgba(0,0,0,${(sp - 0.55) * 0.55})`);
      ctx.fillStyle = vg;
      ctx.fillRect(0, 0, W, H);
    }
  }

  // ============================ звук ============================
  const Sound = {
    ctx: null,
    master: null,
    engineGain: null,
    osc1: null,
    osc2: null,
    noiseGain: null,
    muted: false,
    started: false,
    init: function () {
      if (this.started) return;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try {
        this.ctx = new AC();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.muted ? 0 : 0.35;
        this.master.connect(this.ctx.destination);

        this.engineGain = this.ctx.createGain();
        this.engineGain.gain.value = 0;
        this.engineGain.connect(this.master);

        const filter = this.ctx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 900;
        filter.connect(this.engineGain);

        this.osc1 = this.ctx.createOscillator();
        this.osc1.type = 'sawtooth';
        this.osc1.frequency.value = 60;
        this.osc1.connect(filter);

        this.osc2 = this.ctx.createOscillator();
        this.osc2.type = 'square';
        this.osc2.frequency.value = 90;
        const g2 = this.ctx.createGain();
        g2.gain.value = 0.35;
        this.osc2.connect(g2);
        g2.connect(filter);

        this.osc1.start();
        this.osc2.start();

        // шум гравия
        const len = this.ctx.sampleRate * 2;
        const buffer = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
        const data = buffer.getChannelData(0);
        for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * 0.5;
        const src = this.ctx.createBufferSource();
        src.buffer = buffer;
        src.loop = true;
        const bp = this.ctx.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = 1800;
        bp.Q.value = 0.8;
        this.noiseGain = this.ctx.createGain();
        this.noiseGain.gain.value = 0;
        src.connect(bp);
        bp.connect(this.noiseGain);
        this.noiseGain.connect(this.master);
        src.start();

        this.started = true;
      } catch (e) {
        this.started = false;
      }
    },
    update: function () {
      if (!this.started) return;
      const sp = state.speed / MAX_SPEED;
      const running = state.mode === 'race' || state.mode === 'countdown' || state.mode === 'finish';
      const target = running ? 0.10 + sp * 0.55 : 0;
      const now = this.ctx.currentTime;
      this.engineGain.gain.setTargetAtTime(target, now, 0.1);
      this.osc1.frequency.setTargetAtTime(52 + sp * 155 + (input.gas ? 8 : 0), now, 0.08);
      this.osc2.frequency.setTargetAtTime(78 + sp * 210, now, 0.08);
      const off = Math.abs(state.playerX) > 1;
      this.noiseGain.gain.setTargetAtTime(running ? (off ? 0.16 : 0.05) * sp : 0, now, 0.1);
    },
    toggle: function () {
      this.muted = !this.muted;
      if (this.master) this.master.gain.value = this.muted ? 0 : 0.35;
      return this.muted;
    },
    beep: function (freq, dur) {
      if (!this.started || this.muted) return;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = freq;
      g.gain.value = 0.12;
      o.connect(g);
      g.connect(this.master);
      o.start();
      g.gain.exponentialRampToValueAtTime(0.0001, this.ctx.currentTime + dur);
      o.stop(this.ctx.currentTime + dur);
    }
  };

  // ============================ игровая логика ============================
  const hud = {
    time: document.getElementById('hud-time'),
    speed: document.getElementById('hud-speed'),
    progress: document.getElementById('hud-progress'),
    best: document.getElementById('hud-best'),
    stage: document.getElementById('hud-stage'),
    toast: document.getElementById('hud-toast')
  };

  function formatTime(t) {
    const m = Math.floor(t / 60);
    const s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  }

  function bestKey(stageId) {
    return 'rally.best.' + stageId;
  }

  function loadBest(stageId) {
    try {
      const v = localStorage.getItem(bestKey(stageId));
      return v ? parseFloat(v) : null;
    } catch (e) {
      return null;
    }
  }

  function saveBest(stageId, t) {
    try {
      localStorage.setItem(bestKey(stageId), String(t));
    } catch (e) {
      /* приватный режим — переживём */
    }
  }

  function selectStage(index) {
    state.stageIndex = index;
    state.stage = STAGES[index];
    const track = buildTrack(state.stage);
    state.segments = track.segments;
    state.trackLength = track.trackLength;
    state.finishIndex = track.finishIndex;
    state.finishZ = track.finishIndex * SEG_LEN;
    state.bestTime = loadBest(state.stage.id);
    buildMountains(state.stage);
    buildSky();
    updateStageUI();
  }

  function updateStageUI() {
    document.querySelectorAll('.stage-chip').forEach((el, i) => {
      el.classList.toggle('active', i === state.stageIndex);
    });
    const best = state.bestTime;
    if (hud.best) hud.best.textContent = best ? formatTime(best) : '—';
    if (hud.stage) hud.stage.textContent = state.stage.code + ' · ' + state.stage.title;
    const bestEl = document.getElementById('menu-best');
    if (bestEl) bestEl.textContent = best ? 'РЕКОРД ' + formatTime(best) : 'РЕКОРДА НЕТ';
    const titleEl = document.getElementById('menu-stage-title');
    if (titleEl) titleEl.textContent = state.stage.code + ' · ' + state.stage.title;
    const hintEl = document.getElementById('menu-stage-hint');
    if (hintEl) hintEl.textContent = state.stage.hint;
  }

  function resetRun() {
    state.position = 0;
    state.playerX = 0;
    state.speed = 0;
    state.time = 0;
    state.steer = 0;
    state.shake = 0;
    state.lastCheckpoint = -1;
    dust.length = 0;
    bgOffset = 0;
  }

  function startRace() {
    resetRun();
    state.mode = 'countdown';
    state.countdown = 3.0;
    showOverlay(null);
    document.getElementById('countdown').classList.add('visible');
    Sound.init();
    if (Sound.ctx && Sound.ctx.state === 'suspended') Sound.ctx.resume();
  }

  function finishRace() {
    state.mode = 'finish';
    const t = state.time;
    const prevBest = state.bestTime;
    const isRecord = prevBest === null || t < prevBest;
    if (isRecord) {
      state.bestTime = t;
      saveBest(state.stage.id, t);
    }
    updateStageUI();
    document.getElementById('finish-time').textContent = formatTime(t);
    document.getElementById('finish-record').classList.toggle('show', isRecord);
    document.getElementById('finish-delta').textContent =
      prevBest === null ? 'первый заезд на этом СУ' : isRecord
        ? '−' + (prevBest - t).toFixed(2) + ' с к рекорду'
        : '+' + (t - prevBest).toFixed(2) + ' с к рекорду';
    showOverlay('overlay-finish');
    Sound.beep(660, 0.18);
    setTimeout(() => Sound.beep(880, 0.25), 160);
  }

  function pauseRace() {
    if (state.mode !== 'race' && state.mode !== 'countdown') return;
    state.mode = 'paused';
    showOverlay('overlay-pause');
  }

  function resumeRace() {
    if (state.mode !== 'paused') return;
    state.mode = state.countdown > 0 ? 'countdown' : 'race';
    showOverlay(null);
  }

  function toMenu() {
    state.mode = 'menu';
    resetRun();
    showOverlay('overlay-menu');
  }

  function showOverlay(id) {
    ['overlay-menu', 'overlay-pause', 'overlay-finish'].forEach((k) => {
      const el = document.getElementById(k);
      if (el) el.classList.toggle('visible', k === id);
    });
    const cd = document.getElementById('countdown');
    if (id !== null && cd) cd.classList.remove('visible');
    document.getElementById('controls').classList.toggle('visible', state.mode !== 'menu');
  }

  function toast(text) {
    if (!hud.toast) return;
    hud.toast.textContent = text;
    hud.toast.classList.add('show');
    clearTimeout(toast._t);
    toast._t = setTimeout(() => hud.toast.classList.remove('show'), 1400);
  }

  // ============================ обновление ============================
  function update(dt) {
    if (state.mode === 'countdown') {
      state.countdown -= dt;
      const el = document.getElementById('countdown');
      const n = Math.ceil(state.countdown);
      const label = state.countdown <= 0.6 ? 'ГАЗ' : String(clamp(n, 1, 3));
      if (el.textContent !== label) {
        el.textContent = label;
        el.classList.remove('pulse');
        void el.offsetWidth;
        el.classList.add('pulse');
        Sound.beep(state.countdown <= 0.6 ? 880 : 440, 0.12);
      }
      if (state.countdown <= 0) {
        state.mode = 'race';
        state.countdown = 0;
        el.classList.remove('visible');
        Sound.beep(1200, 0.2);
      }
      return;
    }
    if (state.mode !== 'race') {
      Sound.update();
      return;
    }

    state.time += dt;
    state.tick += dt * 60;

    const playerSegment = findSegment(state.position + PLAYER_Z);
    const speedPercent = state.speed / MAX_SPEED;
    const startPosition = state.position;

    // руль
    const steerInput = (input.left ? -1 : 0) + (input.right ? 1 : 0);
    state.steer = lerp(state.steer, steerInput, Math.min(1, dt * 12));
    state.playerX += dt * 2.25 * steerInput * Math.max(0.3, speedPercent);

    // центробежная сила
    state.playerX -= dt * speedPercent * playerSegment.curve * CENTRIFUGAL;

    // газ / тормоз
    if (input.brake) state.speed += BRAKING * dt;
    else if (input.gas) state.speed += ACCEL * dt;
    else state.speed += DECEL * dt;

    // обочина
    const offRoad = Math.abs(state.playerX) > 1;
    if (offRoad) {
      if (state.speed > OFF_LIMIT) state.speed += OFF_DECEL * dt;
      state.shake = Math.min(6, state.shake + dt * 18);
      if (Math.random() < 0.15) state.playerX += (state.playerX > 0 ? 1 : -1) * dt * 0.06;
    }

    state.speed = clamp(state.speed, 0, MAX_SPEED);
    state.playerX = clamp(state.playerX, -2.2, 2.2);

    // перемещение
    state.position += state.speed * dt;

    // круги/финиш
    if (state.position >= state.finishZ && startPosition < state.finishZ) {
      if (state.speed > 0) {
        finishRace();
        return;
      }
    }
    if (state.position > state.trackLength) state.position -= state.trackLength;

    // контрольные точки
    const cpLen = state.finishZ / 3;
    const cp = Math.floor(state.position / cpLen);
    if (cp > state.lastCheckpoint && cp >= 1 && cp <= 2) {
      state.lastCheckpoint = cp;
      toast('ОТСЕЧКА ' + cp + '/3 · ' + formatTime(state.time));
      Sound.beep(720, 0.1);
    }

    Sound.update();
  }

  // ============================ HUD ============================
  let hudAcc = 0;
  function updateHud(dt) {
    hudAcc += dt;
    if (hudAcc < 0.08) return;
    hudAcc = 0;
    if (hud.time) hud.time.textContent = formatTime(state.time);
    if (hud.speed) hud.speed.textContent = String(Math.round((state.speed / MAX_SPEED) * 205));
    if (hud.progress) {
      const p = clamp(state.position / Math.max(1, state.finishZ), 0, 1);
      hud.progress.style.width = (p * 100).toFixed(1) + '%';
    }
  }

  // ============================ ввод ============================
  function bindButton(id, key) {
    const el = document.getElementById(id);
    if (!el) return;
    const on = (e) => {
      e.preventDefault();
      input[key] = true;
      el.classList.add('pressed');
      if (Sound.ctx && Sound.ctx.state === 'suspended') Sound.ctx.resume();
    };
    const off = (e) => {
      if (e) e.preventDefault();
      input[key] = false;
      el.classList.remove('pressed');
    };
    el.addEventListener('pointerdown', (e) => {
      on(e);
      try {
        el.setPointerCapture(e.pointerId);
      } catch (err) {
        /* старые WebView */
      }
    });
    el.addEventListener('pointerup', off);
    el.addEventListener('pointercancel', off);
    el.addEventListener('pointerleave', off);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function bindKeyboard() {
    const map = {
      ArrowLeft: 'left',
      KeyA: 'left',
      ArrowRight: 'right',
      KeyD: 'right',
      ArrowUp: 'gas',
      KeyW: 'gas',
      ArrowDown: 'brake',
      KeyS: 'brake',
      Space: 'brake'
    };
    window.addEventListener('keydown', (e) => {
      const k = map[e.code];
      if (k) {
        input[k] = true;
        e.preventDefault();
      }
      if (e.code === 'Enter' && state.mode === 'menu') startRace();
      if (e.code === 'Escape') {
        if (state.mode === 'paused') resumeRace();
        else pauseRace();
      }
      if (e.code === 'KeyR' && state.mode === 'race') startRace();
    });
    window.addEventListener('keyup', (e) => {
      const k = map[e.code];
      if (k) {
        input[k] = false;
        e.preventDefault();
      }
    });
  }

  // ============================ главный цикл ============================
  let last = 0;
  function frame(now) {
    if (!last) last = now;
    let dt = (now - last) / 1000;
    last = now;
    dt = Math.min(dt, 1 / 20); // защита от провалов после сворачивания

    if (state.mode === 'paused') {
      Sound.update();
      requestAnimationFrame(frame);
      return;
    }

    update(dt);
    render(dt);
    updateHud(dt);
    requestAnimationFrame(frame);
  }

  // ============================ разметка/кнопки меню ============================
  function bindMenu() {
    const start = document.getElementById('btn-start');
    if (start) start.addEventListener('click', startRace);

    document.querySelectorAll('.stage-chip').forEach((el, i) => {
      el.addEventListener('click', () => {
        selectStage(i);
        Sound.init();
        Sound.beep(520, 0.08);
      });
    });

    const again = document.getElementById('btn-again');
    if (again) again.addEventListener('click', startRace);

    const toMenuBtn = document.getElementById('btn-menu');
    if (toMenuBtn) toMenuBtn.addEventListener('click', toMenu);

    const resume = document.getElementById('btn-resume');
    if (resume) resume.addEventListener('click', resumeRace);

    const restart = document.getElementById('btn-restart');
    if (restart) restart.addEventListener('click', startRace);

    const quit = document.getElementById('btn-quit');
    if (quit) quit.addEventListener('click', toMenu);

    const pause = document.getElementById('btn-pause');
    if (pause) pause.addEventListener('click', pauseRace);

    const sound = document.getElementById('btn-sound');
    if (sound) {
      sound.addEventListener('click', () => {
        Sound.init();
        const m = Sound.toggle();
        sound.textContent = m ? '🔇' : '🔊';
        sound.classList.toggle('off', m);
      });
    }

    document.addEventListener('visibilitychange', () => {
      if (document.hidden) pauseRace();
    });
  }

  // API для нативной обёртки (Android): приложение вызывает window.Rally.pause()
  window.Rally = {
    pause: pauseRace,
    resume: resumeRace,
    start: startRace,
    menu: toMenu,
    state: state,
    input: input
  };

  // ============================ старт ============================
  function init() {
    resize();
    selectStage(0);
    bindButton('btn-left', 'left');
    bindButton('btn-right', 'right');
    bindButton('btn-gas', 'gas');
    bindButton('btn-brake', 'brake');
    bindKeyboard();
    bindMenu();
    showOverlay('overlay-menu');
    window.addEventListener('resize', () => {
      resize();
      buildMountains(state.stage);
    });
    window.addEventListener('orientationchange', () => setTimeout(resize, 250));
    requestAnimationFrame(frame);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
