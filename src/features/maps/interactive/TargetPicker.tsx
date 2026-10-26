'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { selectAoiPicks, useAoiVectorPicks } from '../aoiVectorPicks';
import { MC } from '../mapColors';
import { PanelSelect } from '../components/RightPanel/PanelControls';
import { diffDraft, useInteractiveStore } from './store';
import { Button, Section, note } from './ui';

type Choice = { kind: 'new' } | { kind: 'set'; layerId: string };

/**
 * What this session edits: new objects (saved as a new set) or a set already loaded on the map
 * (cleaned in place). Only vector sets that are on the map are offered; the server then reports
 * how many of their annotations fall inside the AOI.
 */
export function TargetPicker() {
  const target = useInteractiveStore((s) => s.target);
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const aoiLayerId = useInteractiveStore((s) => s.aoiLayerId);
  const running = useInteractiveStore((s) => s.run.status === 'running');
  const layers = useMapLayersStore((s) => s.layers);
  const backendLayerIds = useMapLayersStore((s) => s.backendLayerIds);
  const st = useInteractiveStore.getState;
  const [pending, setPending] = useState<Choice | null>(null);

  // The annotation sets picked on this AOI (the AOI panel's data picker), which are on the map.
  const picked = useAoiVectorPicks(selectAoiPicks(aoiLayerId));
  const sets = useMemo(
    () => Object.values(layers).filter((l) => l.sourceType === 'annotation_set' && l.annotationSetId && !l.isRasterMask && picked.includes(l.annotationSetId)),
    [layers, picked],
  );

  const hasWork = target
    ? (() => { const d = diffDraft(masks, strictness, scaleHidden); return d.added.length + d.updated.length + d.deletedIds.length > 0; })()
    : masks.length > 0;

  const apply = (c: Choice) => {
    setPending(null);
    if (c.kind === 'new') { void st().setTarget(null); return; }
    const l = layers[c.layerId];
    const setId = l?.annotationSetId;
    if (!l || !setId) return;
    const aoiId = aoiLayerId ? backendLayerIds[aoiLayerId] : undefined;
    void st().setTarget({ setId, name: l.name ?? "Annotation set", layerId: l.id, aoiId });
  };
  const choose = (c: Choice) => {
    if (c.kind === 'new' && !target) return;
    if (c.kind === 'set' && target && layers[c.layerId]?.annotationSetId === target.setId) return;
    if (hasWork) setPending(c); else apply(c);
  };

  const cleaning = !!target || pending?.kind === 'set';

  return (
    <Section label="Work on">
      <div role="group" aria-label="What to annotate" style={{ display: 'flex', gap: 0, border: `1px solid ${MC.border}`, borderRadius: 6, padding: 2, background: MC.inputBg }}>
        {([['new', 'New annotations'], ['set', 'Clean a set']] as const).map(([k, label]) => {
          const on = k === 'set' ? !!target : !target;
          return (
            <button
              key={k}
              type="button"
              aria-pressed={on}
              disabled={running}
              onClick={() => (k === 'new' ? choose({ kind: 'new' }) : sets[0] && choose({ kind: 'set', layerId: sets[0].id }))}
              style={{
                flex: 1, height: 26, borderRadius: 4, fontSize: 11, fontWeight: 700, border: 'none',
                background: on ? MC.panelBg : 'transparent', color: on ? MC.text : MC.textSecondary,
                boxShadow: on ? `0 0 0 1px ${MC.accent}` : 'none',
                cursor: running ? 'not-allowed' : k === 'set' && sets.length === 0 ? 'not-allowed' : 'pointer',
                opacity: k === 'set' && sets.length === 0 ? 0.55 : 1,
                transition: 'background 0.12s, box-shadow 0.12s',
              }}
              title={k === 'set' && sets.length === 0 ? 'Add an annotation set to this AOI first' : undefined}
            >
              {label}
            </button>
          );
        })}
      </div>

      {cleaning && (
        <PanelSelect
          aria-label="Annotation set to clean"
          value={target?.layerId ?? ''}
          disabled={running}
          onChange={(e) => e.target.value && choose({ kind: 'set', layerId: e.target.value })}
        >
          {!target && <option value="">Choose a loaded set…</option>}
          {sets.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
        </PanelSelect>
      )}

      {!target && sets.length === 0 && (
        <p style={note}>To clean an existing set, add it under Data in the AOI panel first. The sets you added there are listed here.</p>
      )}
      {!target && <p style={note}>Find objects with SAM 3, label them, and save them as a new set.</p>}

      {target?.status === 'loading' && (
        <p style={{ ...note, display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={11} className="animate-spin" /> Loading annotations inside the AOI…</p>
      )}
      {target?.status === 'ready' && (
        <p style={note}>
          {target.count === 0
            ? 'No annotations of this set fall inside the AOI. Anything you add is saved to the set.'
            : <><b style={{ color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{target.count}</b> annotation{target.count === 1 ? '' : 's'} loaded as masks. Delete false positives in Clean, and outline missed objects below to add them. Changes are saved to the set itself.</>}
        </p>
      )}
      {target?.status === 'error' && (
        <p role="alert" style={{ ...note, color: MC.danger, display: 'flex', gap: 5, alignItems: 'flex-start' }}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} /> {target.error}
        </p>
      )}

      {pending && (
        <div role="alertdialog" aria-label="Replace the draft?" style={{ border: `1px solid ${MC.danger}`, borderRadius: 6, padding: 9, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontSize: 11, color: MC.text }}>Switching replaces the current draft. Your unsaved work here will be lost.</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button primary onClick={() => apply(pending)}>Switch</Button>
            <Button onClick={() => setPending(null)}>Keep working</Button>
          </div>
        </div>
      )}
    </Section>
  );
}
