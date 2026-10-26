'use client';

import { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Bot, Play, Loader2, CheckCircle2, AlertCircle, X, ChevronDown, ChevronRight, Zap,
  Eye, EyeOff, Square, Trash2, Search, Scan, AlertTriangle, GraduationCap, Sparkles,
} from 'lucide-react';
import type LType from 'leaflet';
import { getMapManager } from '../../MapManager';
import { modelsApi } from '@/lib/api/models';
import { inferenceApi } from '@/lib/api/inference';
import { mapAoisApi } from '@/lib/api/map-aois';
import { qk } from '@/lib/query-keys';
import { datasetsApi } from '@/lib/api/datasets';
import {
  embeddingsApi, type EmbeddingRead,
} from '@/lib/api/embeddings';
import { annotationSetsApi } from '@/lib/api/annotation-sets';
import { annotationSetCollectionsApi, annotationSetCollectionsKey } from '@/lib/api/annotation-set-collections';
import { annotationSchemasApi } from '@/lib/api/annotation-schemas';
import { dinoApi } from '@/lib/api/dino';
import { sam3Api } from '@/lib/api/sam3';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { useMapStore } from '@/stores/mapStore';
import { MC } from '../../mapColors';
import { buildClassStyles } from '../../utils/annotationStyles';
import type { Dataset, AIModel, AnnotationSetMount, DatasetItem } from '@/types/api';
import type { GeoJSONGeometry } from '@/types/geo';
import type { LayerConfig } from '../../types';
import { PanelField as Field, InfoTip } from './PanelControls';
import { AnalysisDetailHeader } from './AnalysisDetailHeader';
import { TrainHeadAdvancedDialog, type TrainOpts } from './TrainHeadAdvancedDialog';

/**
 * Pull TiTiler-compatible render params (asset_bidx + rescale) from an AOI
 * source layer's bandSelection + renderingConfig stats, so backend inference
 * patches use the exact same band combination the user is viewing on the map.
 * Returns null when the layer has no bandSelection (caller should send no
 * render_params; backend falls back to the dataset's default preset).
 */
function buildRenderParams(layer: LayerConfig | undefined): Record<string, string> | null {
  if (!layer?.bandSelection) return null;
  const b = layer.bandSelection;
  const params: Record<string, string> = {
    asset_bidx: `data|${b.r},${b.g},${b.b}`,
  };
  const rc = layer.renderingConfig;
  const rBand = rc?.bands?.find((x) => x.index === b.r);
  const gBand = rc?.bands?.find((x) => x.index === b.g);
  const bBand = rc?.bands?.find((x) => x.index === b.b);
  if (rBand && gBand && bBand) {
    const p2 = Math.min(rBand.stats.p2, gBand.stats.p2, bBand.stats.p2);
    const p98 = Math.max(rBand.stats.p98, gBand.stats.p98, bBand.stats.p98);
    params.rescale = `${Math.round(p2)},${Math.round(p98)}`;
  }
  return params;
}

interface AoiInferencePanelProps {
  aoiLayerId: string;
  mapId?: string;
  backendAoiId?: string;
  aoiBbox: [number, number, number, number] | undefined;
  /** Datasets selected on this AOI. */
  selectedDatasets: Dataset[];
  /** Lazy-save callback — resolves to a backend AOI id. */
  onEnsureAoi: () => Promise<string>;
  onBack: () => void;
}

interface RunMeta {
  jobId: string;
  modelName: string;
  datasetName: string;
  /** Display name for the produced annotation set layer. Format:
   *  `<className>_<aoiName>` for prompted (SAM3) runs, `<modelName>_<aoiName>`
   *  otherwise. Built when the run is queued so it survives across remounts. */
  layerName: string;
  /** Schema bound to the model — used to fetch classes + build per-class
   *  fill/stroke styles for the MVT renderer. */
  schemaId: string | null;
  /** Annotation set ids produced by the job — populated by RunRow once the
   *  job completes and the sets get mounted as map layers. Drives the
   *  Visualization aggregation + per-run visibility toggle. */
  setIds?: string[];
}

