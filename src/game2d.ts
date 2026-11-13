// 2D-прототип «Ножичков»: вид с уровня глаз кота через половик, рисованная графика на Canvas.
// Правила (линия разреза, метки-клубки, захват кусков) и бот — общие с 3D-версией (rules.ts, bot.ts).
// Физику броска здесь заменяет простая модель: длина рывка — дальность, резкость — закрутка;
// спица втыкается, если к земле успела сделать почти целое число оборотов (≈ ±40° от вертикали).
import './style.css';
import {
  circlePolygon, halfPlane, intersect, union, difference, components, regionArea, pointInRegion,
  largestInscribed, distToBoundary, type Region, type Vec2,
} from './geometry';
import {
  crackFrom, markHit, canPlaceMark, splitPieces, capturedPieces, guardingMark,
  MARK_R, MARK_HP, MARKS_PER_PLAYER, MIN_PIECE, GUARD_DAMAGE, type Crack, type Mark,
} from './rules';
import { BOT_LEVELS, botPlaceMarks, botTarget, type BotLevel } from './bot';

// ---------- Параметры ----------
const CIRCLE_R = 1.5;
const CIRCLE_AREA = Math.PI * CIRCLE_R * CIRCLE_R;
const FOOT_R = 0.11;
const KNIVES_PER_PLAYER = 5;
const NEEDLE_LEN = 0.34; // длина спицы, ед.
/** Допуск: на сколько оборотов можно ошибиться, чтобы спица воткнулась (40° от вертикали). */
const STICK_TOL = 40 / 360;
const RUN_SPEED = 1.8;
const TAP_MAX = 0.025;
const BOT = 1;
const NAMES = ['Рыжий', 'Серый'];
const COLORS = ['#e39b3c', '#6e8fb3'];
const BOT_KNIFE: KnifeId = 'medium';

/** Бросок: длина рывка (в высотах экрана) — дальность, скорость в конце рывка — закрутка. */
const THROW = {
  dMin: 0.25, // ед., самый короткий бросок
  dMax: 2.6, // ед., самый длинный (дальний край половика с любого места)
  minLen: 0.04,
  fullLen: 0.42,
  minSwipe: 0.3, // высот экрана в секунду: медленнее — это не бросок
  /** Оборотов в секунду на 1 высоту экрана в секунду резкости (≈ 1 оборот при резкости 2,5). */
  spinK: 0.78,
  maxTps: 8,
};
/** Время полёта, с: чем дальше, тем дольше. */
const flightTime = (d: number) => 0.32 + 0.14 * d;
/** Полёт показываем медленнее настоящего — чтобы было видно, как спица крутится. */
const SHOW_SLOW = 1.5;

type KnifeId = 'super' | 'easy' | 'medium' | 'real';
const KNIVES: Record<KnifeId, { label: string; assist: number; damage: number; wobble: number }> = {
  super: { label: 'Супер лёгкая спица', assist: 0.9, damage: 1, wobble: 4 },
  easy: { label: 'Лёгкая спица', assist: 0.7, damage: 1, wobble: 3 },
  medium: { label: 'Средняя спица', assist: 0.4, damage: 2, wobble: 2 },
  real: { label: 'Честная спица', assist: 0, damage: 3, wobble: 1 },
};
type Opponent = 'human' | BotLevel;
type Phase = 'place' | 'aim' | 'gesture' | 'flying' | 'wait' | 'over';

interface Flight {
  owner: number;
  from: Vec2;
  to: Vec2;
  dir: Vec2;
  /** Время полёта, с, и сколько оборотов спица сделает к земле. */
  T: number;
  turns: number;
  t: number;
}
/** Спица на поле: воткнулась (stuck) или лежит. */
interface FieldKnife {
  owner: number;
  pos: Vec2;
  dir: Vec2;
  stuck: boolean;
  tilt: number; // наклон воткнувшейся спицы, рад
}
interface Sample { x: number; y: number; t: number }

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const gauss = () => {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

function load<T extends string>(key: string, ok: (v: string) => boolean, def: T): T {
  try {
    const v = localStorage.getItem(key);
    return v !== null && ok(v) ? (v as T) : def;
  } catch {
    return def;
  }
}
function save(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* нет хранилища — не страшно */
  }
}

// ---------- Состояние ----------
const initialRegions = (): [Region, Region] => {
  const circle = circlePolygon(CIRCLE_R);
  return [intersect(circle, halfPlane([0, 0], [1, 0], 1)), intersect(circle, halfPlane([0, 0], [1, 0], -1))];
};
let regions = initialRegions();
let marks: Mark[] = [];
let cracks: Crack[] = [];
let cur = 0;
let phase: Phase = 'place';
let opponent = load<Opponent>('knives.opponent', (v) => v === 'human' || v in BOT_LEVELS, 'medium');
const knives: [KnifeId, KnifeId] = [
  load<KnifeId>('knives.knife', (v) => v in KNIVES, 'easy'),
  load<KnifeId>('knives.knife', (v) => v in KNIVES, 'easy'),
];
let flight: Flight | null = null;
let landed: FieldKnife | null = null; // последняя брошенная спица (её показываем, пока не сменится ход)
const inHand = [KNIVES_PER_PLAYER, KNIVES_PER_PLAYER];
let field: FieldKnife[] = [];
const stands: Vec2[] = [[0, 0], [0, 0]];
/** Где кот нарисован сейчас (догоняет stands — перебежка). */
const shown: Vec2[] = [[0, 0], [0, 0]];
let pendingTimer: number | undefined;
let gesture: Sample[] = [];
let trail: Sample[] = [];
let clock = 0;
const flashes: { c: Vec2; t0: number }[] = [];
let hoverWorld: Vec2 | null = null;

const isBot = (p: number) => opponent !== 'human' && p === BOT;
const knifeOf = (p: number) => KNIVES[isBot(p) ? BOT_KNIFE : knives[p]];
/** Чьими глазами смотрим: с ботом — всегда человека, вдвоём — того, кто ходит. */
const viewer = () => (opponent === 'human' ? cur : 1 - BOT);
const selectedPlayer = () => (opponent === 'human' ? cur : 1 - BOT);
const canStand = (p: Vec2, region: Region) => pointInRegion(p, region) && distToBoundary(p, region) >= FOOT_R;
const pickable = (p: number) => field.filter((k) => k.owner === p && !pointInRegion(k.pos, regions[1 - p]));

// ---------- Экран и камера ----------
// Камера на уровне глаз кота: чуть позади и правее своего кота («из-за плеча»), смотрит через половик
// на соперника. Проекция — настоящая перспектива; пол, половик и стены рисуются полосками
// (Canvas 2D умеет только аффинные преобразования, а полоска в перспективе — это просто сдвиг и масштаб).
const canvas = $<HTMLCanvasElement>('board');
const ctx = canvas.getContext('2d')!;
const trailCanvas = $<HTMLCanvasElement>('trail');
const trailCtx = trailCanvas.getContext('2d')!;
let W = 0, H = 0, DPR = 1;

