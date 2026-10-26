'use client';

import { useMemo, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, Filter, ListChecks, Loader2, ShieldAlert, ShieldCheck, Trash2 } from 'lucide-react';
import type { DinoAoiSet, DinoExportPreviewResponse, DinoTask, SetRole } from '@/lib/api/dino';
import { MC } from '../../mapColors';
import { IconButton, Tip, popoverStyle, useDismiss } from './PanelControls';

export interface TrainAoi { id: string; name: string }

interface Props {
  aois: TrainAoi[];
  aoiIds: string[];
  onAoiIds: (ids: string[]) => void;
  sets: DinoAoiSet[] | undefined;
  loadingSets: boolean;
  setIds: string[];
  onSetIds: (ids: string[]) => void;
  className: string;
  preview: DinoExportPreviewResponse | undefined;
  loadingPreview: boolean;
  /** Permanently delete one annotation set (the caller does the delete). */
  onDeleteSet: (id: string) => Promise<void>;
  /** Where each set is used (train, test or both), and the change handler. */
  roleOf: (id: string) => SetRole;
  onRole: (id: string, role: SetRole) => void;
  /** The head being trained: a segmenter can only learn from masks, so box-only sets are not selectable. */
  task: DinoTask;
  /** YOLO: the classes of the schema, and the chosen ones (several). */
  classes: { id: string; name: string }[];
  classIds: string[];
  onClassIds: (ids: string[]) => void;
}

const muted: React.CSSProperties = { fontSize: 13, color: MC.textMuted, margin: 0, lineHeight: 1.4 };
const smallLabel: React.CSSProperties = { fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: MC.textMuted };

function Box({ on, label }: { on: boolean; label: string }) {
  return (
    <span
      role="checkbox"
      aria-checked={on}
      aria-label={label}
      style={{
        width: 16, height: 16, flexShrink: 0, borderRadius: 4, display: 'flex', alignItems: 'center', justifyContent: 'center',
        border: `1.5px solid ${on ? MC.accent : MC.inputBorder ?? MC.border}`, background: on ? MC.accent : 'transparent', color: '#fff',
      }}
    >
      {on && <Check size={11} strokeWidth={3} />}
    </span>
  );
}

const popover = popoverStyle;

