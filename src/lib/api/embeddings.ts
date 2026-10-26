import { apiClient } from './client';
import { EP } from './endpoints';
import type { InferenceJobStatus } from './inference';

export interface EmbeddingRead {
  id: string;
  organization_id: string;
  model_id: string | null;
  model_name: string;
  embedding_dim: number;
  dataset_item_id: string;
  class_id: string | null;
  annotation_id: string | null;
  source_geometry: Record<string, unknown>;
  /** Real-world scale tier this embedding was snapped to (geoops/scale.py) —
   *  search() and AOI scans only ever compare same-tier candidates. */
  tile_tier: number;
  created_at: string;
}

export interface EmbeddingCreatePayload {
  model_id: string;
  dataset_item_id: string;
  geometry: Record<string, unknown>;
  annotation_id?: string | null;
  class_id?: string | null;
  crop_size_px?: number;
}

export interface EmbeddingSearchPayload {
  embedding_id: string;
  top_k?: number;
  class_id?: string | null;
  dataset_id?: string | null;
  exclude_self?: boolean;
}

export interface EmbeddingSearchMatch {
  embedding_id: string;
  dataset_item_id: string;
  class_id: string | null;
  annotation_id: string | null;
  source_geometry: Record<string, unknown>;
  similarity: number;
  distance: number;
}

export interface AoiScanPayload {
  reference_embedding_id: string;
  dataset_item_ids: string[];
  aoi_bbox?: [number, number, number, number] | null;
  crop_size_px?: number;
  top_k?: number;
  min_similarity?: number | null;
  max_patches?: number;
  /** Annotation class the returned matches are persisted under, as a new
   *  annotation_set (source_type='analysis') mounted as a map layer once the
   *  job completes. */
  output_class_id: string;
}

export interface AoiScanMatch {
  dataset_item_id: string;
  bbox: [number, number, number, number];
  similarity: number;
  distance: number;
}

export interface AoiScanResult {
  reference_embedding_id: string;
  model_name: string;
  patches_scanned: number;
  patches_cached: number;
  patches_embedded: number;
  patches_truncated: boolean;
  errors_total: number;
  matches: AoiScanMatch[];
  /** The annotation_set created from `matches` — null if the scan found none.
   *  Mount it as a normal `type: 'annotation'` map layer to visualize results. */
  annotation_set_id: string | null;
}

/** Matches backend JobRead — POST /embeddings/aoi-scan returns 202 + this,
 *  poll GET /jobs/{id} the same way inferenceApi.getJob does. */