const CAM = {
  height: 0.8, // высота глаз, ед. (кот сидя ≈ 0,55)
  back: 1.05, // насколько позади своего кота
  side: 0.38, // и правее — свой кот виден слева внизу
  lookAhead: 1.7, // куда смотрим: точка на полу впереди кота
  fovLandscape: 52,
  fovPortrait: 72,
};
const CAT_H = 0.55;
/** Комната (как в 3D): полуширина и высота стен. */
const ROOM_HALF = 3.69;
const WALL_H = (2 * ROOM_HALF) / 1.5;
const NEAR = 0.08;

/** Поворот вида: 0 — смотрим как рыжий (к −y), π — как серый. */
let viewRot = 0;
/** Камера в повёрнутых координатах (вперёд — к −y). */
const cam = { x: 0, y: 2, phi: 0.3, F: 500, cx: 0, cy: 0 };
let camTarget: Vec2 = [0, 2];

function resize() {
  DPR = Math.min(devicePixelRatio, 2);
  W = innerWidth;
  H = innerHeight;
  for (const c of [canvas, trailCanvas, bgCanvas]) {
    c.width = W * DPR;
    c.height = H * DPR;
  }
  const fov = ((W < H ? CAM.fovPortrait : CAM.fovLandscape) * Math.PI) / 180;
  cam.F = H / 2 / Math.tan(fov / 2);
  cam.cx = W / 2;
  cam.cy = H / 2;
  bgKey = '';
}

/** Мир → повёрнутые координаты (свой кот внизу, вперёд — к −y). */
function rot([x, y]: Vec2): Vec2 {
  const c = Math.cos(viewRot), s = Math.sin(viewRot);
  return [x * c - y * s, x * s + y * c];
}
function unrot([x, y]: Vec2): Vec2 {
  const c = Math.cos(-viewRot), s = Math.sin(-viewRot);
  return [x * c - y * s, x * s + y * c];
}

/** Точка в повёрнутых координатах (x, y — по полу, h — высота) → экран и глубина. */
function projR(x: number, y: number, h: number): { x: number; y: number; d: number } {
  const dx = x - cam.x;
  const dz = cam.y - y; // вперёд
  const dy = h - CAM.height;
  const c = Math.cos(cam.phi), s = Math.sin(cam.phi);
  const d = dz * c - dy * s;
  const v = dy * c + dz * s;
  const dd = Math.max(d, 1e-3);
  return { x: cam.cx + (cam.F * dx) / dd, y: cam.cy - (cam.F * v) / dd, d };
}
function proj(p: Vec2, h = 0) {
  const [x, y] = rot(p);
  return projR(x, y, h);
}
/** Экран → точка на полу (мир) или null, если луч смотрит выше горизонта. */
function groundAt(sx: number, sy: number): Vec2 | null {
  const r = groundAtR(sx, sy);
  return r ? unrot([r.x, r.y]) : null;
}
function groundAtR(sx: number, sy: number): { x: number; y: number; t: number } | null {
  const a = (sx - cam.cx) / cam.F, b = -(sy - cam.cy) / cam.F;
  const c = Math.cos(cam.phi), s = Math.sin(cam.phi);
  const up = -s + b * c;
  if (up >= -1e-4) return null;
  const t = CAM.height / -up;
  return { x: cam.x + a * t, y: cam.y - (c + b * s) * t, t };
}
/** Отрезаем всё, что позади камеры (иначе проекция выворачивается). */
const nearY = () => cam.y + (CAM.height * Math.sin(cam.phi) - NEAR) / Math.cos(cam.phi);
function clipRing(ring: Vec2[]): Vec2[] {
  const lim = nearY();
  const out: Vec2[] = [];
  for (let i = 0; i < ring.length; i++) {
    const a = rot(ring[i]), b = rot(ring[(i + 1) % ring.length]);
    const ina = a[1] <= lim, inb = b[1] <= lim;
    if (ina) out.push(a);
    if (ina !== inb) {
      const t = (lim - a[1]) / (b[1] - a[1]);
      out.push([a[0] + (b[0] - a[0]) * t, lim]);
    }
  }
  return out;
}

// ---------- Картинки ----------
function loadImage(path: string, onload?: () => void): HTMLImageElement {
  const img = new Image();
  img.onload = () => {
    bgKey = '';
    onload?.();
  };
  img.src = `${import.meta.env.BASE_URL}${path}`;
  return img;
}
const ready = (img: HTMLImageElement) => img.complete && img.naturalWidth > 0;
const rugImg = loadImage('textures/rug_top.jpg', () => (rugFlipped = flipped(rugImg)));
const floorImg = loadImage('textures/floor_paint.jpg');
let rugFlipped: HTMLCanvasElement | null = null;
/** Картинка, повёрнутая на 180° — половик для вида серого кота. */
function flipped(img: HTMLImageElement): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = img.naturalWidth;
  c.height = img.naturalHeight;
  const g = c.getContext('2d')!;
  g.translate(c.width, c.height);
  g.rotate(Math.PI);
  g.drawImage(img, 0, 0);
  return c;
}

/** Стены-картины (как в 3D): что отрезать по краям — левый, правый, верх, низ. */
const WALL_IMGS: Record<string, { img: HTMLImageElement; crop: [number, number, number, number] }> = {
  sofa: { img: loadImage('textures/wall_sofa.jpg'), crop: [0.02, 0.98, 0.085, 0.925] },
  door: { img: loadImage('textures/wall_door.jpg'), crop: [0.06, 0.945, 0.075, 0.915] },
  stenka: { img: loadImage('textures/wall_stenka.jpg'), crop: [0.075, 0.925, 0.095, 0.955] },
  window: { img: loadImage('textures/wall_window.jpg'), crop: [0.075, 0.935, 0.085, 0.96] },
};

