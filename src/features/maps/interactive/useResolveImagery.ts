'use client';

import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { mapsApi } from '@/lib/api/maps';
import { qk } from '@/lib/query-keys';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { useInteractiveStore } from './store';

/**
 * Works out which imagery SAM 3 reads, with no UI: the dataset selected on the
 * AOI (the mode can't be entered without one) and its active item. The AOI
 * panel's chosen item is used when it exists; otherwise the dataset's first item
 * in this AOI.
 */
export function useResolveImagery(): void {
  const datasets = useInteractiveStore((s) => s.imageryDatasets);
  const imagery = useInteractiveStore((s) => s.imagery);
  const setImagery = useInteractiveStore((s) => s.setImagery);
  const mapId = useInteractiveStore((s) => s.mapId);
  const aoiLayerId = useInteractiveStore((s) => s.aoiLayerId);
  const bbox = useInteractiveStore((s) => s.aoiBbox);

  const dataset = datasets[0];
  const chosenInAoiPanel = useMapLayersStore((s) =>
    dataset && aoiLayerId ? s.layers[`${aoiLayerId}-ds-${dataset.id}`]?.stacItemId : undefined,
  );

  const needFetch = !!dataset && !chosenInAoiPanel && !!bbox && mapId !== 'local';
  const { data } = useQuery({
    queryKey: qk.maps.datasetItemsInAoi(mapId, dataset?.id ?? '', bbox ? bbox.join(',') : ''),
    queryFn: () => mapsApi.listDatasetItemsInAoi(mapId, dataset!.id, bbox!, { limit: 1 }),
    enabled: needFetch,
  });

  const stacItemId = chosenInAoiPanel ?? data?.items?.[0]?.stac_item_id;
  useEffect(() => {
    if (!dataset || !stacItemId) return;
    if (imagery?.datasetId === dataset.id && imagery.stacItemId === stacItemId) return;
    setImagery({ datasetId: dataset.id, stacItemId, name: dataset.name });
  }, [dataset, stacItemId, imagery, setImagery]);
}
