import { apiClient } from './client';
import { EP } from './endpoints';
import type { InferenceJobStatus } from './inference';

/** POST /sam3/auto-annotate — direct SAM3 box+text auto-annotate over an
 *  AOI (async job). Same "verified collection + class" input as Train Head
 *  builds the reference set (no manual box-drawing) — a reference's own
 *  tile gets its bbox as a SAM3 box exemplar, every other AOI tile is
 *  scanned with SAM3's text-only prompt. No embedding/SAM model pickers
 *  needed — geoops-service loads one fixed SAM3 checkpoint itself. */
export interface Sam3AutoAnnotatePayload {
  annotation_set_collection_id: string;
  class_id: string;
  max_references?: number;
  dataset_item_ids: string[];
  aoi_bbox?: [number, number, number, number] | null;
  crop_size_px?: number;
  overlap_ratio?: number | null;
  conf?: number;
  iou_thresh?: number;
  top_k?: number;
  max_patches?: number;
  output_class_id?: string | null;
}

export interface Sam3AutoAnnotateMatch {
  dataset_item_id: string;
  bbox: [number, number, number, number];
  score: number;
  used_box_exemplar: boolean;
}

export interface Sam3AutoAnnotateResult {
  references_used: number;
  meters_per_pixel: number;
  object_px: number;
  overlap_ratio: number;
  patches_scanned: number;
  patches_truncated: boolean;
  candidates_before_nms: number;
  errors_total: number;
  matches: Sam3AutoAnnotateMatch[];
  annotation_set_id: string | null;
}