/** A labelled multi-choice dropdown on one line: the chosen items, with the full list in a popover. */
function ChoicePicker({ label, items, ids, onIds, none }: {
  label: string; items: { id: string; name: string }[]; ids: string[]; onIds: (ids: string[]) => void; none: string;
}) {
  const [open, setOpen] = useState(false);
  const ref = useDismiss(open, () => setOpen(false));
  const names = ids.map((id) => items.find((a) => a.id === id)?.name).filter(Boolean) as string[];
  const toggle = (id: string) => {
    if (ids.includes(id)) { if (ids.length > 1) onIds(ids.filter((a) => a !== id)); } // one always stays
    else onIds([...ids, id]);
  };
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        disabled={items.length === 0}
        style={{
          width: '100%', height: 32, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', borderRadius: 6, cursor: 'pointer',
          border: `1px solid ${MC.inputBorder ?? MC.border}`, background: MC.inputBg, color: MC.text, fontSize: 14, fontWeight: 600, textAlign: 'left',
        }}
      >
        <span style={{ ...smallLabel, fontSize: 11 }}>{label}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {items.length === 0 ? none : names.length > 3 ? `${names.length} of ${items.length}` : names.join(', ')}
        </span>
        <ChevronDown size={14} color={MC.textMuted} />
      </button>
      {open && (
        <div role="listbox" aria-multiselectable style={{ ...popover, top: 'calc(100% + 4px)', left: 0, right: 0, maxHeight: 240, overflowY: 'auto' }}>
          {items.map((a) => (
            <button
              key={a.id}
              type="button"
              role="option"
              aria-selected={ids.includes(a.id)}
              onClick={() => toggle(a.id)}
              style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '6px 8px', borderRadius: 5, border: 'none', background: 'transparent', color: MC.text, fontSize: 14, cursor: 'pointer', textAlign: 'left' }}
            >
              <Box on={ids.includes(a.id)} label={a.name} />
              {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="group" aria-label={label} style={{ display: 'flex' }}>
      {options.map(([v, text], i) => (
        <button
          key={v}
          type="button"
          aria-pressed={value === v}
          onClick={() => onChange(v)}
          style={{
            flex: 1, height: 26, fontSize: 13, fontWeight: 600, cursor: 'pointer', color: MC.text, marginLeft: i === 0 ? 0 : -1,
            border: `1px solid ${value === v ? MC.accent : MC.border}`, background: value === v ? MC.accentDim : 'transparent',
            borderRadius: i === 0 ? '6px 0 0 6px' : i === options.length - 1 ? '0 6px 6px 0' : 0,
          }}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

/** Column 1: choose the areas and the annotation sets inside them that the splits are generated from. */
export function TrainHeadDataStep({
  aois, aoiIds, onAoiIds, sets, loadingSets, setIds, onSetIds, className, preview, loadingPreview, onDeleteSet, roleOf, onRole, task, classes, classIds, onClassIds,
}: Props) {
  const usable = (s: DinoAoiSet) => task !== 'segment' || s.mask_annotations > 0;
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [filterOpen, setFilterOpen] = useState(false);
  const [onlyClass, setOnlyClass] = useState(true);
  const [status, setStatus] = useState<'all' | 'verified' | 'unverified'>('all');
  const filterRef = useDismiss(filterOpen, () => setFilterOpen(false));
  const chosen = useMemo(() => new Set(setIds), [setIds]);
  // Filters only change what is listed; they never change what is chosen.
  const shown = useMemo(
    () => (sets ?? []).filter((s) =>
      (!onlyClass || s.class_annotations > 0)
      && (status === 'all' || (status === 'verified') === (s.review_status === 'verified'))),
    [sets, onlyClass, status],
  );
  const hiddenChosen = (sets ?? []).filter((s) => chosen.has(s.id) && !shown.includes(s)).length;
  const pickable = shown.filter(usable);
  const allShownChosen = pickable.length > 0 && pickable.every((s) => chosen.has(s.id));
  const chosenSets = (sets ?? []).filter((s) => chosen.has(s.id));
  const unverified = chosenSets.filter((s) => s.review_status !== 'verified');
  const toggleSet = (id: string) => onSetIds(chosen.has(id) ? setIds.filter((s) => s !== id) : [...setIds, id]);
  const noun = className || 'class';
  const left = preview ? preview.annotations_skipped_no_item + preview.annotations_skipped_inactive_item : 0;

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, minHeight: 0, padding: '10px 14px 0', display: 'flex', flexDirection: 'column', gap: 10 }}>
        {task === 'yolo' && <ChoicePicker label="Classes" items={classes} ids={classIds} onIds={onClassIds} none="No classes" />}
        <ChoicePicker label="Areas" items={aois} ids={aoiIds} onIds={onAoiIds} none="None on this map" />

        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ ...smallLabel, flex: 1 }}>
            Annotation sets <span style={{ fontWeight: 500, textTransform: 'none', letterSpacing: 0 }}>· {chosenSets.length} chosen{hiddenChosen > 0 ? `, ${hiddenChosen} hidden` : ''}</span>
          </span>
          {pickable.length > 0 && (
            <IconButton
              label={allShownChosen ? 'Clear the listed sets' : `Choose all ${pickable.length} listed`}
              active={allShownChosen}
              size={26}
              onClick={() => onSetIds(allShownChosen ? setIds.filter((id) => !pickable.some((s) => s.id === id)) : [...new Set([...setIds, ...pickable.map((s) => s.id)])])}
            >
              <ListChecks size={14} />
            </IconButton>
          )}
          <div ref={filterRef} style={{ position: 'relative' }}>
            <IconButton label="Filter the list" active={filterOpen || status !== 'all' || !onlyClass} size={26} onClick={() => setFilterOpen(!filterOpen)}>
              <Filter size={14} />
            </IconButton>
            {filterOpen && (
              <div role="dialog" aria-label="Filter the list" style={{ ...popover, top: 'calc(100% + 4px)', right: 0, width: 250, padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
                <Seg label="Show" value={status} onChange={setStatus} options={[['all', 'All'], ['verified', 'Verified'], ['unverified', 'Not verified']]} />
                <button
                  type="button"
                  aria-pressed={onlyClass}
                  onClick={() => setOnlyClass(!onlyClass)}
                  style={{ display: 'flex', alignItems: 'center', gap: 8, border: 'none', background: 'transparent', color: MC.text, fontSize: 13, cursor: 'pointer', padding: 0, textAlign: 'left' }}
                >
                  <Box on={onlyClass} label={`Only sets with ${noun}`} /> Only sets with {noun}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* The list scrolls on its own, so the areas and the filters stay in view */}
        <div style={{ flex: 1, minHeight: 80, overflowY: 'auto', paddingBottom: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {loadingSets ? (
            <p style={{ ...muted, display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={14} className="animate-spin" /> Finding annotation sets…</p>
          ) : shown.length === 0 ? (
            <p style={{ ...muted, fontStyle: 'italic', padding: '10px 0' }}>
              {(sets?.length ?? 0) === 0 ? 'No annotation set has annotations inside these areas.' : `No set matches the filter (${sets?.length} in the areas).`}
            </p>
          ) : (
            shown.map((s) => {
              const on = chosen.has(s.id);
              const ok = s.review_status === 'verified';
              const showTrash = hoverId === s.id || confirmId === s.id;
              return (
                <div key={s.id} onMouseEnter={() => setHoverId(s.id)} onMouseLeave={() => setHoverId(null)} onFocus={() => setHoverId(s.id)} onBlur={() => setHoverId(null)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 4px 4px 8px', borderRadius: 6, border: `1px solid ${on ? MC.accent : 'transparent'}`, background: on ? MC.accentDim : 'transparent', opacity: usable(s) ? 1 : 0.55 }}>
                    <button
                      type="button"
                      aria-pressed={on}
                      aria-label={s.name}
                      disabled={!usable(s)}
                      onClick={() => toggleSet(s.id)}
                      style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', border: 'none', background: 'transparent', color: MC.text, textAlign: 'left', cursor: usable(s) ? 'pointer' : 'not-allowed' }}
                    >
                      <Box on={on} label={s.name} />
                      <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span style={{ display: 'flex', alignItems: 'center', gap: 5, minWidth: 0 }}>
                          <Tip text={ok ? 'Verified' : 'Not verified'}>
                            {ok ? <ShieldCheck size={14} color="#16a34a" /> : <ShieldAlert size={14} color="#d97706" />}
                          </Tip>
                          <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={s.name}>{s.name}</span>
                        </span>
                        <span style={{ ...muted, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                          {s.class_annotations} {noun}
                          {task === 'segment' ? (s.mask_annotations > 0 ? ` · ${s.mask_annotations} masks` : ' · boxes only') : ` · ${s.annotations_in_aois} in total`}
                          {aoiIds.length > 1 && ` · ${aoiIds.map((id) => `${aois.find((a) => a.id === id)?.name ?? '?'} ${s.by_aoi[id] ?? 0}`).join(', ')}`}
                        </span>
                      </span>
                    </button>
                    <select
                      aria-label={`Where ${s.name} is used`}
                      title="Use this set for training only, testing only, or both (split by region)"
                      value={roleOf(s.id)}
                      onChange={(e) => onRole(s.id, e.target.value as SetRole)}
                      style={{ height: 26, width: 64, flexShrink: 0, borderRadius: 5, border: `1px solid ${MC.border}`, background: MC.inputBg, color: MC.text, fontSize: 13, fontWeight: 600, padding: '0 2px', cursor: 'pointer' }}
                    >
                      <option value="train">Train</option>
                      <option value="test">Test</option>
                      <option value="both">Both</option>
                    </select>
                    <span style={{ visibility: showTrash ? 'visible' : 'hidden' }}>
                      <IconButton label="Delete this set permanently" danger active={confirmId === s.id} size={26} onClick={() => setConfirmId(confirmId === s.id ? null : s.id)}>
                        <Trash2 size={14} />
                      </IconButton>
                    </span>
                  </div>
                  {confirmId === s.id && (
                    <div role="alertdialog" aria-label={`Delete ${s.name} permanently`} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '4px 0 2px', padding: '6px 8px', borderRadius: 6, border: '1px solid #dc2626', background: 'rgba(220,38,38,0.08)' }}>
                      <span style={{ flex: 1, fontSize: 13, fontWeight: 600, color: MC.text }}>Delete permanently?</span>
                      <button type="button" disabled={deletingId === s.id} onClick={() => setConfirmId(null)} style={{ height: 26, padding: '0 10px', borderRadius: 5, border: `1px solid ${MC.border}`, background: 'transparent', color: MC.text, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Back</button>
                      <button
                        type="button"
                        disabled={deletingId === s.id}
                        onClick={async () => { setDeletingId(s.id); await onDeleteSet(s.id); setDeletingId(null); setConfirmId(null); }}
                        style={{ height: 26, padding: '0 10px', borderRadius: 5, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: deletingId === s.id ? 'not-allowed' : 'pointer', opacity: deletingId === s.id ? 0.6 : 1 }}
                      >
                        {deletingId === s.id ? 'Deleting…' : 'Confirm delete'}
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* What the choice adds up to: one line, with the warnings behind an icon */}
      <div style={{ flexShrink: 0, borderTop: `1px solid ${MC.border}`, padding: '7px 14px', display: 'flex', alignItems: 'center', gap: 8, background: MC.inputBg, minHeight: 34 }}>
        {loadingPreview ? (
          <span style={{ ...muted, display: 'flex', alignItems: 'center', gap: 6 }}><Loader2 size={14} className="animate-spin" /> Counting…</span>
        ) : chosenSets.length === 0 ? (
          <span style={muted}>Choose at least one annotation set.</span>
        ) : (
          <span style={{ flex: 1, fontSize: 13, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>
            {task === 'yolo' && classIds.length > 1 && preview?.by_class
              ? classIds.map((id, i) => <span key={id}>{i > 0 && ' · '}<b>{preview.by_class?.[id] ?? 0}</b> {classes.find((c) => c.id === id)?.name ?? '?'}</span>)
              : <><b>{preview?.total_annotations ?? 0}</b> {noun}</>} on <b>{preview?.dataset_item_count ?? 0}</b> image{preview?.dataset_item_count === 1 ? '' : 's'}
            {preview?.object_size_p10_m != null && preview.object_size_p90_m != null && <span style={{ color: MC.textMuted }}> · {preview.object_size_p10_m}-{preview.object_size_p90_m} m</span>}
          </span>
        )}
        {(unverified.length > 0 || left > 0) && (
          <Tip text={[
            unverified.length > 0 ? `${unverified.length} chosen set${unverified.length === 1 ? ' is' : 's are'} not verified: its annotations are trained on as if correct.` : '',
            left > 0 ? `${left} annotation(s) left out: no active image.` : '',
          ].filter(Boolean).join(' ')}
          >
            <AlertTriangle size={15} color="#d97706" />
          </Tip>
        )}
      </div>
    </div>
  );
}