/** Коты: на листе слева — сидит лицом к нам, справа — спиной. Вырезаем по непрозрачным пикселям. */
interface CatSprites { front: HTMLCanvasElement; back: HTMLCanvasElement }
const catSprites: (CatSprites | null)[] = [null, null];
['cat_ginger', 'cat_gray'].forEach((name, i) => {
  const img = loadImage(`sprites/${name}.png`, () => {
    const half = (x0: number) => cropAlpha(img, x0, img.naturalWidth / 2);
    catSprites[i] = { front: half(0), back: half(img.naturalWidth / 2) };
  });
});
function cropAlpha(img: HTMLImageElement, x0: number, w: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = Math.round(w);
  c.height = img.naturalHeight;
  const g = c.getContext('2d')!;
  g.drawImage(img, -x0, 0);
  const data = g.getImageData(0, 0, c.width, c.height).data;
  let minX = c.width, minY = c.height, maxX = 0, maxY = 0;
  for (let y = 0; y < c.height; y += 2)
    for (let x = 0; x < c.width; x += 2)
      if (data[(y * c.width + x) * 4 + 3] > 40) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  // Уменьшаем до разумного размера: на экране кот не больше ~500 пикселей.
  const k = Math.min(1, 520 / (maxY - minY + 1));
  const out = document.createElement('canvas');
  out.width = Math.round((maxX - minX + 1) * k);
  out.height = Math.round((maxY - minY + 1) * k);
  out.getContext('2d')!.drawImage(c, minX, minY, maxX - minX + 1, maxY - minY + 1, 0, 0, out.width, out.height);
  return out;
}

/** Бумага: мелкое зерно, рисуется один раз. */
const paper = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const img = g.createImageData(256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 200 + Math.random() * 55;
    img.data[i] = v;
    img.data[i + 1] = v * 0.97;
    img.data[i + 2] = v * 0.9;
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  return c;
})();
let paperPattern: CanvasPattern | null = null;

function jitter(seed: number) {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}
const INK = '#3b2618';

// ---------- Неподвижный фон: стены, пол, половик ----------
// Рисуется полосками и кэшируется: перерисовываем, только когда сдвинулась камера.
const bgCanvas = document.createElement('canvas');
const bg = bgCanvas.getContext('2d')!;
let bgKey = '';

function drawBackground() {
  const key = `${cam.x.toFixed(3)}|${cam.y.toFixed(3)}|${viewRot}|${W}|${H}`;
  if (key === bgKey) return;
  bgKey = key;
  bg.setTransform(DPR, 0, 0, DPR, 0, 0);
  bg.fillStyle = '#c9b48f';
  bg.fillRect(0, 0, W, H);
  const names = viewRot === 0 ? { back: 'sofa', left: 'door', right: 'window' } : { back: 'stenka', left: 'window', right: 'door' };
  drawBackWall(WALL_IMGS[names.back]);
  drawSideWall(WALL_IMGS[names.left], -1);
  drawSideWall(WALL_IMGS[names.right], 1);
  drawFloorAndRug();
}

/** Дальняя стена: строки картины — горизонтальные линии на экране. */
function drawBackWall({ img, crop: [l, r, t, b] }: { img: HTMLImageElement; crop: number[] }) {
  if (!ready(img)) return;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const N = 120;
  for (let i = 0; i < N; i++) {
    const h0 = (i / N) * WALL_H, h1 = ((i + 1) / N) * WALL_H;
    const p0 = projR(-ROOM_HALF, -ROOM_HALF, h0), q0 = projR(ROOM_HALF, -ROOM_HALF, h0);
    const p1 = projR(-ROOM_HALF, -ROOM_HALF, h1);
    // Строка картины: низ стены — низ (b), верх — t.
    const v0 = lerp(b, t, h0 / WALL_H) * ih, v1 = lerp(b, t, h1 / WALL_H) * ih;
    bg.drawImage(img, l * iw, v1, (r - l) * iw, v0 - v1, p0.x, p1.y, q0.x - p0.x, p0.y - p1.y + 0.7);
  }
}

/** Боковая стена (side −1 — слева, 1 — справа): столбцы картины — вертикальные полоски. */
function drawSideWall({ img, crop: [l, r, t, b] }: { img: HTMLImageElement; crop: number[] }, side: number) {
  if (!ready(img)) return;
  const iw = img.naturalWidth, ih = img.naturalHeight;
  const x = side * ROOM_HALF;
  const yNear = Math.min(ROOM_HALF, nearY());
  const N = 140;
  for (let i = 0; i < N; i++) {
    // От дальнего угла к ближнему.
    const y0 = lerp(-ROOM_HALF, yNear, i / N), y1 = lerp(-ROOM_HALF, yNear, (i + 1) / N);
    const a0 = projR(x, y0, 0), a1 = projR(x, y1, 0), top0 = projR(x, y0, WALL_H);
    if (a0.d < NEAR || a1.d < NEAR) continue;
    // Слева стоим лицом к стене — правый край картины у дальнего угла; справа — наоборот.
    const u0 = (y0 + ROOM_HALF) / (2 * ROOM_HALF), u1 = (y1 + ROOM_HALF) / (2 * ROOM_HALF);
    const s0 = side < 0 ? 1 - u0 : u0, s1 = side < 0 ? 1 - u1 : u1;
    const sx0 = lerp(l, r, Math.min(s0, s1)) * iw, sx1 = lerp(l, r, Math.max(s0, s1)) * iw;
    const left = Math.min(a0.x, a1.x), w = Math.abs(a1.x - a0.x) + 0.7;
    bg.drawImage(img, sx0, t * ih, Math.max(1, sx1 - sx0), (b - t) * ih, left, top0.y, w, a0.y - top0.y);
  }
}

