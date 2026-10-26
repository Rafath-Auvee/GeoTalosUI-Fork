import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { datasetsApi } from '@/lib/api/datasets';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import type { Dataset } from '@/types/api';
import type { Bbox } from '../utils/annotationSetHierarchy';
import { useAnnotationSetExtents, vectorSetLayers } from './useAnnotationSetExtents';

const overlaps = (a: Bbox, b: Bbox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function geometryBbox(g: unknown): Bbox | null {
  const pts: number[][] = [];
  const walk = (c: unknown) => {
    if (Array.isArray(c) && typeof c[0] === 'number') pts.push(c as number[]);
    else if (Array.isArray(c)) c.forEach(walk);
  };
  walk((g as { coordinates?: unknown } | null)?.coordinates);
  if (!pts.length) return null;
  const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
  return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
}

/**
 * What is already on the map and overlaps this AOI: raster datasets and vector annotation sets.
 * Needs no overlap query. Datasets are read by id (their footprint), sets by their live extent.
 */
export function useOnMapInAoi(aoiBbox: Bbox | null | undefined) {
  const layers = useMapLayersStore((s) => s.layers);
  const extents = useAnnotationSetExtents(layers);

  const datasetIds = useMemo(
    () => Object.values(layers).filter((l) => l.sourceType === 'dataset' && l.type === 'dataset').map((l) => l.id),
    [layers],
  );
  const dsQs = useQueries({
    queries: datasetIds.map((id) => ({ queryKey: ['datasets', 'detail', id], queryFn: () => datasetsApi.get(id), staleTime: 60_000, retry: false })),
  });
  const dsKey = dsQs.map((q) => q.dataUpdatedAt).join(',');

  const rasters: Dataset[] = useMemo(() => {
    if (!aoiBbox) return [];
    return dsQs
      .map((q) => q.data)
      .filter((d): d is Dataset => {
        if (!d || d.status !== 'ready') return false;
        const b = geometryBbox(d.geometry);
        return !b || overlaps(aoiBbox, b);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [aoiBbox, dsKey]);

  const vectors = useMemo(() => {
    if (!aoiBbox) return [];
    return vectorSetLayers(layers)
      .filter(({ setId }) => { const e = extents.get(setId); return !!e && overlaps(aoiBbox, e); })
      .map(({ layerId, setId }) => ({ id: setId, name: layers[layerId]?.name ?? 'Annotation set' }));
  }, [aoiBbox, layers, extents]);

  return { rasters, vectors };
}