export function AoiInferencePanel({
  aoiLayerId: aoiLayerId,
  mapId,
  backendAoiId,
  aoiBbox,
  selectedDatasets,
  onEnsureAoi,
  onBack,
}: AoiInferencePanelProps) {
  const [modelId, setModelId] = useState('');
  const [datasetId, setDatasetId] = useState('');
  // When true, the run targets every item in the dataset's STAC collection
  // (scope:'dataset') rather than only the items intersecting the AOI
  // (scope:'aoi', the cheaper default). Either way the backend clips each patch
  // to the AOI bbox — scope only changes which frames run, not the spatial
  // extent. Surfaced only for collection-backed datasets — see
  // `isTemporalDataset` below.
  const [runOnCollection, setRunOnCollection] = useState(false);
  const [patchSizePx, setPatchSizePx] = useState<number | null>(null);
  const [stridePx, setStridePx] = useState<number | null>(null);
  const [textPrompt, setTextPrompt] = useState('');
  const [outputClassId, setOutputClassId] = useState('');
  const [promptsOpen, setPromptsOpen] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [bboxPrompts, setBboxPrompts] = useState<{ id: string; bbox: [number, number, number, number] }[]>([]);
  const [runs, setRuns] = useState<RunMeta[]>([]);

  // Leaflet rectangle overlays for the drawn bbox prompts, keyed by prompt id.
  const bboxOverlaysRef = useRef<Map<string, LType.Rectangle>>(new Map());
  const bboxDrawActive = useMapLayersStore((s) => s.bboxPromptDrawMode);
  const capturedBboxPrompt = useMapLayersStore((s) => s.capturedBboxPrompt);

  // ── AOI child layers — drives the band-selection params we send to the
  // backend so its TiTiler patch render matches the user's view. ───────────
  const layerMap = useMapLayersStore((s) => s.layers);
  const aoiChildLayers = useMemo(
    () => Object.values(layerMap).filter((l) => l.parentAoiId === aoiLayerId),
    [layerMap, aoiLayerId],
  );

  // ── Models ────────────────────────────────────────────────────────────────
  const { data: modelsResp, isLoading: loadingModels } = useQuery({
    queryKey: ['models', 'list-for-inference'],
    queryFn: () => modelsApi.list({ page_size: 100 }),
  });
  const models = useMemo(() => modelsResp?.items ?? [], [modelsResp?.items]);

  useEffect(() => {
    if (modelId && models.some((m) => m.id === modelId)) return;
    setModelId(models[0]?.id ?? '');
  }, [models, modelId]);

  useEffect(() => {
    if (datasetId && selectedDatasets.some((d) => d.id === datasetId)) return;
    setDatasetId(selectedDatasets[0]?.id ?? '');
  }, [selectedDatasets, datasetId]);

  const selectedModel = models.find((m) => m.id === modelId);
  // Heads trained from a dataset carry the real-world scale(s) they were
  // trained at; inference scans exactly those, so patch size/stride aren't
  // adjustable. A multi-scale head can be restricted to a subset to bound cost.
  const modelOut = (selectedModel?.output_config ?? {}) as Record<string, unknown>;
  const trainedScales = Array.isArray(modelOut.patch_sizes_m) ? (modelOut.patch_sizes_m as number[]) : [];
  const scaleLocked = modelOut.scale_locked === true;
  const trainingMeta = (selectedModel?.config as { training?: ModelTrainingMeta } | null)?.training;
  const trainedScalesKey = trainedScales.join(',');
  const [scaleSubset, setScaleSubset] = useState<number[]>([]);
  useEffect(() => {
    setScaleSubset(trainedScalesKey ? trainedScalesKey.split(',').map(Number) : []);
  }, [trainedScalesKey, modelId]);
  const selectedDataset = selectedDatasets.find((d) => d.id === datasetId);
  // A dataset is collection-backed (and thus eligible for a whole-collection
  // run) when it has a STAC collection id. Single-item datasets simply produce
  // one set under scope:'dataset', so the toggle is harmless there too.
  const isTemporalDataset = !!selectedDataset?.stac_collection_id;

  // Reset the collection toggle whenever a non-collection dataset is picked so
  // a stale "whole collection" choice can't leak into an AOI-only run.
  useEffect(() => {
    if (!isTemporalDataset && runOnCollection) setRunOnCollection(false);
  }, [isTemporalDataset, runOnCollection]);

  // ── Text-prompt support (SAM3-style models) ──────────────────────────────
  // A model supports text prompts when its adapter declares a prompt_key_map
  // entry for `text_prompt`. For prompted models the user picks a class from
  // the model's bound annotation schema (sent as output_class_id) AND types a
  // separate free-text prompt forwarded to the endpoint — the two are
  // intentionally decoupled because one class can be hinted by many prompts.
  const adapterCfg = (selectedModel?.output_config?.adapter_config ?? {}) as Record<string, unknown>;
  const promptKeyMap = (adapterCfg.prompt_key_map ?? {}) as Record<string, unknown>;
  const supportsTextPrompt = typeof promptKeyMap.text_prompt === 'string';
  // A model accepts bbox-exemplar prompts when its adapter maps the generic
  // `bboxes` key. The user draws rectangles on the map; we send them as
  // `bbox_prompts_4326` and the backend reprojects each into per-patch pixels.
  const supportsBboxPrompt = typeof promptKeyMap.bboxes === 'string';
  // Prompted models (text and/or bbox) always require an explicit output class —
  // the prompt is just a hint; the class labels every prediction.
  const isPrompted = supportsTextPrompt || supportsBboxPrompt;

  const modelSchemaId = selectedModel?.annotation_schema_id ?? null;
  const { data: schemaClassesResp } = useQuery({
    queryKey: ['inference-panel', 'schema-classes', modelSchemaId],
    queryFn: () => annotationSchemasApi.getClasses(modelSchemaId as string),
    enabled: !!modelSchemaId && isPrompted,
  });
  const schemaClasses = useMemo(
    () => schemaClassesResp?.items ?? [],
    [schemaClassesResp?.items],
  );

  // ── Bbox-prompt overlay management ───────────────────────────────────────
  const clearBboxPrompts = useCallback(() => {
    bboxOverlaysRef.current.forEach((r) => r.remove());
    bboxOverlaysRef.current.clear();
    setBboxPrompts([]);
  }, []);

  const removeBboxPrompt = useCallback((id: string) => {
    const rect = bboxOverlaysRef.current.get(id);
    if (rect) { rect.remove(); bboxOverlaysRef.current.delete(id); }
    setBboxPrompts((prev) => prev.filter((b) => b.id !== id));
  }, []);

  const toggleBboxDraw = useCallback(() => {
    const store = useMapLayersStore.getState();
    if (store.bboxPromptDrawMode) {
      store.setBboxPromptDrawMode(false);
      useMapStore.getState().setActiveDrawTool(null);
    } else {
      store.setBboxPromptDrawMode(true);
      useMapStore.getState().setActiveDrawTool('rectangle');
    }
  }, []);

  // Consume a freshly drawn rectangle: append it to the list and render a styled
  // overlay, then clear the relay slot so the next draw is picked up cleanly.
  useEffect(() => {
    if (!capturedBboxPrompt) return;
    const bbox = capturedBboxPrompt;
    useMapLayersStore.getState().setCapturedBboxPrompt(null);
    const id = `bp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    setBboxPrompts((prev) => [...prev, { id, bbox }]);
    (async () => {
      const L: typeof LType = (await import('leaflet')).default;
      const map = getMapManager().getMap();
      if (!map) return;
      const [W, S, E, N] = bbox;
      const rect = L.rectangle([[S, W], [N, E]], {
        color: MC.accent, weight: 1.5, dashArray: '4 3',
        fillColor: MC.accent, fillOpacity: 0.08, interactive: false,
      });
      rect.addTo(map);
      bboxOverlaysRef.current.set(id, rect);
    })();
  }, [capturedBboxPrompt]);

  // Tear down overlays + draw mode when the panel unmounts.
  useEffect(() => {
    const overlays = bboxOverlaysRef.current;
    return () => {
      overlays.forEach((r) => r.remove());
      overlays.clear();
      const store = useMapLayersStore.getState();
      if (store.bboxPromptDrawMode) {
        store.setBboxPromptDrawMode(false);
        useMapStore.getState().setActiveDrawTool(null);
      }
    };
  }, []);

  // Reset prompt + class + bbox prompts when the model changes so stale picks
  // don't leak into the next run (especially across different schemas).
  useEffect(() => {
    setTextPrompt('');
    setOutputClassId('');
    clearBboxPrompts();
  }, [modelId, clearBboxPrompts]);

  // ── Run inference ────────────────────────────────────────────────────────
  const inferenceMut = useMutation({
    mutationFn: async () => {
      if (!mapId) throw new Error('Map not available');
      if (!aoiBbox) throw new Error('AOI bbox missing');
      if (!selectedModel) throw new Error('Pick a model');
      if (!selectedDataset) throw new Error('Pick a dataset');
      const hasText = supportsTextPrompt && !!textPrompt.trim();
      const hasBbox = supportsBboxPrompt && bboxPrompts.length > 0;
      if (isPrompted) {
        if (!outputClassId) throw new Error('Pick the output class');
        if (!hasText && !hasBbox) {
          throw new Error('Enter a text prompt or draw at least one bbox prompt');
        }
      }

      const aoiId = backendAoiId ?? (await onEnsureAoi());
      if (!aoiId) throw new Error('AOI could not be saved');

      const payload: Parameters<typeof mapAoisApi.createInferenceJob>[2] = {
        model_id: selectedModel.id,
        // 'dataset' fans out over every item in the collection; 'aoi' runs only
        // on items intersecting the AOI (cheaper, the default). Both clip each
        // patch to the AOI bbox on the backend. Only collection-backed datasets
        // expose the toggle, so runOnCollection can't be true otherwise.
        scope: runOnCollection ? 'dataset' : 'aoi',
        dataset_id: selectedDataset.id,
        mount_on_map: true,
      };
      if (!scaleLocked) {
        if (patchSizePx != null) payload.patch_size_px = patchSizePx;
        if (stridePx != null) payload.stride_px = stridePx;
      } else if (scaleSubset.length > 0 && scaleSubset.length < trainedScales.length) {
        payload.scales_m = scaleSubset;
      }
      if (isPrompted) {
        // One SAM3 model serves text / bbox / text+bbox. The adapter's
        // prompt_key_map forwards `text_prompt` -> `text_prompts` and
        // `bboxes` -> `bboxes`; bbox prompts are sent as geo `bbox_prompts_4326`
        // and reprojected per-patch on the backend.
        const promptPayload: Record<string, unknown> = {};
        if (hasText) {
          promptPayload.text_prompt = textPrompt
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
        if (hasBbox) {
          promptPayload.bbox_prompts_4326 = bboxPrompts.map((b) => b.bbox);
        }
        payload.prompt_payload = promptPayload;
        payload.output_class_id = outputClassId;
      }
      const sourceLayer = aoiChildLayers.find(
        (l) => l.sourceDatasetId === selectedDataset.id,
      );
      const renderParams = buildRenderParams(sourceLayer);
      if (renderParams) payload.render_params = renderParams;

      const job = await mapAoisApi.createInferenceJob(mapId, aoiId, payload);
      const aoiName = layerMap[aoiLayerId]?.name ?? 'aoi';
      const chosenClass = outputClassId
        ? schemaClasses.find((c) => c.id === outputClassId)?.name
        : undefined;
      const layerName = `${chosenClass ?? selectedModel.name}_${aoiName}`;
      return {
        job,
        modelName: selectedModel.name,
        datasetName: selectedDataset.name,
        layerName,
        schemaId: selectedModel.annotation_schema_id,
      };
    },
    onSuccess: ({ job, modelName, datasetName, layerName, schemaId }) => {
      setRuns((prev) => [
        { jobId: job.id, modelName, datasetName, layerName, schemaId },
        ...prev,
      ]);
      toast.success(`Inference queued — ${modelName} on ${datasetName}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to start inference');
    },
  });

  const dismissRun = useCallback((jobId: string) => {
    setRuns((prev) => prev.filter((r) => r.jobId !== jobId));
  }, []);

  const handleRunSetsResolved = useCallback((jobId: string, setIds: string[]) => {
    setRuns((prev) => prev.map((r) => (r.jobId === jobId ? { ...r, setIds } : r)));
  }, []);

  const canRun =
    !!mapId && !!aoiBbox && !!selectedModel && !!selectedDataset && !inferenceMut.isPending
    && !(scaleLocked && trainedScales.length > 0 && scaleSubset.length === 0);

  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <AnalysisDetailHeader title="Run Inference" icon={<Bot size={11} />} onBack={onBack} />

      {/* Model */}
      <Field label="Model">
        {loadingModels ? (
          <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading models…</p>
        ) : models.length === 0 ? (
          <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
            No models registered. Add one from the Models page.
          </p>
        ) : (
          <select
            value={modelId}
            onChange={(e) => setModelId(e.target.value)}
            style={selectStyle}
          >
            {models.map((m) => {
              const label = [m.name, m.version ? `v${m.version}` : null, m.type]
                .filter(Boolean).join(' · ');
              return <option key={m.id} value={m.id}>{label}</option>;
            })}
          </select>
        )}
        {selectedModel && (
          <div style={{ fontSize: 10, color: MC.textMuted, marginTop: 3 }}>
            {selectedModel.framework ? selectedModel.framework : 'custom'}
            {selectedModel.output_config?.adapter
              ? ` · adapter: ${selectedModel.output_config.adapter as string}`
              : ''}
          </div>
        )}
        {scaleLocked && trainedScales.length > 0 && (
          <ModelTrainingSummary scales={trainedScales} training={trainingMeta} />
        )}
      </Field>

      {/* Dataset */}
      <Field label="Dataset">
        {selectedDatasets.length === 0 ? (
          <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
            Select a dataset on this AOI first (above).
          </p>
        ) : selectedDatasets.length === 1 ? (
          <div
            style={{ ...selectStyle, display: 'flex', alignItems: 'center', cursor: 'default', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            title="Only one dataset is selected on this AOI"
          >
            {selectedDatasets[0].name}
          </div>
        ) : (
          <select
            value={datasetId}
            onChange={(e) => setDatasetId(e.target.value)}
            style={selectStyle}
          >
            {selectedDatasets.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </select>
        )}
        {isTemporalDataset && (
          <label
            title={runOnCollection
              ? 'Runs over every item in the temporal collection — each still clipped to this AOI region — one annotation set per frame, grouped for playback. Slower / more compute.'
              : 'Runs only on items intersecting this AOI, clipped to the AOI region (cheaper). Check to process the whole temporal sequence.'}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 6, marginTop: 6,
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={runOnCollection}
              onChange={(e) => setRunOnCollection(e.target.checked)}
              style={{ marginTop: 1, accentColor: MC.accent, cursor: 'pointer' }}
            />
            <span style={{ fontSize: 10, lineHeight: 1.4, color: MC.textSecondary }}>
              <span style={{ fontWeight: 600, color: MC.text }}>Run on collection</span>
              {' '}
              <span style={{ color: MC.textMuted }}>
                {runOnCollection ? '· every frame, slower' : '· AOI items only'}
              </span>
            </span>
          </label>
        )}
      </Field>

      {/* Class + prompt — for prompted adapters (SAM3-style). Class drives the
          annotation label; the prompt (text and/or drawn bbox exemplars) is
          forwarded to the endpoint. They're intentionally separate — many
          prompts can map to one class. One model serves text / bbox / both. */}
      {isPrompted && (
        <div>
          <button
            type="button"
            onClick={() => setPromptsOpen(!promptsOpen)}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, width: '100%',
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '4px 0', color: MC.textSecondary,
            }}
          >
            {promptsOpen
              ? <ChevronDown size={11} color={MC.textMuted} />
              : <ChevronRight size={11} color={MC.textMuted} />}
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: MC.textMuted,
            }}>
              Class & prompt
              {outputClassId && (() => {
                const c = schemaClasses.find((sc) => sc.id === outputClassId);
                return c ? <span style={{ color: MC.accent }}> · {c.name}</span> : null;
              })()}
              {bboxPrompts.length > 0 && (
                <span style={{ color: MC.accent }}> · {bboxPrompts.length} box{bboxPrompts.length === 1 ? '' : 'es'}</span>
              )}
            </span>
          </button>

          {promptsOpen && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
              {modelSchemaId == null ? (
                <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                  This model has no annotation schema bound. Edit it on /models
                  and pick a schema before running.
                </p>
              ) : schemaClasses.length === 0 ? (
                <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                  The bound schema has no classes — add one first.
                </p>
              ) : (
                <Field label="Output class" hint="Labels every prediction.">
                  <select
                    value={outputClassId}
                    onChange={(e) => setOutputClassId(e.target.value)}
                    style={selectStyle}
                  >
                    <option value="">— pick a class —</option>
                    {schemaClasses.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </Field>
              )}
              {supportsTextPrompt && (
                <Field label="Text prompt (optional)" hint="Free-form prompt sent to the model. Independent from the class above — many prompts can target the same class.">
                  <input
                    value={textPrompt}
                    onChange={(e) => setTextPrompt(e.target.value)}
                    placeholder="e.g. yellow excavator, bulldozer"
                    style={inputStyle}
                  />
                </Field>
              )}
              {supportsBboxPrompt && (
                <Field label="Bbox prompts (optional)" hint="Draw example boxes around target objects. Only patches a box overlaps are sent to the model; boxes are reprojected per patch.">
                  <button
                    type="button"
                    onClick={toggleBboxDraw}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      width: '100%', padding: '6px 8px', borderRadius: 5,
                      fontSize: 10, fontWeight: 600,
                      border: `1px solid ${bboxDrawActive ? MC.accent : MC.border}`,
                      background: bboxDrawActive ? MC.accent : 'transparent',
                      color: bboxDrawActive ? '#fff' : MC.textSecondary,
                      cursor: 'pointer', transition: 'all 0.12s',
                    }}
                  >
                    <Square size={11} />
                    {bboxDrawActive ? 'Drawing… click to stop' : 'Draw bbox on map'}
                  </button>
                  {bboxPrompts.length > 0 && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, marginTop: 6 }}>
                      {bboxPrompts.map((b, i) => (
                        <div key={b.id} style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          fontSize: 10, color: MC.textSecondary,
                          border: `1px solid ${MC.border}`, borderRadius: 4, padding: '3px 6px',
                        }}>
                          <Square size={9} color={MC.accent} />
                          <span style={{ flex: 1, fontFamily: 'monospace' }}>
                            Box {i + 1}: {b.bbox.map((v) => v.toFixed(4)).join(', ')}
                          </span>
                          <button
                            onClick={() => removeBboxPrompt(b.id)}
                            title="Remove box"
                            style={{
                              display: 'flex', background: 'transparent', border: 'none',
                              color: MC.textMuted, cursor: 'pointer', padding: 0,
                            }}
                          >
                            <X size={10} />
                          </button>
                        </div>
                      ))}
                      <button
                        onClick={clearBboxPrompts}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
                          background: 'transparent', border: 'none', color: MC.textMuted,
                          fontSize: 10, cursor: 'pointer', padding: '2px 0',
                        }}
                      >
                        <Trash2 size={9} /> Clear all
                      </button>
                    </div>
                  )}
                </Field>
              )}
            </div>
          )}
        </div>
      )}

      {scaleLocked && trainedScales.length > 1 && (
        <Field label="Scales to scan" hint="Each checked scale scans the whole AOI, so finer scales take longer. Detections are merged across scales.">
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {trainedScales.map((sc) => (
              <label key={sc} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 10, color: MC.textSecondary, cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={scaleSubset.includes(sc)}
                  onChange={(e) => setScaleSubset(
                    e.target.checked ? [...scaleSubset, sc].sort((a, b) => a - b) : scaleSubset.filter((v) => v !== sc),
                  )}
                  style={{ accentColor: MC.accent }}
                />
                {sc} m
              </label>
            ))}
          </div>
        </Field>
      )}

      {/* Patch size / stride overrides — collapsed; both default to the model's own values */}
      <div>
        <button
          type="button"
          onClick={() => setAdvancedOpen(!advancedOpen)}
          aria-expanded={advancedOpen}
          style={{
            display: 'flex', alignItems: 'center', gap: 4, width: '100%',
            background: 'transparent', border: 'none', cursor: 'pointer',
            padding: '4px 0', color: MC.textSecondary,
          }}
        >
          {advancedOpen
            ? <ChevronDown size={11} color={MC.textMuted} />
            : <ChevronRight size={11} color={MC.textMuted} />}
          <span style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: MC.textMuted,
          }}>
            Advanced
            <span style={{ color: patchSizePx != null || stridePx != null ? MC.accent : MC.textMuted, fontWeight: 600 }}>
              {' · '}
              {scaleLocked ? 'locked to trained scale' : patchSizePx != null || stridePx != null
                ? [patchSizePx != null ? `patch ${patchSizePx}px` : null, stridePx != null ? `stride ${stridePx}px` : null]
                    .filter(Boolean).join(', ')
                : 'model defaults'}
            </span>
          </span>
        </button>
        {advancedOpen && scaleLocked && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, paddingTop: 4, fontSize: 10, color: MC.textMuted }}>
            Scans at {trainedScales.join(', ')} m
            <InfoTip size={12} text={`Patch size and stride are fixed by training: this model scans at ${trainedScales.join(', ')} m, the real-world scale${trainedScales.length === 1 ? '' : 's'} of its training tiles.`} />
          </div>
        )}
        {advancedOpen && !scaleLocked && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 4 }}>
      <Field label={`Patch size ${patchSizePx == null ? '(model default)' : `(${patchSizePx}px)`}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range" min={128} max={2048} step={64}
            value={patchSizePx ?? 1024}
            onChange={(e) => setPatchSizePx(Number(e.target.value))}
            disabled={patchSizePx == null}
            style={{ flex: 1, opacity: patchSizePx == null ? 0.5 : 1 }}
          />
          <label style={overrideLabelStyle}>
            <input
              type="checkbox"
              checked={patchSizePx != null}
              onChange={(e) => setPatchSizePx(e.target.checked ? 1024 : null)}
            />
            override
          </label>
        </div>
      </Field>

      <Field label={`Stride ${stridePx == null ? '(model default)' : `(${stridePx}px)`}`}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input
            type="range" min={64} max={2048} step={32}
            value={stridePx ?? Math.min(patchSizePx ?? 1024, 1024)}
            onChange={(e) => setStridePx(Number(e.target.value))}
            disabled={stridePx == null}
            style={{ flex: 1, opacity: stridePx == null ? 0.5 : 1 }}
          />
          <label style={overrideLabelStyle}>
            <input
              type="checkbox"
              checked={stridePx != null}
              onChange={(e) => setStridePx(e.target.checked ? (patchSizePx ?? 1024) : null)}
            />
            override
          </label>
        </div>
      </Field>

          </div>
        )}
      </div>

      {!aoiBbox && (
        <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
          Draw an AOI before running inference.
        </p>
      )}

      {/* Run button */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
      <button
        onClick={() => inferenceMut.mutate()}
        disabled={!canRun}
        style={{
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '8px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600,
          border: `1px solid ${canRun ? MC.accent : MC.border}`,
          background: canRun ? MC.accent : 'transparent',
          color: canRun ? '#fff' : MC.textMuted,
          cursor: canRun ? 'pointer' : 'not-allowed',
          transition: 'all 0.12s',
        }}
      >
        {inferenceMut.isPending
          ? <><Loader2 size={11} className="animate-spin" /> Queueing…</>
          : <><Play size={11} /> Run on AOI</>}
      </button>
      <InfoTip text="Clipped to this AOI; one annotation set per item, mounted as a layer when done." />
      </div>

      {/* Active / completed runs */}
      {runs.length > 0 && (
        <div style={{
          borderTop: `1px dashed ${MC.border}`, paddingTop: 8,
          display: 'flex', flexDirection: 'column', gap: 4,
        }}>
          {runs.map((r) => (
            <RunRow
              key={r.jobId}
              run={r}
              mapId={mapId}
              onDismiss={() => dismissRun(r.jobId)}
              onSetsResolved={handleRunSetsResolved}
            />
          ))}
        </div>
      )}


      {/* ── Train Head ── train a per-class DINOv2 head without leaving the
            map. Collection + class scoped, with an optional AOI restriction
            (see TrainHeadPanel) — lives right below Run Inference since
            that's where training naturally leads. */}
      <TrainHeadPanel mapId={mapId} defaultAoiId={backendAoiId} />

      {/* ── Auto Annotate ── few-shot object detection via SAM3: pick a class
            (same collection + class inputs as Train Head), and it uses a
            handful of that class's existing verified annotations as box
            exemplars, scans this AOI, and mounts the results as a
            reviewable annotation layer. */}
      <AutoAnnotatePanel
        selectedDataset={selectedDataset}
        aoiBbox={aoiBbox}
      />

      {/* ── Embedding Search ── embed a selected annotation / drawn box, then
            search the curated bank or scan this AOI for similar patches. */}
      <EmbeddingSearchPanel
        models={models}
        loadingModels={loadingModels}
        selectedDataset={selectedDataset}
        aoiBbox={aoiBbox}
      />

      {/* ── Anomaly Detection ── embed the annotations a detection model already
            produced for one class in this AOI, then flag the ones least like
            their peers (distance to the class's own embedding centroid). */}
      <AnomalyDetectionPanel
        models={models}
        loadingModels={loadingModels}
        selectedDataset={selectedDataset}
        aoiBbox={aoiBbox}
        detectionSchemaId={selectedModel?.annotation_schema_id ?? null}
      />

    </section>
  );
}

// ── Auto Annotate panel ──────────────────────────────────────────────────────
// Few-shot object detection: pick a verified collection + class (identical
// inputs to Train Head — no manual box-drawing). A handful of that class's
// existing verified annotations become the reference set; each reference's
// own tile gets its bbox as a SAM3 box exemplar, every other AOI tile is
// scanned with SAM3's text-only prompt. No model pickers needed —
// geoops-service loads one fixed SAM3 checkpoint itself. See
// geoops.sam3_tasks.run_sam3_auto_annotate.

interface AutoAnnotatePanelProps {
  selectedDataset: Dataset | undefined;
  aoiBbox: [number, number, number, number] | undefined;
}

function AutoAnnotatePanel({ selectedDataset, aoiBbox }: AutoAnnotatePanelProps) {
  const [open, setOpen] = useState(false);
  const [collectionId, setCollectionId] = useState('');
  const [classId, setClassId] = useState('');
  const [conf, setConf] = useState(0.3);
  const [iouThresh, setIouThresh] = useState(0.3);
  const [topK, setTopK] = useState(50);
  const [jobId, setJobId] = useState<string | null>(null);
  const addAnnotationSetLayer = useMapLayersStore((s) => s.addAnnotationSetLayer);
  const mountedSetIdRef = useRef<string | null>(null);

  const { data: collectionsResp, isLoading: loadingCollections } = useQuery({
    queryKey: annotationSetCollectionsKey(),
    queryFn: () => annotationSetCollectionsApi.list(),
    enabled: open,
  });
  const collections = collectionsResp?.items ?? [];
  const selectedCollection = collections.find((c) => c.id === collectionId);

  const { data: classesResp, isLoading: loadingClasses } = useQuery({
    queryKey: ['auto-annotate-classes', selectedCollection?.schema_id],
    queryFn: () => annotationSchemasApi.getClasses(selectedCollection!.schema_id),
    enabled: open && !!selectedCollection,
  });
  const classes = classesResp?.items ?? [];

  // Dataset items intersecting this AOI — the pool that gets scanned. Same
  // bbox-filtered query Embedding Search uses.
  const { data: itemsResp } = useQuery({
    queryKey: ['auto-annotate-items', selectedDataset?.id, aoiBbox?.join(',')],
    queryFn: () => datasetsApi.listItems(selectedDataset!.id, { bbox: aoiBbox!.join(','), page_size: 50 }),
    enabled: open && !!selectedDataset && !!aoiBbox,
  });
  const items = useMemo<DatasetItem[]>(() => itemsResp?.items ?? [], [itemsResp?.items]);

  useEffect(() => { setJobId(null); mountedSetIdRef.current = null; }, [collectionId, classId]);

  const autoAnnotateMut = useMutation({
    mutationFn: async () => {
      if (!collectionId) throw new Error('Pick a collection');
      if (!classId) throw new Error('Pick a class');
      if (!aoiBbox) throw new Error('Draw an AOI first');
      if (items.length === 0) throw new Error('No dataset items in this AOI');
      return sam3Api.autoAnnotate({
        annotation_set_collection_id: collectionId,
        class_id: classId,
        dataset_item_ids: items.slice(0, 5).map((i) => i.id),
        aoi_bbox: aoiBbox,
        conf,
        iou_thresh: iouThresh,
        top_k: topK,
      });
    },
    onSuccess: (job) => {
      setJobId(job.id);
      toast.success('Auto annotate queued');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to start auto annotate'),
  });

  const { data: job } = useQuery({
    queryKey: ['auto-annotate-job', jobId],
    queryFn: () => sam3Api.getJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 2000;
      return ['pending', 'queued', 'running'].includes(status) ? 2000 : false;
    },
  });

  const result = job?.config?.result;
  const running = !!jobId && ['pending', 'queued', 'running'].includes(job?.status ?? 'pending');

  useEffect(() => {
    if (!result?.annotation_set_id || mountedSetIdRef.current === result.annotation_set_id) return;
    mountedSetIdRef.current = result.annotation_set_id;
    const setId = result.annotation_set_id;
    (async () => {
      try {
        const cls = selectedCollection ? (await annotationSchemasApi.getClasses(selectedCollection.schema_id)).items : [];
        addAnnotationSetLayer({
          setId,
          name: `Auto Annotate (${result.matches.length})`,
          datasetId: selectedDataset?.id,
          classStyles: buildClassStyles(cls),
        });
        toast.success(`${result.matches.length} candidates added as a map layer`);
      } catch (err) {
        toast.error(`Failed to mount results layer: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    })();
  }, [result, selectedCollection, selectedDataset?.id, addAnnotationSetLayer]);

  const canRun = !!collectionId && !!classId && !!aoiBbox && items.length > 0
    && !autoAnnotateMut.isPending && !running;

  return (
    <section style={{ borderTop: `1px dashed ${MC.border}`, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: 1,
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
        }}
      >
        {open ? <ChevronDown size={11} color={MC.textMuted} /> : <ChevronRight size={11} color={MC.textMuted} />}
        <Sparkles size={11} color={MC.accent} />
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: MC.sectionLabel,
        }}>
          Auto Annotate
        </span>
      </button>
      <InfoTip text="Few-shot object detection via SAM3: pick a class, and a handful of its existing verified examples become box exemplars for a scan over this AOI. No manual box-drawing, no model picker." />
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
          <Field label="Verified annotation collection">
            {loadingCollections ? (
              <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading…</p>
            ) : collections.length === 0 ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                No annotation set collections found.
              </p>
            ) : (
              <select
                value={collectionId}
                onChange={(e) => { setCollectionId(e.target.value); setClassId(''); }}
                style={selectStyle}
              >
                <option value="">— pick a collection —</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Field>

          {collectionId && (
            <Field label="Class" hint="Its examples become the references.">
              {loadingClasses ? (
                <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading…</p>
              ) : classes.length === 0 ? (
                <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                  This collection&apos;s schema has no classes.
                </p>
              ) : (
                <select value={classId} onChange={(e) => setClassId(e.target.value)} style={selectStyle}>
                  <option value="">— pick a class —</option>
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </Field>
          )}

          {!aoiBbox ? (
            <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
              Draw an AOI to pick which dataset items get scanned.
            </p>
          ) : items.length === 0 ? (
            <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
              No items intersect this AOI.
            </p>
          ) : null}

          <div style={{ display: 'flex', gap: 6 }}>
            <Field label="Confidence threshold" hint="Lower confidence surfaces more, weaker candidates.">
              <input
                type="number" min={0} max={1} step={0.05} value={conf}
                onChange={(e) => setConf(Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
                style={inputStyle}
              />
            </Field>
            <Field label="NMS overlap threshold" hint="Lower overlap merges more aggressively: fewer near-duplicate boxes from overlapping tiles.">
              <input
                type="number" min={0} max={1} step={0.05} value={iouThresh}
                onChange={(e) => setIouThresh(Math.min(1, Math.max(0, Number(e.target.value) || 0)))}
                style={inputStyle}
              />
            </Field>
          </div>
          <Field label="Max results" hint="How many of the closest matches to return (top_k).">
            <input
              type="number" min={1} max={500} value={topK}
              onChange={(e) => setTopK(Math.min(500, Math.max(1, Number(e.target.value) || 1)))}
              style={inputStyle}
            />
          </Field>

          {jobId && (
            <div style={{
              border: `1px solid ${MC.border}`, borderRadius: 5, padding: '6px 8px',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: MC.textMuted }}>
                {job?.status === 'failed'
                  ? <AlertCircle size={11} color="#dc2626" />
                  : job?.status === 'completed'
                    ? <CheckCircle2 size={11} color="#16a34a" />
                    : <Loader2 size={11} className="animate-spin" color={MC.accent} />}
                <span>
                  {job?.status ?? 'queued'}
                  {running && job && job.total_items > 0 ? ` · ${job.processed_items}/${job.total_items} tiles` : ''}
                </span>
              </div>
              {job?.status === 'failed' && job.logs && (
                <div style={{ fontSize: 10, color: '#dc2626', fontFamily: 'monospace' }}>{job.logs.slice(0, 200)}</div>
              )}
              {result && (
                <>
                  <span style={{ fontSize: 10, color: MC.textMuted }}>
                    {result.references_used} references · {result.patches_scanned} tiles scanned ·{' '}
                    {result.candidates_before_nms} candidates → {result.matches.length} after merge
                    {result.patches_truncated ? ' · truncated (raise max_patches)' : ''}
                  </span>
                  <span style={{ fontSize: 10, color: MC.textMuted }}>
                    ~{result.meters_per_pixel.toFixed(2)} m/px · {result.object_px}px objects ·{' '}
                    {(result.overlap_ratio * 100).toFixed(0)}% overlap
                  </span>
                  {result.matches.map((m) => (
                    <div key={`${m.dataset_item_id}-${m.bbox.join(',')}`} style={{
                      fontSize: 10, color: MC.textSecondary, fontFamily: 'monospace',
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>{m.dataset_item_id.slice(0, 8)}… {m.used_box_exemplar ? '(box)' : '(text)'}</span>
                      <span>{(m.score * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

          <button
            type="button"
            onClick={() => autoAnnotateMut.mutate()}
            disabled={!canRun}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600,
              border: `1px solid ${canRun ? MC.accent : MC.border}`,
              background: canRun ? MC.accent : 'transparent',
              color: canRun ? '#fff' : MC.textMuted,
              cursor: canRun ? 'pointer' : 'not-allowed',
            }}
          >
            {autoAnnotateMut.isPending || running
              ? <><Loader2 size={11} className="animate-spin" /> Running…</>
              : <><Sparkles size={11} /> Auto Annotate</>}
          </button>
        </div>
      )}
    </section>
  );
}

// ── Embedding Search panel ───────────────────────────────────────────────────
// Embeds one reference selection (a drawn box, or best-effort the currently
// selected annotation's own geometry), then either searches the curated
// embedding bank instantly or kicks off an AOI similarity scan (async job —
// multi-tile HTTP work doesn't belong inline in a request). Follows the same
// model-picker + mutation + job-polling conventions as RunRow above, just
// against geoops' /embeddings endpoints instead of /inference.

// Picks the schema + class that scan/detection *results* get persisted under
// (a new annotation_set, source_type='analysis' — see
// embedding_search_changed.md). Independent of any input-side class picker
// (e.g. AnomalyDetectionPanel's own "class to scan") — this is purely about
// how the output gets tagged and colored once mounted as a map layer.
interface SchemaClassPickerProps {
  schemaId: string;
  classId: string;
  onSchemaChange: (id: string) => void;
  onClassChange: (id: string) => void;
}

function SchemaClassPicker({ schemaId, classId, onSchemaChange, onClassChange }: SchemaClassPickerProps) {
  const { data: schemasResp, isLoading: loadingSchemas } = useQuery({
    queryKey: ['embed-output-schemas'],
    queryFn: () => annotationSchemasApi.list(100, 0),
  });
  const schemas = useMemo(() => schemasResp?.items ?? [], [schemasResp?.items]);

  useEffect(() => {
    if (schemaId && schemas.some((s) => s.id === schemaId)) return;
    onSchemaChange(schemas[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [schemas, schemaId]);

  const { data: classesResp, isLoading: loadingClasses } = useQuery({
    queryKey: ['embed-output-classes', schemaId],
    queryFn: () => annotationSchemasApi.getClasses(schemaId),
    enabled: !!schemaId,
  });
  const classes = useMemo(() => classesResp?.items ?? [], [classesResp?.items]);

  useEffect(() => {
    if (classId && classes.some((c) => c.id === classId)) return;
    onClassChange(classes[0]?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [classes, classId]);

  return (
    <>
      <Field label="Output schema" hint="Results are tagged + colored via this.">
        {loadingSchemas ? (
          <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>Loading…</p>
        ) : schemas.length === 0 ? (
          <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
            No annotation schemas — create one first.
          </p>
        ) : (
          <select value={schemaId} onChange={(e) => onSchemaChange(e.target.value)} style={selectStyle}>
            {schemas.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>
        )}
      </Field>
      <Field label="Output class">
        {loadingClasses ? (
          <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>Loading…</p>
        ) : classes.length === 0 ? (
          <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
            {schemaId ? 'This schema has no classes yet.' : 'Pick a schema first.'}
          </p>
        ) : (
          <select value={classId} onChange={(e) => onClassChange(e.target.value)} style={selectStyle}>
            {classes.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        )}
      </Field>
    </>
  );
}

function bboxToPolygon(bbox: [number, number, number, number]): Record<string, unknown> {
  const [w, s, e, n] = bbox;
  return {
    type: 'Polygon',
    coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]],
  };
}

interface EmbeddingSearchPanelProps {
  models: AIModel[];
  loadingModels: boolean;
  selectedDataset: Dataset | undefined;
  aoiBbox: [number, number, number, number] | undefined;
}

function EmbeddingSearchPanel({
  models, loadingModels, selectedDataset, aoiBbox,
}: EmbeddingSearchPanelProps) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [targetItemId, setTargetItemId] = useState('');
  const [embedding, setEmbedding] = useState<EmbeddingRead | null>(null);
  const [searchResults, setSearchResults] = useState<
    { embedding_id: string; dataset_item_id: string; similarity: number }[] | null
  >(null);
  const [scanJobId, setScanJobId] = useState<string | null>(null);
  const [outputSchemaId, setOutputSchemaId] = useState('');
  const [outputClassId, setOutputClassId] = useState('');

  const refDrawActive = useMapLayersStore((s) => s.embedRefDrawMode);
  const capturedRefBbox = useMapLayersStore((s) => s.capturedEmbedRefBbox);
  const selectedFeature = useMapLayersStore((s) => s.selectedFeature);
  const addAnnotationSetLayer = useMapLayersStore((s) => s.addAnnotationSetLayer);
  const refOverlayRef = useRef<LType.Rectangle | null>(null);
  const mountedSetIdRef = useRef<string | null>(null);
  const [refBbox, setRefBbox] = useState<[number, number, number, number] | null>(null);

  // Embedding models are ai_models pointed at an endpoint that returns
  // {model_name, embedding_dim, embedding} — tagged type:"embedding" at
  // registration. Deliberately NOT falling back to the full model list: a
  // detection/inference model auto-selected here would silently 404/500
  // against /embeddings once clicked, several steps downstream of the pick.
  // Require an explicit embedding-tagged model or leave the flow disabled.
  const embeddingModels = useMemo(
    () => models.filter((m) => m.type === 'embedding'),
    [models],
  );

  useEffect(() => {
    if (modelId && embeddingModels.some((m) => m.id === modelId)) return;
    setModelId(embeddingModels[0]?.id ?? '');
  }, [embeddingModels, modelId]);

  // Dataset items intersecting this AOI — the pool the user picks a target
  // image from (to crop the reference patch out of) and the pool scanned.
  // (datasets.py's /datasets/{id}/items previously ignored `bbox` entirely —
  // fixed there directly rather than routing through the maps-scoped in-aoi
  // endpoint, since that requires the dataset to be mounted as a MapLayer on
  // this specific map, which the freeform "Dataset" picker above doesn't
  // guarantee — regular inference runs against any org dataset regardless.)
  const { data: itemsResp } = useQuery({
    queryKey: ['embed-panel-items', selectedDataset?.id, aoiBbox?.join(',')],
    queryFn: () => datasetsApi.listItems(selectedDataset!.id, {
      bbox: aoiBbox!.join(','), page_size: 50,
    }),
    enabled: open && !!selectedDataset && !!aoiBbox,
  });
  const items = useMemo<DatasetItem[]>(() => itemsResp?.items ?? [], [itemsResp?.items]);

  useEffect(() => {
    if (targetItemId && items.some((i) => i.id === targetItemId)) return;
    setTargetItemId(items[0]?.id ?? '');
  }, [items, targetItemId]);

  // Reset the whole workflow when the reference or target changes so a stale
  // embedding_id can't be searched/scanned against the wrong selection.
  useEffect(() => {
    setEmbedding(null);
    setSearchResults(null);
    setScanJobId(null);
    mountedSetIdRef.current = null;
  }, [refBbox, targetItemId, modelId]);

  // ── Draw-box reference ───────────────────────────────────────────────────
  const toggleRefDraw = useCallback(() => {
    const store = useMapLayersStore.getState();
    if (store.embedRefDrawMode) {
      store.setEmbedRefDrawMode(false);
      useMapStore.getState().setActiveDrawTool(null);
    } else {
      store.setEmbedRefDrawMode(true);
      useMapStore.getState().setActiveDrawTool('rectangle');
    }
  }, []);

  useEffect(() => {
    if (!capturedRefBbox) return;
    const bbox = capturedRefBbox;
    useMapLayersStore.getState().setCapturedEmbedRefBbox(null);
    setRefBbox(bbox);
    (async () => {
      const L: typeof LType = (await import('leaflet')).default;
      const map = getMapManager().getMap();
      if (!map) return;
      refOverlayRef.current?.remove();
      const [W, S, E, N] = bbox;
      const rect = L.rectangle([[S, W], [N, E]], {
        color: MC.accent, weight: 1.5, fillColor: MC.accent, fillOpacity: 0.1, interactive: false,
      });
      rect.addTo(map);
      refOverlayRef.current = rect;
    })();
  }, [capturedRefBbox]);

  // Best-effort: use the currently selected annotation's own geometry as the
  // reference instead of drawing a new box. MVT-sourced features don't
  // always expose a working toGeoJSON() — falls through to "draw a box" when
  // it doesn't.
  const useSelectedAnnotation = useCallback(() => {
    const layer = selectedFeature?.layerRef as (LType.Layer & { toGeoJSON?: () => { geometry?: GeoJSONGeometry } }) | undefined;
    const geom = layer?.toGeoJSON?.()?.geometry;
    if (!geom || geom.type !== 'Polygon') {
      toast.error('Could not read this annotation’s geometry — try drawing a box instead');
      return;
    }
    const coords = geom.coordinates[0];
    const lons = coords.map((c) => c[0]);
    const lats = coords.map((c) => c[1]);
    setRefBbox([Math.min(...lons), Math.min(...lats), Math.max(...lons), Math.max(...lats)]);
  }, [selectedFeature]);

  // Tear down the reference-box overlay on unmount. Match results are now a
  // real mounted annotation layer (see the mount effect below), not a
  // component-owned overlay, so they persist independently of this panel.
  useEffect(() => {
    return () => {
      refOverlayRef.current?.remove();
      if (useMapLayersStore.getState().embedRefDrawMode) {
        useMapLayersStore.getState().setEmbedRefDrawMode(false);
        useMapStore.getState().setActiveDrawTool(null);
      }
    };
  }, []);

  // ── Embed the reference ──────────────────────────────────────────────────
  const embedMut = useMutation({
    mutationFn: async () => {
      if (!modelId) throw new Error('Pick an embedding model');
      if (!targetItemId) throw new Error('Pick a target dataset item');
      if (!refBbox) throw new Error('Draw a box or select an annotation first');
      const annotationId = selectedFeature?.featureType?.includes('annotation')
        ? selectedFeature.featureId
        : undefined;
      return embeddingsApi.create({
        model_id: modelId,
        dataset_item_id: targetItemId,
        geometry: bboxToPolygon(refBbox),
        annotation_id: annotationId,
      });
    },
    onSuccess: (row) => {
      setEmbedding(row);
      toast.success(`Embedded — scale tier ${row.tile_tier}`);
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : 'Failed to create embedding');
    },
  });

  // ── Search the curated bank (synchronous) ────────────────────────────────
  const searchMut = useMutation({
    mutationFn: async () => {
      if (!embedding) throw new Error('Embed a reference first');
      return embeddingsApi.search({ embedding_id: embedding.id, top_k: 10 });
    },
    onSuccess: (matches) => setSearchResults(matches),
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Search failed'),
  });

  // ── AOI scan (async job) ─────────────────────────────────────────────────
  const scanMut = useMutation({
    mutationFn: async () => {
      if (!embedding) throw new Error('Embed a reference first');
      if (!aoiBbox) throw new Error('Draw an AOI first');
      if (items.length === 0) throw new Error('No dataset items in this AOI');
      if (!outputClassId) throw new Error('Pick an output schema + class first');
      const job = await embeddingsApi.aoiScan({
        reference_embedding_id: embedding.id,
        dataset_item_ids: items.slice(0, 5).map((i) => i.id),
        aoi_bbox: aoiBbox,
        output_class_id: outputClassId,
      });
      return job;
    },
    onSuccess: (job) => {
      setScanJobId(job.id);
      toast.success('AOI scan queued');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to start AOI scan'),
  });

  const { data: scanJob } = useQuery({
    queryKey: ['embed-aoi-scan-job', scanJobId],
    queryFn: () => embeddingsApi.getJob(scanJobId!),
    enabled: !!scanJobId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 2000;
      return ['pending', 'queued', 'running'].includes(status) ? 2000 : false;
    },
  });

  const scanResult = scanJob?.config?.result;

  // Mount the backend-persisted matches (a real annotation_set, source_type=
  // 'analysis') as a normal annotation layer — same mechanism RunRow uses for
  // inference results — instead of drawing throwaway rectangles ourselves.
  // Gets the layer list entry, visibility/opacity controls, and the existing
  // confidence-heatmap visualization mode (matches' similarity score is
  // stored as Annotation.confidence) for free.
  useEffect(() => {
    if (!scanResult?.annotation_set_id || mountedSetIdRef.current === scanResult.annotation_set_id) return;
    mountedSetIdRef.current = scanResult.annotation_set_id;
    const setId = scanResult.annotation_set_id;
    (async () => {
      try {
        const classes = outputSchemaId ? (await annotationSchemasApi.getClasses(outputSchemaId)).items : [];
        addAnnotationSetLayer({
          setId,
          name: `Embedding Search (${scanResult.matches.length})`,
          datasetId: selectedDataset?.id,
          classStyles: buildClassStyles(classes),
        });
        toast.success(`${scanResult.matches.length} matches added as a map layer`);
      } catch (err) {
        toast.error(`Failed to mount results layer: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    })();
  }, [scanResult, outputSchemaId, selectedDataset?.id, addAnnotationSetLayer]);

  const canEmbed = !!modelId && !!targetItemId && !!refBbox && !embedMut.isPending;
  const scanning = !!scanJobId && ['pending', 'queued', 'running'].includes(scanJob?.status ?? 'pending');

  return (
    <section style={{ borderTop: `1px dashed ${MC.border}`, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: 1,
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
        }}
      >
        {open ? <ChevronDown size={11} color={MC.textMuted} /> : <ChevronRight size={11} color={MC.textMuted} />}
        <Search size={11} color={MC.accent} />
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: MC.sectionLabel,
        }}>
          Embedding Search
        </span>
      </button>
      <InfoTip text="Search compares only same-scale embeddings — a small object never matches a much larger one just because both were cropped to the same patch size. Scanning an overlapping AOI again reuses tiles already embedded instead of redoing the work." />
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
          <Field label="Embedding model">
            {loadingModels ? (
              <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading…</p>
            ) : embeddingModels.length === 0 ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                No embedding model registered — add one with type &quot;embedding&quot; on
                the Models page before embedding, searching, or scanning.
              </p>
            ) : (
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={selectStyle}>
                {embeddingModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Target dataset item" hint="Cropped from this image.">
            {!selectedDataset || !aoiBbox ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                Pick a dataset and draw an AOI first.
              </p>
            ) : items.length === 0 ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                No items intersect this AOI.
              </p>
            ) : (
              <select value={targetItemId} onChange={(e) => setTargetItemId(e.target.value)} style={selectStyle}>
                {items.map((it) => (
                  <option key={it.id} value={it.id}>{it.stac_item_id}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Reference selection">
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                type="button"
                onClick={toggleRefDraw}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '6px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${refDrawActive ? MC.accent : MC.border}`,
                  background: refDrawActive ? MC.accent : 'transparent',
                  color: refDrawActive ? '#fff' : MC.textSecondary, cursor: 'pointer',
                }}
              >
                <Square size={10} />
                {refDrawActive ? 'Drawing…' : 'Draw box'}
              </button>
              <button
                type="button"
                onClick={useSelectedAnnotation}
                disabled={!selectedFeature}
                title={selectedFeature ? 'Use the currently selected annotation' : 'Select an annotation on the map first'}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '6px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${MC.border}`, background: 'transparent',
                  color: selectedFeature ? MC.textSecondary : MC.textMuted,
                  cursor: selectedFeature ? 'pointer' : 'not-allowed',
                }}
              >
                Use selected annotation
              </button>
            </div>
            {refBbox && (
              <p style={{ fontSize: 10, color: MC.textMuted, marginTop: 4, fontFamily: 'monospace' }}>
                {refBbox.map((v) => v.toFixed(4)).join(', ')}
              </p>
            )}
          </Field>

          <button
            onClick={() => embedMut.mutate()}
            disabled={!canEmbed}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600,
              border: `1px solid ${canEmbed ? MC.accent : MC.border}`,
              background: canEmbed ? MC.accent : 'transparent',
              color: canEmbed ? '#fff' : MC.textMuted, cursor: canEmbed ? 'pointer' : 'not-allowed',
            }}
          >
            {embedMut.isPending
              ? <><Loader2 size={11} className="animate-spin" /> Embedding…</>
              : <><Zap size={11} /> Embed reference</>}
          </button>

          {embedding && (
            <SchemaClassPicker
              schemaId={outputSchemaId}
              classId={outputClassId}
              onSchemaChange={setOutputSchemaId}
              onClassChange={setOutputClassId}
            />
          )}

          {embedding && (
            <div style={{ display: 'flex', gap: 6 }}>
              <button
                onClick={() => searchMut.mutate()}
                disabled={searchMut.isPending}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '6px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${MC.accent}`, background: 'transparent',
                  color: MC.accent, cursor: 'pointer',
                }}
              >
                {searchMut.isPending ? <Loader2 size={11} className="animate-spin" /> : <Search size={11} />}
                Search bank
              </button>
              <button
                onClick={() => scanMut.mutate()}
                disabled={scanMut.isPending || scanning || !outputClassId}
                title={!outputClassId ? 'Pick an output schema + class first' : undefined}
                style={{
                  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                  padding: '6px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600,
                  border: `1px solid ${MC.accent}`,
                  background: outputClassId ? MC.accent : 'transparent',
                  color: outputClassId ? '#fff' : MC.textMuted,
                  cursor: outputClassId ? 'pointer' : 'not-allowed',
                }}
              >
                {scanMut.isPending || scanning
                  ? <Loader2 size={11} className="animate-spin" />
                  : <Scan size={11} />}
                Scan AOI
              </button>
            </div>
          )}

          {searchResults && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: MC.textMuted, textTransform: 'uppercase' }}>
                Bank matches ({searchResults.length})
              </span>
              {searchResults.length === 0 ? (
                <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                  No similar embeddings at this scale yet.
                </p>
              ) : searchResults.map((m) => (
                <div key={m.embedding_id} style={{
                  fontSize: 10, color: MC.textSecondary, fontFamily: 'monospace',
                  display: 'flex', justifyContent: 'space-between',
                }}>
                  <span>{m.dataset_item_id.slice(0, 8)}…</span>
                  <span>{(m.similarity * 100).toFixed(0)}%</span>
                </div>
              ))}
            </div>
          )}

          {scanJobId && (
            <div style={{
              border: `1px solid ${MC.border}`, borderRadius: 5, padding: '6px 8px',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: MC.textMuted }}>
                {scanJob?.status === 'failed'
                  ? <AlertCircle size={11} color="#dc2626" />
                  : scanJob?.status === 'completed'
                    ? <CheckCircle2 size={11} color="#16a34a" />
                    : <Loader2 size={11} className="animate-spin" color={MC.accent} />}
                <span>
                  {scanJob?.status ?? 'queued'}
                  {scanning && scanJob && scanJob.total_items > 0
                    ? ` · ${scanJob.processed_items}/${scanJob.total_items} new tiles`
                    : ''}
                </span>
              </div>
              {scanJob?.status === 'failed' && scanJob.logs && (
                <div style={{ fontSize: 10, color: '#dc2626', fontFamily: 'monospace' }}>
                  {scanJob.logs.slice(0, 200)}
                </div>
              )}
              {scanResult && (
                <>
                  <span style={{ fontSize: 10, color: MC.textMuted }}>
                    {scanResult.patches_scanned} scanned · {scanResult.patches_cached} cached ·{' '}
                    {scanResult.patches_embedded} newly embedded
                    {scanResult.patches_truncated ? ' · truncated (raise max_patches)' : ''}
                  </span>
                  {scanResult.matches.map((m) => (
                    <div key={`${m.dataset_item_id}-${m.bbox.join(',')}`} style={{
                      fontSize: 10, color: MC.textSecondary, fontFamily: 'monospace',
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>{m.dataset_item_id.slice(0, 8)}…</span>
                      <span>{(m.similarity * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

        </div>
      )}
    </section>
  );
}

// ── Anomaly Detection panel ──────────────────────────────────────────────────
// Embeds only annotations a model already produced for one class in this AOI
// (AnnotationSet.source_type === 'model' — never tiles empty space the way
// aoi-scan does), groups them by scale tier, and ranks by cosine distance to
// each group's centroid: annotations least like their peers surface first.
// Same job-as-async-Celery-task convention as EmbeddingSearchPanel's scan.

interface AnomalyDetectionPanelProps {
  models: AIModel[];
  loadingModels: boolean;
  selectedDataset: Dataset | undefined;
  aoiBbox: [number, number, number, number] | undefined;
  /** annotation_schema_id of the detection model chosen in the main "Model"
   *  picker above — the class list is scoped to whatever schema that model's
   *  own annotation runs use, since that's the class of annotations actually
   *  present in this AOI to scan. */
  detectionSchemaId: string | null;
}

function AnomalyDetectionPanel({
  models, loadingModels, selectedDataset, aoiBbox, detectionSchemaId,
}: AnomalyDetectionPanelProps) {
  const [open, setOpen] = useState(false);
  const [modelId, setModelId] = useState('');
  const [classId, setClassId] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const [outputSchemaId, setOutputSchemaId] = useState('');
  const [outputClassId, setOutputClassId] = useState('');
  const addAnnotationSetLayer = useMapLayersStore((s) => s.addAnnotationSetLayer);
  const mountedSetIdRef = useRef<string | null>(null);

  // No fallback to untagged models here either — same reasoning as
  // EmbeddingSearchPanel: an accidental non-embedding model pick would only
  // fail once "Detect anomalies" is clicked, not when it's selected.
  const embeddingModels = useMemo(() => models.filter((m) => m.type === 'embedding'), [models]);

  useEffect(() => {
    if (modelId && embeddingModels.some((m) => m.id === modelId)) return;
    setModelId(embeddingModels[0]?.id ?? '');
  }, [embeddingModels, modelId]);

  const { data: classesResp } = useQuery({
    queryKey: ['anomaly-panel-classes', detectionSchemaId],
    queryFn: () => annotationSchemasApi.getClasses(detectionSchemaId as string),
    enabled: open && !!detectionSchemaId,
  });
  const classes = useMemo(() => classesResp?.items ?? [], [classesResp?.items]);

  useEffect(() => {
    if (classId && classes.some((c) => c.id === classId)) return;
    setClassId(classes[0]?.id ?? '');
  }, [classes, classId]);

  useEffect(() => { setJobId(null); mountedSetIdRef.current = null; }, [classId, modelId]);

  // Dataset items intersecting this AOI — same pool passed to the backend as
  // dataset_item_ids (capped at 5, same as aoi-scan) so the query only ever
  // looks at annotations on items actually shown in this AOI.
  const { data: itemsResp } = useQuery({
    queryKey: ['anomaly-panel-items', selectedDataset?.id, aoiBbox?.join(',')],
    queryFn: () => datasetsApi.listItems(selectedDataset!.id, {
      bbox: aoiBbox!.join(','), page_size: 50,
    }),
    enabled: open && !!selectedDataset && !!aoiBbox,
  });
  const itemIds = useMemo(() => (itemsResp?.items ?? []).map((i) => i.id), [itemsResp?.items]);

  const detectMut = useMutation({
    mutationFn: async () => {
      if (!modelId) throw new Error('Pick an embedding model');
      if (!classId) throw new Error('Pick an annotation class');
      if (itemIds.length === 0) throw new Error('No dataset items in this AOI');
      if (!aoiBbox) throw new Error('Draw an AOI first');
      if (!outputClassId) throw new Error('Pick an output schema + class first');
      return embeddingsApi.anomalyScan({
        class_id: classId,
        model_id: modelId,
        dataset_item_ids: itemIds.slice(0, 5),
        aoi_bbox: aoiBbox,
        output_class_id: outputClassId,
      });
    },
    onSuccess: (job) => {
      setJobId(job.id);
      toast.success('Anomaly detection queued');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to start anomaly detection'),
  });

  const { data: job } = useQuery({
    queryKey: ['anomaly-job', jobId],
    queryFn: () => embeddingsApi.getAnomalyJob(jobId!),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 2000;
      return ['pending', 'queued', 'running'].includes(status) ? 2000 : false;
    },
  });

  const result = job?.config?.result;
  const detecting = !!jobId && ['pending', 'queued', 'running'].includes(job?.status ?? 'pending');

  // Mount the backend-persisted flagged annotations (a real annotation_set,
  // source_type='analysis') as a normal annotation layer — same mechanism
  // RunRow uses for inference results — instead of drawing throwaway
  // rectangles ourselves. anomaly_score is stored as Annotation.confidence,
  // so the existing confidence-heatmap visualization mode already makes the
  // strangest ones stand out once this layer is selected.
  useEffect(() => {
    if (!result?.annotation_set_id || mountedSetIdRef.current === result.annotation_set_id) return;
    mountedSetIdRef.current = result.annotation_set_id;
    const setId = result.annotation_set_id;
    (async () => {
      try {
        const classes = outputSchemaId ? (await annotationSchemasApi.getClasses(outputSchemaId)).items : [];
        addAnnotationSetLayer({
          setId,
          name: `Anomaly Detection (${result.anomalies.length})`,
          datasetId: selectedDataset?.id,
          classStyles: buildClassStyles(classes),
        });
        toast.success(`${result.anomalies.length} anomalies added as a map layer`);
      } catch (err) {
        toast.error(`Failed to mount results layer: ${err instanceof Error ? err.message : 'unknown error'}`);
      }
    })();
  }, [result, outputSchemaId, selectedDataset?.id, addAnnotationSetLayer]);

  const canDetect = !!modelId && !!classId && !!aoiBbox && !detectMut.isPending && !detecting;

  return (
    <section style={{ borderTop: `1px dashed ${MC.border}`, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: 1,
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
        }}
      >
        {open ? <ChevronDown size={11} color={MC.textMuted} /> : <ChevronRight size={11} color={MC.textMuted} />}
        <AlertTriangle size={11} color="#dc2626" />
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: MC.sectionLabel,
        }}>
          Anomaly Detection
        </span>
      </button>
      <InfoTip text="Only embeds annotations the detection model already produced for this class — never tiles empty space. Each annotation is embedded once and reused across future runs." />
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
          <Field label="Embedding model">
            {loadingModels ? (
              <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading…</p>
            ) : embeddingModels.length === 0 ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                No embedding model registered — add one with type &quot;embedding&quot; on
                the Models page before running anomaly detection.
              </p>
            ) : (
              <select value={modelId} onChange={(e) => setModelId(e.target.value)} style={selectStyle}>
                {embeddingModels.map((m) => (
                  <option key={m.id} value={m.id}>{m.name}</option>
                ))}
              </select>
            )}
          </Field>

          <Field label="Annotation class">
            {!detectionSchemaId ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                Pick a detection model with a bound schema above first.
              </p>
            ) : classes.length === 0 ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                Bound schema has no classes.
              </p>
            ) : (
              <select value={classId} onChange={(e) => setClassId(e.target.value)} style={selectStyle}>
                {classes.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
            )}
          </Field>

          <SchemaClassPicker
            schemaId={outputSchemaId}
            classId={outputClassId}
            onSchemaChange={setOutputSchemaId}
            onClassChange={setOutputClassId}
          />

          <button
            onClick={() => detectMut.mutate()}
            disabled={!canDetect || !outputClassId}
            title={!outputClassId ? 'Pick an output schema + class first' : undefined}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              padding: '6px 10px', borderRadius: 5, fontSize: 11, fontWeight: 600,
              border: `1px solid ${canDetect && outputClassId ? '#dc2626' : MC.border}`,
              background: canDetect && outputClassId ? '#dc2626' : 'transparent',
              color: canDetect && outputClassId ? '#fff' : MC.textMuted,
              cursor: canDetect && outputClassId ? 'pointer' : 'not-allowed',
            }}
          >
            {detectMut.isPending || detecting
              ? <><Loader2 size={11} className="animate-spin" /> Detecting…</>
              : <><AlertTriangle size={11} /> Detect anomalies</>}
          </button>

          {jobId && (
            <div style={{
              border: `1px solid ${MC.border}`, borderRadius: 5, padding: '6px 8px',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: MC.textMuted }}>
                {job?.status === 'failed'
                  ? <AlertCircle size={11} color="#dc2626" />
                  : job?.status === 'completed'
                    ? <CheckCircle2 size={11} color="#16a34a" />
                    : <Loader2 size={11} className="animate-spin" color={MC.accent} />}
                <span>
                  {job?.status ?? 'queued'}
                  {detecting && job && job.total_items > 0
                    ? ` · ${job.processed_items}/${job.total_items} new embeds`
                    : ''}
                </span>
              </div>
              {job?.status === 'failed' && job.logs && (
                <div style={{ fontSize: 10, color: '#dc2626', fontFamily: 'monospace' }}>
                  {job.logs.slice(0, 200)}
                </div>
              )}
              {result && (
                <>
                  <span style={{ fontSize: 10, color: MC.textMuted }}>
                    {result.annotations_scanned} scanned · {result.annotations_cached} already embedded ·{' '}
                    {result.annotations_embedded} newly embedded
                    {result.annotations_truncated ? ' · truncated (raise max_new_embeddings)' : ''}
                  </span>
                  {result.groups.map((g) => (
                    <span key={g.tile_tier} style={{ fontSize: 10, color: MC.textMuted }}>
                      tier {g.tile_tier}: {g.group_size} annotation{g.group_size === 1 ? '' : 's'}
                      {!g.scored ? ' (too few to score)' : ''}
                    </span>
                  ))}
                  <span style={{ fontSize: 10, fontWeight: 700, color: MC.textMuted, textTransform: 'uppercase' }}>
                    Anomalies ({result.anomalies.length})
                  </span>
                  {result.anomalies.length === 0 ? (
                    <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                      Nothing stood out from its peers.
                    </p>
                  ) : result.anomalies.map((a) => (
                    <div key={a.annotation_id} style={{
                      fontSize: 10, color: MC.textSecondary, fontFamily: 'monospace',
                      display: 'flex', justifyContent: 'space-between',
                    }}>
                      <span>{a.annotation_id.slice(0, 8)}…</span>
                      <span>{(a.anomaly_score * 100).toFixed(0)}%</span>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}

        </div>
      )}
    </section>
  );
}

// ── Train Head panel (DINOv2 tier) ────────────────────────────────────────────
// Trains one small detection head per class on a shared, frozen DINOv2
// backbone — no AOI/dataset scoping needed (unlike the panels above), just a
// verified AnnotationSetCollection + class. Lives here (not a separate page)
// so training doesn't require leaving the map. Same model-picker + mutation +
// job-polling conventions as the other panels in this file.

interface ModelTrainingMeta {
  dataset?: {
    name?: string;
    build_no?: number;
    annotations?: number;
    splits?: Record<'train' | 'eval' | 'test', { tiles: number }>;
  };
  eval_metrics?: { ap50?: number | null; accuracy?: number | null; f1?: number | null };
  best_epoch?: number | null;
}

/** What the model was trained on, right under the model picker: scale(s),
 *  dataset size and headline metric — the scan uses exactly these scales. */
function ModelTrainingSummary({ scales, training }: { scales: number[]; training?: ModelTrainingMeta }) {
  const sp = training?.dataset?.splits;
  const m = training?.eval_metrics;
  const parts = [
    `Scans at ${scales.join(', ')} m (as trained)`,
    sp ? `${sp.train.tiles + sp.eval.tiles + sp.test.tiles} tiles (${sp.train.tiles}/${sp.eval.tiles}/${sp.test.tiles})` : null,
    training?.dataset?.annotations != null ? `${training.dataset.annotations} objects` : null,
    m?.ap50 != null ? `AP50 ${m.ap50.toFixed(2)}` : m?.accuracy != null ? `acc ${m.accuracy.toFixed(2)}` : null,
    training?.dataset?.build_no != null ? `dataset b${training.dataset.build_no}` : null,
    'bands RGB 1-3',
  ].filter(Boolean);
  return <div style={{ fontSize: 10, color: MC.textMuted, marginTop: 3, lineHeight: 1.4 }}>{parts.join(' · ')}</div>;
}

function TrainHeadPanel({ mapId, defaultAoiId }: { mapId?: string; defaultAoiId?: string }) {
  const [open, setOpen] = useState(false);
  const [collectionId, setCollectionId] = useState('');
  const [classId, setClassId] = useState('');
  const [aoiId, setAoiId] = useState('');
  const [task, setTask] = useState<'detect' | 'classify' | 'segment' | 'yolo'>('detect');
  const [epochs, setEpochs] = useState(60);
  // Training hyperparameters, editable in the dataset workspace dialog. The
  // split fractions and tile scale are NOT here: they belong to the dataset.
  const [lr, setLr] = useState(0.0001);
  const [datasetId, setDatasetId] = useState('');
  const [jobId, setJobId] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const { data: collectionsResp, isLoading: loadingCollections } = useQuery({
    queryKey: annotationSetCollectionsKey(),
    queryFn: () => annotationSetCollectionsApi.list(),
    enabled: open,
  });
  const collections = collectionsResp?.items ?? [];
  const selectedCollection = collections.find((c) => c.id === collectionId);

  const { data: classesResp, isLoading: loadingClasses } = useQuery({
    queryKey: ['train-head-classes', selectedCollection?.schema_id],
    queryFn: () => annotationSchemasApi.getClasses(selectedCollection!.schema_id),
    enabled: open && !!selectedCollection,
  });
  const classes = classesResp?.items ?? [];

  // Optional AOI restriction — same tracked AOIs shown in AoiPanel, so a
  // class with annotations spread across several AOIs (some exhaustively
  // labeled, some not) can be pinned to just the one that's safe to train on.
  const { data: aoisResp } = useQuery({
    queryKey: qk.mapAois.list(mapId ?? ''),
    queryFn: () => mapAoisApi.listAois(mapId!),
    enabled: open && !!mapId,
  });
  const aois = aoisResp?.items ?? [];

  // Training happens inside the AOI that is open — default to it.
  useEffect(() => {
    if (!aoiId && defaultAoiId) setAoiId(defaultAoiId);
  }, [aoiId, defaultAoiId]);

  useEffect(() => { setJobId(null); }, [collectionId, classId, aoiId, task]);


  // Datasets of this collection/class/AOI. Polled while one is being built.
  const { data: datasetsResp } = useQuery({
    queryKey: ['train-head-datasets', collectionId, classId, aoiId],
    queryFn: () => dinoApi.listDatasets({
      annotation_set_collection_id: collectionId,
      class_id: classId,
      aoi_id: aoiId,
    }),
    enabled: open && !!collectionId && !!classId && !!aoiId,
    refetchInterval: (q) =>
      q.state.data?.some((d) => d.status === 'pending' || d.status === 'building') ? 2000 : false,
  });
  const datasets = useMemo(() => datasetsResp ?? [], [datasetsResp]);

  // Keep a valid selection: prefer a dataset of the chosen head type.
  useEffect(() => {
    if (datasets.some((d) => d.id === datasetId)) return;
    setDatasetId((datasets.find((d) => d.task === task) ?? datasets[0])?.id ?? '');
  }, [datasets, datasetId, task]);
  const dataset = datasets.find((d) => d.id === datasetId);

  const trainMut = useMutation({
    mutationFn: (opts?: TrainOpts) => {
      if (!dataset) throw new Error('Build a dataset first');
      return dinoApi.finetune({
        dataset_id: dataset.id,
        ...opts,
        epochs,
        lr,
        // Stale data is only trained on after an explicit "Train anyway".
        allow_stale: dataset.is_stale,
      });
    },
    onSuccess: (job) => {
      setJobId(job.id);
      toast.success('Training queued');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Failed to start training'),
  });

  const { data: job } = useQuery({
    queryKey: ['train-head-job', jobId],
    queryFn: () => dinoApi.getJob(jobId as string),
    enabled: !!jobId,
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 2000;
      return ['pending', 'queued', 'running'].includes(status) ? 2000 : false;
    },
  });

  const result = job?.config?.result;
  const training = !!jobId && ['pending', 'queued', 'running'].includes(job?.status ?? 'pending');

  // The new "detect_head" ai_models row shows up in every model picker in
  // this panel (Run Inference, Quick Test) the moment the list refetches.
  const registeredJobIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (job?.status !== 'completed' || !result?.training_triggered) return;
    if (registeredJobIdRef.current === job.id) return;
    registeredJobIdRef.current = job.id;
    queryClient.invalidateQueries({ queryKey: ['models'] });
  }, [job?.status, job?.id, result?.training_triggered, queryClient]);

  const building = dataset?.status === 'building' || dataset?.status === 'pending';
  const canTrain = dataset?.status === 'ready' && !building && !trainMut.isPending && !training;

  return (
    <section style={{ borderTop: `1px dashed ${MC.border}`, paddingTop: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6, flex: 1,
          background: 'transparent', border: 'none', cursor: 'pointer', padding: '4px 0',
        }}
      >
        {open ? <ChevronDown size={11} color={MC.textMuted} /> : <ChevronRight size={11} color={MC.textMuted} />}
        <GraduationCap size={11} color={MC.accent} />
        <span style={{
          fontSize: 10, fontWeight: 700, letterSpacing: '0.08em',
          textTransform: 'uppercase', color: MC.sectionLabel,
        }}>
          Train Head
        </span>
      </button>
      <InfoTip text="Trains a small head on a frozen, shared DINOv2 backbone — one head per class, well-suited to classes with few verified examples. Uses every tracked AOI this class has exhaustively-labeled annotations in, unless you restrict it to one AOI below." />
      </div>

      {open && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingTop: 6 }}>
          <Field label="Head type" hint="Detector draws a box per object. Classifier confirms the class is in a tile and tolerates partial labels, so use it first to scan an AOI, then train a detector once labelling is closer to exhaustive. Segmenter outlines each object and needs masks. YOLO detector is one model for several classes: it trains in two stages and you can add classes to it later.">
            <select
              value={task}
              onChange={(e) => setTask(e.target.value as 'detect' | 'classify' | 'segment' | 'yolo')}
              style={selectStyle}
            >
              <option value="detect">Detector</option>
              <option value="classify">Classifier</option>
              <option value="segment">Segmenter</option>
              <option value="yolo">YOLO detector (several classes)</option>
            </select>
          </Field>

          <Field label="Verified annotation collection">
            {loadingCollections ? (
              <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading…</p>
            ) : collections.length === 0 ? (
              <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                No annotation set collections found.
              </p>
            ) : (
              <select
                value={collectionId}
                onChange={(e) => { setCollectionId(e.target.value); setClassId(''); }}
                style={selectStyle}
              >
                <option value="">— pick a collection —</option>
                {collections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            )}
          </Field>

          {collectionId && (
            <Field label="Class" hint="One head per class.">
              {loadingClasses ? (
                <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Loading…</p>
              ) : classes.length === 0 ? (
                <p style={{ fontSize: 10, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>
                  This collection&apos;s schema has no classes.
                </p>
              ) : (
                <select value={classId} onChange={(e) => setClassId(e.target.value)} style={selectStyle}>
                  <option value="">— pick a class —</option>
                  {classes.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              )}
            </Field>
          )}

          {jobId && (
            <div style={{
              border: `1px solid ${MC.border}`, borderRadius: 5, padding: '6px 8px',
              display: 'flex', flexDirection: 'column', gap: 4,
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: MC.textMuted }}>
                {job?.status === 'failed'
                  ? <AlertCircle size={11} color="#dc2626" />
                  : job?.status === 'completed'
                    ? <CheckCircle2 size={11} color="#16a34a" />
                    : <Loader2 size={11} className="animate-spin" color={MC.accent} />}
                <span>
                  {job?.status ?? 'queued'}
                  {training && job && job.total_items > 0 ? ` · ${job.processed_items}/${job.total_items}` : ''}
                </span>
              </div>
              {job?.status === 'failed' && job.logs && (
                <div style={{ fontSize: 10, color: '#dc2626', fontFamily: 'monospace' }}>
                  {job.logs.slice(0, 200)}
                </div>
              )}
              {job?.status === 'completed' && result && !result.training_triggered && (
                <p style={{ fontSize: 10, color: '#dc2626', margin: 0 }}>
                  {result.note || result.error || 'Not trained'}
                </p>
              )}
              {result?.training_triggered && (
                <p style={{ fontSize: 10, color: '#16a34a', margin: 0 }}>
                  Head trained + registered
                  {result.eval_result?.ap50 != null ? ` · AP50 ${result.eval_result.ap50.toFixed(2)}` : ''}
                  {result.eval_result?.accuracy != null ? ` · accuracy ${result.eval_result.accuracy.toFixed(2)}` : ''}
                  {result.eval_result?.f1 != null ? ` · F1 ${result.eval_result.f1.toFixed(2)}` : ''} ·{' '}
                  {result.train_items} train / {result.eval_items} eval / {result.test_items} test
                </p>
              )}
            </div>
          )}

          <div style={{ display: 'flex' }}>
            <TrainHeadAdvancedDialog
              collectionId={collectionId}
              classId={classId}
              className={classes.find((c) => c.id === classId)?.name ?? 'class'}
              classes={classes.map((c) => ({ id: c.id, name: c.name }))}
              aoiId={aoiId}
              aois={aois.map((a) => ({ id: a.id, name: a.name }))}
              task={task}
              datasets={datasets}
              selectedDatasetId={datasetId}
              onSelectDataset={setDatasetId}
              lr={lr}
              onLrChange={setLr}
              epochs={epochs}
              onEpochsChange={setEpochs}
              train={{
                canTrain,
                busy: trainMut.isPending || training,
                stale: !!dataset?.is_stale,
                onTrain: (opts) => trainMut.mutate(opts),
                job,
              }}
              label="Review and Train"
              busy={trainMut.isPending || training}
              disabled={!collectionId || !classId || !aoiId}
            />
          </div>
        </div>
      )}
    </section>
  );
}

// ── Run row ─────────────────────────────────────────────────────────────────

interface RunRowProps {
  run: RunMeta;
  mapId?: string;
  onDismiss: () => void;
  onSetsResolved: (jobId: string, setIds: string[]) => void;
}

/**
 * Group a completed multi-frame run's per-item annotation sets into one
 * AnnotationSetCollection so the sequence becomes a single selectable series
 * in Temporal Playback. Best-effort: failures (e.g. a 409 name collision, or a
 * schema-less model) leave the sets on the map individually playable.
 */
async function groupRunIntoCollection(
  sets: AnnotationSetMount[],
  run: RunMeta,
  queryClient: ReturnType<typeof useQueryClient>,
): Promise<void> {
  if (!run.schemaId) return;
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const name = `${run.layerName} · ${stamp}`;
    const collection = await annotationSetCollectionsApi.create({
      schema_id: run.schemaId,
      name,
      description: `${run.modelName} on ${run.datasetName} — ${sets.length} frames`,
    });
    await Promise.allSettled(
      sets.map((s) => annotationSetCollectionsApi.addSet(collection.id, s.annotation_set_id)),
    );
    void queryClient.invalidateQueries({ queryKey: annotationSetCollectionsKey(run.schemaId) });
    void queryClient.invalidateQueries({ queryKey: annotationSetCollectionsKey() });
    toast.success(`Grouped ${sets.length} sets into "${name}" for playback`);
  } catch (err) {
    toast.message(
      `Sets added, but collection grouping failed: ${err instanceof Error ? err.message : 'unknown error'}`,
    );
  }
}

function RunRow({ run, mapId, onDismiss, onSetsResolved }: RunRowProps) {
  const addAnnotationSetLayer = useMapLayersStore((s) => s.addAnnotationSetLayer);
  const setLayerVisible = useMapLayersStore((s) => s.setLayerVisible);
  const queryClient = useQueryClient();
  const layersAddedRef = useRef(false);
  const [resultCount, setResultCount] = useState<number | null>(null);
  const [overlayVisible, setOverlayVisible] = useState(true);

  const { data: job, error } = useQuery({
    queryKey: ['inference-job', run.jobId],
    queryFn: () => inferenceApi.getJob(run.jobId),
    refetchInterval: (q) => {
      const status = q.state.data?.status;
      if (!status) return 3000;
      return ['pending', 'queued', 'running'].includes(status) ? 3000 : false;
    },
  });

  useEffect(() => {
    if (job?.status !== 'completed' || !mapId || layersAddedRef.current) return;
    layersAddedRef.current = true;
    (async () => {
      try {
        // Pre-fetch schema classes so the MVT renderer can color polygons by
        // class — without this `classStyles` is undefined and the layer shows
        // nothing on the map (just appears in the left panel).
        const classes = run.schemaId
          ? (await annotationSchemasApi.getClasses(run.schemaId)).items
          : [];
        const classStyles = buildClassStyles(classes);

        const { items } = await annotationSetsApi.listByMap(mapId);
        const sets = items.filter((s) => s.job_id === run.jobId);
        sets.forEach((set, i) => {
          // Single set per run in the common case (one dataset_item). When the
          // model fans out across multiple items we suffix with the stac_item_id
          // so each AnnotationSet gets a distinct legend entry.
          const suffix = sets.length > 1 && set.stac_item_id ? `_${set.stac_item_id.slice(0, 8)}` : '';
          addAnnotationSetLayer({
            setId: set.annotation_set_id,
            name: `${run.layerName}${suffix}` || `inference_${i}`,
            datasetId: set.dataset_id ?? undefined,
            stacItemId: set.stac_item_id ?? undefined,
            tileUrl: annotationSetsApi.getTileUrlTemplate(set.annotation_set_id),
            classStyles,
          });
        });
        setResultCount(sets.length);
        if (sets.length > 0) {
          onSetsResolved(run.jobId, sets.map((s) => s.annotation_set_id));
          toast.success(`${run.modelName}: ${sets.length} annotation set${sets.length === 1 ? '' : 's'} added`);

          // Group multi-frame runs into an AnnotationSetCollection so the
          // sequence is one selectable series in Temporal Playback. A single
          // set (single-item run) doesn't need a collection. Requires the
          // model to have a schema (collections are schema-scoped); schema-less
          // models fall back to ungrouped sets (still individually visible).
          if (sets.length > 1 && run.schemaId) {
            void groupRunIntoCollection(sets, run, queryClient);
          }
        } else {
          toast.message(`${run.modelName}: completed with no outputs`);
        }
      } catch (err) {
        toast.error(
          `Failed to load inference results: ${err instanceof Error ? err.message : 'unknown error'}`,
        );
      }
    })();
  }, [job?.status, mapId, run.jobId, run.modelName, run.layerName, run.schemaId, run, addAnnotationSetLayer, onSetsResolved, queryClient]);

  const toggleOverlayVisibility = useCallback(() => {
    const next = !overlayVisible;
    setOverlayVisible(next);
    (run.setIds ?? []).forEach((setId) => setLayerVisible(`annset-${setId}`, next));
  }, [overlayVisible, run.setIds, setLayerVisible]);

  const status = job?.status ?? 'pending';
  const progressPct = job?.progress != null ? Math.round(job.progress * 100) : null;
  const inFlight = ['pending', 'queued', 'running'].includes(status);
  const failed = status === 'failed' || !!error;
  const done = status === 'completed';

  const statusIcon = failed
    ? <AlertCircle size={11} color="#dc2626" />
    : done
      ? <CheckCircle2 size={11} color="#16a34a" />
      : <Loader2 size={11} className="animate-spin" color={MC.accent} />;

  return (
    <div style={{
      border: `1px solid ${MC.border}`, borderRadius: 5,
      padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        {statusIcon}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 10, fontWeight: 600, color: MC.text,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {run.modelName}
          </div>
          <div style={{
            fontSize: 10, color: MC.textMuted,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {run.datasetName} · {status}
            {inFlight && job && job.total_items > 0
              ? ` · ${job.processed_items}/${job.total_items}`
              : ''}
            {done && resultCount != null ? ` · ${resultCount} set${resultCount === 1 ? '' : 's'}` : ''}
          </div>
        </div>
        {done && (run.setIds?.length ?? 0) > 0 && (
          <button
            onClick={toggleOverlayVisibility}
            title={overlayVisible ? 'Hide overlay on map' : 'Show overlay on map'}
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 2, borderRadius: 3,
              background: 'transparent', border: 'none',
              color: MC.textMuted, cursor: 'pointer',
            }}
          >
            {overlayVisible ? <Eye size={10} /> : <EyeOff size={10} />}
          </button>
        )}
        <button
          onClick={onDismiss}
          title="Dismiss from list"
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 2, borderRadius: 3,
            background: 'transparent', border: 'none',
            color: MC.textMuted, cursor: 'pointer',
          }}
        >
          <X size={10} />
        </button>
      </div>

      {inFlight && progressPct != null && (
        <div style={{ height: 3, borderRadius: 2, background: MC.border, overflow: 'hidden' }}>
          <div style={{
            height: '100%', width: `${progressPct}%`, background: MC.accent,
            transition: 'width 0.3s ease',
          }} />
        </div>
      )}

      {failed && job?.logs && (
        <div style={{
          fontSize: 10, color: '#dc2626', fontFamily: 'monospace',
          maxHeight: 60, overflow: 'auto', wordBreak: 'break-word',
        }}>
          {job.logs.slice(0, 240)}
        </div>
      )}
    </div>
  );
}


// ── Helpers ─────────────────────────────────────────────────────────────────

const selectStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 5,
  border: `1px solid ${MC.border}`, background: MC.inputBg ?? '#1e2518',
  color: MC.text, fontSize: 11, cursor: 'pointer',
};

const inputStyle: React.CSSProperties = {
  width: '100%', padding: '6px 8px', borderRadius: 5,
  border: `1px solid ${MC.border}`, background: MC.inputBg ?? '#1e2518',
  color: MC.text, fontSize: 11,
};

const overrideLabelStyle: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 4,
  fontSize: 10, color: MC.textMuted, cursor: 'pointer',
};
