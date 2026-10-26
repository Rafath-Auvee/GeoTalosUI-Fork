'use client';

import { useCallback, useState } from 'react';
import { useAuth } from '@clerk/nextjs';
import { Check, Image as ImageIcon, MoreHorizontal, Pentagon, Trash2 } from 'lucide-react';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { annotationSchemasApi } from '@/lib/api/annotation-schemas';
import { annotationSetsApi } from '@/lib/api/annotation-sets';
import { datasetsApi } from '@/lib/api/datasets';
import type { AnnotationSet } from '@/types/api';
import { selectAoiPicks, useAoiVectorPicks } from '../../aoiVectorPicks';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { buildClassStyles } from '../../utils/annotationStyles';
import { MC } from '../../mapColors';
import { MenuItem, popoverStyle, useDismiss } from './PanelControls';

const TAG_MAX = 3;

/** Raster or vector marker; the shape differs as well as the colour. */
export function KindIcon({ kind }: { kind: 'raster' | 'vector' }) {
  const Icon = kind === 'raster' ? ImageIcon : Pentagon;
  return (
    <span
      title={kind === 'raster' ? 'Raster dataset' : 'Vector annotation set'}
      aria-label={kind === 'raster' ? 'Raster dataset' : 'Vector annotation set'}
      style={{ display: 'inline-flex', flexShrink: 0, color: kind === 'raster' ? MC.textMuted : MC.accent }}
    >
      <Icon size={12} />
    </span>
  );
}

/** Delete needs an org admin, which is also what the server enforces. */
export function useCanDelete(): boolean {
  const { has } = useAuth();
  return !!has?.({ role: 'org:admin' });
}

