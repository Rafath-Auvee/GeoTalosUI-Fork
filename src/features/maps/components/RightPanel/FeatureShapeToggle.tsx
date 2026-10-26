'use client';

import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { annotationsApi } from '@/lib/api/annotations';
import { getMapInstance } from '@/stores/mapStore';
import { MC } from '../../mapColors';

type Box = [number, number, number, number];

const asBox = (v: unknown): Box | null =>
  Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (v as Box) : null;

/**
 * Mask / Box switch for an annotation that carries a bounding box (properties.bbox, [minx, miny, maxx, maxy]).
 * "Box" outlines the box on the map for the selected feature; it renders nothing when the annotation has none.
 */
export function FeatureShapeToggle({ annotationId, properties }: { annotationId?: string; properties: Record<string, unknown> }) {
  const [view, setView] = useState<'mask' | 'box'>('mask');
  const inline = asBox(properties.bbox);
  // Vector-tile clicks carry only a few properties, so look the annotation up to see whether it has a box.
  const { data } = useQuery({
    queryKey: ['annotation-bbox', annotationId],
    queryFn: () => annotationsApi.get(annotationId as string),
    enabled: !!annotationId && !inline,
    staleTime: 5 * 60_000,
  });
  const box = inline ?? asBox(data?.properties?.bbox);

  useEffect(() => setView('mask'), [annotationId]);

  useEffect(() => {
    if (view !== 'box' || !box) return;
    const map = getMapInstance();
    if (!map) return;
    let layer: { remove: () => void } | null = null;
    let cancelled = false;
    void import('leaflet').then((L) => {
      if (cancelled) return;
      layer = L.rectangle([[box[1], box[0]], [box[3], box[2]]], { color: MC.accent, weight: 3, fill: false, dashArray: '6 4', interactive: false }).addTo(map);
    });
    return () => { cancelled = true; layer?.remove(); };
  }, [view, box]);

  if (!box) return null;
  const opt = (v: 'mask' | 'box', label: string) => (
    <button
      type="button"
      aria-pressed={view === v}
      onClick={() => setView(v)}
      style={{ flex: 1, height: 24, fontSize: 11, fontWeight: 600, cursor: 'pointer', border: `1px solid ${view === v ? MC.accent : MC.inputBorder}`, background: view === v ? MC.accentDim : MC.inputBg, color: MC.text, borderRadius: v === 'mask' ? '4px 0 0 4px' : '0 4px 4px 0' }}
    >
      {label}
    </button>
  );
  return (
    <div style={{ padding: '7px 14px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
      <div style={{ fontSize: 9, color: MC.sectionLabel, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.06em' }}>Shape</div>
      <div style={{ display: 'flex' }} role="group" aria-label="Show the mask or the bounding box">
        {opt('mask', 'Mask')}
        {opt('box', 'Bounding box')}
      </div>
    </div>
  );
}
