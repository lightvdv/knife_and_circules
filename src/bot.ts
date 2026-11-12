// Бот: где ставить метки и куда бросать.
import { pointInRegion, distToBoundary, difference, segmentStrip, components, regionArea, type Region, type Vec2 } from './geometry';
import { crackFrom, markHit, canPlaceMark, capturedPieces, guardingMark, CRACK_W, MIN_PIECE, MARKS_PER_PLAYER, type Mark } from './rules';

export type BotLevel = 'easy' | 'medium' | 'hard';

/** Насколько бот ошибается: σ скорости (м/с), σ закрутки (доля), σ направления (°); сколько лучших целей перебирает наугад. */
export const BOT_LEVELS: Record<BotLevel, { label: string; speed: number; spin: number; yaw: number; pickTop: number }> = {
  easy: { label: 'Бот: лёгкий', speed: 0.14, spin: 0.2, yaw: 4, pickTop: 6 },
  medium: { label: 'Бот: средний', speed: 0.08, spin: 0.11, yaw: 2.5, pickTop: 3 },
  hard: { label: 'Бот: сильный', speed: 0.04, spin: 0.05, yaw: 1.2, pickTop: 1 },
};

function bounds(region: Region) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of region)
    for (const [x, y] of poly[0]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  return { minX, minY, maxX, maxY };
}

function grid(region: Region, step: number): Vec2[] {
  const { minX, minY, maxX, maxY } = bounds(region);
  const pts: Vec2[] = [];
  if (!isFinite(minX)) return pts;
  for (let x = minX + step / 2; x < maxX; x += step)
    for (let y = minY + step / 2; y < maxY; y += step) if (pointInRegion([x, y], region)) pts.push([x, y]);
  return pts;
}

/** Метки бота: стенкой примерно в полуметре от своего места, подальше друг от друга. */
export function botPlaceMarks(own: Region, owner: number, stand: Vec2, marks: Mark[]): Mark[] {
  const placed: Mark[] = [];
  const cands = grid(own, 0.08);
  for (let i = 0; i < MARKS_PER_PLAYER; i++) {
    let best: Vec2 | null = null;
    let bestScore = -Infinity;
    for (const c of cands) {
      if (!canPlaceMark(c, own, [...marks, ...placed])) continue;
      const d = Math.hypot(c[0] - stand[0], c[1] - stand[1]);
      const spread = placed.length ? Math.min(0.8, ...placed.map((m) => Math.hypot(c[0] - m.c[0], c[1] - m.c[1]))) : 0;
      const score = -Math.abs(d - 0.55) * 2 + spread + Math.random() * 0.1;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (!best) break;
    placed.push({ owner, c: best, hp: MARKS_PER_PLAYER - i }); // самое выгодное место — самой прочной метке
  }
  return placed;
}

/**
 * Куда бросать. base — земля соперника.
 * Лучше всего — отрезать кусок побольше; если все куски под защитой меток — сбивать с них прочность.
 */
export function botTarget(args: {
  base: Region;
  opp: number;
  oppStand: Vec2;
  marks: Mark[];
  circleR: number;
  hand: Vec2;
  reach: (dist: number) => boolean;
  level: BotLevel;
}): Vec2 | null {
  const { base, opp, oppStand, marks, circleR, hand, reach, level } = args;
  const scored: { p: Vec2; score: number }[] = [];
  for (const p of grid(base, 0.15)) {
    const dist = Math.hypot(p[0] - hand[0], p[1] - hand[1]);
    if (!reach(dist)) continue;
    // Не бросаем у самого края своей земли: шатание может увести мимо.
    if (distToBoundary(p, base) < 0.05) continue;
    let score: number;
    if (markHit(p, marks, opp)) {
      score = 0.35;
    } else {
      const dir: Vec2 = [(p[0] - hand[0]) / dist, (p[1] - hand[1]) / dist];
      const k = crackFrom(p, dir, circleR);
      const pieces = components(difference(base, segmentStrip(k.a, k.b, CRACK_W))).filter((x) => regionArea(x) > MIN_PIECE);
      const captured = capturedPieces(pieces, oppStand);
      const gain = captured.reduce((s, x) => s + regionArea(x), 0);
      if (gain <= 0) score = 0;
      // Кусок под защитой метки — не отрежем, но собьём прочность (тем ценнее, чем больше кусок).
      else if (guardingMark(p, captured, k, marks, opp)) score = 0.3 + gain * 0.5;
      else score = 1 + gain * 3;
    }
    scored.push({ p, score: score + Math.random() * 0.03 });
  }
  if (!scored.length) return null;
  scored.sort((a, b) => b.score - a.score);
  const top = scored.slice(0, BOT_LEVELS[level].pickTop);
  return top[Math.floor(Math.random() * top.length)].p;
}
