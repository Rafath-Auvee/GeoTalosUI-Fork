'use client';

import { useMemo, useState } from 'react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, SlidersHorizontal, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import type { AnnotationReviewStatus, AnnotationSet } from '@/types/api';
import { annotationSetsApi } from '@/lib/api/annotation-sets';
import { annotationSchemasApi } from '@/lib/api/annotation-schemas';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { MC } from '../mapColors';
import { KindIcon, PurgeDialog, RowMenu, useCanDelete } from './RightPanel/AoiDataList';
import { PanelSelect } from './RightPanel/PanelControls';
import { SortSelect } from './SortSelect';
import { Pager, usePaged } from './Pager';
import { ago, fullDate, sortItems, type SortKey } from '../utils/sortData';

type Review = 'all' | AnnotationReviewStatus;
const REVIEWS: { id: Review; label: string }[] = [
  { id: 'all', label: 'All' }, { id: 'verified', label: 'Verified' }, { id: 'corrected', label: 'Corrected' }, { id: 'raw', label: 'Raw' },
];
const clamp = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

type Bbox = [number, number, number, number];
const intersects = (a: Bbox, b: Bbox) => a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];

function Chip({ on, children, onClick }: { on: boolean; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      onClick={onClick}
      style={{
        height: 24, padding: '0 9px', borderRadius: 12, fontSize: 11, fontWeight: 600, cursor: 'pointer',
        border: `1px solid ${on ? MC.accent : MC.border}`, background: on ? MC.accentDim : 'transparent', color: on ? MC.text : MC.textSecondary,
      }}
    >
      {children}
    </button>
  );
}

