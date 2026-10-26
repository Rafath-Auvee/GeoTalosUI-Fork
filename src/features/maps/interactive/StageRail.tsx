'use client';

import { Check } from 'lucide-react';
import { MC } from '../mapColors';
import { STAGES } from './types';
import { countDraft, useInteractiveStore } from './store';

export function StageRail() {
  const stage = useInteractiveStore((s) => s.stage);
  const setStage = useInteractiveStore((s) => s.setStage);
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const groupCount = useInteractiveStore((s) => s.group.clusters.length);
  const counts = countDraft(masks, strictness);

  const badge = (id: string): string => {
    if (id === 'propose') return counts.total ? String(counts.total) : '–';
    if (id === 'group') return groupCount ? String(groupCount) : '–';
    if (id === 'clean') return counts.flagged ? String(counts.flagged) : '–';
    return '–';
  };
  const done = (id: string) => (id === 'propose' && counts.total > 0) || (id === 'group' && groupCount > 0);

  return (
    <nav aria-label="Annotation stages" style={{ display: 'flex', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
      {STAGES.map((s) => {
        const active = s.id === stage;
        return (
          <button
            key={s.id}
            type="button"
            onClick={() => setStage(s.id)}
            aria-current={active ? 'step' : undefined}
            title={`${s.label} (${s.key})`}
            style={{
              flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
              padding: '8px 2px 7px', background: active ? MC.accentDim : 'transparent', border: 'none',
              borderBottom: `2px solid ${active ? MC.accent : 'transparent'}`, marginBottom: -1, cursor: 'pointer',
            }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
              <span
                style={{
                  width: 16, height: 16, borderRadius: 8, fontSize: 10, fontWeight: 700,
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  background: done(s.id) ? MC.success : active ? MC.accent : 'transparent',
                  border: `1px solid ${done(s.id) ? MC.success : active ? MC.accent : MC.borderLight}`,
                  color: done(s.id) || active ? MC.navBg : MC.textMuted,
                }}
              >
                {done(s.id) ? <Check size={10} strokeWidth={3} color="#fff" /> : s.key}
              </span>
              <span style={{ fontSize: 11, fontWeight: 600, color: active ? MC.text : MC.textSecondary }}>{s.label}</span>
            </span>
            <span style={{ fontSize: 10, color: MC.textMuted, fontVariantNumeric: 'tabular-nums' }}>{badge(s.id)}</span>
          </button>
        );
      })}
    </nav>
  );
}
