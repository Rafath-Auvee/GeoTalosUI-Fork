'use client';

/**
 * Interactive annotation draft — the single source of truth while the mode is
 * active. Nothing here is sent to the backend; `commit` (a later slice) is the
 * only path out. The draft autosaves to IndexedDB so a reload can restore it.
 */
import { create } from 'zustand';
import type { GeoJSONGeometry } from '@/types/geo';
import type {
  CleanTarget, DraftMask, GroupMode, GroupState, ImageryRef, LabelClass, MapFilter, PendingPick, PickState, ReferenceObject, RunState, SimilarState, Stage,
} from './types';
import type { Bbox } from './geo';
import { bboxHectares, bboxSizeM, inBbox, metersToDegrees, nearestInLog } from './geo';
import {
  AUTOSAVE_DEBOUNCE_MS, DEFAULT_GROUPS, DEFAULT_STRICTNESS, GROUP_COLORS, MAX_AOI_HECTARES, MAX_GROUP_MASKS, MAX_MASKS,
  OUTLIER_Z, POINTS_PER_SIDE, SCALE_LADDER_M, TARGET_OBJECT_FRAC,
} from './config';
import { deleteDraft, draftKey, loadDraft, saveDraft, type PersistedDraft } from './persistence';
import { EMPTY_SELECTION, selectMasks, type Selection } from './selection';
import { annotationSchemasApi } from '@/lib/api/annotation-schemas';
import { geomKey } from './types';
import * as turf from '@turf/turf';
import { duplicateIds, fragmentsInside } from './duplicates';
import { sam3MaskRefineApi, sam3CommitApi, sam3GroupApi, sam3PointApi, sam3SegmentApi, type Sam3SegmentAllMasks } from '@/lib/api/sam3';

export interface Restorable {
  count: number;
  savedAt: number;
}

interface InteractiveState {
  active: boolean;
  mapId: string;
  aoiLayerId: string | null;
  aoiName: string;
  aoiBbox: Bbox | null;
  aoiGeometry: GeoJSONGeometry | null;
  /** Imagery the picker segments; null until a dataset item is chosen in the AOI panel. */
  imagery: ImageryRef | null;
  /** Datasets selected on the AOI — the choices for `imagery`. */
  imageryDatasets: { id: string; name: string }[];

  stage: Stage;
  scales: number[];
  strictness: number;
  /** Per-scale map visibility, keyed by scale (m) as a string. */
  scaleHidden: Record<string, boolean>;
  mapFilter: MapFilter;

  masks: DraftMask[];
  run: RunState;

  references: ReferenceObject[];
  /** When true the scales follow the reference objects; editing a scale chip turns it off. */
  scalesAuto: boolean;
  pick: PickState;

  group: GroupState;
  similar: SimilarState;
  /** Combinable filters (size range, look groups, look-alikes); the masks matching all of them are "selected". */
  selection: Selection;
  /** Snapshots of the masks before each destructive edit, for Undo. */
  history: DraftMask[][];
  /** Schema the groups are labelled from, and the classes seen so far (for display). */
  labelSchemaId: string | null;
  /** The class that "Label" applies — chosen once, then applied to any selection. */
  labelClassId: string | null;
  classes: Record<string, LabelClass>;
  /** Clean stage: which masks the one-by-one review walks through, and where it is. */
  review: { filter: 'unusual' | 'unlabelled'; index: number };

  /** Show the masks as outlines or as their bounding boxes. */
  geomView: 'mask' | 'box';
  save: { open: boolean; status: 'idle' | 'saving' | 'error'; error?: string };
  /** null = annotate new objects (saves a new set); set = clean this existing set in place. */
  target: CleanTarget | null;
  /** Existing masks scored against the user's sample objects, and the SAM second-opinion run on the flagged ones. */
  suspect: SuspectState;

  exitPrompt: boolean;
  restorable: Restorable | null;
  lastSavedAt: number | null;

  enter: (p: { mapId?: string; aoiLayerId: string; aoiName?: string; bbox: Bbox; geometry?: GeoJSONGeometry; imagery?: ImageryRef | null; datasets?: { id: string; name: string }[] }) => void;
  requestExit: () => void;
  cancelExit: () => void;
  exit: (opts?: { discard?: boolean }) => void;

  setStage: (s: Stage) => void;
  setGeomView: (v: 'mask' | 'box') => void;
  openSave: (open: boolean) => void;
  /** Write the labelled masks to the project as a verified set. Resolves with the new set ids, or null on failure (see `save.error`). */
  saveDraftToProject: (opts: { name: string; aoiId: string }) => Promise<{ setId: string; count: number; diff?: DraftDiff } | null>;
  /** Choose what the session edits: null for new annotations, or a loaded set to clean. Replaces the draft. */
  /** Embed the draft, score existing masks against the reference objects and flag the ones that look unlike them. */
  findSuspects: () => Promise<void>;
  setSuspectThreshold: (v: number) => void;
  /** Run SAM 3 from 1–2 points inside each flagged existing mask and union the result in. One Undo reverts the batch. */
  refineSuspects: () => Promise<void>;
  setTarget: (t: { setId: string; name: string; layerId: string; aoiId?: string } | null) => Promise<void>;
  toggleScale: (m: number) => void;
  addScale: (m: number) => void;
  setStrictness: (v: number) => void;
  toggleScaleVisible: (m: number) => void;
  setMapFilter: (f: MapFilter) => void;

  setImagery: (i: ImageryRef | null) => void;
  setPickMode: (m: 0 | 1) => void;
  startPick: () => void;
  cancelPick: () => void;
  discardPending: () => void;
  pickClick: (p: { lat: number; lng: number; label: 0 | 1; viewSpanM: number }) => Promise<void>;
  undoPoint: () => Promise<void>;
  resetPick: () => void;
  acceptPending: () => void;
  removeReference: (id: string) => void;
  setScalesAuto: (on: boolean) => void;

  setGroupMode: (m: GroupMode) => void;
  runGrouping: () => void;
  setGroupK: (k: number) => void;
  toggleLookGroup: (index: number) => void;
  pickMask: (id: string, additive: boolean) => void;
  setLabelClass: (id: string | null, cls?: LabelClass | null) => void;
  setReviewFilter: (f: 'unusual' | 'unlabelled') => void;
  setReviewIndex: (i: number) => void;
  keepMask: (id: string) => void;
  deleteMask: (id: string) => void;
  setSizeRange: (range: [number, number] | null) => void;
  clearSelection: () => void;
  splitSelectionByLook: (n: number) => Promise<void>;
  undo: () => void;
  setLabelSchema: (id: string | null) => void;
  assignToSelection: (cls: LabelClass | null) => void;
  /** Label every in-play mask that has no class yet. */
  assignToSelectionOrUnlabelled: (cls: LabelClass | null) => void;
  deleteSelection: () => void;
  /** Delete every visible mask that is not selected (references are always kept). */
  keepOnlySelection: () => void;
  findSimilar: (queryIds: string[]) => Promise<void>;
  setSimilarThreshold: (v: number) => void;
  clearSimilar: () => void;

  startRun: () => void;
  cancelRun: () => void;
  clearMasks: () => void;

  restoreDraft: () => Promise<void>;
  discardRestorable: () => void;
}