/** Пол и половик — строками: строка экрана — это линия пола постоянной глубины. */
function drawFloorAndRug() {
  const horizon = projR(cam.x, -1e4, 0).y;
  const startY = Math.max(0, Math.floor(horizon) + 1);
  const tile = 2.4; // картина пола ≈ 1,4 м
  const R = CIRCLE_R;
  const Ri = R / 0.965;
  const rug = viewRot === 0 ? rugImg : rugFlipped;
  for (let sy = startY; sy < H; sy++) {
    const g0 = groundAtR(cam.cx, sy);
    const g1 = groundAtR(cam.cx, sy + 1);
    if (!g0 || !g1) continue;
    if (g0.y < -ROOM_HALF) continue; // за дальней стеной
    const scale = cam.F / g0.t; // пикселей на единицу на этой строке
    const sxOf = (x: number) => cam.cx + (x - cam.x) * scale;
    // Пол между боковыми стенами.
    const xl = -ROOM_HALF, xr = ROOM_HALF;
    if (ready(floorImg)) {
      const iw = floorImg.naturalWidth, ih = floorImg.naturalHeight;
      const vy = (((g0.y % tile) + tile) % tile) / tile * ih;
      const vh = Math.max(1, (Math.abs(g0.y - g1.y) / tile) * ih);
      for (let tx = Math.floor(xl / tile) * tile; tx < xr; tx += tile) {
        const x0 = Math.max(xl, tx), x1 = Math.min(xr, tx + tile);
        if (x1 <= x0) continue;
        const dx0 = sxOf(x0), dx1 = sxOf(x1);
        if (dx1 < 0 || dx0 > W) continue;
        bg.drawImage(floorImg, ((x0 - tx) / tile) * iw, Math.min(vy, ih - vh), ((x1 - x0) / tile) * iw, vh, dx0, sy, dx1 - dx0 + 0.5, 1.2);
      }
    } else {
      bg.fillStyle = '#6a3c29';
      bg.fillRect(sxOf(xl), sy, (xr - xl) * scale, 1.2);
    }
    // Половик: строка картинки на этой глубине, только внутри круга.
    if (Math.abs(g0.y) < R && rug) {
      const half = Math.sqrt(R * R - g0.y * g0.y);
      const iw = rug instanceof HTMLImageElement ? rug.naturalWidth : rug.width;
      const ih = rug instanceof HTMLImageElement ? rug.naturalHeight : rug.height;
      const v = ((g0.y + Ri) / (2 * Ri)) * ih;
      const vh = Math.max(1, (Math.abs(g0.y - g1.y) / (2 * Ri)) * ih);
      const u0 = ((-half + Ri) / (2 * Ri)) * iw, u1 = ((half + Ri) / (2 * Ri)) * iw;
      bg.drawImage(rug, u0, v, u1 - u0, vh, sxOf(-half), sy, 2 * half * scale, 1.2);
    }
  }
  // Тень под краем половика и обмётка.
  const ring = clipRing(circlePolygon(CIRCLE_R, 120)[0].slice(0, -1).map((p) => unrot(p as Vec2)));
  if (ring.length > 2) {
    bg.beginPath();
    ring.forEach(([x, y], i) => {
      const p = projR(x, y, 0);
      if (i) bg.lineTo(p.x, p.y);
      else bg.moveTo(p.x, p.y);
    });
    bg.closePath();
    bg.strokeStyle = INK;
    bg.lineWidth = 2.5;
    bg.stroke();
  }
}

// ---------- Рисование поверх фона ----------
function regionPath(region: Region) {
  ctx.beginPath();
  for (const poly of region)
    for (const ring of poly) {
      const pts = clipRing((ring as Vec2[]).slice(0, -1));
      pts.forEach(([x, y], i) => {
        const p = projR(x, y, 0.001);
        if (i) ctx.lineTo(p.x, p.y);
        else ctx.moveTo(p.x, p.y);
      });
      ctx.closePath();
    }
}

/** Нитка по полу: толщина — по глубине. */
function drawThread(a: Vec2, b: Vec2, color: string, width: number, seed = 0) {
  const lim = nearY();
  let ra = rot(a), rb = rot(b);
  if (ra[1] > lim && rb[1] > lim) return;
  if (ra[1] > lim) ra = [ra[0] + (rb[0] - ra[0]) * ((lim - ra[1]) / (rb[1] - ra[1])), lim];
  if (rb[1] > lim) rb = [rb[0] + (ra[0] - rb[0]) * ((lim - rb[1]) / (ra[1] - rb[1])), lim];
  const n = Math.max(2, Math.round(Math.hypot(rb[0] - ra[0], rb[1] - ra[1]) / 0.06));
  const pts: { x: number; y: number; w: number }[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const p = projR(lerp(ra[0], rb[0], t), lerp(ra[1], rb[1], t), 0.002);
    const w = i === 0 || i === n ? 0 : jitter(seed + i) * 0.5;
    pts.push({ x: p.x, y: p.y + w, w: Math.max(1.2, (width * cam.F) / Math.max(p.d, NEAR)) });
  }
  ctx.lineCap = 'round';
  for (const [style, k, dash] of [[INK, 1.6, false], [color, 1, false], ['rgba(255,255,255,0.35)', 0.35, true]] as const) {
    ctx.strokeStyle = style;
    for (let i = 1; i < pts.length; i++) {
      if (dash && i % 2) continue;
      ctx.lineWidth = pts[i].w * k + (k > 1 ? 1 : 0);
      ctx.beginPath();
      ctx.moveTo(pts[i - 1].x, pts[i - 1].y);
      ctx.lineTo(pts[i].x, pts[i].y);
      ctx.stroke();
    }
  }
}

/** Красная нитка по границе: только там, где по разные стороны — земли разных котов. */
function borderSegments(): [Vec2, Vec2][] {
  const out: [Vec2, Vec2][] = [];
  const EPS = 0.006;
  for (const poly of regions[0])
    for (const ring of poly)
      for (let k = 0; k + 1 < ring.length; k++) {
        const a = ring[k] as Vec2, b = ring[k + 1] as Vec2;
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 1e-4) continue;
        const m: Vec2 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (Math.hypot(m[0], m[1]) > CIRCLE_R - 0.02) continue;
        const n: Vec2 = [(-(b[1] - a[1]) / len) * EPS, ((b[0] - a[0]) / len) * EPS];
        const l: Vec2 = [m[0] + n[0], m[1] + n[1]];
        const r: Vec2 = [m[0] - n[0], m[1] - n[1]];
        if ((pointInRegion(l, regions[0]) && pointInRegion(r, regions[1])) ||
          (pointInRegion(l, regions[1]) && pointInRegion(r, regions[0]))) out.push([a, b]);
      }
  return out;
}
let borderCache: [Vec2, Vec2][] = [];

/** Тень-эллипс на полу под предметом радиуса r. */
function groundShadow(c: Vec2, r: number, alpha = 0.3) {
  const p = proj(c, 0);
  if (p.d < NEAR) return;
  const rx = (r * cam.F) / p.d;
  const [cx, cy] = rot(c);
  const far = projR(cx, cy - r, 0);
  const ry = Math.max(1, Math.abs(p.y - far.y));
  ctx.fillStyle = `rgba(40,20,10,${alpha})`;
  ctx.beginPath();
  ctx.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.fill();
}

