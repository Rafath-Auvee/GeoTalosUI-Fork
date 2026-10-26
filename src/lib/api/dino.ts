import { apiClient } from './client';
import { EP } from './endpoints';
import type { InferenceJobStatus } from './inference';

/** Matches backend SkippedSet (geoops/export_common.py). */
export interface DinoSkippedSet {
  annotation_set_id: string;
  name: string;
  reason: string;
}

/** POST /dino/export-preview — cheap, synchronous, safe to call repeatedly
 *  while picking a collection/class. No TiTiler/S3/geoops-service calls. */
export interface DinoExportPreviewPayload {
  annotation_set_collection_id: string;
  class_id: string;
  /** Restrict to annotations of this class tagged to this one tracked AOI
   *  (see MapAOI). Omit to use every AOI-tagged annotation of this class in
   *  the collection — only safe when every such AOI is independently
   *  exhaustively labeled. */
  aoi_id?: string;
  /** Several AOIs — with `annotation_set_ids`, annotations are matched to them by position. */
  aoi_ids?: string[];
  /** Use exactly these annotation sets (any review status) instead of the collection's verified ones. */
  annotation_set_ids?: string[];
  /** 'segment' counts only masks, not boxes. */
  task?: DinoTask;
  /** Several classes (YOLO), counted together. */
  class_ids?: string[];
}

/** An annotation set that has annotations inside the chosen AOIs (POST /dino/aoi-annotation-sets). */
export interface DinoAoiSet {
  id: string;
  name: string;
  review_status: string;
  source_type: string | null;
  annotations_in_aois: number;
  /** Of those, how many are masks (more than a box's corners). */
  mask_annotations: number;
  class_annotations: number;
  /** Annotations inside each AOI (any class), keyed by AOI id. */
  by_aoi: Record<string, number>;
}

export interface DinoExportPreviewResponse {
  annotation_set_collection_id: string;
  class_id: string;
  class_name: string;
  schema_id: string;
  geometry_types: string[];
  verified_sets_included: number;
  sets_skipped: DinoSkippedSet[];
  dataset_item_count: number;
  total_annotations: number;
  annotations_skipped_no_item: number;
  annotations_skipped_inactive_item: number;
  /** Median longer-side size (m) of the eligible annotations. */
  median_object_span_m?: number | null;
  /** 10th / 90th percentile object size (m) and their ratio. */
  object_size_p10_m?: number | null;
  object_size_p90_m?: number | null;
  size_spread?: number | null;
  /** Default tile scales: several when the size spread exceeds 4x, else one. */
  suggested_scales_m?: number[];
  /** The single scale nearest the median object size. */
  suggested_tile_scale_m?: number | null;
  /** Eligible annotations per class id, when several classes were asked for. */
  by_class?: Record<string, number>;
  ready: boolean;
}

export type DinoTask = 'detect' | 'classify' | 'segment' | 'yolo';

/** train: only in training · test: only in the final test · both: split by region (the default). */
export type SetRole = 'train' | 'test' | 'both';

/** Build inputs of a dataset. Changing any of them means a rebuild. */
export interface DinoDatasetParams {
  /** Real-world tile edges (m). Several = multi-scale. Omit to derive from object sizes. */
  scales_m?: number[] | null;
  /** Primary scale of a built dataset (informational; derived from scales_m). */
  tile_scale_m?: number | null;
  crop_px?: number;
  eval_split?: number;
  test_split?: number;
  neg_ratio?: number;
  region_tiles?: number;
  /** Where each annotation set (by id) may be used. Sets not listed are 'both'. */
  set_roles?: Record<string, SetRole>;
}

export interface DinoSplitCounts {
  tiles: number;
  positives: number;
  negatives: number;
  annotations: number;
}