function ReviewPill({ status }: { status: string | undefined }) {
  if (!status) return null;
  const color = status === 'verified' ? MC.success : status === 'corrected' ? MC.accent : MC.textMuted;
  return (
    <span style={{ fontSize: 10, fontWeight: 600, color, border: `1px solid ${color}`, borderRadius: 8, padding: '0 6px', height: 15, display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
      {status}
    </span>
  );
}

/**
 * Library → Annotations. Find a set by name, schema, class, review status, source or the AOI it
 * overlaps; add several to the map at once; delete one or many (permanent, two-step confirm).
 * The class filter matches the classes of a set's schema (not which classes the set really uses).
 */
export function LibraryAnnotationSets({
  onAdd, isOnMap,
}: { onAdd: (s: AnnotationSet) => void | Promise<void>; isOnMap: (setId: string) => boolean }) {
  const queryClient = useQueryClient();
  const canDelete = useCanDelete();
  const layers = useMapLayersStore((s) => s.layers);
  const removeAnnotationSetLayer = useMapLayersStore((s) => s.removeAnnotationSetLayer);

  const [query, setQuery] = useState('');
  const [review, setReview] = useState<Review>('all');
  const [schemaId, setSchemaId] = useState('');
  const [className, setClassName] = useState('');
  const [source, setSource] = useState('');
  const [aoiId, setAoiId] = useState('');
  const [onMapOnly, setOnMapOnly] = useState(false);
  const [sort, setSort] = useState<SortKey>('modified');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [confirm, setConfirm] = useState<AnnotationSet[] | null>(null);
  const [busy, setBusy] = useState(false);

  const setsQ = useQuery({ queryKey: ['annotation-sets', 'org', 'library', 'all'], queryFn: () => annotationSetsApi.listAllByOrg(), staleTime: 30_000 });
  const all = useMemo(() => setsQ.data ?? [], [setsQ.data]);

  const schemas = useMemo(() => {
    const m = new Map<string, string>();
    for (const s of all) if (s.schema_id) m.set(s.schema_id, s.schema_name ?? 'Unnamed schema');
    return [...m.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [all]);
  const sources = useMemo(() => [...new Set(all.map((s) => s.source_type).filter(Boolean))] as string[], [all]);
  const aois = useMemo(
    () => Object.values(layers).filter((l) => l.type === 'aoi' && l.aoiBbox).map((l) => ({ id: l.id, name: l.name, bbox: l.aoiBbox as Bbox })),
    [layers],
  );

  // Classes only load once the filter panel is opened, one call per schema in use.
  const classQs = useQueries({
    queries: schemas.map(([id]) => ({
      queryKey: ['interactive-schema-classes', id], queryFn: () => annotationSchemasApi.getClasses(id), enabled: open, staleTime: 60_000,
    })),
  });
  const classesBySchema = useMemo(() => {
    const m = new Map<string, Set<string>>();
    schemas.forEach(([id], i) => m.set(id, new Set((classQs[i]?.data?.items ?? []).map((c) => c.name))));
    return m;
  }, [schemas, classQs]);
  const classNames = useMemo(() => {
    const pool = schemaId ? [classesBySchema.get(schemaId)] : [...classesBySchema.values()];
    return [...new Set(pool.flatMap((s) => [...(s ?? [])]))].sort((a, b) => a.localeCompare(b));
  }, [classesBySchema, schemaId]);

  const aoi = aois.find((a) => a.id === aoiId);
  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sortItems(all, sort).filter((s) => {
      if (q && !s.name.toLowerCase().includes(q)) return false;
      if (review !== 'all' && (s.review_status ?? 'raw') !== review) return false;
      if (schemaId && s.schema_id !== schemaId) return false;
      if (className && !(s.schema_id && classesBySchema.get(s.schema_id)?.has(className))) return false;
      if (source && s.source_type !== source) return false;
      if (aoi && !(s.extent_4326 && intersects(s.extent_4326, aoi.bbox))) return false;
      if (onMapOnly && !isOnMap(s.id)) return false;
      return true;
    });
  }, [all, sort, query, review, schemaId, className, source, aoi, onMapOnly, classesBySchema, isOnMap]);

  const paged = usePaged(items, 25, `${query}|${review}|${schemaId}|${className}|${source}|${aoiId}|${onMapOnly}|${sort}`);
  const active = [review !== 'all', !!schemaId, !!className, !!source, !!aoiId, onMapOnly].filter(Boolean).length;
  const clear = () => { setReview('all'); setSchemaId(''); setClassName(''); setSource(''); setAoiId(''); setOnMapOnly(false); };
  const visibleIds = items.map((s) => s.id);
  const chosen = items.filter((s) => selected.has(s.id));
  const allChosen = items.length > 0 && chosen.length === items.length;
  const toggle = (id: string) => setSelected((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const toggleAll = () => setSelected(allChosen ? new Set() : new Set(visibleIds));

  const doDelete = async () => {
    if (!confirm) return;
    setBusy(true);
    try {
      const ids = confirm.map((s) => s.id);
      const res = ids.length === 1 ? (await annotationSetsApi.purge(ids[0]), { deleted: 1 }) : await annotationSetsApi.bulkPurge(ids);
      ids.forEach((id) => removeAnnotationSetLayer(id));
      setSelected((p) => { const n = new Set(p); ids.forEach((id) => n.delete(id)); return n; });
      void queryClient.invalidateQueries({ queryKey: ['annotation-sets'] });
      void queryClient.invalidateQueries({ queryKey: ['maps'] });
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes('annotation-set') });
      toast.success(`Deleted ${res.deleted} annotation set${res.deleted === 1 ? '' : 's'}`);
    } catch {
      toast.error('Could not delete. Nothing was changed; try again.');
    } finally {
      setBusy(false);
    }
  };

  const addSelected = async () => {
    for (const s of chosen) if (!isOnMap(s.id)) await onAdd(s);
  };
  const totalAnnotations = (confirm ?? []).reduce((n, s) => n + (s.annotation_count ?? 0), 0);

  return (
    <>
      <div style={{ padding: '10px 12px 8px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', gap: 6 }}>
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 6, background: MC.inputBg, borderRadius: 6, padding: '6px 10px', border: `1px solid ${MC.inputBorder}` }}>
            <Search size={12} style={{ color: MC.textMuted, flexShrink: 0 }} />
            <input
              type="text" placeholder="Search annotation sets…" aria-label="Search annotation sets" value={query} onChange={(e) => setQuery(e.target.value)}
              style={{ flex: 1, minWidth: 0, background: 'transparent', border: 'none', outline: 'none', color: MC.text, fontSize: 13 }}
            />
          </div>
          <button
            type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
            style={{ display: 'flex', alignItems: 'center', gap: 5, height: 32, padding: '0 10px', borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: `1px solid ${active ? MC.accent : MC.inputBorder}`, background: active ? MC.accentDim : MC.inputBg, color: MC.text }}
          >
            <SlidersHorizontal size={12} /> Filters{active ? ` · ${active}` : ''}
          </button>
        </div>

        {open && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div role="group" aria-label="Review status" style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
              {REVIEWS.map((r) => <Chip key={r.id} on={review === r.id} onClick={() => setReview(r.id)}>{r.label}</Chip>)}
              <Chip on={onMapOnly} onClick={() => setOnMapOnly((v) => !v)}>On map</Chip>
            </div>
            <PanelSelect aria-label="Schema" value={schemaId} onChange={(e) => { setSchemaId(e.target.value); setClassName(''); }}>
              <option value="">Any schema</option>
              {schemas.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </PanelSelect>
            <PanelSelect aria-label="Class in schema" value={className} onChange={(e) => setClassName(e.target.value)}>
              <option value="">{classQs.some((q) => q.isLoading) ? 'Loading classes…' : 'Any class'}</option>
              {classNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </PanelSelect>
            <PanelSelect aria-label="Overlapping AOI" value={aoiId} onChange={(e) => setAoiId(e.target.value)}>
              <option value="">{aois.length ? 'Anywhere' : 'No AOIs on this map'}</option>
              {aois.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
            </PanelSelect>
            {sources.length > 1 && (
              <PanelSelect aria-label="Source" value={source} onChange={(e) => setSource(e.target.value)}>
                <option value="">Any source</option>
                {sources.map((s) => <option key={s} value={s}>{s}</option>)}
              </PanelSelect>
            )}
            {className && <p style={{ fontSize: 10, color: MC.textMuted, margin: 0 }}>Matches sets whose schema has this class, not necessarily sets that use it.</p>}
            {active > 0 && <button type="button" onClick={clear} style={{ alignSelf: 'flex-start', background: 'transparent', border: 'none', padding: 0, fontSize: 11, fontWeight: 600, color: MC.accent, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 }}>Clear filters</button>}
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minHeight: 26 }}>
          <input type="checkbox" aria-label="Select all matching sets, across pages" checked={allChosen} disabled={items.length === 0} onChange={toggleAll} style={{ accentColor: MC.accent }} />
          <span style={{ flex: 1, fontSize: 11, color: MC.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
            {chosen.length > 0 ? `${chosen.length} selected` : `${items.length} of ${all.length} sets`}
          </span>
          {chosen.length === 0 && <SortSelect value={sort} onChange={setSort} height={24} />}
          {chosen.length > 0 && (
            <>
              <button type="button" onClick={() => void addSelected()} style={{ height: 24, padding: '0 9px', borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: 'pointer', border: `1px solid ${MC.accent}`, background: MC.accentDim, color: MC.accent }}>
                Add to map
              </button>
              <button
                type="button" disabled={!canDelete} title={canDelete ? undefined : 'Admins only'} onClick={() => setConfirm(chosen)}
                style={{ height: 24, padding: '0 9px', borderRadius: 5, fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4, cursor: canDelete ? 'pointer' : 'not-allowed', border: '1px solid #b42318', background: 'transparent', color: '#b42318', opacity: canDelete ? 1 : 0.5 }}
              >
                <Trash2 size={11} /> Delete
              </button>
              <button type="button" aria-label="Clear selection" onClick={() => setSelected(new Set())} style={{ width: 22, height: 22, border: 'none', background: 'transparent', color: MC.textMuted, cursor: 'pointer' }}><X size={12} /></button>
            </>
          )}
        </div>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {setsQ.isLoading ? (
          <div style={{ padding: 24, textAlign: 'center', fontSize: 12, color: MC.textMuted }}>Loading…</div>
        ) : items.length === 0 ? (
          <div style={{ padding: '32px 20px', fontSize: 13, color: MC.textMuted, textAlign: 'center', fontStyle: 'italic' }}>
            {all.length === 0 ? 'No annotation sets yet.' : 'No sets match these filters.'}
          </div>
        ) : (
          paged.pageItems.map((s) => {
            const onMap = isOnMap(s.id);
            const on = selected.has(s.id);
            return (
              <div key={s.id} style={{ padding: '9px 10px 9px 12px', borderBottom: `1px solid ${MC.border}`, display: 'flex', gap: 9, alignItems: 'flex-start', background: on ? MC.accentDim : 'transparent' }}>
                <input type="checkbox" aria-label={`Select ${s.name}`} checked={on} onChange={() => toggle(s.id)} style={{ accentColor: MC.accent, marginTop: 3 }} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                    <KindIcon kind="vector" />
                    <span title={s.name} style={{ fontSize: 13, fontWeight: 600, color: MC.text, ...clamp }}>{s.name}</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: MC.textMuted, minWidth: 0 }}>
                    <ReviewPill status={s.review_status} />
                    <span style={clamp}>
                      {s.schema_name ?? 'no schema'}
                      {typeof s.annotation_count === 'number' && ` · ${s.annotation_count.toLocaleString()} annotation${s.annotation_count === 1 ? '' : 's'}`}
                    </span>
                    <span title={`Modified ${fullDate(s.updated_at)}\nCreated ${fullDate(s.created_at)}`} style={{ flexShrink: 0, marginLeft: 'auto', whiteSpace: 'nowrap' }}>{ago(sort === 'created' ? s.created_at : s.updated_at)}</span>
                  </div>
                </div>
                <button
                  onClick={() => !onMap && void onAdd(s)} disabled={onMap}
                  style={{ flexShrink: 0, height: 26, padding: '0 10px', borderRadius: 5, border: `1px solid ${onMap ? MC.borderLight : MC.accent}`, background: onMap ? 'transparent' : MC.accentDim, color: onMap ? MC.textMuted : MC.accent, cursor: onMap ? 'default' : 'pointer', fontSize: 11, fontWeight: 700, whiteSpace: 'nowrap' }}
                >
                  {onMap ? 'On map' : 'Add'}
                </button>
                <RowMenu name={s.name} canDelete={canDelete} onDelete={() => setConfirm([s])} />
              </div>
            );
          })
        )}
      </div>
      <Pager page={paged.page} pages={paged.pages} total={paged.total} pageSize={paged.pageSize} onPage={paged.setPage} />

      <PurgeDialog
        open={!!confirm}
        onClose={() => setConfirm(null)}
        busy={busy}
        title={confirm && confirm.length > 1 ? `Delete ${confirm.length} annotation sets permanently?` : `Delete “${confirm?.[0]?.name ?? ''}” permanently?`}
        consequences={`This removes ${confirm && confirm.length > 1 ? `these ${confirm.length} sets` : 'this set'}${totalAnnotations ? ` and their ${totalAnnotations.toLocaleString()} annotations` : ' and all their annotations'}, and unmounts ${confirm && confirm.length > 1 ? 'them' : 'it'} from every map and project.`}
        onConfirm={doDelete}
      />
    </>
  );
}