/** Matches backend JobRead — POST /sam3/auto-annotate returns 202 + this. */
export interface Sam3AutoAnnotateJobRead {
  id: string;
  organization_id: string;
  type: string;
  status: InferenceJobStatus;
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { request?: Sam3AutoAnnotatePayload; result?: Sam3AutoAnnotateResult } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export const sam3Api = {
  /** POST /sam3/auto-annotate — async job (202 + job). Poll via getJob. */
  autoAnnotate: (data: Sam3AutoAnnotatePayload) =>
    apiClient.post(EP.sam3.autoAnnotate, { json: data }).json<Sam3AutoAnnotateJobRead>(),

  /** GET /jobs/{id} — poll a SAM3 auto-annotate job's progress/result. */
  getJob: (jobId: string) =>
    apiClient.get(EP.jobs.detail(jobId)).json<Sam3AutoAnnotateJobRead>(),
};


/** One click for POST /sam3/point-mask: 1 = part of the object, 0 = not the object. */
export interface Sam3ClickPoint {
  lat: number;
  lng: number;
  label: 0 | 1;
}

export interface Sam3PointMaskPayload {
  dataset_id: string;
  stac_item_id: string;
  /** Imagery window SAM sees, [west, south, east, north]. Keep it fixed across the clicks of one object. */
  window_bbox: [number, number, number, number];
  points: Sam3ClickPoint[];
}

export interface Sam3PointMaskResult {
  geometry: { type: 'Polygon'; coordinates: number[][][] };
  score: number | null;
  span_m: number;
  area_m2: number;
}

export const sam3PointApi = {
  /** SAM 3 interactive head: positive/negative clicks -> ONE object's mask (GeoJSON Polygon). */
  pointMask: (data: Sam3PointMaskPayload) =>
    apiClient.post(EP.sam3.pointMask, { json: data }).json<Sam3PointMaskResult>(),
};


/** POST /sam3/segment-all — propose every object in a small AOI (async job). */
export interface Sam3SegmentAllPayload {
  dataset_id: string;
  stac_item_id: string;
  aoi_bbox: [number, number, number, number];
  aoi_geometry?: { type: string; coordinates: unknown } | null;
  scales_m: number[];
  points_per_side?: number;
  min_score?: number;
  nms_iou?: number;
  /** The user's reference objects: they win any overlap, so auto masks re-finding them are dropped. */
  reference_geometries?: { type: string; coordinates: unknown }[];
}

export interface Sam3SegmentAllJob {
  id: string;
  status: InferenceJobStatus | 'cancelled';
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { result?: { scales_done?: number[]; mask_count?: number } } | null;
}

export interface Sam3SegmentAllMasks {
  job_id: string;
  scales_done: number[];
  masks: { scale_m: number; geometry: { type: 'Polygon'; coordinates: number[][][] }; score: number }[];
}

export const sam3SegmentApi = {
  start: (data: Sam3SegmentAllPayload) =>
    apiClient.post(EP.sam3.segmentAll, { json: data }).json<Sam3SegmentAllJob>(),
  getJob: (jobId: string) => apiClient.get(EP.jobs.detail(jobId)).json<Sam3SegmentAllJob>(),
  masks: (jobId: string) => apiClient.get(EP.sam3.segmentAllMasks(jobId)).json<Sam3SegmentAllMasks>(),
  cancel: (jobId: string) => apiClient.post(EP.sam3.segmentAllCancel(jobId)).json<Sam3SegmentAllJob>(),
};


/** Grouping proposed masks by look: embed (job) -> cluster / similar / thumbnails. */
export interface Sam3ClusterResult {
  job_id: string;
  n_clusters: number;
  sizes: number[];
  labels: Record<string, number>;
  outlier_z: Record<string, number>;
}

export const sam3GroupApi = {
  /** Start embedding the masks (async job). `mode`: "mask" = the object alone, "box" = with surroundings. */
  embed: (data: {
    dataset_id: string;
    stac_item_id: string;
    masks: { id: string; geometry: unknown }[];
    mode: 'mask' | 'box';
  }) => apiClient.post(EP.sam3.maskEmbeddings, { json: data }).json<Sam3SegmentAllJob>(),
  /** Cut the embeddings into groups. Pass `maskIds` to group only those masks (splitting a selection by look). */
  clusters: (jobId: string, nClusters: number, maskIds?: string[]) =>
    apiClient
      .post(EP.sam3.maskClusters(jobId), { json: { n_clusters: nClusters, ...(maskIds ? { mask_ids: maskIds } : {}) } })
      .json<Sam3ClusterResult>(),
  similar: (jobId: string, queryIds: string[]) =>
    apiClient
      .post(EP.sam3.maskSimilar(jobId), { json: { query_ids: queryIds } })
      .json<{ job_id: string; similarity: Record<string, number> }>(),
  crops: (datasetId: string, stacItemId: string, masks: { id: string; geometry: unknown }[]) =>
    apiClient
      .post(EP.sam3.maskCrops, { json: { dataset_id: datasetId, stac_item_id: stacItemId, masks } })
      .json<{ thumbs: Record<string, string> }>(),
  thumbs: (jobId: string, ids: string[]) =>
    apiClient.post(EP.sam3.maskThumbs(jobId), { json: { ids } }).json<{ thumbs: Record<string, string> }>(),
};


/** Save an Interactive annotation draft as a verified annotation set (POST /sam3/interactive-commit). */
export interface Sam3CommitPayload {
  map_id: string;
  aoi_id: string;
  schema_id: string;
  dataset_id: string;
  stac_item_id: string;
  name: string;
  masks: { geometry: unknown; class_id: string; score?: number | null; scale_m?: number | null }[];
}

export interface Sam3CommitResult {
  annotation_set_id: string;
  annotation_count: number;
  class_counts: Record<string, number>;
}

export interface Sam3ExistingResult {
  schema_id: string | null;
  dataset_id: string | null;
  total: number;
  annotations: { id: string; class_id: string; geometry: unknown; confidence: number | null; properties: Record<string, unknown> | null }[];
}

export interface Sam3ApplyPayload {
  map_id: string;
  aoi_id: string;
  dataset_id: string;
  stac_item_id: string;
  add: { geometry: unknown; class_id: string; score?: number | null; scale_m?: number | null }[];
  update: { id: string; class_id?: string; geometry?: unknown }[];
  delete_ids: string[];
}

export interface Sam3ApplyResult {
  annotation_set_id: string;
  added: number;
  updated: number;
  deleted: number;
  review_status: string;
}

export const sam3CommitApi = {
  /** Annotations of an existing set that intersect the AOI. */
  existingInAoi: (setId: string, mapId: string, aoiId: string) =>
    apiClient.get(EP.sam3.existingInAoi(setId), { searchParams: { map_id: mapId, aoi_id: aoiId } }).json<Sam3ExistingResult>(),
  /** Add / update / delete annotations of an existing set in one transaction. */
  apply: (setId: string, data: Sam3ApplyPayload) => apiClient.post(EP.sam3.applyToSet(setId), { json: data }).json<Sam3ApplyResult>(),
  commit: (data: Sam3CommitPayload) => apiClient.post(EP.sam3.interactiveCommit, { json: data }).json<Sam3CommitResult>(),
};


/** POST /sam3/refine-annotation-set — SAM 3 masks for a set of boxes, saved as a new set (async job). */
export interface Sam3RefineJob {
  id: string;
  status: 'pending' | 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';
  progress: number | null;
  processed_items: number;
  total_items: number;
  logs: string | null;
  config: {
    result?: {
      annotation_set_id?: string;
      name?: string;
      masks?: number;
      boxes_total?: number;
      below_score?: number;
      dropped?: Record<string, number>;
      median_mask_score?: number | null;
    };
  } | null;
}

export const sam3RefineApi = {
  start: (data: { annotation_set_id: string; map_id?: string; min_score: number; scale_m?: number; name?: string }) =>
    apiClient.post(EP.sam3.refineSet, { json: data }).json<Sam3RefineJob>(),
  job: (jobId: string) => apiClient.get(EP.jobs.detail(jobId)).json<Sam3RefineJob>(),
};


/** POST /sam3/refine-masks: second opinion on existing masks (SAM 3 from 1–2 points inside each, unioned in). */
export interface Sam3RefineResult {
  results: { id: string; changed: boolean; geometry: unknown | null; growth: number; reason: string | null }[];
}

export const sam3MaskRefineApi = {
  refine: (data: { dataset_id: string; stac_item_id: string; masks: { id: string; geometry: unknown }[] }) =>
    apiClient.post(EP.sam3.refineMasks, { json: data, timeout: 300_000 }).json<Sam3RefineResult>(),
};