/** Scale (m) at which an object of this size reads best: ~30% of the tile edge. */
export const homeScaleFor = (spanM: number) => nearestInLog(spanM / TARGET_OBJECT_FRAC, SCALE_LADDER_M);

/** Scales spanning the reference objects: every ladder rung from the smallest to the largest object's home scale. */
export function deriveScales(spans: number[]): number[] {
  if (spans.length === 0) return [];
  const homes = spans.map(homeScaleFor);
  const lo = Math.min(...homes);
  const hi = Math.max(...homes);
  return SCALE_LADDER_M.filter((m) => m >= lo && m <= hi).slice(0, 5);
}

const IDLE_PICK: PickState = { active: false, busy: false, mode: 1, points: [], window: null, pending: null, hint: null };
let pickSeq = 0;

/** Message from a failed API call: the backend's `detail` when it sent one. */
async function apiMessage(e: unknown, fallback: string): Promise<string> {
  const res = (e as { response?: Response } | null)?.response;
  if (res) {
    try {
      const body = (await res.clone().json()) as { detail?: unknown };
      if (typeof body.detail === 'string') return body.detail;
    } catch { /* not JSON */ }
  }
  return fallback;
}

/** Square window of `sideM` metres centred on a point, as [west, south, east, north]. */
function windowAround(lat: number, lng: number, sideM: number): [number, number, number, number] {
  const [dLon, dLat] = metersToDegrees(sideM / 2, lat);
  return [lng - dLon, lat - dLat, lng + dLon, lat + dLat];
}
const IDLE_RUN: RunState = { status: 'idle', scale: null, doneScales: 0, totalScales: 0, tilesDone: 0, tilesTotal: 0, jobId: null };
let runToken = 0;

/** Masks a fresh run must not wipe: the user's references and annotations loaded from the target set. */
const survivesRun = (m: DraftMask) => m.source === 'manual' || m.source === 'existing';
let targetToken = 0;

/**
 * Is a positive click starting a different object from the outline being built? Inside the outline, or
 * just outside it (within a fifth of the object's width), it is a refinement; further away it is a new object.
 */
/** How far outside the outline a click must be, as a share of the object's width, to start a new object. */
const NEW_OBJECT_DISTANCE = 0.2;

function startsNewObject(pending: PendingPick, lat: number, lng: number): boolean {
  try {
    const pt = turf.point([lng, lat]);
    const poly = turf.feature(pending.geometry as never);
    if (turf.booleanPointInPolygon(pt, poly as never)) return false;
    const edge = turf.polygonToLine(poly as never);
    const dM = turf.pointToLineDistance(pt, edge as never, { units: 'meters' });
    return dM > Math.max(NEW_OBJECT_DISTANCE * pending.spanM, 0.1);
  } catch {
    return false;
  }
}
let suspectToken = 0;

/**
 * The class a set implies for anything added to it: its only class, else the class most of its own
 * annotations have. Null only when the set is empty and its schema offers several classes.
 */
function impliedClass(existing: DraftMask[], schemaClassIds: string[]): string | null {
  if (schemaClassIds.length === 1) return schemaClassIds[0];
  const counts = new Map<string, number>();
  for (const m of existing) if (m.source === 'existing' && m.classId) counts.set(m.classId, (counts.get(m.classId) ?? 0) + 1);
  let best: string | null = null;
  let n = 0;
  for (const [id, c] of counts) if (c > n) { best = id; n = c; }
  return best;
}

export interface SuspectState {
  status: 'idle' | 'scoring' | 'ready' | 'error';
  error?: string;
  /** Similarity to the reference objects per mask id (1 = identical look). */
  scores: Record<string, number>;
  /** Existing masks scoring below this are flagged. */
  threshold: number;
  refine: { status: 'idle' | 'running' | 'done' | 'error'; done: number; total: number; changed: number; unchanged: number; /** Other masks removed because the new, whole mask now covers them. */ absorbed?: number; error?: string; /** Why masks were left as they were: reason -> count. */ reasons?: Record<string, number> };
}
export const IDLE_SUSPECT: SuspectState = {
  status: 'idle', scores: {}, threshold: 0.6, refine: { status: 'idle', done: 0, total: 0, changed: 0, unchanged: 0 },
};

/** Flag existing masks under the threshold (and clear the flag on the rest). */
function applySuspectFlags(masks: DraftMask[], scores: Record<string, number>, threshold: number): DraftMask[] {
  return masks.map((m) => {
    if (m.source !== 'existing') return m;
    const sc = scores[m.id];
    const bad = sc !== undefined && sc < threshold;
    const has = m.flags.includes('suspect');
    if (bad === has) return m;
    return { ...m, flags: bad ? [...m.flags, 'suspect'] : m.flags.filter((f) => f !== 'suspect') };
  });
}

/** Wait for the grouping job to settle (it is started elsewhere and reports through the store). */
async function waitForGroup(token: number): Promise<boolean> {
  for (;;) {
    const g = useInteractiveStore.getState().group;
    if (g.status === 'ready') return true;
    if (g.status === 'error') return false;
    if (token !== suspectToken) return false;
    await new Promise((r) => setTimeout(r, 600));
  }
}

export interface DraftDiff {
  added: DraftMask[];
  /** New masks that repeat an existing annotation; left out of the save. */
  duplicates: DraftMask[];
  /** New masks with no class (a set with several classes and no obvious one); left out of the save. */
  unclassed: DraftMask[];
  /** Stored annotations the user relabelled or reshaped. */
  updated: DraftMask[];
  /** Ids of stored annotations the user removed. */
  deletedIds: string[];
}

/** What saving would change in the target set: only masks the user touched count. */
export function diffDraft(masks: DraftMask[], strictness: number, scaleHidden: Record<string, boolean>): DraftDiff {
  const inPlay = visibleMasks(masks, strictness, scaleHidden);
  const dup = duplicateIds(masks);
  return {
    added: inPlay.filter((m) => !m.annotationId && !dup.has(m.id) && !!m.classId),
    duplicates: inPlay.filter((m) => dup.has(m.id)),
    unclassed: inPlay.filter((m) => !m.annotationId && !dup.has(m.id) && !m.classId),
    updated: inPlay.filter((m) => m.annotationId && m.base && (m.classId !== m.base.classId || geomKey(m.geometry) !== m.base.geomKey)),
    deletedIds: masks.filter((m) => m.annotationId && m.deleted).map((m) => m.annotationId as string),
  };
}
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** Minimum predicted quality a mask needs to be shown at a given strictness (0–1). */
export const qualityThreshold = (strictness: number) => 0.5 + strictness * 0.42;

