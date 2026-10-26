'use client';

import { useMemo } from 'react';
import { AlertTriangle, Loader2, Network, X } from 'lucide-react';
import { MC } from '../mapColors';
import { MAX_GROUP_MASKS } from './config';
import { useInteractiveStore, visibleMasks } from './store';
import type { GroupMode } from './types';
import { Button, Chip, Section, note } from './ui';
import { SelectionTray } from './SelectionTray';
import { ExistingCheck } from './ExistingCheck';
import { SizeFacet } from './SizeFacet';
import { useThumbs } from './useThumbs';

const MODES: { id: GroupMode; label: string; hint: string }[] = [
  { id: 'mask', label: 'Object only', hint: 'Compares just the outlined object, with its surroundings greyed out. Best for telling kinds of object apart.' },
  { id: 'box', label: 'With surroundings', hint: 'Compares the object and what is around it. Better when context decides what something is, such as a plant among bare soil.' },
];

export function GroupStage() {
  const g = useInteractiveStore((s) => s.group);
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const references = useInteractiveStore((s) => s.references);
  const similar = useInteractiveStore((s) => s.similar);
  const classes = useInteractiveStore((s) => s.classes);
  const lookGroups = useInteractiveStore((s) => s.selection.lookGroups);
  const imagery = useInteractiveStore((s) => s.imagery);
  const st = useInteractiveStore.getState;

  const inPlay = visibleMasks(masks, strictness, scaleHidden);
  const live = masks.filter((m) => !m.deleted);
  const tooMany = inPlay.length > MAX_GROUP_MASKS;
  const embedding = g.status === 'embedding';
  const ready = g.status === 'ready' && g.clusters.length > 0;

  const members = useMemo(() => {
    const by: Record<string, string[]> = {};
    for (const m of live) if (m.clusterId !== null) (by[m.clusterId] ??= []).push(m.id);
    return by;
  }, [live]);
  const classOf = (index: number): string | 'mixed' | null => {
    const set = new Set(live.filter((m) => m.clusterId === String(index)).map((m) => m.classId));
    return set.size === 1 ? ([...set][0] ?? null) : 'mixed';
  };
  const rowIds = new Set(g.clusters.flatMap((c) => (members[String(c.index)] ?? []).slice(0, 4)));
  const thumbs = useThumbs(live.filter((m) => rowIds.has(m.id)));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <p style={note}>
        Narrow the masks by size and by look. The filters combine: whatever matches all of them is selected, and you can delete it or split it by look below. Labelling is the next stage.
      </p>

      <Section label="By size">
        <SizeFacet />
      </Section>

      <Section label="By look" right={ready ? <span style={{ ...note, fontVariantNumeric: 'tabular-nums' }}>{g.clusters.length} groups</span> : undefined}>
        <div role="group" aria-label="What to compare" style={{ display: 'flex', gap: 6 }}>
          {MODES.map((m) => (
            <Chip key={m.id} on={g.mode === m.id} onClick={() => st().setGroupMode(m.id)} disabled={embedding} title={m.hint}>
              {m.label}
            </Chip>
          ))}
        </div>
        <p style={note}>{MODES.find((m) => m.id === g.mode)?.hint}</p>

        {embedding ? (
          <>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(1, g.total)} aria-valuenow={g.done} style={{ height: 6, borderRadius: 3, background: MC.border, overflow: 'hidden' }}>
              <div style={{ width: `${(g.done / Math.max(1, g.total)) * 100}%`, height: '100%', background: MC.accent, transition: 'width 0.3s' }} />
            </div>
            <p style={{ ...note, display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
              <Loader2 size={11} className="animate-spin" color={MC.accent} /> Reading masks · {g.done} of {g.total}
            </p>
          </>
        ) : (
          <Button primary={!ready} icon={<Network size={12} />} disabled={inPlay.length < 2 || tooMany || !imagery} onClick={() => st().runGrouping()}>
            {ready ? `Re-group ${inPlay.length} masks` : `Group ${inPlay.length} masks by look`}
          </Button>
        )}
        {inPlay.length < 2 && !embedding && <p style={note}>Run Segment all in the Propose stage first.</p>}
        {tooMany && <p style={{ ...note, color: MC.danger }}>{inPlay.length} masks is over the {MAX_GROUP_MASKS} limit. Tighten the quality filter first.</p>}
        {g.status === 'error' && (
          <p style={{ ...note, color: MC.danger, display: 'flex', gap: 5, alignItems: 'flex-start' }}>
            <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} /> {g.error ?? 'Grouping failed.'}
          </p>
        )}

        {ready && (
          <>
            <input
              type="range" min={2} max={Math.min(30, Math.max(3, Math.floor(live.length / 4)))} step={1} value={g.k}
              aria-label="Number of groups, fewer to finer"
              onChange={(e) => st().setGroupK(Number(e.target.value))}
              style={{ width: '100%', accentColor: MC.accent }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', ...note }}><span>Fewer groups</span><span>Finer groups</span></div>

            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {g.clusters.map((c) => {
                const ids = members[String(c.index)] ?? [];
                if (ids.length === 0) return null;
                const on = lookGroups.includes(c.index);
                const cls = classOf(c.index);
                const clsInfo = cls && cls !== 'mixed' ? classes[cls] : null;
                return (
                  <li key={c.index}>
                    <button
                      type="button"
                      aria-pressed={on}
                      onClick={() => st().toggleLookGroup(c.index)}
                      style={{ width: '100%', display: 'flex', flexDirection: 'column', gap: 6, padding: '7px 8px', cursor: 'pointer', textAlign: 'left', borderRadius: 6, border: `${on ? 2 : 1}px solid ${on ? c.color : MC.border}`, background: on ? MC.inputBg : 'transparent' }}
                    >
                      <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ width: 22, height: 22, borderRadius: 4, background: c.color, color: '#1a1e17', fontSize: 11, fontWeight: 800, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>{c.name}</span>
                        <span style={{ fontSize: 11, fontWeight: 600, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{ids.length} masks</span>
                        <span style={{ marginLeft: 'auto', fontSize: 10, fontWeight: 600, color: clsInfo ? MC.text : MC.textMuted }}>
                          {clsInfo ? <><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 4, background: clsInfo.color, marginRight: 5 }} />{clsInfo.name}</> : cls === 'mixed' ? 'Mixed labels' : 'Unlabelled'}
                        </span>
                      </span>
                      <span style={{ display: 'flex', gap: 3 }}>
                        {ids.slice(0, 4).map((id) => (
                          // eslint-disable-next-line @next/next/no-img-element
                          thumbs[id] ? <img key={id} src={thumbs[id]} alt="" width={34} height={34} style={{ borderRadius: 3, display: 'block' }} /> : <span key={id} style={{ width: 34, height: 34, borderRadius: 3, background: MC.border }} />
                        ))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
            <p style={note}>Select one or more groups to filter by them. Groups can reflect sharpness as well as appearance, so check the thumbnails.</p>
          </>
        )}
      </Section>

      {ready && (
        <Section label="Look-alikes of my references">
          {!similar.active ? (
            <Button
              disabled={references.length === 0}
              onClick={() => void st().findSimilar(references.map((r) => r.maskId))}
              title={references.length === 0 ? 'Pick a reference object in the Propose stage first' : undefined}
            >
              Find masks like my {references.length || ''} reference{references.length === 1 ? '' : 's'}
            </Button>
          ) : similar.busy ? (
            <p style={{ ...note, display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={11} className="animate-spin" color={MC.accent} /> Comparing…</p>
          ) : (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <span style={note}>Masks at least this similar are selected.</span>
                <button type="button" onClick={() => st().clearSimilar()} aria-label="Remove the look-alike filter" style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: MC.textMuted, padding: 0 }}><X size={13} /></button>
              </div>
              <input
                type="range" min={0.5} max={0.99} step={0.01} value={similar.threshold}
                aria-label="Similarity threshold, looser to stricter"
                onChange={(e) => st().setSimilarThreshold(Number(e.target.value))}
                style={{ width: '100%', accentColor: MC.accent }}
              />
              <div style={{ display: 'flex', justifyContent: 'space-between', ...note }}><span>Looser</span><span>Stricter · {similar.threshold.toFixed(2)}</span></div>
            </>
          )}
        </Section>
      )}

      <ExistingCheck />

      <SelectionTray mode="group" labelClass={null} />
    </div>
  );
}
