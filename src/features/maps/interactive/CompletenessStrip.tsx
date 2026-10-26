'use client';

import { MC } from '../mapColors';
import type { MapFilter } from './types';
import { countDraft, useInteractiveStore } from './store';

const HATCH = `repeating-linear-gradient(135deg, ${MC.accent} 0 3px, rgba(196,152,92,0.35) 3px 6px)`;

/**
 * The mode's constant truth: how much of the draft is labelled, unlabelled or
 * suspect. Segments and legend entries filter the map to that slice.
 */
export function CompletenessStrip() {
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const filter = useInteractiveStore((s) => s.mapFilter);
  const setFilter = useInteractiveStore((s) => s.setMapFilter);
  const c = countDraft(masks, strictness);

  const segs: { id: MapFilter; label: string; n: number; bg: string }[] = [
    { id: 'labelled', label: 'labelled', n: c.barLabelled, bg: MC.success },
    { id: 'unlabelled', label: 'unlabelled', n: c.barUnlabelled, bg: HATCH },
    { id: 'flagged', label: 'flagged', n: c.flagged, bg: MC.danger },
  ];
  const toggle = (id: MapFilter) => setFilter(filter === id ? 'all' : id);

  return (
    <div style={{ padding: '10px 14px 9px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
      <div
        role="img"
        aria-label={`${c.labelled} labelled, ${c.unlabelled} unlabelled, ${c.flagged} flagged of ${c.total}`}
        style={{
          display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden',
          background: c.total ? MC.border : 'transparent', border: `1px solid ${MC.border}`,
        }}
      >
        {c.total > 0 &&
          segs.filter((s) => s.n > 0).map((s) => (
            <button
              key={s.id}
              type="button"
              title={`Show ${s.label} on the map`}
              onClick={() => toggle(s.id)}
              style={{ flex: s.n, minWidth: 3, background: s.bg, border: 'none', padding: 0, cursor: 'pointer', opacity: filter === 'all' || filter === s.id ? 1 : 0.35 }}
            />
          ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, fontSize: 10, fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ color: MC.text, fontWeight: 700 }}>{c.total} masks</span>
        {segs.map((s) => (
          <button
            key={s.id}
            type="button"
            onClick={() => toggle(s.id)}
            aria-pressed={filter === s.id}
            style={{
              background: 'transparent', border: 'none', padding: 0, cursor: 'pointer', fontSize: 10,
              color: filter === s.id ? MC.text : MC.textSecondary, fontWeight: filter === s.id ? 700 : 500,
              textDecoration: filter === s.id ? 'underline' : 'none', textUnderlineOffset: 2,
            }}
          >
            {s.id === 'labelled' ? c.labelled : s.id === 'unlabelled' ? c.unlabelled : c.flagged} {s.label}
          </button>
        ))}
        {c.deleted > 0 && <span style={{ color: MC.textMuted }}>{c.deleted} deleted</span>}
      </div>
    </div>
  );
}