/** The "…" menu on a row. Only Delete for now. */
export function RowMenu({ name, canDelete, onDelete }: { name: string; canDelete: boolean; onDelete: () => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss(open, close);
  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <button
        type="button"
        aria-label={`More actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5, border: 'none', background: open ? MC.accentDim : 'transparent', color: MC.textSecondary, cursor: 'pointer' }}
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <div role="menu" style={{ ...popoverStyle, top: 26, right: 0, minWidth: 200 }}>
          <MenuItem
            icon={<Trash2 size={14} />}
            label="Delete permanently…"
            danger
            disabled={!canDelete}
            hint={canDelete ? undefined : 'Admins only'}
            onClick={() => { close(); onDelete(); }}
          />
        </div>
      )}
    </div>
  );
}

/** Two-step confirmation: first what will go, then a last "this cannot be undone". */
export function PurgeDialog({
  open, onClose, title, consequences, busy, onConfirm,
}: { open: boolean; onClose: () => void; title: string; consequences: string; busy: boolean; onConfirm: () => Promise<void> }) {
  const [step, setStep] = useState<1 | 2>(1);
  const reset = () => { setStep(1); onClose(); };
  return (
    <AlertDialog open={open} onOpenChange={(o) => { if (!o && !busy) reset(); }}>
      <AlertDialogContent
        style={{ background: MC.panelBg, color: MC.text, border: `1px solid ${MC.border}`, boxShadow: '0 16px 48px rgba(0,0,0,0.35)', maxWidth: 420, width: 'calc(100vw - 32px)', zIndex: 10000 }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle style={{ color: step === 2 ? '#b42318' : MC.text, fontSize: 15, fontWeight: 700 }}>{step === 1 ? title : 'Last check: this cannot be undone'}</AlertDialogTitle>
          <AlertDialogDescription style={{ color: MC.textSecondary, fontSize: 13, lineHeight: 1.5 }}>
            {step === 1 ? consequences : 'It will be removed for everyone in the organization, and the data cannot be recovered. Delete it forever?'}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter style={{ background: MC.inputBg, borderTop: `1px solid ${MC.border}` }}>
          {step === 2 && (
            <button type="button" disabled={busy} onClick={() => setStep(1)} className="inline-flex h-9 items-center rounded-md border px-4 text-sm" style={{ borderColor: MC.border, color: MC.text, background: 'transparent' }}>
              Go back
            </button>
          )}
          {step === 1 && <AlertDialogCancel disabled={busy} style={{ borderColor: MC.border, color: MC.text, background: 'transparent' }}>Cancel</AlertDialogCancel>}
          <button
            type="button"
            disabled={busy}
            autoFocus={step === 2}
            onClick={() => (step === 1 ? setStep(2) : void onConfirm().then(reset))}
            className="inline-flex h-9 items-center rounded-md px-4 text-sm font-semibold text-white disabled:opacity-60"
            style={{ background: '#b42318' }}
          >
            {step === 1 ? 'Continue' : busy ? 'Deleting…' : 'Delete forever'}
          </button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/** Schema name and class tags for an annotation set (colours come from the schema's classes). */
function SchemaTags({ schemaId }: { schemaId: string | null | undefined }) {
  const { data: schemas } = useQuery({ queryKey: ['interactive-schemas'], queryFn: () => annotationSchemasApi.list(100, 0), enabled: !!schemaId, staleTime: 60_000 });
  const { data: classes } = useQuery({ queryKey: ['interactive-schema-classes', schemaId], queryFn: () => annotationSchemasApi.getClasses(schemaId as string), enabled: !!schemaId, staleTime: 60_000 });
  if (!schemaId) return <span style={{ fontSize: 10, color: MC.textMuted }}>No schema</span>;
  const schema = schemas?.items.find((s) => s.id === schemaId);
  const items = classes?.items ?? [];
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4, marginTop: 3 }}>
      {schema && <span style={{ fontSize: 10, fontWeight: 600, color: MC.textSecondary }}>{schema.name}</span>}
      {items.slice(0, TAG_MAX).map((c) => (
        <span key={c.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, color: MC.text, padding: '0 6px', height: 16, borderRadius: 8, border: `1px solid ${MC.border}`, background: MC.inputBg }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: 4, background: c.style?.definition?.fillColor ?? MC.accent }} />
          {c.name}
        </span>
      ))}
      {items.length > TAG_MAX && <span style={{ fontSize: 10, color: MC.textMuted }}>+{items.length - TAG_MAX}</span>}
    </div>
  );
}

/** Delete a raster dataset for good; used by the raster rows of the AOI panel. */
export function usePurgeDataset(onGone: (datasetId: string) => void) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<{ id: string; name: string; items: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await datasetsApi.purge(target.id);
      onGone(target.id);
      void queryClient.invalidateQueries({ queryKey: ['maps'] });
      void queryClient.invalidateQueries({ queryKey: ['datasets'] });
      toast.success(`Deleted ${target.name}`);
    } catch {
      toast.error(`Could not delete ${target.name}. Nothing else was changed; try again.`);
    } finally {
      setBusy(false);
    }
  };
  const dialog = (
    <PurgeDialog
      open={!!target}
      onClose={() => setTarget(null)}
      busy={busy}
      title={`Delete “${target?.name ?? ''}” permanently?`}
      consequences={`This removes the raster, its ${target?.items ? `${target.items} file${target.items === 1 ? '' : 's'}` : 'files'} in storage and its catalogue entries. Annotation sets made on it are kept, but lose their link to it.`}
      onConfirm={confirm}
    />
  );
  return { request: setTarget, dialog };
}

/** Put an annotation set on the map and pick it for this AOI, or take it off again. */
export function useVectorPick(aoiLayerId: string) {
  const addAnnotationSetLayer = useMapLayersStore((s) => s.addAnnotationSetLayer);
  const removeAnnotationSetLayer = useMapLayersStore((s) => s.removeAnnotationSetLayer);
  const add = useAoiVectorPicks((s) => s.add);
  const remove = useAoiVectorPicks((s) => s.remove);
  const picked = useAoiVectorPicks(selectAoiPicks(aoiLayerId));
  const toggle = useCallback(
    async (s: { id: string; name: string; schema_id?: string | null }) => {
      if (picked.includes(s.id)) { remove(aoiLayerId, s.id); removeAnnotationSetLayer(s.id); return; }
      let classes;
      if (s.schema_id) {
        try { classes = (await annotationSchemasApi.getClasses(s.schema_id)).items; } catch { /* default colours */ }
      }
      addAnnotationSetLayer({ setId: s.id, name: s.name, classStyles: buildClassStyles(classes) });
      add(aoiLayerId, s.id);
    },
    [aoiLayerId, picked, add, remove, addAnnotationSetLayer, removeAnnotationSetLayer],
  );
  return { picked, toggle };
}

const clamp = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' } as const;

/** Cards for the annotation sets picked on this AOI: same look as the raster cards. */
export function VectorSetCards({ aoiLayerId, onMapIds = [] }: { aoiLayerId: string; onMapIds?: string[] }) {
  const { picked, toggle } = useVectorPick(aoiLayerId);
  const shown = [...new Set([...picked, ...onMapIds])];
  const removeAnnotationSetLayer = useMapLayersStore((s) => s.removeAnnotationSetLayer);
  const removePick = useAoiVectorPicks((s) => s.remove);
  const queryClient = useQueryClient();
  const canDelete = useCanDelete();
  const results = useQueries({
    queries: shown.map((id) => ({ queryKey: ['annotation-set', 'detail', id], queryFn: () => annotationSetsApi.get(id), staleTime: 60_000 })),
  });
  const sets = results.map((r) => r.data).filter((d): d is AnnotationSet => !!d);
  const [target, setTarget] = useState<AnnotationSet | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!target) return;
    setBusy(true);
    try {
      await annotationSetsApi.purge(target.id);
      removeAnnotationSetLayer(target.id);
      removePick(aoiLayerId, target.id);
      void queryClient.invalidateQueries({ queryKey: ['maps'] });
      void queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).includes('annotation-set') });
      toast.success(`Deleted ${target.name}`);
    } catch {
      toast.error(`Could not delete ${target.name}. Nothing else was changed; try again.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {sets.map((s) => (
        <div key={s.id} style={{ display: 'flex', alignItems: 'flex-start', borderRadius: 5, background: picked.includes(s.id) ? MC.accentDim : 'transparent', border: `1px solid ${picked.includes(s.id) ? MC.accent : MC.border}` }}>
          <button
            type="button"
            role="checkbox"
            aria-checked={picked.includes(s.id)}
            aria-label={picked.includes(s.id) ? `${s.name}, picked for this AOI. Click to remove from the map` : `${s.name}, on the map. Click to pick for this AOI`}
            onClick={() => void toggle(s)}
            style={{ display: 'flex', alignItems: 'flex-start', gap: 8, flex: 1, minWidth: 0, padding: '6px 4px 6px 8px', background: 'transparent', border: 'none', cursor: 'pointer', textAlign: 'left' }}
          >
            <div style={{ width: 16, height: 16, borderRadius: 3, marginTop: 1, border: `1.5px solid ${picked.includes(s.id) ? MC.accent : MC.borderLight}`, background: picked.includes(s.id) ? MC.accent : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              {picked.includes(s.id) && <Check size={10} color="#fff" strokeWidth={3} />}
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                <KindIcon kind="vector" />
                <span title={s.name} style={{ fontSize: 11, fontWeight: 600, color: MC.text, ...clamp }}>{s.name}</span>
                {typeof s.annotation_count === 'number' && <span style={{ fontSize: 10, color: MC.textMuted, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>{s.annotation_count}</span>}
              </div>
              <SchemaTags schemaId={s.schema_id} />
            </div>
          </button>
          <div style={{ padding: '4px 4px 0 0' }}>
            <RowMenu name={s.name} canDelete={canDelete} onDelete={() => setTarget(s)} />
          </div>
        </div>
      ))}
      <PurgeDialog
        open={!!target}
        onClose={() => setTarget(null)}
        busy={busy}
        title={`Delete “${target?.name ?? ''}” permanently?`}
        consequences={`This removes the annotation set${typeof target?.annotation_count === 'number' ? ` and its ${target.annotation_count} annotation${target.annotation_count === 1 ? '' : 's'}` : ' and all its annotations'}, and unmounts it from every map and project.`}
        onConfirm={confirm}
      />
    </>
  );
}