export interface AoiScanJobRead {
  id: string;
  organization_id: string;
  type: string;
  status: InferenceJobStatus;
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { request?: AoiScanPayload; result?: AoiScanResult } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ExemplarScanPayload {
  /** Exemplar embeddings, all same model_name + tile_tier. 1-10. */
  reference_embedding_ids: string[];
  /** Previously-rejected candidates' embeddings — a tile scoring closer to a
   *  negative than to every positive reference is dropped. */
  negative_embedding_ids?: string[];
  dataset_item_ids: string[];
  aoi_bbox?: [number, number, number, number] | null;
  crop_size_px?: number;
  /** Fraction of tile width/height consecutive tiles overlap by. Defaults to
   *  the reference object's own pixel footprint (auto-inferred server-side)
   *  when omitted. */
  overlap_ratio?: number | null;
  top_k?: number;
  min_similarity?: number | null;
  /** NMS threshold for merging duplicate candidates from overlapping tiles. */
  iou_thresh?: number;
  max_patches?: number;
  /** Tighten top_k candidate boxes via a registered SAM3 model. */
  refine_with_sam?: boolean;
  /** Required when refine_with_sam=true — a registered SAM3 AIModel id. */
  sam_model_id?: string | null;
  /** Annotation class the returned matches are persisted under, as a new
   *  annotation_set (source_type='analysis') mounted as a map layer once the
   *  job completes. */
  output_class_id: string;
}

export interface ExemplarScanMatch {
  dataset_item_id: string;
  bbox: [number, number, number, number];
  similarity: number;
  refined: boolean;
}

export interface ExemplarScanResult {
  model_name: string;
  meters_per_pixel: number;
  object_px: number;
  overlap_ratio: number;
  patches_scanned: number;
  patches_cached: number;
  patches_embedded: number;
  patches_truncated: boolean;
  candidates_before_nms: number;
  refine_errors: number;
  matches: ExemplarScanMatch[];
  /** The annotation_set created from `matches` — null if the scan found none.
   *  Mount it as a normal `type: 'annotation'` map layer to visualize results. */
  annotation_set_id: string | null;
}

/** Matches backend JobRead — POST /embeddings/exemplar-scan returns 202 + this. */
export interface ExemplarScanJobRead {
  id: string;
  organization_id: string;
  type: string;
  status: InferenceJobStatus;
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { request?: ExemplarScanPayload; result?: ExemplarScanResult } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** "Pick a class, click run" version of exemplar-scan — references are
 *  auto-gathered from a verified annotation collection's existing
 *  annotations of one class (same inputs as dino.finetune/Train Head)
 *  instead of manually drawn/embedded boxes. */
export interface AutoAnnotatePayload {
  annotation_set_collection_id: string;
  class_id: string;
  embedding_model_id: string;
  dataset_item_ids: string[];
  aoi_bbox?: [number, number, number, number] | null;
  max_references?: number;
  crop_size_px?: number;
  top_k?: number;
  min_similarity?: number | null;
  iou_thresh?: number;
  max_patches?: number;
  refine_with_sam?: boolean;
  sam_model_id?: string | null;
  /** Defaults to class_id server-side when omitted. */
  output_class_id?: string | null;
}

/** Matches backend JobRead — POST /embeddings/auto-annotate returns 202 + this.
 *  Result shape is identical to ExemplarScanResult. */
export interface AutoAnnotateJobRead {
  id: string;
  organization_id: string;
  type: string;
  status: InferenceJobStatus;
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { request?: AutoAnnotatePayload; result?: ExemplarScanResult } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AnomalyDetectionPayload {
  class_id: string;
  model_id: string;
  dataset_item_ids: string[];
  aoi_bbox?: [number, number, number, number] | null;
  min_group_size?: number;
  top_k?: number;
  max_new_embeddings?: number;
  /** Annotation class flagged anomalies are persisted under, as a new
   *  annotation_set (source_type='analysis') mounted as a map layer once the
   *  job completes. Independent of `class_id` above (that's the class being
   *  *scanned*, this is the class the *results* get tagged with). */
  output_class_id: string;
}

export interface AnomalyGroup {
  tile_tier: number;
  group_size: number;
  scored: boolean;
}

export interface AnomalyMatch {
  annotation_id: string;
  dataset_item_id: string;
  tile_tier: number;
  bbox: [number, number, number, number];
  anomaly_score: number;
  similarity_to_group: number;
}

export interface AnomalyDetectionResult {
  class_id: string;
  model_name: string;
  annotations_scanned: number;
  annotations_cached: number;
  annotations_embedded: number;
  annotations_truncated: boolean;
  errors_total: number;
  groups: AnomalyGroup[];
  anomalies: AnomalyMatch[];
  /** The annotation_set created from `anomalies` — null if none were flagged.
   *  Mount it as a normal `type: 'annotation'` map layer to visualize results. */
  annotation_set_id: string | null;
}

/** Matches backend JobRead — POST /embeddings/anomaly-scan returns 202 + this. */
export interface AnomalyScanJobRead {
  id: string;
  organization_id: string;
  type: string;
  status: InferenceJobStatus;
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { request?: AnomalyDetectionPayload; result?: AnomalyDetectionResult } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

export const embeddingsApi = {
  /** POST /embeddings — crop + embed one bbox/mask selection. Synchronous. */
  create: (data: EmbeddingCreatePayload) =>
    apiClient.post(EP.embeddings.create, { json: data }).json<EmbeddingRead>(),

  get: (id: string) =>
    apiClient.get(EP.embeddings.detail(id)).json<EmbeddingRead>(),

  /** POST /embeddings/search — cosine nearest-neighbours over the curated bank. */
  search: (data: EmbeddingSearchPayload) =>
    apiClient.post(EP.embeddings.search, { json: data }).json<EmbeddingSearchMatch[]>(),

  /** POST /embeddings/aoi-scan — async job (202 + job). Poll via getJob. */
  aoiScan: (data: AoiScanPayload) =>
    apiClient.post(EP.embeddings.aoiScan, { json: data }).json<AoiScanJobRead>(),

  /** POST /embeddings/anomaly-scan — async job (202 + job). Poll via getAnomalyJob.
   *  Only embeds annotations a model already produced — never tiles empty space. */
  anomalyScan: (data: AnomalyDetectionPayload) =>
    apiClient.post(EP.embeddings.anomalyScan, { json: data }).json<AnomalyScanJobRead>(),

  /** POST /embeddings/exemplar-scan — async job (202 + job). Poll via getExemplarJob.
   *  Multi-reference similarity scan with auto scale, SAHI-style overlapping
   *  tiles, NMS merge, and optional SAM3 box refinement. */
  exemplarScan: (data: ExemplarScanPayload) =>
    apiClient.post(EP.embeddings.exemplarScan, { json: data }).json<ExemplarScanJobRead>(),

  /** GET /jobs/{id} — poll an AOI-scan job's progress/result. */
  getJob: (jobId: string) =>
    apiClient.get(EP.jobs.detail(jobId)).json<AoiScanJobRead>(),

  /** GET /jobs/{id} — poll an anomaly-detection job's progress/result. */
  getAnomalyJob: (jobId: string) =>
    apiClient.get(EP.jobs.detail(jobId)).json<AnomalyScanJobRead>(),

  /** GET /jobs/{id} — poll an exemplar-scan job's progress/result. */
  getExemplarJob: (jobId: string) =>
    apiClient.get(EP.jobs.detail(jobId)).json<ExemplarScanJobRead>(),

  /** POST /embeddings/auto-annotate — async job (202 + job). Poll via getAutoAnnotateJob.
   *  Same collection+class inputs as dino.finetune — no manual reference-box
   *  drawing needed. */
  autoAnnotate: (data: AutoAnnotatePayload) =>
    apiClient.post(EP.embeddings.autoAnnotate, { json: data }).json<AutoAnnotateJobRead>(),

  /** GET /jobs/{id} — poll an auto-annotate job's progress/result. */
  getAutoAnnotateJob: (jobId: string) =>
    apiClient.get(EP.jobs.detail(jobId)).json<AutoAnnotateJobRead>(),
};