/** Ask SAM 3 for the object's mask given all clicks so far; a stale or failed answer never clobbers newer state. */
async function requestMask(
  points: PickPointList,
  window: [number, number, number, number],
  fallbackPoints: PickPointList,
) {
  const seq = ++pickSeq;
  const { imagery } = useInteractiveStore.getState();
  if (!imagery) return;
  try {
    const res = await sam3PointApi.pointMask({
      dataset_id: imagery.datasetId,
      stac_item_id: imagery.stacItemId,
      window_bbox: window,
      points: points.map((p) => ({ lat: p.lat, lng: p.lng, label: p.label })),
    });
    if (seq !== pickSeq) return;
    useInteractiveStore.setState((s) => ({
      pick: {
        ...s.pick, busy: false, hint: null,
        pending: { geometry: res.geometry as unknown as GeoJSONGeometry, spanM: res.span_m, areaM2: res.area_m2, score: res.score },
      },
    }));
  } catch (e) {
    if (seq !== pickSeq) return;
    const hint = await apiMessage(e, 'SAM 3 could not outline that. Try another click.');
    // The last click didn't produce a mask: drop it so the user can click again.
    useInteractiveStore.setState((s) => ({
      pick: { ...s.pick, busy: false, hint, points: fallbackPoints, window: fallbackPoints.length ? s.pick.window : null },
    }));
  }
}
type PickPointList = import('./types').PickPoint[];

const IDLE_GROUP: GroupState = { status: 'idle', mode: 'mask', jobId: null, done: 0, total: 0, k: DEFAULT_GROUPS, clusters: [] };
const IDLE_SIMILAR: SimilarState = { active: false, busy: false, scores: {}, threshold: 0.8, queryIds: [] };
let groupToken = 0;
let reclusterTimer: ReturnType<typeof setTimeout> | null = null;

const letter = (i: number) => (i < 26 ? String.fromCharCode(65 + i) : `${String.fromCharCode(65 + (i % 26))}${Math.floor(i / 26)}`);

/** Ask the server to cut the embeddings into k groups and write the result onto the masks. */
async function applyClusters(jobId: string, k: number, token: number): Promise<void> {
  const res = await sam3GroupApi.clusters(jobId, k);
  if (token !== groupToken) return;
  useInteractiveStore.setState((s) => ({
    masks: s.masks.map((m) => {
      const lab = res.labels[m.id];
      if (lab === undefined) return m;
      const outlier = (res.outlier_z[m.id] ?? 0) > OUTLIER_Z;
      const flags = outlier ? (m.flags.includes('outlier') ? m.flags : [...m.flags, 'outlier']) : m.flags.filter((f) => f !== 'outlier');
      return { ...m, clusterId: String(lab), flags };
    }),
    group: {
      ...s.group,
      k,
      status: 'ready',
      clusters: res.sizes.map((_, i) => ({ index: i, name: letter(i), color: GROUP_COLORS[i % GROUP_COLORS.length] })),
    },
    // Group numbers changed with the re-cut, so a look-group filter would now mean something else.
    selection: { ...s.selection, lookGroups: [] },
  }));
}

/** Replace the auto-proposed masks with the server's cleaned set (references stay). */
async function loadServerMasks(jobId: string, known?: Sam3SegmentAllMasks): Promise<void> {
  const res = known ?? (await sam3SegmentApi.masks(jobId));
  const auto: DraftMask[] = res.masks.slice(0, MAX_MASKS).map((m, i) => ({
    id: `s-${jobId.slice(0, 8)}-${i}`,
    scale_m: m.scale_m,
    geometry: m.geometry as unknown as GeoJSONGeometry,
    score: m.score,
    stability: m.score,
    source: 'auto',
    clusterId: null,
    classId: null,
    deleted: false,
    flags: [],
  }));
  useInteractiveStore.setState((s) => ({ masks: [...s.masks.filter(survivesRun), ...auto] }));
}

/** Poll the backend job; stream each finished scale's masks onto the map as it lands. */
async function pollRun(jobId: string, token: number): Promise<void> {
  let loadedScales = 0;
  for (;;) {
    await new Promise((r) => setTimeout(r, 1500));
    if (token !== runToken) return;
    const job = await sam3SegmentApi.getJob(jobId);
    if (token !== runToken) return;
    const scalesDone = job.config?.result?.scales_done ?? [];
    useInteractiveStore.setState((cur) => ({
      run: {
        ...cur.run,
        tilesDone: job.processed_items,
        tilesTotal: job.total_items,
        doneScales: scalesDone.length,
        scale: cur.scales[Math.min(scalesDone.length, cur.scales.length - 1)] ?? null,
      },
    }));
    if (scalesDone.length > loadedScales) {
      loadedScales = scalesDone.length;
      await loadServerMasks(jobId);
    }
    if (job.status === 'completed') {
      await loadServerMasks(jobId);
      if (token !== runToken) return;
      useInteractiveStore.setState((cur) => ({ run: { ...cur.run, status: 'done', scale: null, doneScales: cur.run.totalScales } }));
      return;
    }
    if (job.status === 'failed' || job.status === 'cancelled') {
      useInteractiveStore.setState({
        run: { ...IDLE_RUN, status: job.status === 'failed' ? 'error' : 'cancelled', jobId, error: job.logs ?? undefined },
      });
      return;
    }
  }
}

