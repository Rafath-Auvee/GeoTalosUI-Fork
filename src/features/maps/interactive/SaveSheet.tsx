'use client';

import { useEffect, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { MC } from '../mapColors';
import { applyDefaultClass, diffDraft, useInteractiveStore, visibleMasks } from './store';
import { Button, note } from './ui';

const stamp = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });

/**
 * The save step. Everything still in the draft after Clean is treated as verified, so this
 * only checks that every mask has a class (one schema), names the set, and writes it.
 * Rendered inside the panel like the exit sheet.
 */
export function SaveSheet() {
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const classes = useInteractiveStore((s) => s.classes);
  const aoiName = useInteractiveStore((s) => s.aoiName);
  const aoiLayerId = useInteractiveStore((s) => s.aoiLayerId);
  const imagery = useInteractiveStore((s) => s.imagery);
  const save = useInteractiveStore((s) => s.save);
  const target = useInteractiveStore((s) => s.target);
  const st = useInteractiveStore.getState;
  const queryClient = useQueryClient();
  const [name, setName] = useState(`Interactive · ${aoiName} · ${stamp()}`);

  // Opening the sheet gives any unlabelled new mask the set's class, whatever state the draft was loaded in.
  useEffect(() => { if (target) applyDefaultClass(); }, [target]);
  const diffNow = diffDraft(masks, strictness, scaleHidden);
  const dupSet = new Set(diffNow.duplicates.map((m) => m.id));
  // Repeats of existing annotations are skipped, so they neither need a class nor count as unlabelled.
  const inPlay = visibleMasks(masks, strictness, scaleHidden).filter((m) => !(target && dupSet.has(m.id)));
  const unlabelled = inPlay.filter((m) => !m.classId).length;
  const perClass = useMemo(() => {
    const by: Record<string, number> = {};
    for (const m of inPlay) if (m.classId) by[m.classId] = (by[m.classId] ?? 0) + 1;
    return Object.entries(by).sort((a, b) => b[1] - a[1]);
  }, [inPlay]);
  const schemaIds = new Set(perClass.map(([id]) => classes[id]?.schemaId));
  const mixedSchemas = schemaIds.size > 1;
  const saving = save.status === 'saving';
  const labelled = inPlay.length - unlabelled;
  const diff = useMemo(() => diffDraft(masks, strictness, scaleHidden), [masks, strictness, scaleHidden]);
  const changes = diff.added.length + diff.updated.length + diff.deletedIds.length;
  // Cleaning a set never needs labelling first: new masks without a class are simply left out.
  const blocked = target ? changes === 0 : unlabelled > 0 || mixedSchemas || labelled === 0 || !name.trim();

  const goLabel = () => {
    st().openSave(false);
    st().setStage('clean');
    st().setReviewFilter('unlabelled');
  };

  const doSave = async () => {
    const aoiId = aoiLayerId ? useMapLayersStore.getState().backendLayerIds[aoiLayerId] : undefined;
    if (!aoiId) {
      useInteractiveStore.setState((s) => ({ save: { ...s.save, status: 'error', error: 'This AOI hasn\'t been saved to the project yet. Open the AOI panel once and try again.' } }));
      return;
    }
    const res = await st().saveDraftToProject({ name: target?.name ?? name.trim(), aoiId });
    if (!res) return;

    if (target) {
      // The set already exists on the map: make its tiles refetch instead of adding a layer.
      const layers = useMapLayersStore.getState();
      const l = layers.layers[target.layerId];
      if (l?.tileUrl) {
        const base = l.tileUrl.replace(/([?&])_v=\d+&?/, '$1').replace(/[?&]$/, '');
        layers.setLayerTileConfig(l.id, { tileUrl: `${base}${base.includes('?') ? '&' : '?'}_v=${Date.now()}` });
      }
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes('annotation-set') });
      toast.success(`Updated ${target.name}: ${diff.added.length} added, ${diff.deletedIds.length} removed, ${diff.updated.length} changed`);
      st().exit({ discard: true });
      return;
    }

    // Show the new set on the map right away (the server has already mounted it on the map).
    const layers = useMapLayersStore.getState();
    const classStyles = Object.fromEntries(
      Object.values(classes).map((c) => [c.id, { fillColor: c.color, strokeColor: c.color, strokeWidth: 2, fillOpacity: 0.3 }]),
    );
    layers.addAnnotationSetLayer({ setId: res.setId, name: name.trim(), datasetId: imagery?.datasetId, classStyles });
    void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes('annotation-set') });
    toast.success(`Saved ${res.count} verified annotations`);
    st().exit({ discard: true });
  };

  return (
    <div
      role="dialog"
      aria-label="Save verified annotations"
      style={{ position: 'absolute', inset: 0, background: 'rgba(36,44,32,0.55)', display: 'flex', alignItems: 'flex-end', zIndex: 5 }}
    >
      <div style={{ width: '100%', maxHeight: '100%', overflowY: 'auto', background: MC.panelBg, borderTop: `2px solid ${MC.accent}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: MC.text }}>
            {target ? `Apply changes to ${target.name}` : `Save ${labelled} verified annotation${labelled === 1 ? '' : 's'}`}
          </div>
          <p style={{ ...note, marginTop: 4 }}>
            {target
              ? `Only what you changed is written. Annotations of the set outside ${aoiName} are left alone.`
              : `Everything left in the draft is saved as a verified annotation set tagged to ${aoiName}, and appears on the map.`}
          </p>
        </div>

        {target && <DiffRows added={diff.added.length} removed={diff.deletedIds.length} changed={diff.updated.length} duplicates={diff.duplicates.length} unchanged={Math.max(0, target.count - diff.deletedIds.length - diff.updated.length)} />}

        {!target && <div>
          <label htmlFor="isv-name" style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: MC.textMuted, display: 'block', marginBottom: 4 }}>Set name</label>
          <input id="isv-name" value={name} maxLength={255} onChange={(e) => setName(e.target.value)} style={{ width: '100%', height: 30, padding: '0 8px', borderRadius: 5, border: `1px solid ${MC.inputBorder}`, background: MC.inputBg, color: MC.text, fontSize: 11 }} />
        </div>}

        {!target && <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
          {perClass.map(([id, n]) => (
            <li key={id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11, color: MC.text }}>
              <span style={{ width: 10, height: 10, borderRadius: 5, background: classes[id]?.color ?? MC.accent }} />
              <span style={{ flex: 1 }}>{classes[id]?.name ?? 'Class'}</span>
              <b style={{ fontVariantNumeric: 'tabular-nums' }}>{n}</b>
            </li>
          ))}
        </ul>}

        <p style={note}>Each annotation is saved with its mask outline and its bounding box, which is re-derived when the outline changes.</p>

        {target && diff.unclassed.length > 0 && (
          <p style={note}>{diff.unclassed.length} new mask{diff.unclassed.length === 1 ? ' has' : 's have'} no class and won&apos;t be saved. Label {diff.unclassed.length === 1 ? 'it' : 'them'} in Clean to include {diff.unclassed.length === 1 ? 'it' : 'them'}.</p>
        )}
        {!target && unlabelled > 0 && (
          <div style={{ border: `1px solid ${MC.danger}`, borderRadius: 6, padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <span style={{ ...note, color: MC.danger, display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} />
              {unlabelled} mask{unlabelled === 1 ? ' has' : 's have'} no class. Label or delete {unlabelled === 1 ? 'it' : 'them'} before saving.
            </span>
            <Button onClick={goLabel}>Go to Clean and label them</Button>
          </div>
        )}
        {!target && mixedSchemas && <p style={{ ...note, color: MC.danger }}>These masks are labelled with classes from more than one schema. A saved set uses one schema, so relabel them with a single schema.</p>}
        {save.status === 'error' && <p role="alert" style={{ ...note, color: MC.danger }}>{save.error}</p>}

        <Button primary disabled={blocked || saving} onClick={() => void doSave()}>
          {saving ? <><Loader2 size={12} className="animate-spin" /> Saving…</> : target ? `Apply ${changes} change${changes === 1 ? '' : 's'}` : `Save ${labelled} annotation${labelled === 1 ? '' : 's'}`}
        </Button>
        <Button disabled={saving} onClick={() => st().openSave(false)}>Not yet</Button>
      </div>
    </div>
  );
}

const rowStyle = { display: 'flex', alignItems: 'baseline', gap: 8, fontSize: 11, color: MC.text, margin: 0 } as const;

/** The change summary for an in-place edit: each row carries a sign as well as a colour. */
function DiffRows({ added, removed, changed, duplicates, unchanged }: { added: number; removed: number; changed: number; duplicates: number; unchanged: number }) {
  const rows: { sign: string; label: string; n: number; color: string }[] = [
    { sign: '+', label: 'added', n: added, color: MC.success },
    { sign: '−', label: 'removed', n: removed, color: MC.danger },
    { sign: '~', label: 'relabelled or reshaped', n: changed, color: MC.accent },
    { sign: '=', label: 'untouched', n: unchanged, color: MC.textMuted },
    { sign: '≈', label: 'skipped: already in the set', n: duplicates, color: MC.textMuted },
  ];
  return (
    <ul aria-label="Changes to the set" style={{ listStyle: 'none', margin: 0, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4, border: `1px solid ${MC.border}`, borderRadius: 6, background: MC.inputBg }}>
      {rows.map((r) => (
        <li key={r.sign} style={{ ...rowStyle, opacity: r.n === 0 ? 0.55 : 1 }}>
          <span aria-hidden="true" style={{ width: 12, fontWeight: 800, color: r.color, textAlign: 'center' }}>{r.sign}</span>
          <b style={{ minWidth: 34, fontVariantNumeric: 'tabular-nums', textAlign: 'right' }}>{r.n}</b>
          <span style={{ flex: 1, color: MC.textSecondary }}>{r.label}</span>
        </li>
      ))}
    </ul>
  );
}
