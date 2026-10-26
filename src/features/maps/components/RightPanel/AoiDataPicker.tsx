'use client';

import { useCallback, useId, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, Plus, Search } from 'lucide-react';
import type { Dataset } from '@/types/api';
import type { MapAoiAnnotationSetRef } from '@/lib/api/maps';
import { MC } from '../../mapColors';
import { KindIcon } from './AoiDataList';
import { popoverStyle, useDismiss } from './PanelControls';
import { SortSelect } from '../SortSelect';
import { Pager, usePaged } from '../Pager';
import { ago, sortItems, type SortKey } from '../../utils/sortData';

const clamp = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

function Option({
  kind, name, detail, selected, onClick,
}: { kind: 'raster' | 'vector'; name: string; detail?: string; selected: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onClick}
      title={name}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '6px 8px', borderRadius: 5,
        border: 'none', background: selected ? MC.accentDim : 'transparent', cursor: 'pointer', color: MC.text,
      }}
    >
      <span style={{ width: 14, height: 14, borderRadius: 3, flexShrink: 0, border: `1.5px solid ${selected ? MC.accent : MC.borderLight}`, background: selected ? MC.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {selected && <Check size={9} color="#fff" strokeWidth={3} />}
      </span>
      <KindIcon kind={kind} />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12, fontWeight: 600, ...clamp }}>{name}</span>
      {detail && <span style={{ fontSize: 10, color: MC.textMuted, flexShrink: 0, maxWidth: 90, ...clamp }}>{detail}</span>}
    </button>
  );
}

/**
 * One searchable multi-select for everything that overlaps the AOI: rasters and vector annotation
 * sets. The lists only load once it is opened. Picked items become cards in the panel.
 */
export function AoiDataPicker({
  rasters, vectors, selectedRasterIds, pickedVectorIds, loading, onOpen, onToggleRaster, onToggleVector,
}: {
  rasters: Dataset[];
  vectors: MapAoiAnnotationSetRef[];
  selectedRasterIds: string[];
  pickedVectorIds: string[];
  loading: boolean;
  onOpen: () => void;
  onToggleRaster: (d: Dataset) => void;
  onToggleVector: (s: MapAoiAnnotationSetRef) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('modified');
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  const listId = useId();
  const needle = q.trim().toLowerCase();
  const r = useMemo(() => sortItems(rasters, sort).filter((d) => !needle || d.name.toLowerCase().includes(needle)), [rasters, needle, sort]);
  const v = useMemo(() => sortItems(vectors as unknown as { name: string; created_at?: string; updated_at?: string }[], sort).filter((s) => !needle || s.name.toLowerCase().includes(needle)) as unknown as MapAoiAnnotationSetRef[], [vectors, needle, sort]);
  const total = rasters.length + vectors.length;
  type Row = { kind: 'raster'; d: Dataset } | { kind: 'vector'; s: MapAoiAnnotationSetRef };
  const rows = useMemo<Row[]>(() => [...r.map((d) => ({ kind: 'raster' as const, d })), ...v.map((s) => ({ kind: 'vector' as const, s }))], [r, v]);
  const paged = usePaged(rows, 20, `${needle}|${sort}`);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => { if (!open) onOpen(); setOpen((o) => !o); }}
        style={{
          display: 'flex', alignItems: 'center', gap: 7, width: '100%', height: 30, padding: '0 10px', borderRadius: 5,
          border: `1px solid ${open ? MC.accent : MC.inputBorder}`, background: MC.inputBg, color: MC.text, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        }}
      >
        <Plus size={12} color={MC.accent} />
        <span style={{ flex: 1, textAlign: 'left' }}>Add data to this AOI…</span>
        <ChevronDown size={12} color={MC.textMuted} />
      </button>
      {open && (
        <div style={{ ...popoverStyle, top: 34, left: 0, right: 0, padding: 6 }}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 6 }}>
          <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px', height: 28, borderRadius: 5, border: `1px solid ${MC.inputBorder}`, background: MC.inputBg }}>
            <Search size={12} color={MC.textMuted} />
            <input
              autoFocus
              aria-label="Search data"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search by name"
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: MC.text, fontSize: 12 }}
            />
          </div>
          <SortSelect value={sort} onChange={setSort} />
          </div>
          <div id={listId} role="listbox" aria-multiselectable aria-label="Data that overlaps this AOI" style={{ maxHeight: 280, overflowY: 'auto' }}>
            {loading ? (
              <p style={{ fontSize: 11, color: MC.textMuted, padding: '10px 8px', margin: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
                <Loader2 size={11} className="animate-spin" /> Finding what overlaps this AOI…
              </p>
            ) : total === 0 ? (
              <p style={{ fontSize: 11, color: MC.textMuted, padding: '10px 8px', margin: 0, fontStyle: 'italic' }}>No ready datasets or annotation sets overlap this AOI.</p>
            ) : r.length + v.length === 0 ? (
              <p style={{ fontSize: 11, color: MC.textMuted, padding: '10px 8px', margin: 0, fontStyle: 'italic' }}>Nothing matches “{q}”.</p>
            ) : (
              <>
                {paged.pageItems.map((row, i) => {
                  const prev = paged.pageItems[i - 1];
                  const head = !prev || prev.kind !== row.kind
                    ? <Group label={row.kind === 'raster' ? `Rasters (${r.length})` : `Annotation sets (${v.length})`} />
                    : null;
                  return row.kind === 'raster' ? (
                    <div key={row.d.id}>{head}<Option kind="raster" name={row.d.name} detail={ago(sort === 'created' ? row.d.created_at : row.d.updated_at)} selected={selectedRasterIds.includes(row.d.id)} onClick={() => onToggleRaster(row.d)} /></div>
                  ) : (
                    <div key={row.s.id}>{head}<Option kind="vector" name={row.s.name} detail={ago((sort === 'created' ? row.s.created_at : row.s.updated_at) as string | undefined)} selected={pickedVectorIds.includes(row.s.id)} onClick={() => onToggleVector(row.s)} /></div>
                  );
                })}
              </>
            )}
          </div>
          <Pager page={paged.page} pages={paged.pages} total={paged.total} pageSize={paged.pageSize} onPage={paged.setPage} />
        </div>
      )}
    </div>
  );
}

function Group({ label }: { label: string }) {
  return <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', color: MC.textMuted, padding: '6px 8px 2px' }}>{label}</div>;
}