export const useInteractiveStore = create<InteractiveState>()((set, get) => ({
  active: false,
  mapId: 'local',
  aoiLayerId: null,
  aoiName: '',
  aoiBbox: null,
  aoiGeometry: null,
  imagery: null,
  imageryDatasets: [],

  stage: 'propose',
  scales: [10, 20],
  strictness: DEFAULT_STRICTNESS,
  scaleHidden: {},
  mapFilter: 'all',

  masks: [],
  run: IDLE_RUN,

  references: [],
  scalesAuto: true,
  pick: IDLE_PICK,

  group: IDLE_GROUP,
  similar: IDLE_SIMILAR,
  selection: EMPTY_SELECTION,
  history: [],
  labelSchemaId: null,
  labelClassId: null,
  classes: {},
  review: { filter: 'unusual', index: 0 },
  geomView: 'mask',
  save: { open: false, status: 'idle' },
  target: null,
  suspect: IDLE_SUSPECT,

  exitPrompt: false,
  restorable: null,
  lastSavedAt: null,

  enter: ({ mapId, aoiLayerId, aoiName, bbox, geometry, imagery, datasets }) => {
    const key = draftKey(mapId ?? 'local', aoiLayerId);
    set({
      active: true,
      mapId: mapId ?? 'local',
      aoiLayerId,
      aoiName: aoiName ?? 'AOI',
      aoiBbox: bbox,
      aoiGeometry: geometry ?? null,
      imagery: imagery ?? null,
      imageryDatasets: datasets ?? [],
      stage: 'propose',
      masks: [],
      run: IDLE_RUN,
      references: [],
      scalesAuto: true,
      pick: IDLE_PICK,
      group: IDLE_GROUP,
      similar: IDLE_SIMILAR,
      selection: EMPTY_SELECTION,
      history: [],
      labelSchemaId: null,
      labelClassId: null,
      classes: {},
      review: { filter: 'unusual', index: 0 },
      geomView: 'mask',
      save: { open: false, status: 'idle' },
      target: null,
      suspect: IDLE_SUSPECT,
      scaleHidden: {},
      mapFilter: 'all',
      exitPrompt: false,
      restorable: null,
      lastSavedAt: null,
      strictness: DEFAULT_STRICTNESS,
    });
    void loadDraft(key).then((d) => {
      const s = get();
      if (d && d.version === 1 && d.masks.length > 0 && s.active && s.aoiLayerId === aoiLayerId) {
        set({ restorable: { count: d.masks.length, savedAt: d.savedAt } });
      }
    });
  },

  requestExit: () => {
    const { masks } = get();
    if (masks.some((m) => !m.deleted)) set({ exitPrompt: true });
    else get().exit();
  },
  cancelExit: () => set({ exitPrompt: false }),

  exit: (opts) => {
    runToken++;
    groupToken++;
    if (saveTimer) clearTimeout(saveTimer);
    const cur = get();
    const { mapId, aoiLayerId } = cur;
    if (aoiLayerId) {
      if (opts?.discard) void deleteDraft(draftKey(mapId, aoiLayerId));
      else if (cur.masks.length > 0) {
        // Leaving keeps the draft: write it now, don't wait for the debounce.
        void saveDraft(draftKey(mapId, aoiLayerId), {
          version: 1, savedAt: Date.now(), stage: cur.stage, scales: cur.scales, strictness: cur.strictness, masks: cur.masks,
          references: cur.references, scalesAuto: cur.scalesAuto,
          group: { jobId: cur.group.jobId, mode: cur.group.mode, k: cur.group.k }, classes: cur.classes, labelSchemaId: cur.labelSchemaId,
          target: cur.target?.status === 'ready' ? cur.target : null,
        });
      }
    }
    set({
      active: false,
      aoiLayerId: null,
      aoiBbox: null,
      aoiGeometry: null,
      imagery: null,
      imageryDatasets: [],
      masks: [],
      run: IDLE_RUN,
      references: [],
      pick: IDLE_PICK,
      group: IDLE_GROUP,
      similar: IDLE_SIMILAR,
      selection: EMPTY_SELECTION,
      history: [],
      geomView: 'mask',
      save: { open: false, status: 'idle' },
      exitPrompt: false,
      restorable: null,
      target: null,
      suspect: IDLE_SUSPECT,
    });
  },

  // Leaving Propose ends any object picking, so the map isn't left waiting for clicks.
  setStage: (stage) =>
    set((s) => {
      if (stage !== 'propose' && s.pick.active) pickSeq++;
      // The mask Clean is reviewing is only "selected" while reviewing: don't carry it into Group.
      const selection = s.stage === 'clean' && stage !== 'clean' && s.selection.picked.length ? { ...s.selection, picked: [] } : s.selection;
      return stage !== 'propose' && s.pick.active ? { stage, selection, pick: IDLE_PICK } : { stage, selection };
    }),
  setGeomView: (geomView) => set({ geomView }),

  findSuspects: async () => {
    const s0 = get();
    if (!s0.target || s0.target.status !== 'ready') return;
    const refIds = s0.references.map((r) => r.maskId);
    if (refIds.length === 0) { set({ suspect: { ...s0.suspect, status: 'error', error: 'Outline a few good example objects first.' } }); return; }
    const token = ++suspectToken;
    set({ suspect: { ...IDLE_SUSPECT, threshold: s0.suspect.threshold, status: 'scoring' } });
    try {
      // The embeddings are the group job's: reuse them when the masks are already embedded.
      if (get().group.status !== 'ready') {
        get().runGrouping();
        if (!(await waitForGroup(token))) {
          if (token === suspectToken) set((c) => ({ suspect: { ...c.suspect, status: 'error', error: get().group.error ?? 'The masks could not be compared.' } }));
          return;
        }
      }
      const jobId = get().group.jobId;
      if (!jobId) return;
      const res = await sam3GroupApi.similar(jobId, refIds);
      if (token !== suspectToken) return;
      set((c) => ({
        suspect: { ...c.suspect, status: 'ready', scores: res.similarity },
        masks: applySuspectFlags(c.masks, res.similarity, c.suspect.threshold),
      }));
    } catch (e) {
      if (token === suspectToken) set((c) => ({ suspect: { ...c.suspect, status: 'error', error: 'The masks could not be compared. Try again.' } }));
      void e;
    }
  },

  setSuspectThreshold: (threshold) =>
    set((s) => ({ suspect: { ...s.suspect, threshold }, masks: applySuspectFlags(s.masks, s.suspect.scores, threshold) })),

  refineSuspects: async () => {
    const s0 = get();
    if (!s0.imagery || s0.suspect.refine.status === 'running') return;
    const flagged = visibleMasks(s0.masks, s0.strictness, s0.scaleHidden).filter((m) => m.source === 'existing' && m.flags.includes('suspect'));
    if (flagged.length === 0) return;
    const CHUNK = 40;
    const updates = new Map<string, GeoJSONGeometry>();
    let changed = 0; let unchanged = 0; let done = 0;
    const reasons: Record<string, number> = {};
    let absorbedCount = 0;
    const progress = (status: SuspectState['refine']['status'], error?: string) =>
      set((c) => ({ suspect: { ...c.suspect, refine: { status, done, total: flagged.length, changed, unchanged, absorbed: absorbedCount, error, reasons: { ...reasons } } } }));
    progress('running');
    try {
      for (let i = 0; i < flagged.length; i += CHUNK) {
        const part = flagged.slice(i, i + CHUNK);
        const res = await sam3MaskRefineApi.refine({
          dataset_id: s0.imagery.datasetId, stac_item_id: s0.imagery.stacItemId,
          masks: part.map((m) => ({ id: m.id, geometry: m.geometry })),
        });
        for (const r of res.results) {
          if (r.changed && r.geometry) { updates.set(r.id, r.geometry as GeoJSONGeometry); changed++; } else { unchanged++; const why = r.reason ?? 'no change'; reasons[why] = (reasons[why] ?? 0) + 1; }
        }
        done += part.length;
        progress('running');
      }
      progress('done');
    } catch (e) {
      progress('error', await apiMessage(e, 'SAM 3 could not finish. The masks refined so far were kept.'));
    }
    if (updates.size > 0) {
      // A model often splits one object into pieces. Once SAM has given the whole object to one piece, the
      // other pieces are redundant: drop every other mask that now lies mostly inside a replaced one.
      const cur = get();
      const live = cur.masks.filter((m) => !m.deleted && m.source !== 'manual');
      const gone = new Set<string>();
      for (const [id, geom] of updates) {
        if (gone.has(id)) continue;
        const others = live
          .filter((m) => m.id !== id && !gone.has(m.id))
          .map((m) => ({ id: m.id, geometry: updates.get(m.id) ?? m.geometry }));
        for (const f of fragmentsInside(geom, others)) gone.add(f);
      }
      absorbedCount = gone.size;
      // One snapshot for the whole batch, so a single Undo reverts it.
      set((c) => ({
        history: [...c.history, c.masks].slice(-20),
        masks: c.masks.map((m) => {
          if (gone.has(m.id)) return { ...m, deleted: true };
          return updates.has(m.id) ? { ...m, geometry: updates.get(m.id) as GeoJSONGeometry } : m;
        }),
      }));
      progress(get().suspect.refine.status);
    }
  },

  setTarget: async (t) => {
    const token = ++targetToken;
    const s0 = get();
    runToken++;
    groupToken++;
    const fresh = {
      masks: [] as DraftMask[], run: IDLE_RUN, references: [], pick: IDLE_PICK, group: IDLE_GROUP, similar: IDLE_SIMILAR,
      selection: EMPTY_SELECTION, history: [] as DraftMask[][], scaleHidden: {}, stage: 'propose' as Stage,
      labelSchemaId: null, labelClassId: null, classes: {} as Record<string, LabelClass>, restorable: null,
      save: { open: false, status: 'idle' as const },
    };
    if (!t) { set({ ...fresh, target: null, suspect: IDLE_SUSPECT }); return; }
    set({ ...fresh, suspect: IDLE_SUSPECT, target: { setId: t.setId, name: t.name, layerId: t.layerId, status: 'loading', schemaId: null, datasetId: null, count: 0 } });
    const aoiId = t.aoiId;
    const failed = (error: string) => {
      if (token === targetToken) set((c) => (c.target ? { target: { ...c.target, status: 'error', error } } : {}));
    };
    if (!aoiId || s0.mapId === 'local') return failed('This AOI hasn\'t been saved to the project yet. Open the AOI panel once and try again.');
    try {
      const res = await sam3CommitApi.existingInAoi(t.setId, s0.mapId, aoiId);
      const classes = res.schema_id ? await annotationSchemasApi.getClasses(res.schema_id) : { items: [] };
      if (token !== targetToken) return;
      const classMap: Record<string, LabelClass> = Object.fromEntries(
        classes.items.map((c) => [c.id, { id: c.id, name: c.name, color: c.style?.definition?.fillColor ?? '#c9a13a', schemaId: c.schema_id }]),
      );
      const masks: DraftMask[] = res.annotations.map((a) => ({
        id: `e-${a.id}`, annotationId: a.id, scale_m: 0, geometry: a.geometry as GeoJSONGeometry,
        score: 1, stability: 1, source: 'existing', clusterId: null, classId: a.class_id, deleted: false, flags: [],
        base: { classId: a.class_id, geomKey: geomKey(a.geometry) },
      }));
      // Masks added while cleaning belong to the same class as the set when there is no real choice.
      const defaultClassId = impliedClass(masks, classes.items.map((c) => c.id));
      set((c) => ({
        masks,
        classes: classMap,
        labelSchemaId: res.schema_id,
        labelClassId: defaultClassId,
        target: c.target ? { ...c.target, status: 'ready', schemaId: res.schema_id, datasetId: res.dataset_id, count: masks.length, defaultClassId } : null,
      }));
    } catch (e) {
      failed(await apiMessage(e, 'The set could not be loaded.'));
    }
  },

  saveDraftToProject: async ({ name, aoiId }) => {
    const s = get();
    const fail = (error: string) => { set((cur) => ({ save: { ...cur.save, status: 'error', error } })); return null; };
    if (!s.imagery) return fail('There is no imagery to attach the annotations to.');
    if (s.mapId === 'local') return fail('The map isn\'t available, so nothing can be saved.');
    const toSave = visibleMasks(s.masks, s.strictness, s.scaleHidden);
    if (!s.target && toSave.some((m) => !m.classId)) return fail('Some masks have no class yet. Label or delete them first.');
    if (s.target) {
      if (s.target.status !== 'ready') return fail('The set is still loading.');
      const d = diffDraft(s.masks, s.strictness, s.scaleHidden);
      if (!d.added.length && !d.updated.length && !d.deletedIds.length) return fail('Nothing has changed in this set yet.');
      if (toSave.some((m) => !!m.classId && !d.duplicates.includes(m) && s.classes[m.classId as string]?.schemaId !== s.target?.schemaId)) return fail('Some masks use a class from another schema. Use this set\'s classes.');
    } else if (toSave.length === 0) return fail('There is nothing to save.');
    const schemas = new Set<string | undefined>(toSave.map((m) => s.classes[m.classId as string]?.schemaId));
    if (!s.target && (schemas.size !== 1 || schemas.has(undefined))) return fail('The masks are labelled with classes from more than one schema. A saved set uses one schema.');
    set((cur) => ({ save: { ...cur.save, status: 'saving', error: undefined } }));
    if (s.target) {
      try {
        const diff = diffDraft(s.masks, s.strictness, s.scaleHidden);
        const res = await sam3CommitApi.apply(s.target.setId, {
          map_id: s.mapId,
          aoi_id: aoiId,
          dataset_id: s.imagery.datasetId,
          stac_item_id: s.imagery.stacItemId,
          add: diff.added.map((m) => ({ geometry: m.geometry, class_id: m.classId as string, score: m.score, scale_m: m.scale_m || null })),
          update: diff.updated.map((m) => ({
            id: m.annotationId as string,
            ...(m.classId !== m.base?.classId ? { class_id: m.classId as string } : {}),
            ...(geomKey(m.geometry) !== m.base?.geomKey ? { geometry: m.geometry } : {}),
          })),
          delete_ids: diff.deletedIds,
        });
        return { setId: res.annotation_set_id, count: res.added + res.updated + res.deleted, diff };
      } catch (e) {
        return fail(await apiMessage(e, 'The changes could not be saved. Your draft is untouched; try again.'));
      }
    }
    try {
      const res = await sam3CommitApi.commit({
        map_id: s.mapId,
        aoi_id: aoiId,
        schema_id: [...schemas][0] as string,
        dataset_id: s.imagery.datasetId,
        stac_item_id: s.imagery.stacItemId,
        name,
        masks: toSave.map((m) => ({ geometry: m.geometry, class_id: m.classId as string, score: m.score, scale_m: m.scale_m })),
      });
      return { setId: res.annotation_set_id, count: res.annotation_count };
    } catch (e) {
      return fail(await apiMessage(e, 'The annotations could not be saved. Your draft is untouched; try again.'));
    }
  },
  openSave: (open) => set((s) => ({ save: { ...s.save, open, status: open ? s.save.status : 'idle', error: undefined } })),
  toggleScale: (m) =>
    set((s) => ({
      scales: s.scales.includes(m) ? s.scales.filter((v) => v !== m) : [...s.scales, m].sort((a, b) => a - b),
      scalesAuto: s.references.length > 0 ? false : s.scalesAuto,
    })),
  addScale: (m) =>
    set((s) => ({
      scales: s.scales.includes(m) ? s.scales : [...s.scales, m].sort((a, b) => a - b),
      scalesAuto: s.references.length > 0 ? false : s.scalesAuto,
    })),
  setScalesAuto: (on) =>
    set((s) => ({
      scalesAuto: on,
      scales: on && s.references.length > 0 ? deriveScales(s.references.map((r) => r.spanM)) : s.scales,
    })),

  setImagery: (imagery) => set({ imagery }),
  setPickMode: (mode) => set((s) => ({ pick: { ...s.pick, mode } })),
  startPick: () => set((s) => ({ pick: { ...s.pick, active: true, pending: null, hint: null } })),
  cancelPick: () => {
    pickSeq++;
    set({ pick: IDLE_PICK });
  },
  discardPending: () => {
    pickSeq++;
    set((s) => ({ pick: { ...s.pick, pending: null, points: [], window: null, busy: false, hint: null } }));
  },

  pickClick: async ({ lat, lng, label, viewSpanM }) => {
    const s = get();
    if (!s.pick.active || !s.aoiBbox) return;
    if (!s.imagery) {
      set({ pick: { ...s.pick, hint: 'Choose a dataset in the AOI panel first, so SAM 3 has imagery to read.' } });
      return;
    }
    if (!inBbox(lat, lng, s.aoiBbox)) {
      set({ pick: { ...s.pick, hint: 'Click inside the AOI frame.' } });
      return;
    }
    // A click on a different object than the outline in progress saves that outline and starts the next one,
    // so there is no Accept click between objects.
    if (label === 1 && !s.pick.busy && s.pick.pending && s.pick.points.length > 0 && startsNewObject(s.pick.pending, lat, lng)) {
      get().acceptPending();
      await get().pickClick({ lat, lng, label, viewSpanM });
      return;
    }
    if (label === 0 && s.pick.points.length === 0) {
      set({ pick: { ...s.pick, hint: 'Click the object first (+), then exclude areas with Shift-click or right-click.' } });
      return;
    }
    // What the user sees is the context SAM gets, fixed at the first click so later clicks reuse its
    // image embedding. A click outside that window (after panning or zooming) re-centres it on all
    // the points instead of failing.
    const before = s.pick.points;
    const w0 = s.pick.window;
    let window: [number, number, number, number] = w0 ?? [0, 0, 0, 0]; // replaced below when there is no usable window
    if (!w0 || lng < w0[0] || lng > w0[2] || lat < w0[1] || lat > w0[3]) {
      const all = [...before, { lat, lng }];
      const lats = all.map((p) => p.lat);
      const lngs = all.map((p) => p.lng);
      const south = Math.min(...lats), north = Math.max(...lats), west = Math.min(...lngs), east = Math.max(...lngs);
      const { w: spreadW, h: spreadH } = bboxSizeM([west, south, east, north]);
      const side = Math.max(6, Math.min(Math.max(viewSpanM, Math.max(spreadW, spreadH) * 2.4), 600));
      window = windowAround((south + north) / 2, (west + east) / 2, side);
    }
    const points = [...before, { lat, lng, label }];
    set({ pick: { ...s.pick, points, window, busy: true, hint: null } });
    await requestMask(points, window, before);
  },

  undoPoint: async () => {
    const s = get();
    if (!s.pick.active || s.pick.busy || s.pick.points.length === 0) return;
    const points = s.pick.points.slice(0, -1);
    if (points.length === 0 || !points.some((p) => p.label === 1)) {
      pickSeq++;
      set({ pick: { ...s.pick, points: [], window: null, pending: null, busy: false, hint: null } });
      return;
    }
    set({ pick: { ...s.pick, points, busy: true, hint: null } });
    await requestMask(points, s.pick.window as [number, number, number, number], s.pick.points);
  },

  resetPick: () => {
    pickSeq++;
    set((s) => ({ pick: { ...s.pick, points: [], window: null, pending: null, busy: false, hint: null } }));
  },

  acceptPending: () => {
    const s = get();
    const pending = s.pick.pending;
    if (!pending) return;
    const id = `ref-${Date.now().toString(36)}-${s.references.length}`;
    const homeScale = homeScaleFor(pending.spanM);
    const mask: DraftMask = {
      id: `m-${id}`, scale_m: homeScale, geometry: pending.geometry, score: 1, stability: 1,
      source: 'manual', clusterId: null, classId: null, deleted: false, flags: [],
    };
    const ref: ReferenceObject = { id, maskId: mask.id, geometry: pending.geometry, spanM: pending.spanM, homeScale };
    const references = [...s.references, ref];
    set({
      masks: [...s.masks, mask],
      references,
      scales: s.scalesAuto ? deriveScales(references.map((r) => r.spanM)) : s.scales,
      pick: { ...s.pick, pending: null, points: [], window: null, hint: null }, // stay in pick mode: references are usually several
    });
  },

  removeReference: (id) =>
    set((s) => {
      const ref = s.references.find((r) => r.id === id);
      if (!ref) return {};
      const references = s.references.filter((r) => r.id !== id);
      return {
        references,
        masks: s.masks.filter((m) => m.id !== ref.maskId),
        scales: s.scalesAuto && references.length > 0 ? deriveScales(references.map((r) => r.spanM)) : s.scales,
      };
    }),
  setStrictness: (strictness) => set({ strictness }),
  toggleScaleVisible: (m) => set((s) => ({ scaleHidden: { ...s.scaleHidden, [String(m)]: !s.scaleHidden[String(m)] } })),
  setMapFilter: (mapFilter) => set({ mapFilter }),

  setGroupMode: (mode) => set((s) => ({ group: { ...s.group, mode } })),

  runGrouping: () => {
    const s = get();
    if (!s.imagery || s.group.status === 'embedding') return;
    // Everything currently in play: not deleted, above the quality filter, on a visible scale.
    const inPlay = visibleMasks(s.masks, s.strictness, s.scaleHidden).slice(0, MAX_GROUP_MASKS);
    if (inPlay.length < 2) {
      set({ group: { ...s.group, status: 'error', error: 'Need at least two masks to group.' } });
      return;
    }
    const token = ++groupToken;
    set({ group: { ...s.group, status: 'embedding', done: 0, total: inPlay.length, error: undefined, clusters: [] }, similar: IDLE_SIMILAR, selection: EMPTY_SELECTION });
    void (async () => {
      try {
        const job = await sam3GroupApi.embed({
          dataset_id: s.imagery!.datasetId,
          stac_item_id: s.imagery!.stacItemId,
          masks: inPlay.map((m) => ({ id: m.id, geometry: m.geometry })),
          mode: s.group.mode,
        });
        if (token !== groupToken) return;
        set((cur) => ({ group: { ...cur.group, jobId: job.id } }));
        for (;;) {
          await new Promise((r) => setTimeout(r, 1200));
          if (token !== groupToken) return;
          const j = await sam3SegmentApi.getJob(job.id);
          if (token !== groupToken) return;
          set((cur) => ({ group: { ...cur.group, done: j.processed_items, total: j.total_items || cur.group.total } }));
          if (j.status === 'completed') break;
          if (j.status === 'failed' || j.status === 'cancelled') {
            set((cur) => ({ group: { ...cur.group, status: 'error', error: j.logs ?? 'Grouping failed.' } }));
            return;
          }
        }
        await applyClusters(job.id, get().group.k, token);
      } catch (e) {
        if (token !== groupToken) return;
        const error = await apiMessage(e, 'Could not group the masks. Try again.');
        if (token === groupToken) set((cur) => ({ group: { ...cur.group, status: 'error', error } }));
      }
    })();
  },

  // Dragging the slider re-cuts the stored tree; debounce so only the resting value is requested.
  setGroupK: (k) => {
    const s = get();
    set({ group: { ...s.group, k } });
    if (!s.group.jobId || s.group.status === 'embedding') return;
    if (reclusterTimer) clearTimeout(reclusterTimer);
    const token = groupToken;
    reclusterTimer = setTimeout(() => {
      const jobId = get().group.jobId;
      if (jobId) void applyClusters(jobId, get().group.k, token).catch(() => {});
    }, 350);
  },

  toggleLookGroup: (index) =>
    set((s) => ({
      selection: {
        ...s.selection,
        lookGroups: s.selection.lookGroups.includes(index) ? s.selection.lookGroups.filter((i) => i !== index) : [...s.selection.lookGroups, index],
      },
    })),
  setSizeRange: (sizeRange) => set((s) => ({ selection: { ...s.selection, sizeRange } })),
  clearSelection: () => set({ selection: EMPTY_SELECTION, similar: IDLE_SIMILAR }),

  // Re-group only the selected masks by look: they become new groups, the rest keep theirs.
  splitSelectionByLook: async (n) => {
    const s = get();
    const jobId = s.group.jobId;
    if (!jobId || s.group.status !== 'ready') return;
    const sel = selectMasks(visibleMasks(s.masks, s.strictness, s.scaleHidden), s.selection, s.similar);
    if (sel.length < 2) return;
    try {
      const res = await sam3GroupApi.clusters(jobId, n, sel.map((m) => m.id));
      const cur = get();
      const base = cur.group.clusters.length;
      const added = res.sizes.map((_, i) => ({ index: base + i, name: letter(base + i), color: GROUP_COLORS[(base + i) % GROUP_COLORS.length] }));
      set({
        history: [...cur.history, cur.masks].slice(-20),
        masks: cur.masks.map((m) => (res.labels[m.id] !== undefined ? { ...m, clusterId: String(base + res.labels[m.id]) } : m)),
        group: { ...cur.group, clusters: [...cur.group.clusters, ...added] },
        selection: { ...cur.selection, lookGroups: added.map((c) => c.index) },
        similar: IDLE_SIMILAR,
      });
    } catch { /* the selection is unchanged; the UI keeps showing it */ }
  },

  undo: () =>
    set((s) => (s.history.length ? { masks: s.history[s.history.length - 1], history: s.history.slice(0, -1) } : {})),

  setLabelSchema: (labelSchemaId) => set({ labelSchemaId, labelClassId: null }),
  setLabelClass: (labelClassId, cls) => set((s) => ({ labelClassId, classes: cls ? { ...s.classes, [cls.id]: cls } : s.classes })),
  setReviewFilter: (filter) => set({ review: { filter, index: 0 } }),
  setReviewIndex: (index) => set((s) => ({ review: { ...s.review, index } })),

  // A mask clicked on its own: replaces the picks; additive (Shift) toggles it in or out.
  pickMask: (id, additive) =>
    set((s) => {
      const has = s.selection.picked.includes(id);
      const picked = additive ? (has ? s.selection.picked.filter((p) => p !== id) : [...s.selection.picked, id]) : has && s.selection.picked.length === 1 ? [] : [id];
      return { selection: { ...s.selection, picked } };
    }),

  // "Keep" in review: the user looked and it's fine, so it is no longer flagged unusual. An unlabelled mask
  // is also given the class chosen under "Label with" — and can't be kept until one is chosen.
  keepMask: (id) =>
    set((s) => {
      const m = s.masks.find((x) => x.id === id);
      if (!m) return {};
      const cls = !m.classId && s.labelClassId ? s.classes[s.labelClassId] : undefined;
      if (!m.classId && !cls) return {};
      return {
        history: [...s.history, s.masks].slice(-20),
        masks: s.masks.map((x) => (x.id === id ? { ...x, flags: x.flags.filter((f) => f !== 'outlier'), classId: cls ? cls.id : x.classId } : x)),
      };
    }),
  deleteMask: (id) =>
    set((s) => {
      const target = s.masks.find((m) => m.id === id);
      if (!target || target.source === 'manual') return {};
      return {
        history: [...s.history, s.masks].slice(-20),
        masks: s.masks.map((m) => (m.id === id ? { ...m, deleted: true } : m)),
        selection: { ...s.selection, picked: s.selection.picked.filter((p) => p !== id) },
      };
    }),

  assignToSelection: (cls) =>
    set((s) => {
      const ids = new Set(selectMasks(visibleMasks(s.masks, s.strictness, s.scaleHidden), s.selection, s.similar).map((m) => m.id));
      if (ids.size === 0) return {};
      return {
        history: [...s.history, s.masks].slice(-20),
        masks: s.masks.map((m) => (ids.has(m.id) ? { ...m, classId: cls?.id ?? null } : m)),
        classes: cls ? { ...s.classes, [cls.id]: cls } : s.classes,
      };
    }),

  assignToSelectionOrUnlabelled: (cls) =>
    set((s) => {
      if (!cls) return {};
      const ids = new Set(visibleMasks(s.masks, s.strictness, s.scaleHidden).filter((m) => !m.classId).map((m) => m.id));
      if (ids.size === 0) return {};
      return {
        history: [...s.history, s.masks].slice(-20),
        masks: s.masks.map((m) => (ids.has(m.id) ? { ...m, classId: cls.id } : m)),
        classes: { ...s.classes, [cls.id]: cls },
      };
    }),

  keepOnlySelection: () =>
    set((s) => {
      const visible = visibleMasks(s.masks, s.strictness, s.scaleHidden);
      const keep = new Set(selectMasks(visible, s.selection, s.similar).map((m) => m.id));
      const drop = new Set(visible.filter((m) => !keep.has(m.id) && m.source !== 'manual').map((m) => m.id));
      if (keep.size === 0 || drop.size === 0) return {};
      return {
        history: [...s.history, s.masks].slice(-20),
        masks: s.masks.map((m) => (drop.has(m.id) ? { ...m, deleted: true } : m)),
        selection: EMPTY_SELECTION,
        similar: IDLE_SIMILAR,
      };
    }),

  // Delete never touches the references the user picked by hand.
  deleteSelection: () =>
    set((s) => {
      const ids = new Set(selectMasks(visibleMasks(s.masks, s.strictness, s.scaleHidden), s.selection, s.similar).filter((m) => m.source !== 'manual').map((m) => m.id));
      if (ids.size === 0) return {};
      return {
        history: [...s.history, s.masks].slice(-20),
        masks: s.masks.map((m) => (ids.has(m.id) ? { ...m, deleted: true } : m)),
        selection: EMPTY_SELECTION,
        similar: IDLE_SIMILAR,
      };
    }),

  findSimilar: async (queryIds) => {
    const s = get();
    const jobId = s.group.jobId;
    if (!jobId || s.group.status !== 'ready' || queryIds.length === 0) return;
    set({ similar: { ...s.similar, active: true, busy: true, queryIds } });
    try {
      const res = await sam3GroupApi.similar(jobId, queryIds);
      set((cur) => ({ similar: { ...cur.similar, busy: false, scores: res.similarity } }));
    } catch {
      set({ similar: IDLE_SIMILAR });
    }
  },
  setSimilarThreshold: (threshold) => set((s) => ({ similar: { ...s.similar, threshold } })),
  clearSimilar: () => set({ similar: IDLE_SIMILAR }),

  startRun: () => {
    const s = get();
    if (!s.aoiBbox || !s.aoiLayerId || s.scales.length === 0 || s.run.status === 'running') return;
    if (bboxHectares(s.aoiBbox) > MAX_AOI_HECTARES) return;
    if (!s.imagery) {
      set({ run: { ...IDLE_RUN, status: 'error', error: 'Choose the imagery to segment first.' } });
      return;
    }
    const token = ++runToken;
    // A fresh run replaces the previous proposals; the user's reference objects stay.
    set({
      masks: s.masks.filter(survivesRun),
      run: { ...IDLE_RUN, status: 'running', totalScales: s.scales.length },
      scaleHidden: {},
      pick: IDLE_PICK,
      group: IDLE_GROUP,
      similar: IDLE_SIMILAR,
      selection: EMPTY_SELECTION,
    });
    const geom = s.aoiGeometry as unknown as { type?: string; coordinates?: unknown } | null;
    void (async () => {
      try {
        const job = await sam3SegmentApi.start({
          dataset_id: s.imagery!.datasetId,
          stac_item_id: s.imagery!.stacItemId,
          aoi_bbox: s.aoiBbox as [number, number, number, number],
          aoi_geometry: geom?.type === 'Polygon' ? (geom as { type: string; coordinates: unknown }) : null,
          scales_m: s.scales,
          points_per_side: POINTS_PER_SIDE,
          reference_geometries: s.references.map((r) => r.geometry as unknown as { type: string; coordinates: unknown }),
        });
        if (token !== runToken) return;
        set((cur) => ({ run: { ...cur.run, jobId: job.id, tilesTotal: job.total_items } }));
        await pollRun(job.id, token);
      } catch (e) {
        if (token !== runToken) return;
        set({ run: { ...IDLE_RUN, status: 'error', error: await apiMessage(e, 'Could not start Segment all.') } });
      }
    })();
  },

  cancelRun: () => {
    const jobId = get().run.jobId;
    set((cur) => ({ run: { ...cur.run, status: 'cancelled', scale: null } }));
    if (jobId) {
      // Keep what finished: the worker writes its last result when it sees the cancel.
      void sam3SegmentApi.cancel(jobId).catch(() => {});
      const token = runToken;
      setTimeout(() => { if (token === runToken) void loadServerMasks(jobId); }, 2500);
    }
    runToken++;
  },

  clearMasks: () => set((s) => ({ masks: s.masks.filter(survivesRun), run: IDLE_RUN, scaleHidden: {} })),

  restoreDraft: async () => {
    const { mapId, aoiLayerId } = get();
    if (!aoiLayerId) return;
    const d = await loadDraft(draftKey(mapId, aoiLayerId));
    if (!d || d.version !== 1) return;
    set({
      masks: d.masks,
      scales: d.scales.length ? d.scales : [...SCALE_LADDER_M].slice(1, 3),
      strictness: d.strictness,
      stage: d.stage,
      run: { ...IDLE_RUN, status: 'done', doneScales: d.scales.length, totalScales: d.scales.length },
      references: d.references ?? [],
      scalesAuto: d.scalesAuto ?? true,
      classes: d.classes ?? {},
      labelSchemaId: d.labelSchemaId ?? null,
      target: d.target ?? null,
      group: { ...IDLE_GROUP, mode: d.group?.mode ?? 'mask', k: d.group?.k ?? DEFAULT_GROUPS, jobId: d.group?.jobId ?? null },
      restorable: null,
      lastSavedAt: d.savedAt,
      selection: EMPTY_SELECTION, // a restored draft starts with nothing selected
      similar: IDLE_SIMILAR,
    });
    // The embeddings live on the server: re-cut them so the groups come back with the masks.
    const gj = d.group?.jobId;
    if (gj) void applyClusters(gj, d.group?.k ?? DEFAULT_GROUPS, ++groupToken).catch(() => {});
  },

  discardRestorable: () => {
    const { mapId, aoiLayerId } = get();
    if (aoiLayerId) void deleteDraft(draftKey(mapId, aoiLayerId));
    set({ restorable: null });
  },
}));