export interface DinoDatasetStats {
  splits: Record<'train' | 'eval' | 'test', DinoSplitCounts>;
  /** Tiles / positive tiles / annotations per tile scale (keys are metres). */
  by_scale?: Record<string, { tiles: number; positives: number; annotations: number }>;
  scales_m?: number[];
  object_size_p10_m?: number | null;
  object_size_p90_m?: number | null;
  size_spread?: number | null;
  objects_out_of_range?: number;
  warnings: string[];
  annotations?: number;
  items?: number;
  tiles_skipped_ambiguous?: number;
  tiles_failed?: number;
  errors?: string[];
  tile_scale_m?: number;
  crop_px?: number;
}

export type DinoDatasetStatus = 'pending' | 'building' | 'ready' | 'failed';

/** A reusable training dataset: built once, reviewed, then trained on repeatedly. */
export interface DinoDataset {
  id: string;
  name: string;
  annotation_set_collection_id: string;
  class_id: string;
  aoi_id: string;
  /** Set when the dataset covers several AOIs / explicit sets. */
  aoi_ids?: string[] | null;
  annotation_set_ids?: string[] | null;
  class_ids?: string[] | null;
  task: DinoTask;
  params: DinoDatasetParams;
  status: DinoDatasetStatus;
  build_no: number;
  stats: DinoDatasetStats | null;
  source_dataset_id: string | null;
  job_id: string | null;
  error: string | null;
  is_stale: boolean;
  stale_reason: string | null;
  created_at: string;
  updated_at: string;
}

export interface DinoDatasetCreatePayload {
  annotation_set_collection_id: string;
  class_id: string;
  aoi_id: string;
  /** Several AOIs (needs annotation_set_ids). The first is the primary one. */
  aoi_ids?: string[];
  annotation_set_ids?: string[];
  /** Several classes (YOLO); their order is the YOLO class index. */
  class_ids?: string[];
  task: DinoTask;
  name?: string;
  params?: DinoDatasetParams;
  /** Clone a ready detect dataset into a classify one (reuses its tiles). */
  source_dataset_id?: string;
}

/** POST /dino/finetune — trains from an already-built dataset. Nothing is
 *  regenerated; split and scale belong to the dataset. */
export interface DinoFinetunePayload {
  dataset_id: string;
  backbone_model_id?: string | null;
  /** Frozen DINOv2 backbone: small (default) or base. */
  backbone?: 'dinov2-vits14' | 'dinov2-vitb14';
  /** YOLO: a weights file name, or the storage key of an earlier YOLO model. */
  base_weights?: string;
  /** YOLO: neck and head only, then everything at a lower learning rate. */
  stage1_epochs?: number;
  stage2_epochs?: number;
  stage1_lr?: number;
  stage2_lr?: number;
  epochs?: number;
  lr?: number;
  weight_decay?: number;
  /** Pick lr (and epochs / weight decay for DINOv2 heads) with Optuna. Tuned once per dataset build + model, then reused. */
  auto_tune?: boolean;
  /** Optuna trials when tuning runs (default 5). */
  n_trials?: number;
  /** Tune again even if this dataset + model already has a saved config. */
  force_retune?: boolean;
  /** Multi-run: 3 to 5 seeds. Empty / omitted = a single run. */
  seeds?: number[];
  result_model_name?: string | null;
  allow_stale?: boolean;
}

/** mean / sample std (n-1) / min / max of one metric across the seeds. */
export interface DinoMetricSummary { n: number; mean: number | null; std: number | null; min: number | null; max: number | null }

/** Multi-seed report: each seed trained and evaluated on the held-out test split. */
export interface DinoMultirunReport {
  seeds: number[];
  n_runs: number;
  /** Which seed's model was kept — chosen by validation loss, never by test score. */
  selected_seed: number;
  selected_by: string;
  summary: Record<string, DinoMetricSummary>;
  best_val_loss: DinoMetricSummary;
  runs: { seed: number; best_epoch: number | null; best_val_loss: number | null; artifact_key: string; epoch_losses?: number[] | null; val_losses?: number[] | null; metrics: Record<string, number | null> }[];
  seconds: number;
}

export interface DinoTuningTrial { number: number; params: Record<string, number>; value: number | null; state: string; /** The epoch where this trial's validation loss was lowest. */ best_epoch?: number | null; /** How many epochs it actually trained (it stops early once validation loss stops improving). */ epochs_run?: number | null; /** Set when the trial was abandoned early for being behind the others. */ pruned_at?: number | null }

