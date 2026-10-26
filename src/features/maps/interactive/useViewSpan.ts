'use client';

import { useEffect, useState } from 'react';
import { getMapManager } from '../MapManager';
import { useMapStore } from '@/stores/mapStore';

/** Shorter side of the visible map (m). Zooming is how the user picks "how big is an object here". */
export function useViewSpanM(active: boolean): number | null {
  const mapReady = useMapStore((s) => s.mapReady);
  const [span, setSpan] = useState<number | null>(null);

  useEffect(() => {
    if (!active || !mapReady) return;
    const map = getMapManager().getMap();
    if (!map) return;
    const update = () => {
      const b = map.getBounds();
      const c = b.getCenter();
      const w = map.distance([c.lat, b.getWest()], [c.lat, b.getEast()]);
      const h = map.distance([b.getSouth(), c.lng], [b.getNorth(), c.lng]);
      setSpan(Math.min(w, h));
    };
    update();
    map.on('moveend zoomend', update);
    return () => { map.off('moveend zoomend', update); };
  }, [active, mapReady]);

  return span;
}