// ── Default class while cleaning a set ──────────────────────────────────────
// Anything added to the set (proposals, outlined examples, SAM picks) takes the set's class, so only a
// real choice between classes ever asks the user to label.

/** The class new masks should take (see `impliedClass`). */
function defaultClassFor(s: InteractiveState): string | null {
  const t = s.target;
  if (!t || t.status !== 'ready') return null;
  if (t.defaultClassId) return t.defaultClassId;
  return impliedClass(s.masks, Object.values(s.classes).filter((c) => c.schemaId === t.schemaId).map((c) => c.id));
}

/** Give every unlabelled mask the default class (no-op when there is none). */
export function applyDefaultClass(): void {
  const s = useInteractiveStore.getState();
  const def = defaultClassFor(s);
  if (!def || !s.masks.some((m) => !m.classId && !m.deleted)) return;
  useInteractiveStore.setState({ masks: s.masks.map((m) => (!m.classId && !m.deleted ? { ...m, classId: def } : m)) });
}

useInteractiveStore.subscribe((s, prev) => {
  if (!s.active || !s.target || (s.masks === prev.masks && s.target === prev.target)) return;
  applyDefaultClass();
});

// ── Autosave ────────────────────────────────────────────────────────────────
// Debounced; only while the mode is active and there is something worth keeping.
useInteractiveStore.subscribe((s, prev) => {
  if (!s.active || !s.aoiLayerId) return;
  if (s.masks === prev.masks && s.scales === prev.scales && s.strictness === prev.strictness && s.stage === prev.stage && s.references === prev.references && s.classes === prev.classes && s.target === prev.target) return;
  if (s.run.status === 'running') return; // save once the run settles, not per batch
  if (s.masks.length === 0) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const cur = useInteractiveStore.getState();
    if (!cur.active || !cur.aoiLayerId) return;
    const draft: PersistedDraft = {
      version: 1,
      savedAt: Date.now(),
      stage: cur.stage,
      scales: cur.scales,
      strictness: cur.strictness,
      masks: cur.masks,
      references: cur.references,
      scalesAuto: cur.scalesAuto,
      group: { jobId: cur.group.jobId, mode: cur.group.mode, k: cur.group.k },
      classes: cur.classes,
      labelSchemaId: cur.labelSchemaId,
      target: cur.target?.status === 'ready' ? cur.target : null,
    };
    void saveDraft(draftKey(cur.mapId, cur.aoiLayerId), draft).then(() => {
      useInteractiveStore.setState({ lastSavedAt: draft.savedAt });
    });
  }, AUTOSAVE_DEBOUNCE_MS);
});