/** What auto-tuning decided for a run. */
export interface DinoTuningSummary {
  cache_hit: boolean;
  tuned_config_id: string | null;
  model_key: string;
  best_params: Record<string, number>;
  metric?: string;
  n_trials?: number;
  best_value?: number | null;
  best_trial?: number;
  trials?: DinoTuningTrial[];
  seconds?: number;
  /** What every trial shared: the epoch limits and early-stop patience (DINOv2 heads) or the two stage lengths (YOLO). */
  fixed?: Record<string, number>;
}

/** GET /dino/datasets/{id}/tuned-configs — the saved Optuna result for one dataset + model. */
export interface DinoTunedConfig {
  id: string;
  dataset_id: string;
  dataset_build_no: number;
  /** The DINOv2 backbone key, or for YOLO the base weights. */
  model_key: string;
  best_params: Record<string, number>;
  tuning: { metric: string; n_trials: number; best_value: number; best_trial: number; seed: number; seconds: number; trials: DinoTuningTrial[]; fixed?: Record<string, number> };
  multirun: DinoMultirunReport | null;
  job_id: string | null;
  /** The dataset was rebuilt since this was tuned; the next auto-tuned run searches again. */
  is_stale: boolean;
  created_at: string;
  updated_at: string;
}

/** GET /dino/runs/{id}/report */
export interface DinoRunReport {
  job_id: string;
  dataset_id: string | null;
  task: string | null;
  hyperparameters: Record<string, unknown> | null;
  tuning: DinoTuningSummary | null;
  multirun: DinoMultirunReport | null;
}

/** A run's report: dataset reference, hyperparameters, curves, metrics, timings. */
export interface DinoFinetuneResult {
  dataset_id: string;
  dataset_build_no: number;
  task: string;
  class_id: string;
  class_name: string;
  train_items: number;
  eval_items: number;
  test_items: number;
  patch_span_m?: number | null;
  hyperparameters?: { epochs: number; lr: number; weight_decay?: number; seeds?: number[] | null; source?: 'manual' | 'auto_tuned' | 'saved_config'; backbone?: string; stages?: { stage1_epochs: number; stage2_epochs: number; frozen_layers: number; stage1_lr?: number; stage2_lr: number } } | null;
  training_triggered: boolean;
  ai_model_id?: string | null;
  backbone_model_id?: string | null;
  tuning?: DinoTuningSummary | null;
  multirun?: DinoMultirunReport | null;
  train_result?: {
    artifact_key: string;
    train_examples: number;
    eval_examples: number;
    epoch_losses: number[];
    val_losses?: number[];
    best_epoch?: number;
    best_val_loss?: number | null;
    final_loss: number | null;
    stages?: { stage1_epochs: number; stage2_epochs: number; frozen_layers: number; stage1_lr?: number; stage2_lr: number };
    classes?: string[];
  } | null;
  eval_result?: {
    num_images: number;
    // detect (FCOS)
    num_ground_truth?: number;
    num_predictions?: number;
    ap50?: number | null;
    mean_iou_tp?: number | null;
    iou_thresh?: number;
    // segment
    map?: number | null;
    per_class?: { name: string; ap50: number; precision: number; recall: number; instances: number }[];
    pixel_iou?: number | null;
    dice?: number | null;
    count_mae?: number | null;
    area_err_pct?: number | null;
    // classify
    accuracy?: number | null;
    f1?: number | null;
    score_thresh?: number;
    tp?: number;
    fp?: number;
    tn?: number;
    fn?: number;
    // shared
    precision?: number | null;
    recall?: number | null;
    note?: string;
  } | null;
  timings?: { train_seconds: number; eval_seconds: number; total_seconds: number } | null;
  note?: string | null;
  error?: string | null;
}

