import type { GeoJSONGeometry } from '@/types/geo';

export type Stage = 'propose' | 'group' | 'clean';

export const STAGES: { id: Stage; label: string; key: string }[] = [
  { id: 'propose', label: 'Propose', key: '1' },
  { id: 'group', label: 'Group', key: '2' },
  { id: 'clean', label: 'Clean', key: '3' },
];

/** One proposed object. Geometry is a GeoJSON Polygon in EPSG:4326 (vectors, never raster). */
export interface DraftMask {
  id: string;
  /** Tile scale (m) the mask was proposed at. */
  scale_m: number;
  geometry: GeoJSONGeometry;
  /** Model-predicted mask quality, 0–1. */
  score: number;
  /** Stability of the mask under threshold changes, 0–1. */
  stability: number;
  source: 'auto' | 'manual' | 'refined' | 'existing';
  /** Set when the mask is an annotation already stored in the target set. */
  annotationId?: string;
  /** What the stored annotation looked like on load, to tell edited from untouched. */
  base?: { classId: string; geomKey: string };
  clusterId: string | null;
  /** Annotation class assigned (schema class id), null while unlabelled. */
  classId: string | null;
  deleted: boolean;
  /** Reasons the Clean stage flagged this mask (empty = not flagged). */
  flags: string[];
}

export type RunStatus = 'idle' | 'running' | 'done' | 'cancelled' | 'error';

export interface RunState {
  status: RunStatus;
  /** Scale (m) currently being processed. */
  scale: number | null;
  doneScales: number;
  totalScales: number;
  /** Tiles processed / total across all scales (from the backend job). */
  tilesDone: number;
  tilesTotal: number;
  jobId: string | null;
  error?: string;
}

/** Which slice of the draft the map is currently emphasising. */
export type MapFilter = 'all' | 'labelled' | 'unlabelled' | 'flagged';

/** An object the user outlined with the one-point SAM 3 picker; its size sets the scales and, later, what "similar" means. */
export interface ReferenceObject {
  id: string;
  /** The DraftMask that represents this reference in the draft. */
  maskId: string;
  geometry: GeoJSONGeometry;
  spanM: number;
  /** Scale (m) at which this object reads best (~30% of the tile). */
  homeScale: number;
}

export interface PendingPick {
  geometry: GeoJSONGeometry;
  spanM: number;
  areaM2: number;
  /** SAM 3's own confidence in the mask, when reported. */
  score: number | null;
}

/** A click on the object being outlined: label 1 includes the spot, 0 excludes it. */
export interface PickPoint {
  lat: number;
  lng: number;
  label: 0 | 1;
}

export interface PickState {
  active: boolean;
  /** A SAM 3 request is in flight. */
  busy: boolean;
  /** What a plain click does: include (1) or exclude (0). Shift-click / right-click always exclude. */
  mode: 0 | 1;
  /** All clicks for the object in progress; each new click re-asks SAM 3 with the whole set. */
  points: PickPoint[];
  /** Imagery window SAM sees — fixed at the first click so refinement clicks reuse the cached embedding. */
  window: [number, number, number, number] | null;
  pending: PendingPick | null;
  /** Inline message, e.g. "Click inside the AOI". */
  hint: string | null;
}

/** The imagery item the picker segments (a dataset item of the AOI). */
export interface ImageryRef {
  datasetId: string;
  stacItemId: string;
  name: string;
}

export type GroupMode = 'mask' | 'box';

export interface GroupCluster {
  /** Index from the server, 0 = the largest group. */
  index: number;
  /** Letter shown with the colour (A, B, C…). */
  name: string;
  color: string;
}

export interface GroupState {
  status: 'idle' | 'embedding' | 'ready' | 'error';
  mode: GroupMode;
  /** Backend embedding job; its stored embeddings back every cluster / similarity request. */
  jobId: string | null;
  done: number;
  total: number;
  error?: string;
  /** How many groups the slider asks for. */
  k: number;
  clusters: GroupCluster[];
}

/** A class the user can label groups with (from the chosen annotation schema). */
export interface LabelClass {
  id: string;
  name: string;
  color: string;
  /** Schema the class belongs to; a saved set uses exactly one schema. */
  schemaId: string;
}

/** "Find look-alikes" result: similarity of every embedded mask to the query masks. */
export interface SimilarState {
  active: boolean;
  busy: boolean;
  scores: Record<string, number>;
  threshold: number;
  queryIds: string[];
}

/** "Clean an existing set" mode: the annotation set the draft edits in place. */
export interface CleanTarget {
  setId: string;
  name: string;
  /** Map layer showing the set; hidden while the draft stands in for it. */
  layerId: string;
  status: 'loading' | 'ready' | 'error';
  schemaId: string | null;
  datasetId: string | null;
  /** Class that masks added while cleaning get automatically: the schema's only class, or the one most of the set's annotations have. */
  defaultClassId?: string | null;
  /** Annotations of the set inside the AOI when loaded. */
  count: number;
  error?: string;
}

/** Stable key for a polygon, to tell whether a stored mask was edited. */
export const geomKey = (g: unknown): string => JSON.stringify(g);
