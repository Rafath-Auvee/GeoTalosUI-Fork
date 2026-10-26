'use client';

import { useQuery } from '@tanstack/react-query';
import { sam3GroupApi } from '@/lib/api/sam3';
import { useInteractiveStore } from './store';
import type { DraftMask } from './types';

const CHUNK = 60; // the crop endpoint's per-request limit

/** Thumbnails (data URIs) of the imagery around each mask, with the mask outlined. Rendered on demand,
 *  so they exist for every mask — references and unlabelled ones included — with no grouping step needed. */
export function useThumbs(masks: Pick<DraftMask, 'id' | 'geometry'>[]): Record<string, string> {
  const imagery = useInteractiveStore((s) => s.imagery);
  const key = masks.map((m) => m.id).join(',');
  const { data } = useQuery({
    queryKey: ['interactive-crops', imagery?.datasetId, imagery?.stacItemId, key],
    queryFn: async () => {
      const chunks: Pick<DraftMask, 'id' | 'geometry'>[][] = [];
      for (let i = 0; i < masks.length; i += CHUNK) chunks.push(masks.slice(i, i + CHUNK));
      const parts = await Promise.all(
        chunks.map((c) => sam3GroupApi.crops(imagery!.datasetId, imagery!.stacItemId, c.map((m) => ({ id: m.id, geometry: m.geometry })))),
      );
      return Object.assign({}, ...parts.map((p) => p.thumbs)) as Record<string, string>;
    },
    enabled: !!imagery && masks.length > 0,
    staleTime: Infinity,
    placeholderData: (prev) => prev,
  });
  const out: Record<string, string> = {};
  for (const [id, b64] of Object.entries(data ?? {})) out[id] = `data:image/jpeg;base64,${b64}`;
  return out;
}