/** Matches backend JobRead — POST /dino/finetune returns 202 + this. */
export interface DinoFinetuneJobRead {
  id: string;
  organization_id: string;
  type: string;
  status: InferenceJobStatus;
  progress: number | null;
  processed_items: number;
  total_items: number;
  failed_items: number;
  logs: string | null;
  config: { request?: Partial<DinoFinetunePayload> & { aoi_id?: string; task?: string }; result?: DinoFinetuneResult } | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  updated_at: string;
}

/** GET /dino/datasets/{id}/items — one tile of the dataset's current build.
 *  image_key is a raw S3 key, not a browser-fetchable URL — fetch bytes via
 *  dinoApi.getDatasetImageBlob (goes through the API's own port + auth). */
export interface DinoDatasetItem {
  item_id: string;
  split: 'train' | 'eval' | 'test';
  image_key: string;
  /** Tile edge (m) this tile was cut at. */
  scale_m?: number | null;
  /** detect only. */
  box_count?: number | null;
  /** detect only — normalized [cx, cy, w, h] in [0,1] relative to the tile. */
  boxes?: [number, number, number, number][] | null;
  /** segment only — each object's outline as flat normalized [x1, y1, x2, y2, ...]. */
  polygons?: number[][] | null;
  /** 1 if the class is present in this tile, 0 otherwise. */
  label?: number | null;
}

export interface DinoDatasetItemsResponse {
  dataset_id: string;
  task: string;
  total: number;
  truncated: boolean;
  items: DinoDatasetItem[];
}

export interface DinoListRunsQuery {
  annotation_set_collection_id: string;
  class_id: string;
  /** Only runs that were themselves scoped to this AOI. Omit to see every
   *  past run for this class regardless of AOI restriction. */
  aoi_id?: string;
  limit?: number;
}

