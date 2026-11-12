// Правила линии разреза и защитных меток.
import {
  difference, components, segmentStrip, regionArea, pointInRegion, distToBoundary,
  type Region, type Vec2,
} from './geometry';

export const MARK_R = 0.18; // радиус метки, м
export const MARK_HP = 3; // прочность метки
export const MARKS_PER_PLAYER = 3;
export const GUARD_DAMAGE = 1; // сколько прочности теряет метка, защитив отрезаемый кусок
export const CRACK_W = 0.01; // ширина линии разреза в расчётах
export const MIN_PIECE = 0.003; // м²: куски меньше считаем крошками

/**
 * Защитная метка. Пока она целая, кусок земли с ней (или линия через неё) не отрезается —
 * вместо этого метка теряет прочность. Прямое попадание ножом снимает урон ножа.
 */
export interface Mark {
  owner: number;
  c: Vec2;
  hp: number;
}

/** Линия разреза — отрезок на земле. */
export interface Crack {
  a: Vec2;
  b: Vec2;
}

/** Целая метка игрока owner, в которую попал нож (с небольшим запасом). */
export function markHit(p: Vec2, marks: Mark[], owner: number): Mark | undefined {
  return marks.find((m) => m.owner === owner && m.hp > 0 && Math.hypot(p[0] - m.c[0], p[1] - m.c[1]) <= MARK_R + 0.02);
}

/** Линия разреза от точки p вдоль dir в обе стороны до края круга. */
export function crackFrom(p: Vec2, dir: Vec2, circleR: number): Crack {
  const end = (s: 1 | -1): Vec2 => {
    const dx = dir[0] * s;
    const dy = dir[1] * s;
    // Край круга: |p + t·d| = R.
    const b = p[0] * dx + p[1] * dy;
    const c = p[0] * p[0] + p[1] * p[1] - circleR * circleR;
    const t = -b + Math.sqrt(Math.max(0, b * b - c));
    return [p[0] + dx * t, p[1] + dy * t];
  };
  return { a: end(-1), b: end(1) };
}

function distToSegment([px, py]: Vec2, [ax, ay]: Vec2, [bx, by]: Vec2): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return Math.hypot(ax + dx * t - px, ay + dy * t - py);
}

/**
 * Метка, которая защищает отрезаемую землю: целая метка соперника, стоящая на отрезаемом куске
 * или задетая линией. Если таких несколько — ближайшая к ножу p.
 */
export function guardingMark(p: Vec2, captured: Region[], line: Crack, marks: Mark[], owner: number): Mark | undefined {
  const guards = marks.filter(
    (m) => m.owner === owner && m.hp > 0 &&
      (distToSegment(m.c, line.a, line.b) < MARK_R || captured.some((piece) => pointInRegion(m.c, piece))),
  );
  const d = (m: Mark) => Math.hypot(m.c[0] - p[0], m.c[1] - p[1]);
  return guards.sort((x, y) => d(x) - d(y))[0];
}

/** Регион без полосок линий разреза. */
export function cutRegion(region: Region, cracks: Crack[]): Region {
  let r = region;
  for (const k of cracks) r = difference(r, segmentStrip(k.a, k.b, CRACK_W));
  return r;
}

/** На какие куски линии делят регион (крошки отброшены). */
export function splitPieces(region: Region, cracks: Crack[]): Region[] {
  return components(cutRegion(region, cracks)).filter((p) => regionArea(p) > MIN_PIECE);
}

/** Можно ли поставить метку в точку c на своей земле own. */
export function canPlaceMark(c: Vec2, own: Region, marks: Mark[]): boolean {
  if (!pointInRegion(c, own)) return false;
  if (distToBoundary(c, own) < MARK_R * 0.7) return false;
  return marks.every((m) => Math.hypot(c[0] - m.c[0], c[1] - m.c[1]) >= MARK_R * 2);
}

/**
 * Что отходит бросающему: соперник остаётся на куске, где стоит (если стоит на линии — на самом большом),
 * все остальные отсечённые куски забирает бросающий.
 */
export function capturedPieces(pieces: Region[], stand: Vec2): Region[] {
  if (pieces.length < 2) return [];
  let keep = pieces.findIndex((p) => pointInRegion(stand, p));
  if (keep < 0) keep = pieces.reduce((bi, p, i) => (regionArea(p) > regionArea(pieces[bi]) ? i : bi), 0);
  return pieces.filter((_, i) => i !== keep);
}