// ── Selectors ───────────────────────────────────────────────────────────────

export interface DraftCounts {
  total: number;
  labelled: number;
  unlabelled: number;
  flagged: number;
  /** Mutually exclusive buckets for the completeness bar (flagged wins). */
  barLabelled: number;
  barUnlabelled: number;
  deleted: number;
  /** Masks hidden only by the strictness filter (still in the draft). */
  filteredOut: number;
}

/** Masks currently in play: not deleted, above the strictness threshold. */
export function visibleMasks(masks: DraftMask[], strictness: number, scaleHidden: Record<string, boolean>): DraftMask[] {
  const t = qualityThreshold(strictness);
  return masks.filter((m) => !m.deleted && m.score >= t && !scaleHidden[String(m.scale_m)]);
}

export function countDraft(masks: DraftMask[], strictness: number): DraftCounts {
  const t = qualityThreshold(strictness);
  const c: DraftCounts = { total: 0, labelled: 0, unlabelled: 0, flagged: 0, barLabelled: 0, barUnlabelled: 0, deleted: 0, filteredOut: 0 };
  for (const m of masks) {
    if (m.deleted) { c.deleted++; continue; }
    if (m.score < t) { c.filteredOut++; continue; }
    c.total++;
    if (m.classId) c.labelled++;
    else c.unlabelled++;
    if (m.flags.length > 0) c.flagged++;
    else if (m.classId) c.barLabelled++;
    else c.barUnlabelled++;
  }
  return c;
}
