'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Pencil, Layers, Trash2, ImageIcon, Download, Loader2 } from 'lucide-react';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { annotationSetsApi } from '@/lib/api/annotation-sets';
import { sam3RefineApi } from '@/lib/api/sam3';
import { datasetsApi } from '@/lib/api/datasets';
import { annotationSchemasApi } from '@/lib/api/annotation-schemas';
import { qk } from '@/lib/query-keys';
import type { AnnotationClass } from '@/types/api';
import { MC } from '../../mapColors';
import { getMapManager } from '../../MapManager';
import { extractClassIdFromProperties, normalizeClassStyleDefinition } from '../../utils/annotationStyles';
import { getMapInstance } from '@/stores/mapStore';

function asNonEmptyText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function getClassDescription(cls: AnnotationClass): string | undefined {
  return asNonEmptyText(cls.description) ?? asNonEmptyText(cls.properties?.description);
}

interface AnnotationSetPanelProps {
  annotationSetId: string;
  mapId?: string;
}

export function AnnotationSetPanel({ annotationSetId, mapId }: AnnotationSetPanelProps) {
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [purgeOpen, setPurgeOpen] = useState(false);
  const [refineScore, setRefineScore] = useState(0.5);
  const [refineJobId, setRefineJobId] = useState<string | null>(null);
  const addAnnotationSetLayer = useMapLayersStore((s) => s.addAnnotationSetLayer);
  const [purging, setPurging] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const openAnnotationPanel = useMapLayersStore((s) => s.openAnnotationPanel);
  const removeLayer = useMapLayersStore((s) => s.removeLayer);
  const closeRightPanel = useMapLayersStore((s) => s.closeRightPanel);
  const backendLayerIds = useMapLayersStore((s) => s.backendLayerIds);
  const layerId = `annset-${annotationSetId}`;
  const layer = useMapLayersStore((s) => s.layers[layerId]);
  const setLayerOpacity = useMapLayersStore((s) => s.setLayerOpacity);
  const queryClient = useQueryClient();

  const isRasterMask = !!layer?.isRasterMask;

  const { data: annSet, isLoading } = useQuery({
    queryKey: qk.annotationSets.detail(annotationSetId),
    queryFn: () => annotationSetsApi.get(annotationSetId),
    enabled: !!annotationSetId,
    retry: 2,
    retryDelay: 1000,
  });

  const { data: schema } = useQuery({
    queryKey: qk.annotationSchemas.detail(annSet?.schema_id ?? ''),
    queryFn: () => annotationSchemasApi.get(annSet!.schema_id!),
    enabled: !!annSet?.schema_id,
  });

  // Raster config — only fetch for raster masks
  const { data: rasterConfig } = useQuery({
    queryKey: ['annotation-sets', annotationSetId, 'raster-config'],
    queryFn: () => annotationSetsApi.getRasterConfig(annotationSetId),
    enabled: !!annotationSetId && isRasterMask,
  });

  const schemaClasses = schema?.classes;
  const embeddedClasses = annSet?.schema?.classes;
  const classes = useMemo(() => schemaClasses ?? embeddedClasses ?? [], [schemaClasses, embeddedClasses]);

  // Views of the whole set: which shape each annotation is drawn as (mask, box or both), and which classes show.
  // Each view is applied by re-feeding the layer the set's own features, so they combine.
  type ShapeView = 'mask' | 'box' | 'both';
  const [shapeView, setShapeView] = useState<ShapeView>('mask');
  const [hiddenClasses, setHiddenClasses] = useState<string[]>([]);
  const overlayRef = useRef<{ remove: () => void } | null>(null);
  const { data: setFeatures } = useQuery({
    queryKey: ['annotation-set-features', annotationSetId],
    queryFn: () => annotationSetsApi.getFeatures(annotationSetId),
    enabled: !!annotationSetId && !isRasterMask && !!layer,
    staleTime: 60_000,
  });
  type Feat = { geometry?: { coordinates?: unknown } | null; properties?: Record<string, unknown> & { bbox?: number[]; class_name?: string } };
  // A box for every annotation that has an extent: the stored one when there is one, else the geometry's own bounds.
  const boxOf = (f: Feat): [number, number, number, number] | null => {
    const stored = f.properties?.bbox;
    if (Array.isArray(stored) && stored.length === 4 && stored.every((n) => typeof n === 'number')) return stored as [number, number, number, number];
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const visit = (c: unknown) => {
      if (!Array.isArray(c)) return;
      if (typeof c[0] === 'number') {
        const [x, y] = c as number[];
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      } else for (const part of c) visit(part);
    };
    visit(f.geometry?.coordinates);
    return Number.isFinite(minX) && maxX > minX && maxY > minY ? [minX, minY, maxX, maxY] : null; // points have no extent
  };
  const featureList = useMemo(() => ((setFeatures as { features?: Feat[] } | undefined)?.features ?? []), [setFeatures]);
  const hasBoxes = useMemo(() => featureList.some((f) => boxOf(f) !== null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [featureList]);
  // The classes actually present in the set (a model-output set may not list its schema's classes).
  const presentClasses = useMemo(() => {
    const found = new Map<string, string>();
    for (const f of featureList) {
      const id = extractClassIdFromProperties(f.properties);
      if (id && !found.has(id)) found.set(id, typeof f.properties?.class_name === 'string' ? f.properties.class_name : id);
    }
    return [...found].map(([id, fallbackName]) => {
      const c = classes.find((x) => x.id === id || x.name === id);
      const key = c?.id ?? id;
      return { id: key, ids: new Set([id, key, c?.name].filter(Boolean) as string[]), name: c?.name ?? fallbackName, color: c ? normalizeClassStyleDefinition(c.style?.definition as Record<string, unknown> | undefined).fillColor : MC.accent };
    });
  }, [featureList, classes]);
  const boxPolygon = (b: number[]) => ({ type: 'Polygon', coordinates: [[[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [b[0], b[1]]]] });

  const applyView = async (shape: ShapeView, hidden: string[]) => {
    if (!setFeatures) return;
    const fc = setFeatures as { features?: Feat[] };
    const visible = (fc.features ?? []).filter((f) => {
      const cid = extractClassIdFromProperties(f.properties);
      if (!cid) return true;
      const cls = presentClasses.find((c) => c.ids.has(cid));
      return !hidden.includes(cls?.id ?? cid);
    });
    const features = shape === 'box' ? visible.map((f) => { const b = boxOf(f); return b ? { ...f, geometry: boxPolygon(b) } : f; }) : visible;
    getMapManager().setLayerData(layerId, { ...fc, features });

    overlayRef.current?.remove();
    overlayRef.current = null;
    const map = getMapInstance();
    if (shape === 'both' && map) {
      const L = await import('leaflet');
      const group = L.layerGroup(
        visible.flatMap((f) => {
          const b = boxOf(f);
          return b ? [L.rectangle([[b[1], b[0]], [b[3], b[2]]], { color: MC.accent, weight: 2, fill: false, dashArray: '5 4', interactive: false })] : [];
        }),
      ).addTo(map);
      overlayRef.current = group;
    }
  };
  const showShape = (view: ShapeView) => { setShapeView(view); void applyView(view, hiddenClasses); };
  const toggleClassVisible = (id: string) => {
    const next = hiddenClasses.includes(id) ? hiddenClasses.filter((c) => c !== id) : [...hiddenClasses, id];
    setHiddenClasses(next);
    void applyView(shapeView, next);
  };
  // A set of boxes (a detector's output): offer to turn them into masks with SAM 3.
  const boxCount = useMemo(() => featureList.filter((f) => {
    const ring = (f.geometry as { type?: string; coordinates?: number[][][] } | null | undefined);
    if (ring?.type !== 'Polygon' || ring.coordinates?.[0]?.length !== 5) return false;
    const pts = ring.coordinates[0];
    return new Set(pts.map((p) => p[0].toFixed(7))).size <= 2 && new Set(pts.map((p) => p[1].toFixed(7))).size <= 2;
  }).length, [featureList]);
  const isBoxSet = featureList.length > 0 && boxCount === featureList.length;
  const eligible = useMemo(() => featureList.filter((f) => {
    const c = (f.properties as { confidence?: number } | undefined)?.confidence;
    return c == null || c >= refineScore;
  }).length, [featureList, refineScore]);
  const refineStart = useMutation({
    mutationFn: () => sam3RefineApi.start({ annotation_set_id: annotationSetId, map_id: mapId, min_score: refineScore }),
    onSuccess: (job) => setRefineJobId(job.id),
    onError: () => toast.error('Could not start generating masks'),
  });
  const { data: refineJob } = useQuery({
    queryKey: ['sam3-refine-job', refineJobId],
    queryFn: () => sam3RefineApi.job(refineJobId as string),
    enabled: !!refineJobId,
    refetchInterval: (q) => (['completed', 'failed', 'cancelled'].includes(q.state.data?.status ?? '') ? false : 2000),
  });
  const refineDone = useRef<string | null>(null);
  useEffect(() => {
    if (!refineJob || refineDone.current === refineJob.id) return;
    if (refineJob.status === 'completed' && refineJob.config?.result?.annotation_set_id) {
      refineDone.current = refineJob.id;
      const r = refineJob.config.result;
      addAnnotationSetLayer({ setId: r.annotation_set_id as string, name: r.name ?? 'SAM masks' });
      void queryClient.invalidateQueries({ queryKey: ['annotation-sets'] });
      if (mapId) void queryClient.invalidateQueries({ queryKey: qk.maps.detail(mapId) });
      toast.success(`Generated ${r.masks} masks`);
    } else if (refineJob.status === 'failed') {
      refineDone.current = refineJob.id;
      toast.error(refineJob.logs || 'Generating masks failed');
    }
  }, [refineJob, addAnnotationSetLayer, queryClient, mapId]);
  const refining = refineStart.isPending || (!!refineJobId && !!refineJob && ['pending', 'queued', 'running'].includes(refineJob.status)) || (!!refineJobId && !refineJob);

  // Leaving the panel puts the layer back as it was saved.
  const restoreRef = useRef<() => void>(() => {});
  restoreRef.current = () => {
    overlayRef.current?.remove();
    overlayRef.current = null;
    if (setFeatures && (shapeView !== 'mask' || hiddenClasses.length > 0)) {
      try { getMapManager().setLayerData(layerId, setFeatures); } catch { /* the layer is already gone */ }
    }
  };
  useEffect(() => () => restoreRef.current(), []);

  const geometryTypes = schema?.geometry_types ?? [];

  const handleAddAnnotation = () => {
    // Open the annotation panel, pre-filled with this set's info
    openAnnotationPanel();
    // Set the pending annotation's set/class after a tick (after state update)
    setTimeout(() => {
      const store = useMapLayersStore.getState();
      if (store.pendingAnnotation) {
        store.setPendingAnnotationField({
          annotationSetId: annotationSetId,
          classId: classes[0]?.id,
        });
      }
    }, 0);
  };

  const handleDownload = async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      const fc = await annotationSetsApi.getAllFeatures(annotationSetId);
      const safeName = (annSet?.name ?? 'annotation-set').replace(/[^a-z0-9-_]+/gi, '_');
      const blob = new Blob([JSON.stringify(fc, null, 2)], { type: 'application/geo+json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${safeName}.geojson`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      const count = fc.features?.length ?? 0;
      toast.success(`Downloaded ${count} feature${count !== 1 ? 's' : ''}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
    }
  };

  const handleRemoveFromMap = async () => {
    if (!confirmRemove) {
      setConfirmRemove(true);
      return;
    }
    if (mapId) {
      const backendId = backendLayerIds[layerId];
      if (backendId) {
        try {
          await datasetsApi.deleteMapLayer(mapId, backendId);
        } catch {
          toast.error('Unable to delete layer');
          setConfirmRemove(false);
          return;
        }
      }
    }
    removeLayer(layerId);
    closeRightPanel();
    if (mapId) {
      queryClient.invalidateQueries({ queryKey: qk.maps.detail(mapId) });
    }
  };

  const handlePurge = async () => {
    if (!annSet || purging) return;
    setPurging(true);
    try {
      await annotationSetsApi.purge(annotationSetId);
      removeLayer(layerId);
      closeRightPanel();
      if (mapId) queryClient.invalidateQueries({ queryKey: qk.maps.detail(mapId) });
      queryClient.invalidateQueries({ queryKey: ['annotation-sets'] });
      queryClient.invalidateQueries({ queryKey: ['train-head-aoi-sets'] });
      queryClient.invalidateQueries({ queryKey: ['train-head-datasets'] });
      toast.success(`Deleted “${annSet.name}”`);
    } catch {
      toast.error('Could not delete the annotation set. It needs an admin role.');
      setPurging(false);
    }
  };

  useEffect(() => {
    if (!confirmRemove) return;
    const t = setTimeout(() => setConfirmRemove(false), 3000);
    return () => clearTimeout(t);
  }, [confirmRemove]);

  if (isLoading) {
    return (
      <div style={{ padding: '20px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: MC.textMuted }}>Loading...</div>
      </div>
    );
  }

  if (!annSet) {
    return (
      <div style={{ padding: '20px 14px', textAlign: 'center' }}>
        <div style={{ fontSize: 12, color: MC.textMuted }}>Annotation set not found</div>
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflowY: 'auto' }}>
      {/* Header info */}
      <Section title={isRasterMask ? 'Raster Mask' : 'Annotation Set'}>
        <div style={{ marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {isRasterMask && (
              <ImageIcon size={13} style={{ color: MC.accent, flexShrink: 0 }} />
            )}
            <div style={{ fontSize: 13, fontWeight: 600, color: MC.text }}>{annSet.name}</div>
          </div>
          {isRasterMask && (
            <div style={{
              display: 'inline-flex', alignItems: 'center', gap: 4,
              marginTop: 5, padding: '2px 7px', borderRadius: 10,
              background: MC.accentDim, border: `1px solid ${MC.border}`,
              fontSize: 10, fontWeight: 600, color: MC.accent, letterSpacing: '0.04em',
            }}>
              RASTER MASK
            </div>
          )}
          {annSet.description && (
            <div style={{ fontSize: 11, color: MC.textMuted, marginTop: 4, lineHeight: 1.4 }}>
              {annSet.description}
            </div>
          )}
        </div>
        {!isRasterMask && annSet.annotation_count != null && (
          <div style={{ fontSize: 11, color: MC.textMuted }}>
            {annSet.annotation_count} annotation{annSet.annotation_count !== 1 ? 's' : ''}
          </div>
        )}
        {schema && (
          <div style={{ fontSize: 11, color: MC.textMuted, marginTop: 4 }}>
            Schema: {schema.name} (v{schema.version})
          </div>
        )}
        {!isRasterMask && geometryTypes.length > 0 && (
          <div style={{ fontSize: 10, color: MC.textMuted, marginTop: 4 }}>
            Geometry: {geometryTypes.join(', ')}
          </div>
        )}
      </Section>

      {!isRasterMask && layer && (hasBoxes || presentClasses.length > 1) && (
        <Section title="View">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {hasBoxes && (
              <div>
                <div style={{ fontSize: 10, color: MC.textMuted, marginBottom: 4 }}>Shape</div>
                <div style={{ display: 'flex' }} role="group" aria-label="Show masks, bounding boxes or both">
                  {([['mask', 'Mask'], ['box', 'Box'], ['both', 'Both']] as const).map(([v, label], i, arr) => (
                    <button
                      key={v}
                      type="button"
                      aria-pressed={shapeView === v}
                      onClick={() => showShape(v)}
                      style={{
                        flex: 1, height: 26, fontSize: 11, fontWeight: 600, cursor: 'pointer',
                        border: `1px solid ${shapeView === v ? MC.accent : MC.inputBorder}`, background: shapeView === v ? MC.accentDim : MC.inputBg, color: MC.text,
                        borderRadius: i === 0 ? '4px 0 0 4px' : i === arr.length - 1 ? '0 4px 4px 0' : 0, marginLeft: i === 0 ? 0 : -1,
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {presentClasses.length > 1 && (
              <div>
                <div style={{ fontSize: 10, color: MC.textMuted, marginBottom: 4 }}>Classes shown</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                  {presentClasses.map((c) => {
                    const on = !hiddenClasses.includes(c.id);
                    const color = c.color;
                    return (
                      <button
                        key={c.id}
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleClassVisible(c.id)}
                        title={on ? `Hide ${c.name}` : `Show ${c.name}`}
                        style={{
                          display: 'inline-flex', alignItems: 'center', gap: 5, height: 24, padding: '0 9px', borderRadius: 12, cursor: 'pointer', fontSize: 11, fontWeight: 600,
                          border: `1px solid ${on ? MC.accent : MC.border}`, background: on ? MC.accentDim : 'transparent', color: on ? MC.text : MC.textMuted,
                          textDecoration: on ? 'none' : 'line-through',
                        }}
                      >
                        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, background: color }} />
                        {c.name}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}
          </div>
        </Section>
      )}

      {!isRasterMask && layer && isBoxSet && (
        <Section title="Masks">
          <p style={{ fontSize: 11, color: MC.textMuted, margin: '0 0 8px', lineHeight: 1.45 }}>
            These annotations are boxes. SAM 3 can outline each object, and the masks are saved as a new set with the same layout as hand-made masks. The original stays.
          </p>
          <label style={{ fontSize: 10, color: MC.textMuted, display: 'block', marginBottom: 4 }} htmlFor="refine-score">Boxes with a score of at least</label>
          <select id="refine-score" value={refineScore} disabled={refining} onChange={(e) => setRefineScore(Number(e.target.value))}
            style={{ width: '100%', height: 28, borderRadius: 4, border: `1px solid ${MC.inputBorder}`, background: MC.inputBg, color: MC.text, fontSize: 12, marginBottom: 8 }}>
            {[0.3, 0.4, 0.5, 0.6, 0.7].map((v) => <option key={v} value={v}>{v.toFixed(1)}</option>)}
          </select>
          <button type="button" disabled={refining || eligible === 0} onClick={() => refineStart.mutate()}
            style={{ width: '100%', height: 32, borderRadius: 4, border: `1.5px solid ${MC.accent}`, background: refining ? 'transparent' : MC.accentDim, color: MC.accent, cursor: refining || eligible === 0 ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
            {refining ? <Loader2 size={12} className="animate-spin" /> : <Layers size={12} />}
            {refining ? (refineJob && refineJob.total_items > 0 ? `Generating masks · ${refineJob.processed_items}/${refineJob.total_items} tiles` : 'Starting…') : `Generate masks for ${eligible} boxes`}
          </button>
          {refineJob?.status === 'completed' && refineJob.config?.result && (
            <p style={{ fontSize: 11, color: MC.textMuted, margin: '8px 0 0', lineHeight: 1.45 }}>
              {refineJob.config.result.masks} masks made{refineJob.config.result.dropped ? `, ${Object.values(refineJob.config.result.dropped).reduce((a, b) => a + b, 0)} dropped as unusable` : ''}.
            </p>
          )}
        </Section>
      )}

      {/* Raster mask config details */}
      {isRasterMask && rasterConfig && (
        <Section title="Raster Config">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: MC.textMuted }}>Band</span>
              <span style={{ color: MC.text, fontWeight: 600 }}>{rasterConfig.band_index}</span>
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11 }}>
              <span style={{ color: MC.textMuted }}>Mapped values</span>
              <span style={{ color: MC.text, fontWeight: 600 }}>
                {Object.keys(rasterConfig.colormap).length}
              </span>
            </div>
          </div>
        </Section>
      )}

      {/* Raster mask value→class colormap */}
      {isRasterMask && rasterConfig && classes.length > 0 && (
        <Section title="Value Mapping">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {Object.entries(rasterConfig.colormap).map(([val, rgba]) => {
              const [r, g, b, a] = rgba;
              if (a === 0) return null; // skip transparent (nodata)
              const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
              return (
                <div key={val} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{
                    width: 10, height: 10, borderRadius: 2, flexShrink: 0,
                    background: hex, border: `1px solid ${MC.borderLight}`,
                  }} />
                  <span style={{ fontSize: 10, color: MC.textMuted, fontFamily: 'monospace', width: 24, flexShrink: 0 }}>
                    {val}
                  </span>
                  <span style={{ fontSize: 11, color: MC.textSecondary, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {classes.find((c) => {
                      const style = c.style?.definition;
                      if (!style) return false;
                      const ch = (style as Record<string, string>).fillColor?.toLowerCase();
                      return ch === hex.toLowerCase();
                    })?.name ?? '—'}
                  </span>
                </div>
              );
            })}
          </div>
        </Section>
      )}

      {/* Classes — for vector annotation sets */}
      {!isRasterMask && classes.length > 0 && (
        <Section title="Classes">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {renderClassTree(classes)}
          </div>
        </Section>
      )}

      {/* Layer opacity */}
      {layer && (
        <Section title="Opacity">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="range" min={0} max={100}
              value={Math.round(layer.opacity * 100)}
              aria-label="Layer opacity"
              aria-valuetext={`${Math.round(layer.opacity * 100)}%`}
              onChange={(e) => setLayerOpacity(layerId, Number(e.target.value) / 100)}
              style={{ flex: 1, accentColor: MC.accent, cursor: 'pointer' }}
            />
            <span style={{ fontSize: 11, color: MC.textMuted, width: 32, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
              {Math.round(layer.opacity * 100)}%
            </span>
          </div>
        </Section>
      )}

      {/* Footer actions */}
      <div style={{
        padding: '12px 14px 16px',
        borderTop: `1px solid ${MC.border}`,
        flexShrink: 0,
        marginTop: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}>
        <button
          onClick={handleRemoveFromMap}
          style={{
            width: '100%',
            height: 32,
            borderRadius: 4,
            border: `1px solid ${MC.accent}`,
            background: confirmRemove ? MC.accentDim : 'transparent',
            color: MC.accent,
            cursor: 'pointer',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.02em',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 6,
          }}
        >
          <Trash2 size={12} />
          {confirmRemove ? 'Click again to remove from map' : 'Remove from map'}
        </button>
        {!isRasterMask && (
          <button
            onClick={handleDownload}
            disabled={downloading}
            style={{
              width: '100%',
              height: 32,
              borderRadius: 4,
              border: `1px solid ${MC.border}`,
              background: 'transparent',
              color: MC.text,
              cursor: downloading ? 'default' : 'pointer',
              opacity: downloading ? 0.6 : 1,
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: '0.02em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Download size={12} />
            {downloading ? 'Preparing…' : 'Download GeoJSON'}
          </button>
        )}
        {!isRasterMask && (
          <button
            onClick={handleAddAnnotation}
            style={{
              width: '100%',
              height: 34,
              borderRadius: 4,
              border: `1.5px solid ${MC.accent}`,
              background: MC.accentDim,
              color: MC.accent,
              cursor: 'pointer',
              fontSize: 12,
              fontWeight: 700,
              letterSpacing: '0.03em',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 6,
            }}
          >
            <Pencil size={12} />
            Add Annotation
          </button>
        )}

        <div style={{ marginTop: 6, paddingTop: 10, borderTop: `1px solid ${MC.border}`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!purgeOpen ? (
            <button
              type="button"
              onClick={() => setPurgeOpen(true)}
              style={{
                width: '100%', height: 32, borderRadius: 4, border: '1px solid rgba(220,38,38,0.45)', background: 'transparent', color: '#dc2626',
                cursor: 'pointer', fontSize: 11, fontWeight: 700, letterSpacing: '0.02em', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
              }}
            >
              <Trash2 size={12} />
              Delete annotation set permanently…
            </button>
          ) : (
            <div role="alertdialog" aria-label="Delete the annotation set permanently" style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={() => setPurgeOpen(false)}
                style={{ flex: 1, height: 32, borderRadius: 4, border: `1px solid ${MC.border}`, background: 'transparent', color: MC.text, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}
              >
                Back
              </button>
              <button
                type="button"
                disabled={purging}
                onClick={handlePurge}
                style={{ flex: 1, height: 32, borderRadius: 4, border: 'none', background: '#dc2626', color: '#fff', cursor: purging ? 'not-allowed' : 'pointer', opacity: purging ? 0.6 : 1, fontSize: 11, fontWeight: 700 }}
              >
                {purging ? 'Deleting…' : 'Confirm delete'}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Class tree rendering ─────────────────────────────────────────────────────

function renderClassTree(classes: AnnotationClass[]) {
  // Build a flat list, indented by path depth
  const sorted = [...classes].sort((a, b) => (a.path ?? a.name).localeCompare(b.path ?? b.name));

  return sorted.map((cls) => {
    const depth = cls.path ? cls.path.split('.').length - 1 : 0;
    const color = normalizeClassStyleDefinition(
      cls.style?.definition as Record<string, unknown> | undefined,
    ).fillColor;
    const description = getClassDescription(cls);

    return (
      <div
        key={cls.id}
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 8,
          paddingLeft: depth * 16,
        }}
      >
        <div style={{
          width: 10,
          height: 10,
          borderRadius: 2,
          background: color,
          flexShrink: 0,
          opacity: 0.85,
          marginTop: description ? 2 : 3,
        }} />
        <div style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{
            fontSize: 12,
            color: MC.text,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            {cls.name}
          </span>
          {description && (
            <span style={{
              marginTop: 1,
              fontSize: 10,
              color: MC.textMuted,
              lineHeight: 1.3,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}>
              {description}
            </span>
          )}
        </div>
      </div>
    );
  });
}

// ── Section wrapper ──────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{
      padding: '12px 14px',
      borderBottom: `1px solid ${MC.border}`,
      display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700,
        letterSpacing: '0.08em', textTransform: 'uppercase',
        color: MC.sectionLabel,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <Layers size={11} />
        {title}
      </div>
      {children}
    </div>
  );
}
