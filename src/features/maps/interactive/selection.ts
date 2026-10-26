/**
 * The flexible selection behind the Group stage.
 *
 * Grouping mechanisms are independent *filters*, and the selection is whatever
 * matches every active one: a size range, any number of look groups (embedding
 * clusters), and the look-alikes of the reference objects. Pick size first and
 * refine by look, or the other way round — the result is the same intersection.
 * Delete, label or split-by-look then act on that selection.
 */
import { maskSpanM } from './geo';
import type { DraftMask, SimilarState } from './types';

export interface Selection {
  /** Keep masks whose size (longer side, m) is within [min, max]. */
  sizeRange: [number, number] | null;
  /** Keep masks in any of these look groups (embedding clusters). */
  lookGroups: number[];
  /** Masks clicked individually on the map or in the gallery. They are added to whatever the filters select. */
  picked: string[];
}

export const EMPTY_SELECTION: Selection = { sizeRange: null, lookGroups: [], picked: [] };

const similarActive = (s: SimilarState) => s.active && !s.busy;

const facetsActive = (sel: Selection, similar: SimilarState) => sel.sizeRange !== null || sel.lookGroups.length > 0 || similarActive(similar);

/** True when something is selected: an active filter or an individually picked mask. */
export function isFiltering(sel: Selection, similar: SimilarState): boolean {
  return facetsActive(sel, similar) || sel.picked.length > 0;
}

export function matchesSelection(m: DraftMask, sel: Selection, similar: SimilarState): boolean {
  if (sel.sizeRange) {
    const span = maskSpanM(m.geometry);
    if (span < sel.sizeRange[0] || span > sel.sizeRange[1]) return false;
  }
  if (sel.lookGroups.length > 0 && (m.clusterId === null || !sel.lookGroups.includes(Number(m.clusterId)))) return false;
  if (similarActive(similar)) {
    if (m.source === 'manual') return false; // the references are the query, not part of the result
    if ((similar.scores[m.id] ?? -1) < similar.threshold) return false;
  }
  return true;
}

/** Masks matching every active filter, plus any picked individually, out of `candidates` (normally the masks in play). */
export function selectMasks(candidates: DraftMask[], sel: Selection, similar: SimilarState): DraftMask[] {
  const picked = new Set(sel.picked);
  const filters = facetsActive(sel, similar);
  return candidates.filter((m) => picked.has(m.id) || (filters && matchesSelection(m, sel, similar)));
}

/** Size histogram on a log axis: counts of masks per bin between the smallest and largest mask. */
export function sizeHistogram(masks: DraftMask[], bins = 14): { edges: number[]; counts: number[] } | null {
  if (masks.length === 0) return null;
  const spans = masks.map((m) => maskSpanM(m.geometry));
  const lo = Math.max(0.05, Math.min(...spans));
  const hi = Math.max(lo * 1.001, Math.max(...spans));
  const edges = Array.from({ length: bins + 1 }, (_, i) => lo * (hi / lo) ** (i / bins));
  const counts = new Array<number>(bins).fill(0);
  for (const s of spans) {
    const i = Math.min(bins - 1, Math.max(0, Math.floor((Math.log(Math.max(s, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * bins)));
    counts[i]++;
  }
  return { edges, counts };
}

/** Review order: the least confident first (unusual masks are flagged, so they lead). */
export function reviewQueue(masks: DraftMask[], filter: 'unusual' | 'unlabelled'): DraftMask[] {
  return masks
    // References are real objects that need a class too, so only the "unusual" list (a grouping judgement) skips them.
    .filter((m) => (filter === 'unusual' ? m.source !== 'manual' && m.flags.length > 0 : !m.classId))
    .sort((a, b) => b.flags.length - a.flags.length || a.score - b.score);
}
