import { getMapManager } from '../MapManager';

/** Fly the map to a mask, leaving room for the right panel and the bottom gallery. */
export function flyToMask(geometry: unknown): void {
  const map = getMapManager().getMap();
  if (!map) return;
  const ring = (geometry as { coordinates: number[][][] }).coordinates[0];
  const lngs = ring.map((p) => p[0]);
  const lats = ring.map((p) => p[1]);
  map.fitBounds(
    [[Math.min(...lats), Math.min(...lngs)], [Math.max(...lats), Math.max(...lngs)]],
    { maxZoom: 22, paddingTopLeft: [60, 60], paddingBottomRight: [430, 250], animate: true },
  );
}
