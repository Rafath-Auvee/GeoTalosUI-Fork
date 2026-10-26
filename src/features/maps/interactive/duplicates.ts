import * as turf from '@turf/turf';
import type { DraftMask } from './types';

type Box = [number, number, number, number];

function boxOf(g: unknown): Box | null {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === 'number') {
      const [x, y] = c as number[];
      if (x < w) w = x; if (x > e) e = x; if (y < s) s = y; if (y > n) n = y;
    } else if (Array.isArray(c)) c.forEach(walk);
  };
  walk((g as { coordinates?: unknown } | null)?.coordinates);
  return Number.isFinite(w) ? [w, s, e, n] : null;
}

const touches = (a: Box, b: Box) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function iou(a: DraftMask, b: DraftMask): number {
  try {
    const fa = turf.feature(a.geometry as never);
    const fb = turf.feature(b.geometry as never);
    const inter = turf.intersect(turf.featureCollection([fa, fb]) as never);
    if (!inter) return 0;
    const ia = turf.area(inter);
    const union = turf.area(fa) + turf.area(fb) - ia;
    return union > 0 ? ia / union : 0;
  } catch {
    return 0;
  }
}

const cache = new WeakMap<DraftMask[], Set<string>>();

/**
 * New masks that restate a mask the set already has (overlap above `threshold`, IoU). They are skipped on
 * save so cleaning never doubles up annotations. Deleted existing masks don't count: re-adding one is intended.
 * Cached per masks array, so the many callers that ask during render cost one pass.
 */
export function duplicateIds(masks: DraftMask[], threshold = 0.7): Set<string> {
  const hit = cache.get(masks);
  if (hit) return hit;
  const existing = masks.filter((m) => m.source === 'existing' && !m.deleted).map((m) => ({ m, box: boxOf(m.geometry) }));
  const out = new Set<string>();
  if (existing.length > 0) {
    for (const m of masks) {
      if (m.annotationId || m.deleted) continue;
      const box = boxOf(m.geometry);
      if (!box) continue;
      if (existing.some((x) => x.box && touches(box, x.box) && iou(m, x.m) >= threshold)) out.add(m.id);
    }
  }
  cache.set(masks, out);
  return out;
}


/** Share of `inner`'s area that lies inside `outer` (0–1). Unlike IoU, a half of an object scores ~1 against the whole. */
function containedShare(inner: unknown, outer: unknown): number {
  try {
    const fi = turf.feature(inner as never);
    const fo = turf.feature(outer as never);
    const a = turf.area(fi);
    if (a <= 0) return 0;
    const x = turf.intersect(turf.featureCollection([fi, fo]) as never);
    return x ? turf.area(x) / a : 0;
  } catch {
    return 0;
  }
}

/**
 * Masks that are mostly inside `outer` and no bigger than it: fragments of the same object that a
 * model split into pieces. IoU/NMS misses these (a half has a low IoU with the whole), so the test is
 * containment: how much of the other mask lies inside the new, whole one.
 */
export function fragmentsInside(
  outer: unknown,
  others: { id: string; geometry: unknown }[],
  threshold = 0.8,
  minShare = 0.1,
): string[] {
  const ob = boxOf(outer);
  if (!ob) return [];
  const oa = turf.area(turf.feature(outer as never));
  const out: string[] = [];
  for (const m of others) {
    const b = boxOf(m.geometry);
    if (!b || !touches(ob, b)) continue;
    const ma = turf.area(turf.feature(m.geometry as never));
    // Only pieces of a comparable size count as fragments; a tiny mask inside a big one is likely its own object.
    if (ma > oa || ma < oa * minShare) continue;
    if (containedShare(m.geometry, outer) >= threshold) out.push(m.id);
  }
  return out;
}