export const dinoApi = {
  /** POST /dino/export-preview — validate + preview before building a dataset. */
  exportPreview: (data: DinoExportPreviewPayload) =>
    apiClient.post(EP.dino.exportPreview, { json: data }).json<DinoExportPreviewResponse>(),

  /** POST /dino/aoi-annotation-sets — annotation sets with annotations inside the AOIs (PostGIS). */
  aoiAnnotationSets: (data: { annotation_set_collection_id: string; class_id?: string; class_ids?: string[]; aoi_ids: string[] }) =>
    apiClient.post(EP.dino.aoiAnnotationSets, { json: data }).json<DinoAoiSet[]>(),

  /** GET /dino/datasets — datasets of one collection/class (optionally one AOI). */
  listDatasets: (query: { annotation_set_collection_id: string; class_id: string; aoi_id?: string }) =>
    apiClient
      .get(EP.dino.datasets, {
        searchParams: {
          annotation_set_collection_id: query.annotation_set_collection_id,
          class_id: query.class_id,
          ...(query.aoi_id ? { aoi_id: query.aoi_id } : {}),
        },
      })
      .json<DinoDataset[]>(),

  /** PATCH /dino/datasets/{id} — rename a dataset. */
  renameDataset: (id: string, name: string) =>
    apiClient.patch(EP.dino.dataset(id), { json: { name } }).json<DinoDataset>(),

  /** DELETE /dino/datasets/{id} — remove a dataset and its tile files. */
  deleteDataset: (id: string) => apiClient.delete(EP.dino.dataset(id)).then(() => undefined),

  getDataset: (id: string) => apiClient.get(EP.dino.dataset(id)).json<DinoDataset>(),

  /** GET /dino/yolo-bases — what a YOLO training can start from. */
  yoloBases: () =>
    apiClient.get(EP.dino.yoloBases).json<{ pretrained: { id: string; name: string; size_bytes: number }[]; earlier: { id: string; name: string }[] }>(),

  /** POST /dino/datasets — create + build a new dataset (202). */
  createDataset: (data: DinoDatasetCreatePayload) =>
    apiClient.post(EP.dino.datasets, { json: data }).json<DinoDataset>(),

  /** POST /dino/datasets/{id}/rebuild — regenerate one dataset, optionally with new params (202). */
  rebuildDataset: (id: string, params?: DinoDatasetParams) =>
    apiClient.post(EP.dino.datasetRebuild(id), { json: { params: params ?? null } }).json<DinoDataset>(),

  /** GET /dino/datasets/{id}/items — every tile of the current build. */
  getDatasetItems: (id: string, split?: 'train' | 'eval' | 'test') =>
    apiClient
      .get(EP.dino.datasetItems(id), { searchParams: split ? { split } : {} })
      .json<DinoDatasetItemsResponse>(),

  /** GET /dino/runs/{id}/model — which model files exist for a run (``seed``: one seed of a multi-seed experiment). */
  modelExports: (runId: string, seed?: number) =>
    apiClient.get(EP.dino.runModel(runId), { searchParams: seed != null ? { seed } : {} }).json<{ pt_size_bytes: number | null; onnx_size_bytes: number | null }>(),

  /** POST /dino/runs/{id}/model/onnx — convert the run's model to ONNX (idempotent). */
  exportOnnx: (runId: string, seed?: number) =>
    apiClient.post(EP.dino.runModelOnnx(runId), { timeout: false, searchParams: seed != null ? { seed } : {} }).json<{ pt_size_bytes: number | null; onnx_size_bytes: number | null }>(),

  /** DELETE /dino/runs/{id}/model — delete the run's trained model (files and model-list entry). */
  deleteModel: (runId: string) => apiClient.delete(EP.dino.runModel(runId)).then(() => undefined),

  /** GET /dino/runs/{id}/model/download — the model file as a blob. */
  downloadModel: (runId: string, format: 'pt' | 'onnx', seed?: number) =>
    apiClient.get(EP.dino.runModelDownload(runId), { searchParams: seed != null ? { format, seed } : { format }, timeout: false }).blob(),

  /** GET /dino/datasets/{id}/download — the dataset as a COCO-format zip (images + instances_*.json). */
  downloadDataset: (id: string) => apiClient.get(EP.dino.datasetDownload(id), { timeout: false }).blob(),

  /** GET /dino/datasets/{id}/image — one tile's PNG bytes, proxied through the
   *  API rather than a presigned MinIO URL the browser might not reach. Caller
   *  turns the blob into an object URL and revokes it when done. */
  getDatasetImageBlob: (id: string, imageKey: string) =>
    apiClient.get(EP.dino.datasetImage(id), { searchParams: { key: imageKey } }).blob(),

  /** POST /dino/finetune — train from a built dataset (202 + Job). Poll via getJob. */
  finetune: (data: DinoFinetunePayload) =>
    apiClient.post(EP.dino.finetune, { json: data }).json<DinoFinetuneJobRead>(),

  /** GET /dino/runs — past Train Head runs (reports) for one class, newest first. */
  listRuns: (query: DinoListRunsQuery) =>
    apiClient
      .get(EP.dino.runs, {
        searchParams: {
          annotation_set_collection_id: query.annotation_set_collection_id,
          class_id: query.class_id,
          ...(query.aoi_id ? { aoi_id: query.aoi_id } : {}),
          ...(query.limit ? { limit: String(query.limit) } : {}),
        },
      })
      .json<DinoFinetuneJobRead[]>(),

  /** GET /dino/datasets/{id}/tuned-configs — saved auto-tune results of a dataset (one per model). */
  listTunedConfigs: (datasetId: string) =>
    apiClient.get(EP.dino.tunedConfigs(datasetId)).json<DinoTunedConfig[]>(),

  /** DELETE /dino/datasets/{id}/tuned-config — forget it, so the next auto-tuned run searches again. */
  deleteTunedConfig: (datasetId: string, modelKey: string) =>
    apiClient.delete(EP.dino.tunedConfig(datasetId), { searchParams: { model_key: modelKey } }).then(() => undefined),

  /** GET /dino/runs/{id}/report — tuning summary + multi-run mean ± std of one run. */
  getRunReport: (runId: string) => apiClient.get(EP.dino.runReport(runId)).json<DinoRunReport>(),

  /** GET /jobs/{id} — poll a build or training job's progress/result. */
  getJob: (jobId: string) =>
    apiClient.get(EP.jobs.detail(jobId)).json<DinoFinetuneJobRead>(),
};
