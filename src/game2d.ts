// 2D-прототип «Ножичков»: вид на половик сверху, рисованная графика на Canvas.
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

function loadImage(name: string): HTMLImageElement {
  const img = new Image();
  img.src = `${import.meta.env.BASE_URL}textures/${name}.jpg`;
  return img;
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

// ---------- Экран ----------
const canvas = $<HTMLCanvasElement>('board');
const ctx = canvas.getContext('2d')!;
const trailCanvas = $<HTMLCanvasElement>('trail');
const trailCtx = trailCanvas.getContext('2d')!;
let W = 0, H = 0, DPR = 1;
/** Масштаб (пикселей на единицу) и центр половика на экране. */
let S = 100, CX = 0, CY = 0;
/** Поворот вида: свой кот всегда внизу. */
let viewRot = 0;

function resize() {
  DPR = Math.min(devicePixelRatio, 2);
  W = innerWidth;
  H = innerHeight;
  for (const c of [canvas, trailCanvas]) {
    c.width = W * DPR;
    c.height = H * DPR;
  }
  // Место под панели сверху и снизу.
  const top = 70, bottom = W < 700 ? 190 : 150;
  const avail = Math.min(W - 24, H - top - bottom);
  S = avail / (2 * (CIRCLE_R + 0.12));
  CX = W / 2;
  CY = top + (H - top - bottom) / 2;
}
addEventListener('resize', resize);
resize();

function toScreen([x, y]: Vec2): Vec2 {
  const c = Math.cos(viewRot), s = Math.sin(viewRot);
  return [CX + (x * c - y * s) * S, CY + (x * s + y * c) * S];
}
function toWorld(sx: number, sy: number): Vec2 {
  const x = (sx - CX) / S, y = (sy - CY) / S;
  const c = Math.cos(-viewRot), s = Math.sin(-viewRot);
  return [x * c - y * s, x * s + y * c];
}
/** Вектор направления (мир → экран), без сдвига. */
function dirToScreen([x, y]: Vec2): Vec2 {
  const c = Math.cos(viewRot), s = Math.sin(viewRot);
  return [x * c - y * s, x * s + y * c];
}

// ---------- Картинки и фактуры ----------
const rugImg = loadImage('rug_top');
const floorImg = loadImage('floor_paint');
let floorPattern: CanvasPattern | null = null;

/** Бумага: мелкое зерно и пятна пигмента, рисуется один раз. */
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

/** Детерминированное дрожание — линии «от руки», но не мерцают от кадра к кадру. */
function jitter(seed: number) {
  const x = Math.sin(seed * 127.1) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

const INK = '#3b2618';

// ---------- Рисование ----------
function regionPath(region: Region) {
  ctx.beginPath();
  for (const poly of region)
    for (const ring of poly)
      ring.forEach((p, i) => {
        const [x, y] = toScreen(p as Vec2);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
}

/** Нитка: тёмный контур, цвет и светлые «витки». */
function drawThread(a: Vec2, b: Vec2, color: string, width: number, seed = 0) {
  const [ax, ay] = toScreen(a), [bx, by] = toScreen(b);
  const len = Math.hypot(bx - ax, by - ay);
  const n = Math.max(2, Math.round(len / 18));
  const nx = -(by - ay) / (len || 1), ny = (bx - ax) / (len || 1);
  const pts: Vec2[] = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const w = i === 0 || i === n ? 0 : jitter(seed + i) * 2.2;
    pts.push([lerp(ax, bx, t) + nx * w, lerp(ay, by, t) + ny * w]);
  }
  const stroke = (style: string, wd: number, dash: number[] = []) => {
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.strokeStyle = style;
    ctx.lineWidth = wd;
    ctx.setLineDash(dash);
    ctx.stroke();
  };
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  stroke(INK, width + 2.5);
  stroke(color, width);
  stroke('rgba(255,255,255,0.35)', width * 0.35, [width * 0.9, width * 1.3]);
  ctx.setLineDash([]);
}

function drawFloor() {
  if (!floorPattern && floorImg.complete && floorImg.naturalWidth) floorPattern = ctx.createPattern(floorImg, 'repeat');
  ctx.fillStyle = '#5d3a2a';
  ctx.fillRect(0, 0, W, H);
  if (floorPattern) {
    // Доски ≈ 17 см: картина пола (8 досок) — около 1,4 м, т. е. 2,4 ед.
    const k = (2.4 * S) / floorImg.naturalWidth;
    floorPattern.setTransform(new DOMMatrix().translate(CX, CY).rotate((viewRot * 180) / Math.PI).scale(k));
    ctx.save();
    ctx.fillStyle = floorPattern;
    ctx.globalAlpha = 0.85;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
}

function drawRug() {
  const [cx, cy] = toScreen([0, 0]);
  const r = CIRCLE_R * S;
  // Тень половика на полу.
  ctx.save();
  ctx.fillStyle = 'rgba(40,20,10,0.35)';
  ctx.beginPath();
  ctx.ellipse(cx + 4, cy + 7, r + 3, r + 3, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  if (rugImg.complete && rugImg.naturalWidth) {
    // Круг на картинке чуть меньше кадра (как в 3D-версии: берём середину 96,5 %).
    const size = (2 * r) / 0.965;
    ctx.translate(cx, cy);
    ctx.rotate(viewRot);
    ctx.drawImage(rugImg, -size / 2, -size / 2, size, size);
  } else {
    ctx.fillStyle = '#c9a77c';
    ctx.fill();
  }
  ctx.restore();

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

  // Край половика — обмётка.
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.strokeStyle = INK;
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.strokeStyle = 'rgba(120,60,40,0.8)';
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 4]);
  ctx.beginPath();
  ctx.arc(cx, cy, r - 4, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);
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

/** Склеить соседние отрезки в длинные нитки — так дрожание линии выглядит естественнее. */
function drawBorder() {
  borderCache.forEach(([a, b], i) => drawThread(a, b, '#c8282c', 0.022 * S, i * 7.3));
}

function drawYarn(m: Mark) {
  if (m.hp <= 0) return;
  const [x, y] = toScreen(m.c);
  const r = MARK_R * S * 0.62;
  const color = m.owner === 0 ? '#f0a23a' : '#4f86c6';
  ctx.save();
  // Тень.
  ctx.fillStyle = 'rgba(40,20,10,0.3)';
  ctx.beginPath();
  ctx.ellipse(x + r * 0.25, y + r * 0.35, r, r * 0.8, 0, 0, Math.PI * 2);
  ctx.fill();
  // Клубок.
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  ctx.clip();
  // Витки нитки.
  ctx.strokeStyle = 'rgba(60,30,10,0.35)';
  ctx.lineWidth = Math.max(1, r * 0.09);
  const seed = m.c[0] * 13 + m.c[1] * 7;
  for (let i = 0; i < 7; i++) {
    const a = seed + i * 0.9;
    ctx.beginPath();
    ctx.ellipse(x + Math.cos(a) * r * 0.3, y + Math.sin(a) * r * 0.3, r * 0.95, r * 0.35, a, 0, Math.PI * 2);
    ctx.stroke();
  }
  // Свет сверху-слева, тень справа-снизу.
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
  // Прочность — узелки сверху.
  for (let i = 0; i < m.hp; i++) {
    const a = -Math.PI / 2 + (i - (m.hp - 1) / 2) * 0.55;
    ctx.beginPath();
    ctx.arc(x + Math.cos(a) * r * 1.3, y + Math.sin(a) * r * 1.3, Math.max(2.5, r * 0.16), 0, Math.PI * 2);
    ctx.fillStyle = '#f7efe0';
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }
}

/** Кот сверху, мордой по направлению face (рад, в экранных координатах). */
function drawCat(p: number, at: Vec2, face: number) {
  const [x, y] = toScreen(at);
  const k = S; // всё в единицах мира
  const coat = p === 0
    ? { base: '#d98a3d', stripe: '#a85a22', light: '#f3d2a2' }
    : { base: '#8f949a', stripe: '#4f545a', light: '#d9dbdc' };
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(face);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  // Тень.
  ctx.fillStyle = 'rgba(40,20,10,0.3)';
  ctx.beginPath();
  ctx.ellipse(-0.02 * k + 4, 6, 0.2 * k, 0.13 * k, 0, 0, Math.PI * 2);
  ctx.fill();
  // Хвост — дугой сбоку.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.055 * k + 3;
  const tail = () => {
    ctx.beginPath();
    ctx.moveTo(-0.17 * k, 0.02 * k);
    ctx.bezierCurveTo(-0.3 * k, 0.06 * k, -0.28 * k, 0.2 * k, -0.12 * k, 0.2 * k);
    ctx.stroke();
  };
  tail();
  ctx.strokeStyle = coat.base;
  ctx.lineWidth = 0.055 * k;
  tail();
  // Тело.
  ctx.beginPath();
  ctx.ellipse(-0.05 * k, 0, 0.15 * k, 0.11 * k, 0, 0, Math.PI * 2);
  ctx.fillStyle = coat.base;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Полоски на спине.
  ctx.save();
  ctx.clip();
  ctx.strokeStyle = coat.stripe;
  ctx.lineWidth = 0.022 * k;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    ctx.moveTo((-0.05 + i * 0.05) * k, -0.12 * k);
    ctx.quadraticCurveTo((-0.08 + i * 0.05) * k, 0, (-0.05 + i * 0.05) * k, 0.12 * k);
    ctx.stroke();
  }
  ctx.restore();
  // Передние лапы.
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.ellipse(0.08 * k, s * 0.06 * k, 0.045 * k, 0.028 * k, 0, 0, Math.PI * 2);
    ctx.fillStyle = coat.light;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  // Голова с ушами.
  const hx = 0.1 * k;
  for (const s of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(hx + 0.01 * k, s * 0.035 * k);
    ctx.lineTo(hx + 0.06 * k, s * 0.085 * k);
    ctx.lineTo(hx - 0.035 * k, s * 0.075 * k);
    ctx.closePath();
    ctx.fillStyle = coat.stripe;
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = 2;
    ctx.stroke();
  }
  ctx.beginPath();
  ctx.ellipse(hx, 0, 0.07 * k, 0.075 * k, 0, 0, Math.PI * 2);
  ctx.fillStyle = coat.base;
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2.5;
  ctx.stroke();
  // Полоски на лбу.
  ctx.strokeStyle = coat.stripe;
  ctx.lineWidth = 0.014 * k;
  for (const s of [-1, 0, 1]) {
    ctx.beginPath();
    ctx.moveTo(hx - 0.045 * k, s * 0.025 * k);
    ctx.lineTo(hx + 0.01 * k, s * 0.018 * k);
    ctx.stroke();
  }
  // Нос — сверху виден кончик.
  ctx.beginPath();
  ctx.arc(hx + 0.065 * k, 0, 0.012 * k, 0, Math.PI * 2);
  ctx.fillStyle = '#d98c8c';
  ctx.fill();
  ctx.restore();
}

/**
 * Спица. center — середина в мире, h — высота над полом (ед.), theta — наклон в плоскости полёта
 * (0 — остриём вверх, π — остриём вниз), dir — направление полёта.
 */
function drawNeedle(owner: number, center: Vec2, h: number, theta: number, dir: Vec2, alpha = 1) {
  const kind = knifeOf(owner).assist >= 0.7 ? 'bamboo' : 'metal';
  const [gx, gy] = toScreen(center);
  const [dx, dy] = dirToScreen(dir);
  const half = (NEEDLE_LEN / 2) * S;
  // Высота на экране — сдвиг вверх (вид чуть наискосок), вертикаль сжата.
  const lift = 0.6;
  const along = Math.sin(theta) * half;
  const up = Math.cos(theta) * half * lift;
  const cx = gx, cy = gy - h * S * lift;
  const tip: Vec2 = [cx + dx * along, cy + dy * along - up];
  const knob: Vec2 = [cx - dx * along, cy - dy * along + up];
  ctx.save();
  ctx.globalAlpha = alpha;
  // Тень на полу — проекция спицы сверху.
  ctx.strokeStyle = 'rgba(40,20,10,0.3)';
  ctx.lineWidth = 0.022 * S;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(gx + dx * along + 3, gy + dy * along + 4);
  ctx.lineTo(gx - dx * along + 3, gy - dy * along + 4);
  ctx.stroke();
  // Сама спица.
  ctx.strokeStyle = INK;
  ctx.lineWidth = 0.024 * S + 2.5;
  ctx.beginPath();
  ctx.moveTo(...knob);
  ctx.lineTo(...tip);
  ctx.stroke();
  ctx.strokeStyle = kind === 'bamboo' ? '#d9b77a' : '#c9ced4';
  ctx.lineWidth = 0.024 * S;
  ctx.beginPath();
  ctx.moveTo(...knob);
  ctx.lineTo(...tip);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.007 * S;
  ctx.beginPath();
  ctx.moveTo(lerp(knob[0], tip[0], 0.1) - 1, lerp(knob[1], tip[1], 0.1) - 1);
  ctx.lineTo(lerp(knob[0], tip[0], 0.85) - 1, lerp(knob[1], tip[1], 0.85) - 1);
  ctx.stroke();
  // Шарик-навершие цвета владельца.
  ctx.beginPath();
  ctx.arc(knob[0], knob[1], 0.03 * S, 0, Math.PI * 2);
  ctx.fillStyle = COLORS[owner];
  ctx.fill();
  ctx.strokeStyle = INK;
  ctx.lineWidth = 2;
  ctx.stroke();
  ctx.restore();
}

function drawFieldKnife(k: FieldKnife) {
  if (k.stuck) {
    // Торчит из половика: середина на высоте половины длины, наклон tilt.
    const h = (NEEDLE_LEN / 2) * Math.cos(k.tilt);
    const c: Vec2 = [k.pos[0] - k.dir[0] * Math.sin(k.tilt) * NEEDLE_LEN / 2, k.pos[1] - k.dir[1] * Math.sin(k.tilt) * NEEDLE_LEN / 2];
    drawNeedle(k.owner, c, h, Math.PI - k.tilt, k.dir);
  } else {
    drawNeedle(k.owner, k.pos, 0.02, Math.PI / 2, k.dir);
  }
}

function drawFlight(f: Flight) {
  const u = clamp(f.t / f.T, 0, 1);
  const pos: Vec2 = [lerp(f.from[0], f.to[0], u), lerp(f.from[1], f.to[1], u)];
  const d = Math.hypot(f.to[0] - f.from[0], f.to[1] - f.from[1]);
  const peak = 0.25 + 0.14 * d;
  const h = 4 * peak * u * (1 - u) + 0.3 * (1 - u) + (NEEDLE_LEN / 2) * u;
  const theta = Math.PI + 2 * Math.PI * f.turns * u;
  drawNeedle(f.owner, pos, h, theta, f.dir);
}

function drawGhost() {
  if (phase !== 'place' || isBot(cur) || !hoverWorld) return;
  const ok = canPlaceMark(hoverWorld, regions[cur], marks);
  const [x, y] = toScreen(hoverWorld);
  ctx.beginPath();
  ctx.arc(x, y, MARK_R * S * 0.62, 0, Math.PI * 2);
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = ok ? 'rgba(255,250,235,0.9)' : 'rgba(200,40,40,0.8)';
  ctx.lineWidth = 2.5;
  ctx.stroke();
  ctx.setLineDash([]);
}

function render() {
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  drawFloor();
  drawRug();
  drawBorder();
  cracks.forEach((k, i) => drawThread(k.a, k.b, '#f3ead8', 0.016 * S, 100 + i));
  for (const m of marks) drawYarn(m);
  for (const f of flashes) {
    const a = (clock - f.t0) / 0.6;
    if (a > 1) continue;
    const [x, y] = toScreen(f.c);
    ctx.beginPath();
    ctx.arc(x, y, MARK_R * S * (0.6 + a * 0.6), 0, Math.PI * 2);
    ctx.strokeStyle = `rgba(255,240,150,${1 - a})`;
    ctx.lineWidth = 4;
    ctx.stroke();
  }
  drawGhost();
  // Коты: смотрят друг на друга.
  for (let i = 0; i < 2; i++) {
    const o = shown[1 - i], me = shown[i];
    const [ox, oy] = toScreen(o), [mx, my] = toScreen(me);
    drawCat(i, me, Math.atan2(oy - my, ox - mx));
  }
  for (const k of field) drawFieldKnife(k);
  if (landed) drawFieldKnife(landed);
  if (flight) drawFlight(flight);

  // Бумага поверх всего.
  if (!paperPattern) paperPattern = ctx.createPattern(paper, 'repeat');
  if (paperPattern) {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.globalAlpha = 0.35;
    ctx.fillStyle = paperPattern;
    ctx.fillRect(0, 0, W, H);
    ctx.restore();
  }
  // Виньетка.
  const v = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.35, W / 2, H / 2, Math.max(W, H) * 0.75);
  v.addColorStop(0, 'rgba(30,15,5,0)');
  v.addColorStop(1, 'rgba(30,15,5,0.45)');
  ctx.fillStyle = v;
  ctx.fillRect(0, 0, W, H);
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
    : '<b>Рывок</b> в сторону цели: длина — дальность, резкость — закрутка (нужен ровно один оборот) · ' +
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
  viewRot = viewer() === 0 ? 0 : Math.PI;
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
    const p = toWorld(last.x, last.y);
    if (canStand(p, regions[cur])) stands[cur] = p;
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
  // Направление — весь рывок целиком (от начала до конца), в мире.
  const a = samples[0];
  const w0 = toWorld(a.x, a.y), w1 = toWorld(last.x, last.y);
  const L = Math.hypot(w1[0] - w0[0], w1[1] - w0[1]) || 1;
  const dir: Vec2 = [(w1[0] - w0[0]) / L, (w1[1] - w0[1]) / L];
  const u = clamp((len - THROW.minLen) / (THROW.fullLen - THROW.minLen), 0, 1);
  const dist = lerp(THROW.dMin, THROW.dMax, u);
  const tps = Math.min(THROW.maxTps, sharp * THROW.spinK);
  launch(dir, dist, tps);
}

canvas.addEventListener('pointerdown', (ev) => {
  if (isBot(cur) || ev.button !== 0) return;
  if (phase === 'place') {
    placeMark(toWorld(ev.clientX, ev.clientY));
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
  hoverWorld = toWorld(ev.clientX, ev.clientY);
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
