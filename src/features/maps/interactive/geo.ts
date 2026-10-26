const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

export type Bbox = [number, number, number, number]; // [west, south, east, north]

/** Width and height (m) of an EPSG:4326 bbox — equirectangular, fine at AOI scale. */
export function bboxSizeM(b: Bbox): { w: number; h: number } {
  const midLat = ((b[1] + b[3]) / 2) * (Math.PI / 180);
  return {
    w: Math.abs(b[2] - b[0]) * M_PER_DEG_LON_EQ * Math.cos(midLat),
    h: Math.abs(b[3] - b[1]) * M_PER_DEG_LAT,
  };
}

export function bboxHectares(b: Bbox): number {
  const { w, h } = bboxSizeM(b);
  return (w * h) / 10_000;
}

/** Degrees spanned by `m` metres at latitude `lat`: [lon, lat]. */
export function metersToDegrees(m: number, lat: number): [number, number] {
  const cos = Math.cos(lat * (Math.PI / 180)) || 1e-9;
  return [m / (M_PER_DEG_LON_EQ * cos), m / M_PER_DEG_LAT];
}

/** Nearest value in `ladder` to `x`, compared in log-space. */
export function nearestInLog(x: number, ladder: readonly number[]): number {
  const lx = Math.log(Math.max(x, 1e-6));
  return ladder.reduce((best, v) => (Math.abs(Math.log(v) - lx) < Math.abs(Math.log(best) - lx) ? v : best), ladder[0]);
}

export function fmtScale(m: number): string {
  return `${Number.isInteger(m) ? m : m.toFixed(1)} m`;
}

/** Point-in-bbox test, EPSG:4326. */
export function inBbox(lat: number, lng: number, b: Bbox): boolean {
  return lng >= b[0] && lng <= b[2] && lat >= b[1] && lat <= b[3];
}

const spanCache = new WeakMap<object, number>();

/** Longer side (m) of a mask's bounding box — the "size" used to group and filter masks. Cached per geometry. */
export function maskSpanM(geometry: unknown): number {
  const g = geometry as { coordinates: number[][][] };
  const hit = spanCache.get(g);
  if (hit !== undefined) return hit;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of g.coordinates[0]) {
    w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y);
  }
  const { w: wm, h: hm } = bboxSizeM([w, s, e, n]);
  const span = Math.max(wm, hm);
  spanCache.set(g, span);
  return span;
}

/** The axis-aligned bounding box of a mask as a GeoJSON Polygon — the "box" form of the same object. */
const boxCache = new WeakMap<object, { type: 'Polygon'; coordinates: number[][][] }>();
export function boxGeometry(geometry: unknown): { type: 'Polygon'; coordinates: number[][][] } {
  const g = geometry as { coordinates: number[][][] };
  const hit = boxCache.get(g);
  if (hit) return hit;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of g.coordinates[0]) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  const box = { type: 'Polygon' as const, coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] };
  boxCache.set(g, box);
  return box;
}

/** Ray-casting point-in-polygon on a GeoJSON ring of [lng, lat]. */
export function pointInRing(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** The smallest mask containing the point (a small object inside a big one wins), or null. */
export function hitTest<T extends { geometry: unknown }>(items: T[], lat: number, lng: number): T | null {
  let best: T | null = null;
  let bestSpan = Infinity;
  for (const m of items) {
    const ring = (m.geometry as { coordinates: number[][][] }).coordinates[0];
    if (!pointInRing(lng, lat, ring)) continue;
    const span = maskSpanM(m.geometry);
    if (span < bestSpan) { best = m; bestSpan = span; }
  }
  return best;
}


/** [west, south, east, north] of a GeoJSON geometry's coordinates, or null when it has none. */
export function geometryBounds(g: unknown): Bbox | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x;
      if (x > e) e = x;
      if (y < s) s = y;
      if (y > n) n = y;
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk((g as { coordinates?: unknown } | null)?.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

/** Position along a Hilbert curve (order 10) of a point in the unit square: nearby points get nearby numbers. */
function hilbert(x: number, y: number): number {
  const N = 1024;
  let rx: number, ry: number, d = 0;
  let px = Math.min(N - 1, Math.max(0, Math.floor(x * N)));
  let py = Math.min(N - 1, Math.max(0, Math.floor(y * N)));
  for (let s = N / 2; s >= 1; s = Math.floor(s / 2)) {
    rx = (px & s) > 0 ? 1 : 0;
    ry = (py & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { px = s - 1 - px; py = s - 1 - py; }
      const t = px; px = py; py = t;
    }
  }
  return d;
}

/**
 * Order items so that ones close together on the map sit next to each other: each item's box centre
 * is placed on a Hilbert curve across the extent of all the items (their max bounds). Unlike a plain
 * left-to-right or top-to-bottom sort, neighbours in the list are neighbours on the ground.
 */
export function orderByProximity<T extends { id: string; geometry: unknown }>(items: T[]): T[] {
  const boxes = items.map((m) => geometryBounds(m.geometry));
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const b of boxes) {
    if (!b) continue;
    w = Math.min(w, b[0]); s = Math.min(s, b[1]); e = Math.max(e, b[2]); n = Math.max(n, b[3]);
  }
  const spanX = e - w || 1, spanY = n - s || 1;
  const key = (i: number) => {
    const b = boxes[i];
    if (!b) return Number.MAX_SAFE_INTEGER;
    return hilbert(((b[0] + b[2]) / 2 - w) / spanX, ((b[1] + b[3]) / 2 - s) / spanY);
  };
  return items
    .map((m, i) => ({ m, k: key(i) }))
    .sort((a, b) => a.k - b.k || a.m.id.localeCompare(b.m.id))
    .map((x) => x.m);
}
