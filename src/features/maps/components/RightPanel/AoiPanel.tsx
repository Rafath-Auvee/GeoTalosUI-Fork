'use client';

import { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import {
  BoxSelect, Check, ChevronDown, ChevronRight, Database, ScanSearch,
} from 'lucide-react';
import { useMutation, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { mapAoisApi, getOrStartAoiCreate } from '@/lib/api/map-aois';
import { mapsApi } from '@/lib/api/maps';
import { datasetsApi } from '@/lib/api/datasets';
import { qk } from '@/lib/query-keys';
import { MC } from '../../mapColors';
import type { Dataset, DatasetItem } from '@/types/api';
import { datasetItemLabel } from '@/features/datasets/itemLabel';
import type { BandSelection } from '../../types';
import { BandSelector } from './BandSelector';
import { PanelSelect } from './PanelControls';
import { useInteractiveStore } from '../../interactive/store';
import { switchAoiChildLayerToItem } from '@/features/maps/utils/aoiChildItem';
import { KindIcon, RowMenu, VectorSetCards, useCanDelete, usePurgeDataset, useVectorPick } from './AoiDataList';
import { AoiDataPicker } from './AoiDataPicker';
import { useOnMapInAoi } from '../../hooks/useOnMapInAoi';
import { AoiInferencePanel } from './AoiInferencePanel';
import { AoiVisualizationPanel } from './AoiVisualizationPanel';
import { AoiAnalysisHub, type AoiAnalysisKey } from './AoiAnalysisHub';
import {
  AoiTemporalPanel,
  AoiNdviPanel,
  AoiAreaStatsPanel,
  AoiCompositePanel,
  AoiChangeDetectionPanel,
} from './AoiSimpleAnalysisPanels';

interface AoiPanelProps {
  aoiLayerId: string;
  mapId?: string;
}

export function AoiPanel({ aoiLayerId, mapId }: AoiPanelProps) {
  const layer = useMapLayersStore((s) => s.layers[aoiLayerId]);
  const backendAoiId = useMapLayersStore((s) => s.backendLayerIds[aoiLayerId]);
  const aoiSelectedDatasetIds = useMapLayersStore((s) => s.aoiSelectedDatasetIds);
  const toggleAoiDataset = useMapLayersStore((s) => s.toggleAoiDataset);
  const setAoiSelectedDatasets = useMapLayersStore((s) => s.setAoiSelectedDatasets);
  const addAoiBoundedDataset = useMapLayersStore((s) => s.addAoiBoundedDataset);
  const removeAoiBoundedDataset = useMapLayersStore((s) => s.removeAoiBoundedDataset);
  const setBackendLayerId = useMapLayersStore((s) => s.setBackendLayerId);
  const queryClient = useQueryClient();

  const bbox = layer?.aoiBbox;
  const geometry = layer?.aoiGeometry;
  const bboxStr = bbox ? bbox.join(',') : '';

  // ── Backend-driven intersecting resources (datasets, items, vectors, masks) ──
  // Source of truth: GET /maps/{id}/aoi/resources?bbox=… — replaces client-side
  // bbox intersect against `datasets` prop.
  // Lazy: the intersect query is the slow one, so it only runs once the data picker is opened.
  const [resourcesWanted, setResourcesWanted] = useState(false);
  useEffect(() => { setResourcesWanted(false); }, [aoiLayerId]);
  const { data: aoiResources, isLoading: aoiResourcesLoading } = useQuery({
    queryKey: qk.maps.aoiResources(mapId ?? '', bboxStr),
    queryFn: () => mapsApi.listAoiResources(mapId!, bbox!),
    enabled: !!mapId && !!bbox && resourcesWanted,
    staleTime: 30_000,
  });

  // Use backend resources when present; gracefully fall back to the `datasets` prop
  // for newly-drawn AOIs whose resources query hasn't resolved yet.
  const intersecting: Dataset[] = useMemo(() => {
    if (aoiResources?.datasets?.length) {
      return aoiResources.datasets.filter((d) => d.status === 'ready');
    }
    return [];
  }, [aoiResources?.datasets]);

  const vectorSets = aoiResources?.vector_annotation_sets ?? [];
  const canDelete = useCanDelete();
  const vectorPick = useVectorPick(aoiLayerId);
  const onMap = useOnMapInAoi(bbox as [number, number, number, number] | undefined);

  // Selected datasets are fetched by id (cheap), so the cards and the restored overlays don't wait
  // for the intersect query.
  const missingIds = aoiSelectedDatasetIds.filter((id) => !intersecting.some((d) => d.id === id));
  const fetchedSelected = useQueries({
    queries: missingIds.map((id) => ({ queryKey: ['datasets', 'detail', id], queryFn: () => datasetsApi.get(id), staleTime: 60_000, retry: false })),
  });
  const knownDatasets: Dataset[] = useMemo(
    () => [...intersecting, ...fetchedSelected.map((q) => q.data).filter((d): d is Dataset => !!d && d.status === 'ready')],
    [intersecting, fetchedSelected],
  );

  // ── Restore selection from backend on AOI open ──────────────────────────────
  const { data: backendSelection } = useQuery({
    queryKey: qk.mapAois.selection(mapId ?? '', backendAoiId ?? ''),
    queryFn: () => mapAoisApi.getSelection(mapId!, backendAoiId!),
    enabled: !!mapId && !!backendAoiId,
    staleTime: 30_000,
  });

  // Deterministically mirror the backend selection for the *currently open* AOI
  // into the (single, shared) store array. Keyed on AOI + the resolved id set so
  // it re-syncs whenever the saved selection changes — including the empty case,
  // which clears any stale carryover from a previously-open AOI. Replaces the old
  // one-shot guard that skipped empty selections and leaked state between AOIs.
  const restoredKeyRef = useRef<string | null>(null);
  useEffect(() => {
    // Wait until the selection query for THIS AOI has actually resolved.
    if (!backendAoiId || backendSelection === undefined) return;
    const ids = backendSelection.dataset_ids ?? [];
    const key = `${aoiLayerId}:${[...ids].sort().join(',')}`;
    if (restoredKeyRef.current === key) return;
    restoredKeyRef.current = key;
    setAoiSelectedDatasets(ids);
  }, [aoiLayerId, backendAoiId, backendSelection, setAoiSelectedDatasets]);

  // Ensure a bounded dataset overlay exists on the map for every selected dataset
  // that intersects this AOI. Idempotent (skips datasets whose child layer is
  // already present), so it restores imagery for a restored selection even when
  // the intersecting-resources query resolves after the selection query.
  useEffect(() => {
    if (!bbox) return;
    const state = useMapLayersStore.getState();
    for (const ds of knownDatasets) {
      if (!aoiSelectedDatasetIds.includes(ds.id)) continue;
      const childLayerId = `${aoiLayerId}-ds-${ds.id}`;
      if (state.layers[childLayerId]) continue;
      addAoiBoundedDataset(
        aoiLayerId,
        { id: ds.id, name: ds.name, stac_collection_id: ds.stac_collection_id ?? undefined },
        bbox,
      );
    }
  }, [aoiLayerId, bbox, knownDatasets, aoiSelectedDatasetIds, addAoiBoundedDataset]);

  // ── Ensure AOI exists on the backend ────────────────────────────────────────
  // Centralises the POST /maps/{id}/aois call. The MapEditorShell subscribe
  // path also creates AOIs, but races and silent failures can leave the panel
  // without a backend id — this mutation lets the panel both proactively save
  // when it opens and lazily save right before temporal playback.
  const ensureAoiMut = useMutation({
    mutationFn: async () => {
      if (!mapId) throw new Error('Map not available');
      if (!layer) throw new Error('AOI layer missing');
      const existing = useMapLayersStore.getState().backendLayerIds[aoiLayerId];
      if (existing) return existing;
      if (!layer.aoiBbox) throw new Error('AOI has no bbox');
      // Coalesce with the MapEditorShell subscribe-based create so we never
      // POST the same AOI twice in parallel.
      const aoi = await getOrStartAoiCreate(aoiLayerId, () =>
        mapAoisApi.createAoi(mapId, {
          name: layer.name ?? 'AOI',
          bbox_4326: layer.aoiBbox!,
          geometry: layer.aoiGeometry,
          visible: layer.visible,
          opacity: layer.opacity,
          z_index: layer.zIndex,
        }),
      );
      setBackendLayerId(aoiLayerId, aoi.id);
      queryClient.invalidateQueries({ queryKey: qk.mapAois.list(mapId) });
      return aoi.id;
    },
    onError: (err) => {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Failed to save AOI: ${msg.slice(0, 120)}`);
    },
  });

  // Auto-save on open if it hasn't been persisted yet (covers any race or silent
  // failure in the MapEditorShell subscribe path).
  const autoSaveAttemptedRef = useRef(false);
  useEffect(() => {
    if (autoSaveAttemptedRef.current) return;
    if (!mapId || !layer || backendAoiId || !layer.aoiBbox) return;
    if (ensureAoiMut.isPending) return;
    autoSaveAttemptedRef.current = true;
    ensureAoiMut.mutate();
  }, [mapId, layer, backendAoiId, ensureAoiMut]);

  // Reset the auto-save guard when the panel switches to a different AOI.
  useEffect(() => {
    autoSaveAttemptedRef.current = false;
  }, [aoiLayerId]);

  const hasSelected = aoiSelectedDatasetIds.length > 0;

  // ── View state — hub vs. selected analysis detail ──────────────────────────
  const [view, setView] = useState<'hub' | AoiAnalysisKey>('hub');
  // Reset view when switching to a different AOI.
  useEffect(() => { setView('hub'); }, [aoiLayerId]);
  const backToHub = useCallback(() => setView('hub'), []);

  // Datasets currently selected on this AOI, filtered to the intersecting set.
  const selectedDatasetObjs = useMemo(
    () => knownDatasets.filter((d) => aoiSelectedDatasetIds.includes(d.id)),
    [knownDatasets, aoiSelectedDatasetIds],
  );
  const ensureAoi = useCallback(() => ensureAoiMut.mutateAsync(), [ensureAoiMut]);

  /**
   * Toggle dataset selection + create/remove bounded child layer overlay.
   * Also syncs selection to backend AOI.
   */
  const handleToggleDataset = useCallback(
    (ds: Dataset) => {
      const isSelected = aoiSelectedDatasetIds.includes(ds.id);
      const childLayerId = `${aoiLayerId}-ds-${ds.id}`;

      toggleAoiDataset(ds.id);

      if (!bbox) return;

      if (isSelected) {
        if (useMapLayersStore.getState().layers[childLayerId]) {
          removeAoiBoundedDataset(childLayerId);
        }
      } else {
        addAoiBoundedDataset(
          aoiLayerId,
          { id: ds.id, name: ds.name, stac_collection_id: ds.stac_collection_id ?? undefined },
          bbox
        );
      }

      // Sync updated selection to backend. If the AOI hasn't reached the
      // backend yet, save it first via ensureAoiMut — this avoids losing
      // selections made immediately after drawing an AOI.
      if (!mapId) return;
      const newSelectedIds = isSelected
        ? aoiSelectedDatasetIds.filter((id) => id !== ds.id)
        : [...aoiSelectedDatasetIds, ds.id];

      const persistSelection = async () => {
        const aoiId = backendAoiId ?? (await ensureAoiMut.mutateAsync());
        if (!aoiId) return;
        try {
          await mapAoisApi.updateSelection(mapId, aoiId, {
            dataset_ids: newSelectedIds,
            dataset_item_ids: [],
          });
          queryClient.invalidateQueries({
            queryKey: qk.mapAois.selection(mapId, aoiId),
          });
          queryClient.invalidateQueries({
            queryKey: qk.mapAois.timeline(mapId, aoiId),
          });
        } catch (err: unknown) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          console.error('[AoiPanel] Failed to update AOI selection:', errorMsg, err);
          toast.error(`Failed to save dataset selection: ${errorMsg.substring(0, 60)}`);
        }
      };
      void persistSelection();
    },
    [aoiLayerId, aoiSelectedDatasetIds, bbox, toggleAoiDataset, addAoiBoundedDataset, removeAoiBoundedDataset, mapId, backendAoiId, queryClient, ensureAoiMut]
  );

  // Cards: what is selected on this AOI plus whatever is already on the map and overlaps it.
  const cardDatasets = useMemo(() => {
    const seen = new Set(selectedDatasetObjs.map((d) => d.id));
    return [...selectedDatasetObjs, ...onMap.rasters.filter((d) => !seen.has(d.id))];
  }, [selectedDatasetObjs, onMap.rasters]);
  const onMapVectorIds = useMemo(() => onMap.vectors.map((v) => v.id), [onMap.vectors]);
  const cardCount = cardDatasets.length + new Set([...vectorPick.picked, ...onMapVectorIds]).size;

  const purge = usePurgeDataset((datasetId) => {
    const ds = knownDatasets.find((d) => d.id === datasetId);
    if (ds && aoiSelectedDatasetIds.includes(datasetId)) handleToggleDataset(ds);
  });

  if (!layer) return null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflow: 'hidden' }}>
      <div style={{ flex: 1, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 12 }}>

        {/* ── Interactive annotation — separate mode, local draft until commit ── */}
        {bbox && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <button
              type="button"
              disabled={!hasSelected}
              onClick={() =>
                {
                  // Datasets selected on this AOI; the mode resolves which item to read.
                  useInteractiveStore.getState().enter({
                    mapId,
                    aoiLayerId,
                    aoiName: layer.name,
                    bbox,
                    geometry,
                    datasets: selectedDatasetObjs.map((d) => ({ id: d.id, name: d.name })),
                  });
                }
              }
              style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 7, height: 32, borderRadius: 5,
                fontSize: 11, fontWeight: 700,
                border: `1.5px solid ${hasSelected ? MC.accent : MC.border}`,
                background: hasSelected ? MC.accentDim : 'transparent',
                color: hasSelected ? MC.text : MC.textMuted,
                cursor: hasSelected ? 'pointer' : 'not-allowed',
              }}
            >
              <ScanSearch size={13} color={hasSelected ? MC.accent : MC.textMuted} />
              Interactive annotation
            </button>
            <span style={{ fontSize: 10, color: MC.textMuted, lineHeight: 1.4 }}>
              {hasSelected
                ? 'Find every object in this AOI, group and label them, then save. Nothing is saved until you commit.'
                : 'Select a dataset below to start.'}
            </span>
          </div>
        )}

        {/* ── Bounding box — read-only, one line ─────────────────── */}
        {bbox && (
          <div
            title="Bounding box (W, S, E, N)"
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              fontSize: 10, color: MC.textMuted, fontVariantNumeric: 'tabular-nums',
            }}
          >
            <span style={{ color: MC.accent, display: 'flex' }}><BoxSelect size={11} /></span>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {bbox.map((v) => v.toFixed(4)).join(', ')}
            </span>
          </div>
        )}

        {/* ── Data: dataset checklist with item + band controls inline ─ */}
        <section>
          <SectionHeader icon={<Database size={11} />} label={`Data (${cardCount})`} />
          <AoiDataPicker
            rasters={intersecting}
            vectors={vectorSets}
            selectedRasterIds={aoiSelectedDatasetIds}
            pickedVectorIds={vectorPick.picked}
            loading={resourcesWanted && aoiResourcesLoading}
            onOpen={() => setResourcesWanted(true)}
            onToggleRaster={handleToggleDataset}
            onToggleVector={(s) => void vectorPick.toggle(s)}
          />
          {cardCount === 0 ? (
            <p style={{ fontSize: 11, color: MC.textMuted, fontStyle: 'italic', padding: '6px 0' }}>
              Nothing on the map overlaps this AOI yet. Add a raster to analyse it, or an annotation set to clean it.
            </p>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0' }}>
              {cardDatasets.map((ds) => {
                const checked = aoiSelectedDatasetIds.includes(ds.id);
                const fileCount = ds.metadata?.file_count ?? 0;
                const temporal = ds.temporal_extent;
                return (
                  <div
                    key={ds.id}
                    style={{
                      borderRadius: 5,
                      background: checked ? MC.accentDim : 'transparent',
                      border: `1px solid ${checked ? MC.accent : MC.border}`,
                      transition: 'all 0.12s',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center' }}>
                    <button
                      role="checkbox"
                      aria-checked={checked}
                      onClick={() => handleToggleDataset(ds)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 8, flex: 1, minWidth: 0,
                        padding: '6px 4px 6px 8px', background: 'transparent', border: 'none',
                        cursor: 'pointer', textAlign: 'left',
                      }}
                    >
                      <div style={{
                        width: 16, height: 16, borderRadius: 3,
                        border: `1.5px solid ${checked ? MC.accent : MC.borderLight}`,
                        background: checked ? MC.accent : 'transparent',
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        flexShrink: 0, transition: 'all 0.12s',
                      }}>
                        {checked && <Check size={10} color="#fff" strokeWidth={3} />}
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{
                          fontSize: 11, fontWeight: 600, color: MC.text,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          display: 'flex', alignItems: 'center', gap: 6,
                        }}>
                          <KindIcon kind="raster" />
                          <span title={ds.name} style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{ds.name}</span>
                        </div>
                        <div style={{ fontSize: 10, color: MC.textMuted, display: 'flex', gap: 8, marginTop: 1 }}>
                          {fileCount > 0 && <span>{fileCount} item{fileCount !== 1 ? 's' : ''}</span>}
                          {temporal && (
                            <span>
                              {fmtShortDate(temporal.lower)} — {fmtShortDate(temporal.upper)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <div style={{ padding: '0 4px 0 0' }}>
                      <RowMenu name={ds.name} canDelete={canDelete} onDelete={() => purge.request({ id: ds.id, name: ds.name, items: fileCount })} />
                    </div>
                    </div>
                    {bbox && checked && (
                      <AoiDatasetItemControl
                        aoiLayerId={aoiLayerId}
                        dataset={ds}
                        bbox={bbox}
                        mapId={mapId}
                      />
                    )}
                  </div>
                );
              })}
              <VectorSetCards aoiLayerId={aoiLayerId} onMapIds={onMapVectorIds} />
            </div>
          )}
          {purge.dialog}
        </section>

        {/* ── Analyses: hub or selected detail ────────────────── */}
        {view === 'hub' && (
          <AoiAnalysisHub
            hasSelectedDataset={hasSelected}
            hasAoiBbox={!!bbox}
            onSelect={setView}
          />
        )}

        {view === 'inference' && (
          <AoiInferencePanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            backendAoiId={backendAoiId}
            aoiBbox={bbox}
            selectedDatasets={selectedDatasetObjs}
            onEnsureAoi={ensureAoi}
            onBack={backToHub}
          />
        )}

        {view === 'visualization' && (
          <AoiVisualizationPanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            aoiBbox={bbox}
            onBack={backToHub}
          />
        )}

        {view === 'temporal' && (
          <AoiTemporalPanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            backendAoiId={backendAoiId}
            aoiBbox={bbox}
            geometry={geometry}
            selectedDatasets={selectedDatasetObjs}
            onEnsureAoi={ensureAoi}
            onBack={backToHub}
          />
        )}

        {view === 'ndvi' && (
          <AoiNdviPanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            backendAoiId={backendAoiId}
            geometry={geometry}
            selectedDatasets={selectedDatasetObjs}
            onEnsureAoi={ensureAoi}
            onBack={backToHub}
          />
        )}

        {view === 'area_stats' && (
          <AoiAreaStatsPanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            backendAoiId={backendAoiId}
            geometry={geometry}
            selectedDatasets={selectedDatasetObjs}
            onEnsureAoi={ensureAoi}
            onBack={backToHub}
          />
        )}

        {view === 'composite' && (
          <AoiCompositePanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            backendAoiId={backendAoiId}
            geometry={geometry}
            selectedDatasets={selectedDatasetObjs}
            onEnsureAoi={ensureAoi}
            onBack={backToHub}
          />
        )}

        {view === 'change_detection' && (
          <AoiChangeDetectionPanel
            aoiLayerId={aoiLayerId}
            mapId={mapId}
            backendAoiId={backendAoiId}
            geometry={geometry}
            selectedDatasets={selectedDatasetObjs}
            onEnsureAoi={ensureAoi}
            onBack={backToHub}
          />
        )}
      </div>
    </div>
  );
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function SectionHeader({ icon, label }: { icon: React.ReactNode; label: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
      <span style={{ color: MC.accent, display: 'flex' }}>{icon}</span>
      <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase', color: MC.sectionLabel }}>
        {label}
      </span>
    </div>
  );
}

function AoiDatasetItemControl({
  aoiLayerId,
  dataset,
  bbox,
  mapId,
}: {
  aoiLayerId: string;
  dataset: Dataset;
  bbox: [number, number, number, number];
  mapId?: string;
}) {
  const childLayerId = `${aoiLayerId}-ds-${dataset.id}`;
  const childLayer = useMapLayersStore((s) => s.layers[childLayerId]);
  const setLayerBandSelection = useMapLayersStore((s) => s.setLayerBandSelection);

  const bboxStr = bbox.join(',');
  // Use the AOI-scoped endpoint so we only get items intersecting the bbox.
  const { data, isLoading } = useQuery({
    queryKey: qk.maps.datasetItemsInAoi(mapId ?? '', dataset.id, bboxStr),
    queryFn: () => mapsApi.listDatasetItemsInAoi(mapId!, dataset.id, bbox, { limit: 100 }),
    enabled: !!childLayer && !!mapId,
  });
  const items = data?.items ?? [];
  const selectedStacItemId = childLayer?.stacItemId ?? items[0]?.stac_item_id ?? '';

  const handleItemSelect = useCallback(async (stacItemId: string) => {
    const latestLayer = useMapLayersStore.getState().layers[childLayerId];
    if (!latestLayer) return;
    try {
      await switchAoiChildLayerToItem({
        childLayerId,
        datasetId: dataset.id,
        stacItemId,
        layerSnapshot: latestLayer,
      });
    } catch {
      toast.error('Failed to switch AOI item');
    }
  }, [childLayerId, dataset.id]);

  const handleBandChange = useCallback(async (bands: BandSelection, preset?: string | null) => {
    const latestLayer = useMapLayersStore.getState().layers[childLayerId];
    if (!latestLayer || !selectedStacItemId) return;
    setLayerBandSelection(childLayerId, bands, preset ?? null);
    try {
      await switchAoiChildLayerToItem({
        childLayerId,
        datasetId: dataset.id,
        stacItemId: selectedStacItemId,
        layerSnapshot: latestLayer,
        bandSelection: bands,
        activePreset: preset ?? null,
      });
    } catch {
      toast.error('Failed to apply AOI band selection');
    }
  }, [childLayerId, dataset.id, selectedStacItemId, setLayerBandSelection]);

  const handlePresetChange = useCallback(async (presetId: string) => {
    const latestLayer = useMapLayersStore.getState().layers[childLayerId];
    const rc = latestLayer?.renderingConfig;
    if (!latestLayer || !selectedStacItemId || !rc) return;
    const preset = rc.presets[presetId];
    const match = preset?.params.asset_bidx?.match(/\|(\d+),(\d+),(\d+)/);
    const bands: BandSelection | null = match
      ? { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]) }
      : null;
    setLayerBandSelection(childLayerId, bands, presetId);
    try {
      await switchAoiChildLayerToItem({
        childLayerId,
        datasetId: dataset.id,
        stacItemId: selectedStacItemId,
        layerSnapshot: latestLayer,
        bandSelection: bands,
        activePreset: bands ? null : presetId,
      });
    } catch {
      toast.error('Failed to apply AOI preset');
    }
  }, [childLayerId, dataset.id, selectedStacItemId, setLayerBandSelection]);

  const [bandsOpen, setBandsOpen] = useState(false);
  const hasBands = !!childLayer?.renderingConfig && childLayer.renderingConfig.bands.length > 1;
  const rc = childLayer?.renderingConfig;
  const activePresetLabel = childLayer?.activePreset
    ? rc?.presets[childLayer.activePreset]?.label
    : childLayer?.bandSelection
      ? 'custom RGB'
      : rc?.presets[rc.default_preset]?.label;

  return (
    <div style={{ padding: '0 8px 8px 32px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <PanelSelect
        aria-label={`Active item for ${dataset.name}`}
        value={selectedStacItemId}
        disabled={isLoading || items.length === 0}
        onChange={(e) => { void handleItemSelect(e.target.value); }}
      >
        {isLoading && <option value="">Loading items…</option>}
        {!isLoading && items.length === 0 && <option value="">No AOI items found</option>}
        {!isLoading && items.map((item: DatasetItem) => (
          <option key={item.id} value={item.stac_item_id} title={item.stac_item_id}>
            {datasetItemLabel(item)}
          </option>
        ))}
      </PanelSelect>

      {hasBands && childLayer?.renderingConfig && (
        <div>
          <button
            type="button"
            onClick={() => setBandsOpen(!bandsOpen)}
            aria-expanded={bandsOpen}
            style={{
              display: 'flex', alignItems: 'center', gap: 4, width: '100%',
              background: 'transparent', border: 'none', cursor: 'pointer',
              padding: '2px 0', color: MC.textSecondary,
            }}
          >
            {bandsOpen
              ? <ChevronDown size={11} color={MC.textMuted} />
              : <ChevronRight size={11} color={MC.textMuted} />}
            <span style={{
              fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
              textTransform: 'uppercase', color: MC.textMuted,
            }}>
              Bands
              <span style={{ color: MC.accent, fontWeight: 600 }}>
                {' · '}{activePresetLabel ?? 'default'}
              </span>
            </span>
          </button>
          {bandsOpen && (
            <div style={{ paddingTop: 4 }}>
              <BandSelector
                compact
                renderingConfig={childLayer.renderingConfig}
                bandSelection={childLayer.bandSelection ?? null}
                activePreset={childLayer.activePreset ?? null}
                onBandChange={handleBandChange}
                onPresetChange={handlePresetChange}
              />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function fmtShortDate(iso: string | undefined | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { month: 'short', year: '2-digit' });
}
