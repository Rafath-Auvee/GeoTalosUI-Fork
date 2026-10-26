import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { annotationSetsApi } from '@/lib/api/annotation-sets';
import type { LayerConfig } from '../types';
import type { Bbox } from '../utils/annotationSetHierarchy';

/** Vector annotation-set layers currently on the map: layer id -> set id. */
export function vectorSetLayers(layers: Record<string, LayerConfig>): { layerId: string; setId: string }[] {
  return Object.values(layers)
    .filter((l) => l.sourceType === 'annotation_set' && l.annotationSetId && !l.isRasterMask)
    .map((l) => ({ layerId: l.id, setId: l.annotationSetId as string }));
}

/**
 * Live extent of every annotation set on the map, read from the server per set (not from the map's
 * mount list, which goes stale when a set is reloaded or filled by a model after it was mounted).
 * A set with no extent yet (a model still writing) is re-checked a few times. Keyed under
 * 'annotation-set' so saves and deletes that invalidate that prefix refresh it.
 */
export function useAnnotationSetExtents(layers: Record<string, LayerConfig>): Map<string, Bbox> {
  const ids = useMemo(() => [...new Set(vectorSetLayers(layers).map((x) => x.setId))], [layers]);
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ['annotation-set', 'extent', id],
      queryFn: async (): Promise<Bbox | null> => {
        const { bounds } = await annotationSetsApi.getBounds(id);
        return bounds ? [bounds.west, bounds.south, bounds.east, bounds.north] : null;
      },
      staleTime: 60_000,
      refetchInterval: (q: { state: { data?: Bbox | null; dataUpdateCount: number } }) =>
        q.state.data == null && q.state.dataUpdateCount < 8 ? 4000 : false,
    })),
  });
  return useMemo(() => {
    const m = new Map<string, Bbox>();
    ids.forEach((id, i) => { const b = results[i]?.data; if (b) m.set(id, b); });
    return m;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids, results.map((r) => r.dataUpdatedAt).join(',')]);
}
