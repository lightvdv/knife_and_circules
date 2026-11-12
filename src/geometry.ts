// 2D-геометрия территорий на земле.
// Координаты: [x, z] мировой системы (земля — плоскость y = 0).
import polygonClipping, { type MultiPolygon, type Pair, type Polygon, type Ring } from 'polygon-clipping';

export type Vec2 = [number, number];
export type Region = MultiPolygon;

export function circlePolygon(r: number, segments = 160): Polygon {
  const ring: Pair[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    ring.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  ring.push(ring[0]);
  return [ring];
}

/** Полуплоскость слева (side = 1) или справа (side = -1) от прямой через p с направлением dir. */
export function halfPlane(p: Vec2, dir: Vec2, side: 1 | -1, size = 50): Polygon {
  const [px, py] = p;
  const [dx, dy] = dir;
  const nx = -dy * side;
  const ny = dx * side;
  const a: Pair = [px - dx * size, py - dy * size];
  const b: Pair = [px + dx * size, py + dy * size];
  const c: Pair = [b[0] + nx * size, b[1] + ny * size];
  const d: Pair = [a[0] + nx * size, a[1] + ny * size];
  return [[a, b, c, d, a]];
}

type Geom = Region | Polygon;

const isMulti = (g: Geom): g is Region => g.length > 0 && Array.isArray(g[0][0][0]);
const asMulti = (g: Geom): Region => (isMulti(g) ? g : g.length ? [g as Polygon] : []);

/** Округляет координаты к сетке eps: убирает почти совпадающие точки на швах разрезов. */
function snap(g: Geom, eps: number): Region {
  const r = (v: number) => Math.round(v / eps) * eps;
  return asMulti(g).map((poly) => poly.map((ring) => ring.map(([x, y]) => [r(x), r(y)] as Pair)));
}

/**
 * polygon-clipping иногда падает на почти совпадающих точках («Unable to complete output ring»).
 * Пробуем с округлением всё грубее; если не вышло — используем запасной вариант.
 */
function robust(op: (a: Geom, b: Geom) => Region, a: Geom, b: Geom, fallback: () => Region): Region {
  for (const eps of [1e-9, 1e-7, 1e-5]) {
    try {
      return op(snap(a, eps), snap(b, eps));
    } catch {
      /* пробуем грубее */
    }
  }
  return fallback();
}

export function intersect(a: Geom, b: Geom): Region {
  return robust(polygonClipping.intersection, a, b, () => []);
}

/** Объединение. Куски у нас никогда не пересекаются, поэтому в крайнем случае их можно просто сложить. */
export function union(a: Geom, b: Geom): Region {
  return robust(polygonClipping.union, a, b, () => [...asMulti(a), ...asMulti(b)]);
}

/** Разрезает регион прямой на две части (каждая может быть пустой). */
export function splitByLine(region: Region, p: Vec2, dir: Vec2): [Region, Region] {
  return [intersect(region, halfPlane(p, dir, 1)), intersect(region, halfPlane(p, dir, -1))];
}

function ringArea(ring: Ring): number {
  let s = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % n];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s) / 2;
}

export function regionArea(region: Region): number {
  let total = 0;
  for (const poly of region) {
    total += ringArea(poly[0]);
    for (let h = 1; h < poly.length; h++) total -= ringArea(poly[h]);
  }
  return total;
}

function pointInRing([x, y]: Vec2, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export function pointInRegion(p: Vec2, region: Region): boolean {
  for (const poly of region) {
    if (!pointInRing(p, poly[0])) continue;
    let inHole = false;
    for (let h = 1; h < poly.length; h++) if (pointInRing(p, poly[h])) inHole = true;
    if (!inHole) return true;
  }
  return false;
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + dx * t - px;
  const cy = ay + dy * t - py;
  return Math.sqrt(cx * cx + cy * cy);
}

function distToBoundary([x, y]: Vec2, region: Region): number {
  let best = Infinity;
  for (const poly of region)
    for (const ring of poly)
      for (let i = 0; i < ring.length - 1; i++) {
        const d = distToSegment(x, y, ring[i][0], ring[i][1], ring[i + 1][0], ring[i + 1][1]);
        if (d < best) best = d;
      }
  return best;
}

/**
 * Самый большой вписанный круг (приближённо): куда игрок может встать.
 * Если radius меньше размера стопы — стоять негде.
 */
export function largestInscribed(region: Region): { center: Vec2; radius: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of region)
    for (const [x, y] of poly[0]) {
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
  if (!isFinite(minX)) return { center: [0, 0], radius: 0 };

  let best: Vec2 = [(minX + maxX) / 2, (minY + maxY) / 2];
  let bestR = 0;
  const probe = (p: Vec2) => {
    if (!pointInRegion(p, region)) return;
    const d = distToBoundary(p, region);
    if (d > bestR) { bestR = d; best = p; }
  };

  const n = 40;
  const sx = (maxX - minX) / n;
  const sy = (maxY - minY) / n;
  for (let i = 0; i <= n; i++) for (let j = 0; j <= n; j++) probe([minX + i * sx, minY + j * sy]);

  // Уточняем вокруг лучшей точки.
  let step = Math.max(sx, sy);
  for (let iter = 0; iter < 4; iter++) {
    const [cx, cy] = best;
    for (let i = -5; i <= 5; i++) for (let j = -5; j <= 5; j++) probe([cx + (i * step) / 5, cy + (j * step) / 5]);
    step /= 4;
  }
  return { center: best, radius: bestR };
}