const YARN_R = MARK_R * 0.62;
function drawYarn(m: Mark) {
  const p = proj(m.c, YARN_R);
  if (p.d < NEAR * 2) return;
  const r = (YARN_R * cam.F) / p.d;
  const x = p.x, y = p.y;
  groundShadow(m.c, YARN_R * 1.1);
  const color = m.owner === 0 ? '#f0a23a' : '#4f86c6';
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.clip();
  ctx.strokeStyle = 'rgba(60,30,10,0.35)';
  ctx.lineWidth = Math.max(1, r * 0.09);
  const seed = m.c[0] * 13 + m.c[1] * 7;
  for (let i = 0; i < 7; i++) {
    const a = seed + i * 0.9;
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3, r * 0.95, r * 0.35, a, 0, Math.PI * 2);
    ctx.stroke();
  }
  const g = ctx.createRadialGradient(x - r * 0.4, y - r * 0.4, r * 0.1, x, y, r * 1.1);
  g.addColorStop(0, 'rgba(255,250,235,0.45)');
  g.addColorStop(0.6, 'rgba(255,250,235,0)');
  g.addColorStop(1, 'rgba(40,20,10,0.35)');
  ctx.fillStyle = g;
  ctx.fillRect(x - r, y - r, 2 * r, 2 * r);
  ctx.restore();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  // Прочность — узелки над клубком.
  for (let i = 0; i < m.hp; i++) {
    const kx = x + (i - (m.hp - 1) / 2) * r * 0.6;
    ctx.beginPath();
    ctx.arc(kx, y - r * 1.35, Math.max(2.5, r * 0.17), 0, Math.PI * 2);
    ctx.fillStyle = '#f7efe0';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** Кот-спрайт: свой — спиной, соперник — лицом к нам. Низ спрайта — на полу в точке at. */
function drawCat(p: number, at: Vec2) {
  const sp = catSprites[p];
  const g = proj(at, 0);
  if (g.d < NEAR || !sp) return;
  const img = p === viewer() ? sp.back : sp.front;
  const h = (CAT_H * cam.F) / g.d;
  const w = (h * img.width) / img.height;
  groundShadow(at, 0.2, 0.35);
  ctx.drawImage(img, g.x - w / 2, g.y - h * 0.97, w, h);
}

/**
 * Спица: центр, высота центра над полом, наклон theta в плоскости полёта (0 — остриём вверх,
 * π — остриём вниз), направление полёта dir.
 */
function drawNeedle(owner: number, center: Vec2, h: number, theta: number, dir: Vec2) {
  const kind = knifeOf(owner).assist >= 0.7 ? 'bamboo' : 'metal';
  const half = NEEDLE_LEN / 2;
  const along = Math.sin(theta) * half, up = Math.cos(theta) * half;
  const tipW: Vec2 = [center[0] + dir[0] * along, center[1] + dir[1] * along];
  const knobW: Vec2 = [center[0] - dir[0] * along, center[1] - dir[1] * along];
  const tip = proj(tipW, h - up), knob = proj(knobW, h + up);
  if (tip.d < NEAR || knob.d < NEAR) return;
  const sTip = proj(tipW, 0), sKnob = proj(knobW, 0);
  const wpx = (0.022 * cam.F) / ((tip.d + knob.d) / 2);
  ctx.save();
  ctx.lineCap = 'round';
  // Тень на полу.
  ctx.strokeStyle = 'rgba(40,20,10,0.28)';
  ctx.lineWidth = wpx;
  ctx.beginPath();
  ctx.moveTo(sKnob.x, sKnob.y);
  ctx.lineTo(sTip.x, sTip.y);
  ctx.stroke();
  for (const [style, w] of [[INK, wpx + 2.5], [kind === 'bamboo' ? '#d9b77a' : '#c9ced4', wpx]] as const) {
    ctx.strokeStyle = style;
    ctx.lineWidth = w;
    ctx.beginPath();
    ctx.moveTo(knob.x, knob.y);
    ctx.lineTo(tip.x, tip.y);
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.arc(knob.x, knob.y, Math.max(3, (0.03 * cam.F) / knob.d), 0, Math.PI * 2);
  ctx.fillStyle = COLORS[owner];
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawFieldKnife(k: FieldKnife) {
  if (k.stuck) {
    const s = Math.sin(k.tilt) * (NEEDLE_LEN / 2);
    const c: Vec2 = [k.pos[0] - k.dir[0] * s, k.pos[1] - k.dir[1] * s];
    drawNeedle(k.owner, c, (NEEDLE_LEN / 2) * Math.cos(k.tilt), Math.PI - k.tilt, k.dir);
  } else {
    drawNeedle(k.owner, k.pos, 0.012, Math.PI / 2, k.dir);
  }
}

function flightPose(f: Flight) {
  const u = clamp(f.t / f.T, 0, 1);
  const pos: Vec2 = [lerp(f.from[0], f.to[0], u), lerp(f.from[1], f.to[1], u)];
  const d = Math.hypot(f.to[0] - f.from[0], f.to[1] - f.from[1]);
  const peak = 0.25 + 0.14 * d;
  const h = 4 * peak * u * (1 - u) + 0.35 * (1 - u) + (NEEDLE_LEN / 2) * u;
  return { pos, h, theta: Math.PI + 2 * Math.PI * f.turns * u };
}

function drawGhost() {
  if (phase !== 'place' || isBot(cur) || !hoverWorld) return;
  const ok = canPlaceMark(hoverWorld, regions[cur], marks);
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) {
    const a = (i / 40) * Math.PI * 2;
    const p = proj([hoverWorld[0] + Math.cos(a) * YARN_R, hoverWorld[1] + Math.sin(a) * YARN_R], 0);
    if (i) ctx.lineTo(p.x, p.y);
    else ctx.moveTo(p.x, p.y);
  }
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = ok ? 'rgba(255,250,235,0.95)' : 'rgba(200,40,40,0.85)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function render() {
  drawBackground();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(bgCanvas, 0, 0);
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);

  // Земли: половик перекрашен в цвет кота (оттенок меняется, рисунок косичек остаётся).
  for (let i = 0; i < 2; i++) {
    ctx.save();
    regionPath(regions[i]);
    ctx.fillStyle = COLORS[i];
    ctx.globalAlpha = 0.55;
    ctx.globalCompositeOperation = 'color';
    ctx.fill('evenodd');
    ctx.restore();
  }
  borderCache.forEach(([a, b], i) => drawThread(a, b, '#c8282c', 0.02, i * 7.3));
  cracks.forEach((k, i) => drawThread(k.a, k.b, '#f3ead8', 0.016, 100 + i));
  for (const f of flashes) {
    const a = (clock - f.t0) / 0.6;
    if (a > 1) continue;
    const p = proj(f.c, YARN_R);
    if (p.d < NEAR) continue;
    ctx.beginPath();
    ctx.arc(p.x, p.y, ((YARN_R * cam.F) / p.d) * (1 + a), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,240,150,${1 - a})`;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  drawGhost();

  // Всё стоящее на полу — от дальнего к ближнему.
  const items: { d: number; draw: () => void }[] = [];
  for (const m of marks) if (m.hp > 0) items.push({ d: proj(m.c).d, draw: () => drawYarn(m) });
  for (let i = 0; i < 2; i++) items.push({ d: proj(shown[i]).d, draw: () => drawCat(i, shown[i]) });
  for (const k of [...field, ...(landed ? [landed] : [])]) items.push({ d: proj(k.pos).d - 0.01, draw: () => drawFieldKnife(k) });
  if (flight) {
    const f = flight;
    const pose = flightPose(f);
    items.push({ d: proj(pose.pos).d - 0.02, draw: () => drawNeedle(f.owner, pose.pos, pose.h, pose.theta, f.dir) });
  }
  items.sort((a, b) => b.d - a.d).forEach((it) => it.draw());

  if (!paperPattern) paperPattern = ctx.createPattern(paper, 'repeat');
  if (paperPattern) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = paperPattern;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(30,15,5,0)');
  v.addColorStop(1, 'rgba(30,15,5,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
}

/** Куда смотрит камера: за своим котом (в повёрнутых координатах). */
function updateCamera(dt: number, snap = false) {
  const [sx, sy] = rot(shown[viewer()]);
  camTarget = [sx + CAM.side, sy + CAM.back];
  const a = snap ? 1 : 1 - Math.exp(-dt * 6);
  cam.x = lerp(cam.x, camTarget[0], a);
  cam.y = lerp(cam.y, camTarget[1], a);
  cam.phi = Math.atan2(CAM.height, CAM.back + CAM.lookAhead);
}

function drawTrail() {
  trailCtx.setTransform(DPR, 0, 0, DPR, 0, 0);
  trailCtx.clearRect(0, 0, W, H);
  const now = performance.now() / 1000;
  trail = trail.filter((s) => now - s.t < 0.35);
  if (trail.length < 2) return;
  trailCtx.lineCap = 'round';
  for (let i = 1; i < trail.length; i++) {
    const a = 1 - (now - trail[i].t) / 0.35;
    trailCtx.strokeStyle = `rgba(255,245,225,${a * 0.8})`;
    trailCtx.lineWidth = 2 + a * 6;
    trailCtx.beginPath();
    trailCtx.moveTo(trail[i - 1].x, trail[i - 1].y);
    trailCtx.lineTo(trail[i].x, trail[i].y);
    trailCtx.stroke();
  }
}

addEventListener('resize', resize);
resize();

// ---------- HUD ----------
const msgEl = $('message');
const infoEl = $('throwinfo');
const knifeSelect = $<HTMLSelectElement>('knife');
const opponentSelect = $<HTMLSelectElement>('opponent');
const setMessage = (t: string) => (msgEl.textContent = t);

for (const [key, k] of Object.entries(KNIVES)) knifeSelect.add(new Option(k.label, key));
knifeSelect.addEventListener('change', () => {
  knives[selectedPlayer()] = knifeSelect.value as KnifeId;
  save('knives.knife', knifeSelect.value);
  updateHud();
  knifeSelect.blur();
});
opponentSelect.add(new Option('Вдвоём', 'human'));
for (const [key, b] of Object.entries(BOT_LEVELS)) opponentSelect.add(new Option(b.label, key));
opponentSelect.value = opponent;
opponentSelect.addEventListener('change', () => {
  opponent = opponentSelect.value as Opponent;
  save('knives.opponent', opponent);
  opponentSelect.blur();
  reset();
});
$('collect').addEventListener('click', () => collect());
$('restart').addEventListener('click', () => reset());
$('overlay-restart').addEventListener('click', () => reset());

function updateHud() {
  const who = isBot(cur) ? `${NAMES[cur]} (бот)` : NAMES[cur];
  $('turn').innerHTML = `<span class="dot" style="background:${COLORS[cur]}"></span>` +
    (phase === 'place' ? `Клубки: ${who}` : `Ход: ${who}`);
  for (let i = 0; i < 2; i++)
    $(`score${i}`).textContent = `${Math.round((regionArea(regions[i]) / CIRCLE_AREA) * 100)}% · спиц ${inHand[i]}`;
  const myTurn = phase === 'aim' && !isBot(cur);
  const canCollect = myTurn ? pickable(cur).length : 0;
  $('collect').hidden = !canCollect;
  $('collect').textContent = `Собрать спицы (${canCollect})`;
  knifeSelect.value = knives[selectedPlayer()];
  const k = knifeOf(cur);
  $('hint').innerHTML = phase === 'place'
    ? 'Нажми на свою землю, чтобы положить клубок: первый — прочность 1, второй — 2, третий — 3. ' +
      'Кусок под целым клубком не отрезать: вместо этого клубок теряет прочность.'
    : '<b>Рывок вверх</b> (вбок — направление): длина — дальность, резкость — закрутка (нужен ровно один оборот) · ' +
      '<b>Тап по своей земле</b> — перебежать · ' +
      `<b>${k.label}</b>: помощь ${Math.round(k.assist * 100)}%, урон по клубку ${k.damage}, шатание ±${k.wobble}°`;
}

// ---------- Ход игры ----------
function rebuildTerritories() {
  for (let i = 0; i < 2; i++)
    if (!canStand(stands[i], regions[i])) stands[i] = largestInscribed(regions[i]).center;
  borderCache = borderSegments();
  updateHud();
}

function damageMark(m: Mark, dmg: number) {
  m.hp = Math.max(0, m.hp - dmg);
  flashes.push({ c: m.c, t0: clock });
}

function takeBack(list: FieldKnife[]) {
  for (const k of list) inHand[k.owner]++;
  field = field.filter((k) => !list.includes(k));
}

function collect() {
  if (phase !== 'aim') return;
  const list = pickable(cur);
  if (!list.length) return;
  takeBack(list);
  passTurn(`${NAMES[cur]} собирает спицы: +${list.length}`, 1200);
  updateHud();
}

function passTurn(msg: string, delay = 1600) {
  setMessage(msg);
  phase = 'wait';
  pendingTimer = window.setTimeout(nextTurn, delay);
}

/** Бросок: направление (мир), дальность, обороты в секунду. Свойства спицы — шатание и помощь. */
function launch(dir: Vec2, dist: number, tps: number) {
  if (inHand[cur] <= 0) return;
  inHand[cur]--;
  const k = knifeOf(cur);
  const wob = (gauss() * k.wobble * Math.PI) / 180;
  const c = Math.cos(wob), s = Math.sin(wob);
  const d: Vec2 = [dir[0] * c - dir[1] * s, dir[0] * s + dir[1] * c];
  const from = stands[cur];
  const T = flightTime(dist);
  let turns = tps * T;
  // Помощь подтягивает закрутку к целому числу оборотов (не меньше одного).
  turns = lerp(turns, Math.max(1, Math.round(turns)), k.assist);
  flight = {
    owner: cur, from: [...from], to: [from[0] + d[0] * dist, from[1] + d[1] * dist], dir: d,
    T: T * SHOW_SLOW, turns, t: 0,
  };
  phase = 'flying';
  setMessage('');
  infoEl.textContent = `дальность ${dist.toFixed(2)} · ${turns.toFixed(2)} оборота`;
  updateHud();
}

function land(f: Flight) {
  flight = null;
  const target = Math.max(1, Math.round(f.turns));
  const delta = f.turns - target;
  const tilt = Math.abs(delta) * 2 * Math.PI;
  if (Math.abs(delta) > STICK_TOL || f.turns < 0.5) {
    // Плашмя: спица отскакивает чуть вперёд и ложится.
    const pos: Vec2 = [f.to[0] + f.dir[0] * 0.08, f.to[1] + f.dir[1] * 0.08];
    const a = (gauss() * 25 * Math.PI) / 180;
    landed = { owner: f.owner, pos, dir: [f.dir[0] * Math.cos(a) - f.dir[1] * Math.sin(a), f.dir[0] * Math.sin(a) + f.dir[1] * Math.cos(a)], stuck: false, tilt: 0 };
    const advice = delta > 0 ? `перекрутил на ${delta.toFixed(2)} оборота` : `недокрутил на ${(-delta).toFixed(2)} оборота`;
    passTurn(`Не воткнулась: ${advice}. Ход переходит к игроку ${NAMES[1 - cur]}`);
    return;
  }
  landed = { owner: f.owner, pos: f.to, dir: f.dir, stuck: true, tilt: Math.sign(delta) * tilt };
  onStuck(f.to, f.dir);
}

/** Спица воткнулась в точку p, вдоль dir. */
function onStuck(p: Vec2, dir: Vec2) {
  const opp = 1 - cur;
  if (!pointInRegion(p, regions[opp])) {
    const where = pointInRegion(p, regions[cur]) ? 'Воткнулась в свою землю' : 'Мимо половика';
    passTurn(`${where}. Ход переходит к игроку ${NAMES[opp]}`);
    return;
  }
  const mark = markHit(p, marks, opp);
  if (mark) {
    damageMark(mark, knifeOf(cur).damage);
    passTurn(mark.hp > 0 ? `Попал в клубок! Осталось прочности: ${mark.hp}` : 'Клубок распущен!');
    return;
  }
  const line = crackFrom(p, dir, CIRCLE_R);
  cracks = [line];
  const captured = capturedPieces(splitPieces(regions[opp], cracks), stands[opp]);
  if (!captured.length) {
    passTurn('Линия ничего не отрезала');
    return;
  }
  const guard = guardingMark(p, captured, line, marks, opp);
  if (guard) {
    damageMark(guard, GUARD_DAMAGE);
    passTurn(guard.hp > 0
      ? `Клубок защитил землю, осталось прочности: ${guard.hp}`
      : 'Клубок защитил землю и распустился — теперь здесь можно резать!');
    return;
  }
  let gained = 0;
  for (const piece of captured) {
    gained += regionArea(piece);
    regions[cur] = union(regions[cur], piece);
    regions[opp] = difference(regions[opp], piece);
    for (const m of marks) if (m.owner === opp && pointInRegion(m.c, piece)) m.hp = 0;
  }
  for (const crumb of components(regions[opp])) {
    if (regionArea(crumb) >= MIN_PIECE) continue;
    regions[cur] = union(regions[cur], crumb);
    regions[opp] = difference(regions[opp], crumb);
  }
  rebuildTerritories();
  if (largestInscribed(regions[opp]).radius < FOOT_R) {
    setMessage('Воткнулась!');
    phase = 'wait';
    pendingTimer = window.setTimeout(() => gameOver(cur), 1200);
    return;
  }
  // Отрезал — спица возвращается, и свои спицы с отрезанной земли тоже.
  landed = null;
  inHand[cur]++;
  const found = field.filter((k) => k.owner === cur && captured.some((piece) => pointInRegion(k.pos, piece)));
  takeBack(found);
  updateHud();
  const extra = found.length ? ` и ещё +${found.length}` : '';
  passTurn(`Отрезал ${Math.round((gained / CIRCLE_AREA) * 100)}% половика! Спица вернулась${extra}`, 2000);
}

function nextTurn() {
  pendingTimer = undefined;
  if (landed) field.push(landed);
  landed = null;
  cracks = [];
  cur = 1 - cur;
  phase = 'aim';
  updateView();
  updateHud();
  if (inHand[cur] === 0 && !pickable(cur).length) {
    gameOver(1 - cur, `У игрока ${NAMES[cur]} кончились спицы`);
    return;
  }
  setMessage(inHand[cur] === 0 && !isBot(cur) ? 'Спицы кончились — нажми «Собрать спицы»' : `Бросает ${NAMES[cur]}`);
  if (isBot(cur)) pendingTimer = window.setTimeout(botThrow, 1100);
}

function gameOver(winner: number, reason = '') {
  phase = 'over';
  setMessage(reason);
  $('overlay-title').textContent = `Победил ${NAMES[winner]}${isBot(winner) ? ' (бот)' : ''}!${reason ? ` ${reason}.` : ''}`;
  $('overlay').hidden = false;
}

function startPlacement(p: number) {
  cur = p;
  phase = 'place';
  updateView();
  if (isBot(p)) {
    marks.push(...botPlaceMarks(regions[p], p, stands[p], marks));
    finishPlacement(p);
    return;
  }
  updateHud();
  setMessage(`${NAMES[p]}: положи клубки на свою землю — первый с прочностью 1`);
}

function placeMark(c: Vec2): boolean {
  if (phase !== 'place' || !canPlaceMark(c, regions[cur], marks)) return false;
  const placed = marks.filter((m) => m.owner === cur).length;
  marks.push({ owner: cur, c, hp: Math.min(MARK_HP, placed + 1) });
  if (MARKS_PER_PLAYER - placed - 1 > 0) setMessage(`${NAMES[cur]}: следующий клубок — прочность ${placed + 2}`);
  else finishPlacement(cur);
  return true;
}

function finishPlacement(p: number) {
  if (p === 0) {
    startPlacement(1);
    return;
  }
  cur = 0;
  phase = 'aim';
  updateView();
  updateHud();
  setMessage(`Бросает ${NAMES[cur]}`);
}

function botThrow() {
  pendingTimer = undefined;
  if (phase !== 'aim' || !isBot(cur) || opponent === 'human') return;
  const pk = pickable(cur).length;
  if (inHand[cur] === 0 || (inHand[cur] === 1 && pk >= 2)) {
    collect();
    return;
  }
  aimAsBot(opponent);
}

function aimAsBot(level: BotLevel) {
  const opp = 1 - cur;
  const hand = stands[cur];
  const target = botTarget({
    base: regions[opp], opp, oppStand: stands[opp], marks, circleR: CIRCLE_R, hand,
    reach: (d) => d >= THROW.dMin && d <= THROW.dMax, level,
  }) ?? largestInscribed(regions[opp]).center;
  const noise = BOT_LEVELS[level];
  const dist0 = Math.hypot(target[0] - hand[0], target[1] - hand[1]);
  const dist = clamp(dist0 + gauss() * noise.speed * 0.6, THROW.dMin, THROW.dMax);
  const yaw = Math.atan2(target[1] - hand[1], target[0] - hand[0]) + (gauss() * noise.yaw * Math.PI) / 180;
  const tps = (1 / flightTime(dist)) * (1 + gauss() * noise.spin);
  launch([Math.cos(yaw), Math.sin(yaw)], dist, tps);
}

function updateView() {
  const r = viewer() === 0 ? 0 : Math.PI;
  if (r !== viewRot) {
    viewRot = r;
    updateCamera(0, true);
  }
}

function reset() {
  if (pendingTimer !== undefined) clearTimeout(pendingTimer);
  pendingTimer = undefined;
  flight = null;
  landed = null;
  field = [];
  inHand[0] = inHand[1] = KNIVES_PER_PLAYER;
  regions = initialRegions();
  stands[0] = [0, 0];
  stands[1] = [0, 0];
  marks = [];
  cracks = [];
  gesture = [];
  infoEl.textContent = '';
  $('overlay').hidden = true;
  rebuildTerritories();
  shown[0] = [...stands[0]];
  shown[1] = [...stands[1]];
  updateCamera(0, true);
  startPlacement(0);
}

// ---------- Ввод ----------
function gestureLength(samples: Sample[]) {
  if (samples.length < 2) return 0;
  const a = samples[0], b = samples[samples.length - 1];
  return Math.hypot(b.x - a.x, b.y - a.y) / H;
}

function finishSwipe() {
  const samples = gesture;
  gesture = [];
  phase = 'aim';
  const len = gestureLength(samples);
  const last = samples[samples.length - 1];
  if (!last) return;
  if (len < TAP_MAX) {
    const p = groundAt(last.x, last.y);
    if (p && canStand(p, regions[cur])) stands[cur] = p;
    else setMessage('Рывок — бросок, тап по своей земле — перебежать');
    return;
  }
  if (inHand[cur] <= 0) {
    setMessage('Спиц в лапе нет — собери свои');
    return;
  }
  // Скорость в конце рывка — за последние 70 мс.
  let first = samples[samples.length - 2];
  for (let i = samples.length - 2; i >= 0 && last.t - samples[i].t <= 0.07; i--) first = samples[i];
  const dt = Math.max(1e-3, last.t - first.t);
  const vx = (last.x - first.x) / dt / H, vy = (last.y - first.y) / dt / H;
  const sharp = Math.hypot(vx, vy);
  if (sharp < THROW.minSwipe) {
    setMessage('Сделай резкий рывок в сторону цели');
    return;
  }
  // Направление — весь рывок целиком: вверх по экрану — вперёд от себя, вбок — вбок.
  const a = samples[0];
  const L = Math.hypot(last.x - a.x, last.y - a.y) || 1;
  const dir = unrot([(last.x - a.x) / L, (last.y - a.y) / L]);
  const u = clamp((len - THROW.minLen) / (THROW.fullLen - THROW.minLen), 0, 1);
  const dist = lerp(THROW.dMin, THROW.dMax, u);
  const tps = Math.min(THROW.maxTps, sharp * THROW.spinK);
  launch(dir, dist, tps);
}

canvas.addEventListener('pointerdown', (ev) => {
  if (isBot(cur) || ev.button !== 0) return;
  if (phase === 'place') {
    const p = groundAt(ev.clientX, ev.clientY);
    if (p) placeMark(p);
    updateHud();
    return;
  }
  if (phase !== 'aim') return;
  canvas.setPointerCapture(ev.pointerId);
  phase = 'gesture';
  const s = { x: ev.clientX, y: ev.clientY, t: performance.now() / 1000 };
  gesture = [s];
  trail = [s];
});
canvas.addEventListener('pointermove', (ev) => {
  hoverWorld = groundAt(ev.clientX, ev.clientY);
  if (phase !== 'gesture') return;
  const s = { x: ev.clientX, y: ev.clientY, t: performance.now() / 1000 };
  gesture.push(s);
  trail.push(s);
});
const endGesture = (ev: PointerEvent) => {
  if (phase !== 'gesture') return;
  gesture.push({ x: ev.clientX, y: ev.clientY, t: performance.now() / 1000 });
  finishSwipe();
};
canvas.addEventListener('pointerup', endGesture);
canvas.addEventListener('pointercancel', () => {
  if (phase === 'gesture') phase = 'aim';
  gesture = [];
});

// ---------- Цикл ----------
function update(dt: number) {
  clock += dt;
  updateCamera(dt);
  if (flight) {
    flight.t += dt;
    if (flight.t >= flight.T) land(flight);
  }
  // Перебежка: нарисованный кот догоняет место, где стоит.
  for (let i = 0; i < 2; i++) {
    const dx = stands[i][0] - shown[i][0], dy = stands[i][1] - shown[i][1];
    const d = Math.hypot(dx, dy);
    const step = RUN_SPEED * dt;
    if (d <= step) shown[i] = [...stands[i]];
    else shown[i] = [shown[i][0] + (dx / d) * step, shown[i][1] + (dy / d) * step];
  }
}

let last = performance.now();
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000);
  last = now;
  update(dt);
  render();
  drawTrail();
  requestAnimationFrame(frame);
}

reset();
requestAnimationFrame(frame);

if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__game2d = {
    /** Бросок за текущего игрока: угол (° от «вперёд к сопернику»), дальность, обороты в секунду. */
    throwAt(deg: number, dist: number, tps: number) {
      if (phase !== 'aim') return `phase=${phase}`;
      const [ox, oy] = stands[1 - cur], [x, y] = stands[cur];
      const yaw = Math.atan2(oy - y, ox - x) + (deg * Math.PI) / 180;
      launch([Math.cos(yaw), Math.sin(yaw)], dist, tps);
      return 'thrown';
    },
    autoPlace() {
      while (phase === 'place') {
        const own = marks.filter((m) => m.owner === cur).length;
        const placed = botPlaceMarks(regions[cur], cur, stands[cur], marks).slice(0, MARKS_PER_PLAYER - own);
        if (!placed.length) break;
        for (const m of placed) placeMark(m.c);
      }
    },
    botThrow(level: BotLevel = 'medium') {
      if (phase !== 'aim') return `phase=${phase}`;
      aimAsBot(level);
      return 'thrown';
    },
    /** Прокрутить игру без requestAnimationFrame (скрытая вкладка). */
    simulate(seconds: number) {
      for (let t = 0; t < seconds; t += 1 / 60) update(1 / 60);
      render();
    },
    flush() {
      if (pendingTimer === undefined) return false;
      clearTimeout(pendingTimer);
      pendingTimer = undefined;
      nextTurn();
      return true;
    },
    get state() {
      return { phase, cur, areas: regions.map(regionArea), message: msgEl.textContent, inHand, stands, field: field.length };
    },
  };
}
