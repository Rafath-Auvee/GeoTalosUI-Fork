import { create } from 'zustand';

/**
 * Annotation sets the user picked for each AOI (by AOI layer id). Picking mounts the set on the
 * map; the AOI panel shows the picks as cards and Interactive mode offers them for cleaning.
 * Session-only: a reload starts with no picks, the sets themselves are untouched.
 */
interface AoiVectorPicksState {
  picks: Record<string, string[]>;
  add: (aoiLayerId: string, setId: string) => void;
  remove: (aoiLayerId: string, setId: string) => void;
}

export const useAoiVectorPicks = create<AoiVectorPicksState>((set) => ({
  picks: {},
  add: (aoiLayerId, setId) =>
    set((s) => {
      const cur = s.picks[aoiLayerId] ?? [];
      return cur.includes(setId) ? s : { picks: { ...s.picks, [aoiLayerId]: [...cur, setId] } };
    }),
  remove: (aoiLayerId, setId) =>
    set((s) => ({ picks: { ...s.picks, [aoiLayerId]: (s.picks[aoiLayerId] ?? []).filter((id) => id !== setId) } })),
}));

const NONE: string[] = [];
export const selectAoiPicks = (aoiLayerId: string | null) => (s: AoiVectorPicksState) => (aoiLayerId ? s.picks[aoiLayerId] ?? NONE : NONE);
