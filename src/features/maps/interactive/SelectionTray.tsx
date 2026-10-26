'use client';

import { useState } from 'react';
import { Scissors, Trash2, Undo2, X } from 'lucide-react';
import { MC } from '../mapColors';
import { isFiltering, selectMasks } from './selection';
import { useInteractiveStore, visibleMasks } from './store';
import type { LabelClass } from './types';
import { Button, note } from './ui';

const fmtM = (m: number) => (m >= 100 ? `${Math.round(m)}` : m >= 10 ? m.toFixed(0) : m.toFixed(1));

/**
 * What the active filters select, and what can be done to it. Sticky at the bottom of
 * the Group stage so the actions are always in reach while the filters are being tuned.
 */
export function SelectionTray({ mode, labelClass }: { mode: 'group' | 'clean'; labelClass: LabelClass | null }) {
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const selection = useInteractiveStore((s) => s.selection);
  const similar = useInteractiveStore((s) => s.similar);
  const group = useInteractiveStore((s) => s.group);
  const canUndo = useInteractiveStore((s) => s.history.length > 0);
  const [splitN, setSplitN] = useState(3);
  const st = useInteractiveStore.getState;

  const filtering = isFiltering(selection, similar);
  const inPlay = visibleMasks(masks, strictness, scaleHidden);
  const selected = selectMasks(inPlay, selection, similar);
  const deletable = selected.filter((m) => m.source !== 'manual').length;
  const others = inPlay.filter((m) => m.source !== 'manual' && !selected.includes(m)).length;
  if (!filtering && !canUndo) return null;

  const names = selection.lookGroups.map((i) => group.clusters.find((c) => c.index === i)?.name ?? '?').join(', ');
  const chip = (label: string, onClear: () => void) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, height: 22, padding: '0 4px 0 8px', borderRadius: 11, border: `1px solid ${MC.accent}`, background: MC.accentDim, fontSize: 10, fontWeight: 600, color: MC.text }}>
      {label}
      <button type="button" aria-label={`Remove filter ${label}`} onClick={onClear} style={{ width: 16, height: 16, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: MC.textMuted, cursor: 'pointer', padding: 0 }}>
        <X size={11} />
      </button>
    </span>
  );

  return (
    <div style={{ position: 'sticky', bottom: -16, margin: '4px -14px -16px', padding: '10px 14px 12px', background: MC.panelBg, borderTop: `2px solid ${MC.accent}`, display: 'flex', flexDirection: 'column', gap: 8, boxShadow: '0 -4px 12px rgba(36,44,32,0.12)' }}>
      {filtering && (
        <>
          <div role="status" aria-live="polite" style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            <b style={{ fontSize: 12, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{selected.length}</b>
            <span style={note}>of {inPlay.length} masks selected</span>
            {selected.length === 0 && <span style={{ ...note, color: MC.danger }}>· nothing matches all the filters</span>}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
            {selection.picked.length > 0 && chip(`Picked ${selection.picked.length}`, () => useInteractiveStore.setState((s) => ({ selection: { ...s.selection, picked: [] } })))}
            {selection.sizeRange && chip(`Size ${fmtM(selection.sizeRange[0])}–${fmtM(selection.sizeRange[1])} m`, () => st().setSizeRange(null))}
            {selection.lookGroups.length > 0 && chip(`Look ${names}`, () => selection.lookGroups.forEach((i) => st().toggleLookGroup(i)))}
            {similar.active && !similar.busy && chip(`Look-alikes ≥ ${similar.threshold.toFixed(2)}`, () => st().clearSimilar())}
            <button type="button" onClick={() => st().clearSelection()} style={{ background: 'transparent', border: 'none', color: MC.accent, fontSize: 10, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>Clear all</button>
          </div>

          {mode === 'clean' && (
            <Button
              primary
              disabled={selected.length === 0 || !labelClass}
              onClick={() => st().assignToSelection(labelClass)}
              title={labelClass ? undefined : 'Choose a class under "Label with" first'}
            >
              {labelClass ? <>Label {selected.length} as <span style={{ display: 'inline-block', width: 9, height: 9, borderRadius: 5, background: labelClass.color, margin: '0 2px 0 4px' }} />{labelClass.name}</> : 'Choose a class to label'}
            </Button>
          )}

          <div style={{ display: 'flex', gap: 6 }}>
            <Button icon={<Trash2 size={11} />} disabled={deletable === 0} onClick={() => st().deleteSelection()} title="Remove these masks from the draft (Delete key). Your reference objects are never deleted.">
              Delete {deletable}
            </Button>
            <Button icon={<Undo2 size={11} />} disabled={!canUndo} onClick={() => st().undo()} title="Undo the last label or delete">Undo</Button>
          </div>
          <Button
            icon={<Trash2 size={11} />}
            disabled={selected.length === 0 || others === 0}
            onClick={() => st().keepOnlySelection()}
            title={selected.length === 0 ? 'Nothing is selected, so this would delete every mask. Loosen the filters until some masks are selected.' : 'Keep the selected masks and remove all the others from the draft. Your reference objects are kept. Undo brings them back.'}
          >
            Keep these {selected.length}, delete the other {others}
          </Button>

          {mode === 'group' && group.status === 'ready' && selected.length >= 2 && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <Scissors size={12} color={MC.textMuted} />
              <span style={note}>Split these by look into</span>
              <select aria-label="Number of sub-groups" value={splitN} onChange={(e) => setSplitN(Number(e.target.value))} style={{ height: 24, borderRadius: 4, border: `1px solid ${MC.inputBorder}`, background: MC.inputBg, color: MC.text, fontSize: 11 }}>
                {[2, 3, 4, 5, 6].map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <Button fullWidth={false} onClick={() => void st().splitSelectionByLook(Math.min(splitN, selected.length))}>Split</Button>
            </div>
          )}
        </>
      )}
      {!filtering && canUndo && <Button icon={<Undo2 size={11} />} onClick={() => st().undo()}>Undo last change</Button>}
    </div>
  );
}
