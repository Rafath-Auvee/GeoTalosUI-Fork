'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import {
  Wand2, X, Loader2, AlertCircle, AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight,
  Hammer, GraduationCap, Trash2, Download, SlidersHorizontal, MoreHorizontal, Pencil,
} from 'lucide-react';
import {
  dinoApi,
  type DinoDataset, type DinoDatasetItem, type DinoDatasetParams, type DinoExportPreviewResponse,
  type DinoFinetuneJobRead, type DinoTask, type DinoTunedConfig, type SetRole,
} from '@/lib/api/dino';
import { annotationSetsApi } from '@/lib/api/annotation-sets';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { MC } from '../../mapColors';
import { TrainHeadDataStep, type TrainAoi } from './TrainHeadDataStep';
import { IconButton, InfoTip, MenuItem, Tip, popoverStyle, useDismiss } from './PanelControls';
import { TrainHeadModelActions } from './TrainHeadModelExport';
import { LossChart, Stat, fmt } from './TrainHeadCharts';
import { ResultsPane } from './TrainHeadResults';
import { DEFAULT_TUNE, SEARCH_MAX_EPOCHS, RunHyperparameters, RunTuningReport, TuningOptions, tunePayload, type TuneOptions } from './TrainHeadTuning';

const LADDER_M = [10, 20, 40, 80, 160, 320, 640];
const SPLITS = ['train', 'eval', 'test'] as const;

interface TrainHeadAdvancedDialogProps {
  collectionId: string;
  classId: string;
  className: string;
  /** The schema's classes: YOLO trains on several of them at once. */
  classes: { id: string; name: string }[];
  /** The AOI that is open on the map: the dialog starts with it chosen. */
  aoiId: string;
  /** Every AOI on the map — more can be added to the training data. */
  aois: TrainAoi[];
  task: DinoTask;

  datasets: DinoDataset[];
  selectedDatasetId: string;
  onSelectDataset: (id: string) => void;

  lr: number;
  onLrChange: (v: number) => void;
  epochs: number;
  onEpochsChange: (v: number) => void;

  /** Training the selected dataset (state and action live in the panel that owns the job). */
  train: { canTrain: boolean; busy: boolean; stale: boolean; onTrain: (opts: TrainOpts) => void; job: DinoFinetuneJobRead | undefined };

  /** Text for a full-width opening button (the panel's call to action). Without it, a small icon button. */
  label?: string;
  /** Training is running: the button says so. */
  busy?: boolean;
  disabled?: boolean;
}

type Backbone = 'dinov2-vits14' | 'dinov2-vitb14';

const TASK_NAME: Record<DinoTask, string> = { detect: 'Detector', classify: 'Classifier', segment: 'Segmenter', yolo: 'YOLO detector' };

/** What a training run is started with. The DINOv2 heads use the backbone; YOLO uses the starting weights and the two stage lengths. */
export interface TrainOpts {
  backbone?: Backbone; base_weights?: string; stage1_epochs?: number; stage2_epochs?: number; stage1_lr?: number; stage2_lr?: number;
  /** Optuna search, reused once saved for this dataset + model. */
  auto_tune?: boolean; n_trials?: number; force_retune?: boolean;
  /** Repeat over 3 to 5 seeds and report mean ± std. */
  seeds?: number[];
}

interface Draft {
  scales_m: number[];
  crop_px: number;
  eval_split: number;
  test_split: number;
  neg_ratio: number;
  region_tiles: number;
}

const DEFAULT_DRAFT: Draft = {
  scales_m: [], crop_px: 1280, eval_split: 0.15, test_split: 0.15, neg_ratio: 2, region_tiles: 3,
};

/** YOLO sees each tile as exported, so its tiles default to the network's 640 px input. */
function draftFrom(p: DinoDatasetParams | undefined, suggested: number[] | undefined, defaultPx = DEFAULT_DRAFT.crop_px): Draft {
  const own = p?.scales_m?.length ? p.scales_m : p?.tile_scale_m ? [p.tile_scale_m] : null;
  return {
    scales_m: [...(own ?? suggested ?? [])].sort((a, b) => a - b),
    crop_px: p?.crop_px ?? defaultPx,
    eval_split: p?.eval_split ?? DEFAULT_DRAFT.eval_split,
    test_split: p?.test_split ?? DEFAULT_DRAFT.test_split,
    neg_ratio: p?.neg_ratio ?? DEFAULT_DRAFT.neg_ratio,
    region_tiles: p?.region_tiles ?? DEFAULT_DRAFT.region_tiles,
  };
}

/**
 * Train Head's dataset workspace: build a dataset from an AOI, review its
 * tiles and train/eval/test split, change the scale/size and rebuild, and
 * only then train. A dataset is built once and reused by every training
 * run; it is regenerated only when the annotations change or when you
 * rebuild it here. Also holds the training hyperparameters and the report
 * of previous runs (metrics, curves, timings — not the data they used).
 */
export function TrainHeadAdvancedDialog({
  collectionId, classId, className: classNameProp, classes, aoiId, aois, task,
  datasets, selectedDatasetId, onSelectDataset,
  lr, onLrChange, epochs, onEpochsChange,
  train, label, busy, disabled,
}: TrainHeadAdvancedDialogProps) {
  const [open, setOpen] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [aoiIds, setAoiIds] = useState<string[]>([aoiId]);
  const [setIds, setSetIds] = useState<string[]>([]);
  const [touched, setTouched] = useState(false);
  const [classIds, setClassIds] = useState<string[]>([classId]);
  const [base, setBase] = useState('yolo26l.pt');
  const [stage1, setStage1] = useState(40);
  const [stage2, setStage2] = useState(40);
  const [lr1, setLr1] = useState(0.002);
  const [lr2, setLr2] = useState(0.0001);
  const [roles, setRoles] = useState<Record<string, SetRole>>({});
  const [name, setName] = useState('');
  const [draft, setDraft] = useState<Draft>(() => draftFrom(undefined, undefined, task === 'yolo' ? 640 : undefined));
  const [backbone, setBackbone] = useState<Backbone>('dinov2-vits14');
  const [tune, setTune] = useState<TuneOptions>(DEFAULT_TUNE);
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const fit = () => setScale(Math.max(0.78, Math.min(1, window.innerWidth / 1600, window.innerHeight / 920)));
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, []);
  const queryClient = useQueryClient();
  const selected = datasets.find((d) => d.id === selectedDatasetId);

  const openDialog = () => {
    setAoiIds([aoiId]);
    setClassIds([classId]);
    setTouched(false);
    setRunId(null);
    setName('');
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  // Annotation sets of this schema with annotations inside the chosen areas (PostGIS on the server).
  const aoiKey = aoiIds.join(',');
  const wantedClasses = task === 'yolo' ? classIds : [classId];
  const className = task === 'yolo' ? wantedClasses.map((id) => classes.find((c) => c.id === id)?.name ?? '').filter(Boolean).join(' + ') || classNameProp : classNameProp;
  const { data: sets, isLoading: loadingSets } = useQuery({
    queryKey: ['train-head-aoi-sets', collectionId, classId, aoiKey, wantedClasses.join(',')],
    queryFn: () => dinoApi.aoiAnnotationSets({ annotation_set_collection_id: collectionId, class_id: classId, class_ids: task === 'yolo' ? wantedClasses : undefined, aoi_ids: aoiIds }),
    enabled: open && !!collectionId && !!classId && aoiIds.length > 0,
  });
  // Until the user picks by hand, the choice follows the areas: verified sets that have the class.
  useEffect(() => {
    if (!sets) return;
    if (touched) { setSetIds((prev) => prev.filter((id) => sets.some((x) => x.id === id))); return; }
    const withClass = sets.filter((x) => x.class_annotations > 0 && (task !== 'segment' || x.mask_annotations > 0));
    const verified = withClass.filter((x) => x.review_status === 'verified');
    setSetIds((verified.length ? verified : withClass).map((x) => x.id));
  }, [sets, touched, task]);

  const setKey = [...setIds].sort().join(',');
  const { data: preview, isLoading: loadingPreview } = useQuery({
    queryKey: ['train-head-scope-preview', collectionId, classId, aoiKey, setKey, task, wantedClasses.join(',')],
    queryFn: () => dinoApi.exportPreview({
      annotation_set_collection_id: collectionId,
      class_id: wantedClasses[0],
      class_ids: task === 'yolo' ? wantedClasses : undefined,
      aoi_id: aoiIds[0],
      aoi_ids: aoiIds,
      annotation_set_ids: setIds,
      task,
    }),
    enabled: open && !!collectionId && !!classId && setIds.length > 0,
  });

  const { data: bases } = useQuery({ queryKey: ['yolo-bases'], queryFn: () => dinoApi.yoloBases(), enabled: open && task === 'yolo' });

  const { data: runs, isLoading: loadingRuns } = useQuery({
    queryKey: ['train-head-runs', collectionId, classId],
    queryFn: () => dinoApi.listRuns({ annotation_set_collection_id: collectionId, class_id: classId, limit: 50 }),
    enabled: open && !!collectionId && !!classId,
  });

  // The saved Optuna result of the selected dataset, for the model that would be trained.
  const modelKey = task === 'yolo' ? base : backbone;
  const { data: tunedConfigs } = useQuery({
    queryKey: ['train-head-tuned', selected?.id],
    queryFn: () => dinoApi.listTunedConfigs(selected!.id),
    enabled: open && !!selected?.id,
  });
  const savedTuned = tunedConfigs?.find((c) => c.model_key === modelKey);
  const forgetTuned = useMutation({
    mutationFn: () => dinoApi.deleteTunedConfig(selected!.id, modelKey),
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: ['train-head-tuned'] }); toast.success('Saved config removed'); },
    onError: () => toast.error('Could not remove the saved config'),
  });

  // Tell the user when a run they started ends (a toast, wherever they are in the panel).
  const lastSeen = useRef<{ id: string; status: string } | null>(null);
  useEffect(() => {
    const job = train.job;
    if (!job) return;
    const prev = lastSeen.current;
    lastSeen.current = { id: job.id, status: job.status };
    if (!prev || prev.id !== job.id || prev.status === job.status) return;
    if (job.status === 'failed') {
      toast.error(`Training failed${job.logs ? `: ${job.logs.slice(0, 140)}` : ''}`);
    } else if (job.status === 'completed') {
      const mr = job.config?.result?.multirun;
      const lead = mr?.summary?.ap50 ?? mr?.summary?.f1;
      const spread = lead?.mean != null && mr ? ` (mean ${lead.mean.toFixed(3)} ± ${(lead.std ?? 0).toFixed(3)} over ${mr.n_runs} seeds)` : '';
      toast.success(`Training finished${runMetrics(job) ? ` · ${runMetrics(job)}` : ''}${spread}`);
    }
  }, [train.job]);

  // A finished training run shows up in the list and is opened.
  const doneJob = train.job?.status === 'completed' || train.job?.status === 'failed' ? train.job : undefined;
  useEffect(() => {
    if (!doneJob) return;
    void queryClient.invalidateQueries({ queryKey: ['train-head-runs'] });
    void queryClient.invalidateQueries({ queryKey: ['train-head-tuned'] });
    setRunId(doneJob.id);
  }, [doneJob, queryClient]);

  // The split settings start from the selected splits (or the sizes of the chosen objects) and are the user's to change.
  const suggested = preview?.suggested_scales_m;
  const seedKey = selected ? `${selected.id}:${selected.build_no}` : `new:${(suggested ?? []).join(',')}`;
  useEffect(() => {
    setDraft(draftFrom(selected?.params, suggested, task === 'yolo' ? 640 : undefined));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seedKey, task]);
  // Roles follow the selected splits, and are not reset by changing the data choice.
  useEffect(() => {
    setRoles(selected?.params?.set_roles ?? {});
  }, [selected?.id, selected?.build_no, selected?.params?.set_roles]);

  // Where each chosen set is used. Unless you say otherwise, verified sets go in both and unreviewed ones in training only.
  const roleOf = (id: string): SetRole => roles[id] ?? (sets?.find((x) => x.id === id)?.review_status === 'verified' ? 'both' : 'train');

  // Permanently delete one annotation set (admin only). It leaves maps and collections too.
  const deleteSet = async (id: string) => {
    try {
      await annotationSetsApi.purge(id);
    } catch {
      toast.error('Could not delete the annotation set. It needs an admin role.');
      return;
    }
    useMapLayersStore.getState().removeLayer(`annset-${id}`);
    setSetIds((prev) => prev.filter((x) => x !== id));
    for (const key of ['train-head-aoi-sets', 'train-head-scope-preview', 'train-head-datasets', 'annotation-sets', 'annotation-set-features']) {
      void queryClient.invalidateQueries({ queryKey: [key] });
    }
    toast.success('Annotation set deleted');
  };

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['train-head-datasets'] });
  const scopeReady = setIds.length > 0 && aoiIds.length > 0;
  const building = selected?.status === 'building' || selected?.status === 'pending';
  const splitsReady = selected?.status === 'ready';
  const defaultName = `${className} · ${aoiIds.map((id) => aois.find((a) => a.id === id)?.name ?? '').filter(Boolean).join(' + ')} · ${new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`;
  const training = train.busy;
  const sp = selected?.stats?.splits;

  return (
    <>
      <button
        type="button"
        onClick={openDialog}
        disabled={disabled}
        title="Choose the data, generate and review the splits, train, and see the metrics"
        style={label ? {
          flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
          padding: '7px 10px', borderRadius: 5, fontSize: 13, fontWeight: 600,
          border: `1px solid ${disabled ? MC.border : MC.accent}`, background: disabled ? 'transparent' : MC.accent,
          color: disabled ? MC.textMuted : '#fff', cursor: disabled ? 'not-allowed' : 'pointer',
        } : {
          width: 26, height: 26, flexShrink: 0,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          borderRadius: 5, border: `1px solid ${MC.border}`,
          background: 'transparent', color: MC.accent,
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.5 : 1,
        }}
      >
        {label ? (
          <>
            {busy ? <Loader2 size={12} className="animate-spin" /> : <GraduationCap size={12} />}
            {busy ? 'Training…' : label}
          </>
        ) : <Wand2 size={12} />}
      </button>

      {/* Portaled to <body> as a fixed window so it floats over the whole
          map canvas and is never clipped by the right panel's own
          overflow/transform (same pattern as LayerCard's context menu). */}
      {open && typeof document !== 'undefined' && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{ position: 'fixed', inset: 0, zIndex: 2000, background: 'rgba(0,0,0,0.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16 }}
        >
          <div
            role="dialog"
            aria-label="Train Head — workspace"
            onClick={(e) => e.stopPropagation()}
            style={{
              // On a laptop everything shrinks together, and the window grows to compensate, so it keeps the layout of a larger screen.
              zoom: scale, width: `${96 / scale}vw`, height: `${92 / scale}vh`, display: 'flex', flexDirection: 'column',
              background: MC.panelBg, border: `1px solid ${MC.panelBorder ?? MC.border}`,
              borderRadius: 10, boxShadow: '0 12px 40px rgba(0,0,0,0.35)', overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 18px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
              <Wand2 size={16} color={MC.accent} />
              <span style={{ fontSize: 17, fontWeight: 700, color: MC.text }}>Train Head</span>
              <span style={{ fontSize: 15, color: MC.textMuted, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {className} · {TASK_NAME[task].toLowerCase()}
              </span>
              <button type="button" aria-label="Close" onClick={() => setOpen(false)} style={{ background: 'transparent', border: 'none', cursor: 'pointer', color: MC.textMuted, padding: 2 }}>
                <X size={18} />
              </button>
            </div>

            {/* The flow, left to right: data → splits → training and metrics */}
            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(300px, 20fr) minmax(420px, 60fr) minmax(340px, 20fr)' }}>
              <FlowColumn title="Data" done={scopeReady && splitsReady && !selected?.is_stale}
                sub={scopeReady ? `${aoiIds.length} area${aoiIds.length === 1 ? '' : 's'} · ${setIds.length} set${setIds.length === 1 ? '' : 's'}` : 'Choose areas and annotation sets'}>
                <TrainHeadDataStep
                  aois={aois} aoiIds={aoiIds} onAoiIds={setAoiIds}
                  sets={sets} loadingSets={loadingSets}
                  setIds={setIds} onSetIds={(ids) => { setTouched(true); setSetIds(ids); }}
                  className={className} preview={preview} loadingPreview={loadingPreview && setIds.length > 0}
                  onDeleteSet={deleteSet}
                  roleOf={roleOf}
                  task={task}
                  classes={classes} classIds={classIds} onClassIds={setClassIds}
                  onRole={(id, role) => setRoles((prev) => ({ ...prev, [id]: role }))}
                />
                <SplitsSetup
                  onSelect={onSelectDataset}
                  draft={draft} setDraft={setDraft} name={name} setName={setName} defaultName={defaultName}
                  setRoles={Object.fromEntries(setIds.map((id) => [id, roleOf(id)]))}
                  collectionId={collectionId} classId={wantedClasses[0]} classIds={task === 'yolo' ? wantedClasses : undefined} aoiIds={aoiIds} setIds={setIds} task={task}
                  preview={preview} onChanged={refresh}
                />
              </FlowColumn>

              <FlowColumn title="Review splits" done={splitsReady && !selected?.is_stale}
                sub={!selected ? 'Nothing generated yet' : building ? 'Generating…' : selected.status === 'failed' ? 'Generation failed'
                  : selected.is_stale ? 'Out of date — regenerate' : sp ? `${sp.train.tiles} train · ${sp.eval.tiles} eval · ${sp.test.tiles} test tiles` : 'Ready'}>
                <SplitsReview datasets={datasets} selected={selected} onSelect={onSelectDataset} onChanged={refresh} />
              </FlowColumn>

              <FlowColumn title="Train" done={!!runs?.some((r) => r.status === 'completed')} last
                sub={training ? 'Training…' : runs?.length ? `${runs.length} run${runs.length === 1 ? '' : 's'}` : 'Not trained yet'}>
                <TrainingSection
                  backbone={backbone} onBackbone={setBackbone}
                  lr={lr} onLrChange={onLrChange} epochs={epochs} onEpochsChange={onEpochsChange}
                  train={train} splitsReady={splitsReady} dataset={selected}
                  tune={{ value: tune, onChange: setTune, saved: savedTuned, onForget: () => forgetTuned.mutate(), forgetting: forgetTuned.isPending }}
                  yolo={task === 'yolo' ? { bases, base, onBase: setBase, stage1, onStage1: setStage1, stage2, onStage2: setStage2, lr1, onLr1: setLr1, lr2, onLr2: setLr2 } : undefined}
                  onTrain={() => train.onTrain({
                    ...(task === 'yolo' ? { base_weights: base, stage1_epochs: stage1, stage2_epochs: stage2, stage1_lr: lr1, stage2_lr: lr2 } : { backbone }),
                    ...tunePayload(tune),
                  })}
                />
                <TrainJobCard job={train.job} busy={training} />
                <ResultsPane
                  runs={runs} loading={loadingRuns} expId={runId} onExp={setRunId}
                  renderRun={(run, label, embedded) => <RunDetail run={run} label={label} embedded={embedded} />}
                />
              </FlowColumn>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

/** One stage of the flow: a quiet label, a status dot, and its own scroll. The detail is behind the info icon. */
function FlowColumn({ title, sub, done, last, children }: {
  title: string; sub: string; done: boolean; last?: boolean; children: React.ReactNode;
}) {
  return (
    <section style={{ minWidth: 0, minHeight: 0, display: 'flex', flexDirection: 'column', borderRight: last ? 'none' : `1px solid ${MC.border}` }}>
      <header style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
        <span aria-hidden style={{ width: 8, height: 8, borderRadius: 4, flexShrink: 0, background: done ? '#16a34a' : '#d97706' }} />
        <h2 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: MC.text }}>{title}</h2>
        <InfoTip text={sub} size={12} />
      </header>
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflowY: 'auto' }}>{children}</div>
    </section>
  );
}

// ── Sections ────────────────────────────────────────────────────────────────

/** Data column, last block: the splits that exist, and the form that generates new ones. */
function SplitsSetup({
  onSelect, draft, setDraft, name, setName, defaultName, setRoles,
  collectionId, classId, classIds, aoiIds, setIds, task, preview, onChanged,
}: {
  onSelect: (id: string) => void;
  draft: Draft; setDraft: (d: Draft) => void; name: string; setName: (n: string) => void; defaultName: string;
  setRoles: Record<string, SetRole>;
  collectionId: string; classId: string; classIds?: string[]; aoiIds: string[]; setIds: string[]; task: DinoTask;
  preview: DinoExportPreviewResponse | undefined; onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const suggested = preview?.suggested_scales_m;
  const splitsOk = draft.eval_split + draft.test_split <= 0.7;
  const params: DinoDatasetParams = { ...draft, scales_m: draft.scales_m.length ? draft.scales_m : undefined, set_roles: setRoles };

  const createMut = useMutation({
    mutationFn: () => dinoApi.createDataset({
      name: name.trim() || defaultName,
      annotation_set_collection_id: collectionId,
      class_id: classId,
      class_ids: classIds,
      aoi_id: aoiIds[0],
      aoi_ids: aoiIds,
      annotation_set_ids: setIds,
      task,
      params,
    }),
    onSuccess: (ds) => {
      // Put it in the list before selecting, or the panel's "keep a valid selection" would pick another one.
      queryClient.setQueriesData<DinoDataset[]>({ queryKey: ['train-head-datasets'] }, (old) => (old ? [ds, ...old.filter((d) => d.id !== ds.id)] : [ds]));
      onSelect(ds.id);
      setName('');
      onChanged();
      toast.success('Generating splits…');
    },
    onError: (err) => toast.error(err instanceof Error ? err.message : 'Could not generate the splits'),
  });
  const canGenerate = setIds.length > 0 && !!preview?.ready && !createMut.isPending && splitsOk && draft.scales_m.length > 0;

  const [settingsOpen, setSettingsOpen] = useState(false);
  const wrap = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!settingsOpen) return;
    const onDown = (e: MouseEvent) => { if (wrap.current && !wrap.current.contains(e.target as Node)) setSettingsOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); setSettingsOpen(false); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [settingsOpen]);

  const sizes = preview?.object_size_p10_m != null && preview.object_size_p90_m != null
    ? `Your objects span ${preview.object_size_p10_m}–${preview.object_size_p90_m} m (${preview.size_spread}× spread)${suggested?.length ? `, so ${suggested.length > 1 ? 'several scales' : 'one scale'} (${suggested.join(', ')} m) suit them` : ''}. The trained model scans at the scales you pick here.`
    : 'The trained model scans at the scales you pick here.';
  const summary = `${draft.scales_m.length ? `${draft.scales_m.join(', ')} m` : 'no scale'} · ${Math.round((1 - draft.eval_split - draft.test_split) * 100)}/${Math.round(draft.eval_split * 100)}/${Math.round(draft.test_split * 100)}%`;

  return (
    <section ref={wrap} style={{ flexShrink: 0, position: 'relative', padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 8, borderTop: `1px solid ${MC.border}` }}>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input
          aria-label="Name these splits"
          type="text"
          value={name}
          maxLength={255}
          placeholder={defaultName}
          onChange={(e) => setName(e.target.value)}
          style={{ ...hpInputStyle, flex: 1, minWidth: 0, height: 30, fontSize: 14, fontWeight: 600 }}
        />
        <IconButton label={`Split settings · ${summary}`} active={settingsOpen} onClick={() => setSettingsOpen(!settingsOpen)} size={30}>
          <SlidersHorizontal size={15} />
        </IconButton>
        <button
          type="button"
          disabled={!canGenerate}
          onClick={() => createMut.mutate()}
          title={setIds.length === 0 ? 'Choose annotation sets above first' : undefined}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, height: 30, padding: '0 12px', borderRadius: 6, fontSize: 13, fontWeight: 700, flexShrink: 0,
            border: `1px solid ${canGenerate ? MC.accent : MC.border}`, background: canGenerate ? MC.accent : 'transparent',
            color: canGenerate ? '#fff' : MC.textMuted, cursor: canGenerate ? 'pointer' : 'not-allowed',
          }}
        >
          {createMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Hammer size={14} />} Generate
        </button>
      </div>

      {settingsOpen && (
        <div
          role="dialog"
          aria-label="Split settings"
          style={{
            position: 'absolute', left: 10, right: 10, bottom: 'calc(100% - 6px)', zIndex: 15, maxHeight: '70vh', overflowY: 'auto',
            background: MC.panelBg, border: `1px solid ${MC.border}`, borderRadius: 8, boxShadow: '0 10px 28px rgba(0,0,0,0.25)',
            padding: 14, display: 'flex', flexDirection: 'column', gap: 12,
          }}
        >
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4 }}>
              <span style={hpLabelStyle}>Tile scales (m)</span>
              <InfoTip text={sizes} />
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
              {LADDER_M.map((t) => {
                const on = draft.scales_m.includes(t);
                return (
                  <button
                    key={t}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setDraft({ ...draft, scales_m: (on ? draft.scales_m.filter((v) => v !== t) : [...draft.scales_m, t]).sort((x, y) => x - y) })}
                    style={{
                      height: 26, padding: '0 10px', borderRadius: 5, fontSize: 13, fontWeight: 700, cursor: 'pointer',
                      border: `1px solid ${on ? MC.accent : MC.border}`, background: on ? MC.accent : 'transparent', color: on ? '#fff' : MC.textMuted,
                    }}
                  >
                    {t}
                  </button>
                );
              })}
              {!!suggested?.length && (
                <button
                  type="button"
                  onClick={() => setDraft({ ...draft, scales_m: [...suggested] })}
                  title={`Reset to the suggested scales (${suggested.join(', ')} m)`}
                  style={{ height: 26, padding: '0 10px', borderRadius: 5, fontSize: 13, fontWeight: 600, cursor: 'pointer', border: `1px dashed ${MC.border}`, background: 'transparent', color: MC.textSecondary }}
                >
                  Suggested
                </button>
              )}
            </div>
            {draft.scales_m.length === 0 && <p style={{ ...noteStyle, color: '#d97706', marginTop: 4 }}>Pick at least one scale.</p>}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 10 }}>
            <NumField label="Eval split" value={draft.eval_split} min={0.05} max={0.4} step={0.01} onChange={(v) => setDraft({ ...draft, eval_split: v })} />
            <NumField label="Test split" value={draft.test_split} min={0.05} max={0.4} step={0.01} onChange={(v) => setDraft({ ...draft, test_split: v })} />
            <NumField label="Empty / object" value={draft.neg_ratio} min={0} max={10} step={0.5} onChange={(v) => setDraft({ ...draft, neg_ratio: v })} />
            <NumField label="Tile px" value={draft.crop_px} min={128} max={1280} step={64} onChange={(v) => setDraft({ ...draft, crop_px: v })} />
            <div style={{ flex: 1 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 3 }}>
                <label style={{ ...hpLabelStyle, marginBottom: 0 }} htmlFor="th-region">Region</label>
                <InfoTip size={12} text={`Each ${draft.region_tiles}×${draft.region_tiles}-tile block goes wholly to train, eval or test, so neighbouring tiles never straddle the split. Eval and test sizes apply to sets marked “Both”.`} />
              </div>
              <input id="th-region" type="number" min={1} max={10} step={1} value={draft.region_tiles}
                onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) setDraft({ ...draft, region_tiles: v }); }} style={hpInputStyle} />
            </div>
          </div>
          {!splitsOk && <p style={{ ...noteStyle, color: '#dc2626' }}>Eval + test must leave at least 30% for training.</p>}
        </div>
      )}
    </section>
  );
}

/** Review column: pick generated splits, see how they divide, and check their tiles. Rename, download and delete live in the "…" menu. */
function SplitsReview({ datasets, selected, onSelect, onChanged }: {
  datasets: DinoDataset[]; selected: DinoDataset | undefined; onSelect: (id: string) => void; onChanged: () => void;
}) {
  const queryClient = useQueryClient();
  const [nameDraft, setNameDraft] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [menu, setMenu] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const menuRef = useDismiss(menu, () => { setMenu(false); setConfirmDelete(false); });
  useEffect(() => { setNameDraft(selected?.name ?? ''); setRenaming(false); setConfirmDelete(false); }, [selected?.id, selected?.name]);
  const onError = (err: unknown) => toast.error(err instanceof Error ? err.message : 'Request failed');

  const renameMut = useMutation({ mutationFn: (n: string) => dinoApi.renameDataset(selected!.id, n), onSuccess: () => onChanged(), onError });
  const downloadMut = useMutation({
    mutationFn: async () => {
      const blob = await dinoApi.downloadDataset(selected!.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selected!.name.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '') || 'dataset'}_coco.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onSuccess: () => setMenu(false),
    onError,
  });
  const deleteMut = useMutation({
    mutationFn: () => dinoApi.deleteDataset(selected!.id),
    onSuccess: () => {
      const gone = selected!.id;
      queryClient.setQueriesData<DinoDataset[]>({ queryKey: ['train-head-datasets'] }, (old) => old?.filter((d) => d.id !== gone));
      setMenu(false);
      setConfirmDelete(false);
      onChanged();
      toast.success('Splits deleted');
    },
    onError: async (err) => {
      setConfirmDelete(false);
      let msg = 'Could not delete the splits';
      try { const body = await (err as { response?: Response }).response?.json(); if (body?.detail) msg = String(body.detail); } catch { /* keep the default */ }
      toast.error(msg);
    },
  });

  if (!selected) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: MC.textMuted, fontSize: 14 }}>
        Generate splits under Data and they appear here.
      </div>
    );
  }
  const busy = selected.status === 'building' || selected.status === 'pending';
  const counts = selected.stats?.splits;
  const total = counts ? SPLITS.reduce((n, k) => n + counts[k].tiles, 0) : 0;
  const SPLIT_COLOR = { train: MC.accent, eval: '#6b8e4e', test: '#7a8794' } as const;
  const state = selected.status === 'failed' ? ['#dc2626', 'Generation failed'] : busy ? ['#d97706', 'Generating'] : selected.is_stale ? ['#d97706', 'Out of date: regenerate before training'] : ['#16a34a', 'Ready'];
  const notes = [
    TASK_NAME[selected.task],
    selected.source_dataset_id ? 'Shares the tile images and split of its source detector splits; only the labels differ.' : '',
    selected.stats?.by_scale && Object.keys(selected.stats.by_scale).length > 1
      ? `By scale: ${Object.entries(selected.stats.by_scale).sort(([x], [y]) => Number(x) - Number(y)).map(([m, v]) => `${m} m ${v.tiles} tiles`).join(' · ')}.` : '',
    selected.stats?.tiles_skipped_ambiguous
      ? `${selected.stats.tiles_skipped_ambiguous} tile(s) beside an object were left out of the empty tiles, since the object is only partly in them.` : '',
  ].filter(Boolean).join(' ');
  const commitName = () => {
    const n = nameDraft.trim();
    setRenaming(false);
    if (!n || n === selected.name) { setNameDraft(selected.name); return; }
    renameMut.mutate(n);
  };
  const warn = [
    selected.is_stale && selected.stale_reason ? `${selected.stale_reason} Regenerate before training.` : '',
    ...(selected.status === 'ready' ? selected.stats?.warnings ?? [] : []),
  ].filter(Boolean);

  return (
    <>
      <div style={{ flexShrink: 0, padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: `1px solid ${MC.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Tip text={state[1]}>{busy ? <Loader2 size={14} className="animate-spin" color={state[0]} /> : <span aria-hidden style={{ width: 9, height: 9, borderRadius: 5, background: state[0] }} />}</Tip>
          {renaming ? (
            <input
              autoFocus
              aria-label="Splits name"
              value={nameDraft}
              maxLength={255}
              onChange={(e) => setNameDraft(e.target.value)}
              onBlur={commitName}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitName();
                if (e.key === 'Escape') { setNameDraft(selected.name); setRenaming(false); }
              }}
              style={{ ...hpInputStyle, flex: 1, minWidth: 0, height: 30, fontSize: 15, fontWeight: 700 }}
            />
          ) : (
            <select
              aria-label="Generated splits"
              value={selected.id}
              onChange={(e) => onSelect(e.target.value)}
              style={{ flex: 1, minWidth: 0, height: 30, fontSize: 15, fontWeight: 700, color: MC.text, background: 'transparent', border: `1px solid ${MC.border}`, borderRadius: 6, padding: '0 6px', cursor: 'pointer' }}
            >
              {datasets.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
          )}
          <InfoTip text={notes} />
          <div ref={menuRef} style={{ position: 'relative' }}>
            <IconButton label="Rename, download or delete these splits" active={menu} onClick={() => { setMenu(!menu); setConfirmDelete(false); }}>
              <MoreHorizontal size={15} />
            </IconButton>
            {menu && (
              <div role="menu" style={{ ...popoverStyle, top: 'calc(100% + 4px)', right: 0, minWidth: 230 }}>
                <MenuItem icon={<Pencil size={14} />} label="Rename" onClick={() => { setMenu(false); setRenaming(true); }} />
                <MenuItem
                  icon={downloadMut.isPending ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
                  label="Download as COCO zip" disabled={selected.status !== 'ready' || downloadMut.isPending} onClick={() => downloadMut.mutate()}
                />
                {confirmDelete ? (
                  <div style={{ display: 'flex', gap: 6, padding: '4px 6px' }}>
                    <button type="button" onClick={() => setConfirmDelete(false)} style={{ flex: 1, height: 28, borderRadius: 5, border: `1px solid ${MC.border}`, background: 'transparent', color: MC.text, fontSize: 13, fontWeight: 600, cursor: 'pointer' }}>Back</button>
                    <button type="button" disabled={deleteMut.isPending} onClick={() => deleteMut.mutate()} style={{ flex: 1, height: 28, borderRadius: 5, border: 'none', background: '#dc2626', color: '#fff', fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>
                      {deleteMut.isPending ? 'Deleting…' : 'Confirm delete'}
                    </button>
                  </div>
                ) : (
                  <MenuItem icon={<Trash2 size={14} />} label="Delete" danger disabled={busy} onClick={() => setConfirmDelete(true)} />
                )}
              </div>
            )}
          </div>
        </div>

        {selected.status === 'failed' && selected.error && <p style={{ ...noteStyle, color: '#dc2626', fontFamily: 'monospace' }}>{selected.error.slice(0, 240)}</p>}

        {counts && selected.status === 'ready' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', background: MC.border }} role="img" aria-label="Share of tiles in train, eval and test">
              {SPLITS.map((k) => counts[k].tiles > 0 && <div key={k} style={{ width: `${(counts[k].tiles / total) * 100}%`, background: SPLIT_COLOR[k] }} />)}
            </div>
            <div style={{ display: 'flex', gap: 16, fontSize: 14, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>
              {SPLITS.map((k) => (
                <Tip key={k} text={`${counts[k].annotations} objects in ${counts[k].positives} tiles, ${counts[k].negatives} empty tiles`}>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                    <span aria-hidden style={{ width: 8, height: 8, borderRadius: 2, background: SPLIT_COLOR[k] }} />
                    <b>{counts[k].tiles}</b> <span style={{ color: MC.textMuted }}>{k}</span>
                  </span>
                </Tip>
              ))}
              {warn.length > 0 && <span style={{ marginLeft: 'auto' }}><Tip text={warn.join(' ')}><AlertTriangle size={15} color="#d97706" /></Tip></span>}
            </div>
          </div>
        )}
      </div>
      <DatasetBrowser datasetId={selected.status === 'ready' ? selected.id : null} build={selected.build_no} />
    </>
  );
}

// ── Shared bits ──────────────────────────────────────────────────────────────

type SplitFilter = 'all' | 'train' | 'eval' | 'test';

const hpLabelStyle: React.CSSProperties = {
  fontSize: 12, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase',
  color: MC.textMuted, display: 'block', marginBottom: 3,
};

const hpInputStyle: React.CSSProperties = {
  width: '100%', padding: '5px 7px', borderRadius: 6,
  border: `1px solid ${MC.border}`, background: MC.inputBg ?? '#1e2518',
  color: MC.text, fontSize: 14,
};

const noteStyle: React.CSSProperties = { fontSize: 13, color: MC.textMuted, margin: 0, lineHeight: 1.4 };

function NumField({
  label, value, min, max, step, onChange,
}: { label: string; value: number; min: number; max: number; step: number; onChange: (v: number) => void }) {
  return (
    <div style={{ flex: 1 }}>
      <label style={hpLabelStyle}>{label}</label>
      <input
        type="number" min={min} max={max} step={step} value={value}
        onChange={(e) => { const v = Number(e.target.value); if (!Number.isNaN(v)) onChange(v); }}
        style={hpInputStyle}
      />
    </div>
  );
}

/**
 * Renders one exported tile's bytes as an <img>, fetched through the API (authenticated, same port as
 * everything else) rather than a presigned MinIO URL. The blob becomes an object URL that is revoked on
 * unmount or key change, so a long session with many tiles does not leak memory.
 */
function AuthedImg({ datasetId, imageKey, alt, style }: { datasetId: string; imageKey: string; alt: string; style: React.CSSProperties }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let objectUrl: string | null = null;
    let cancelled = false;
    setUrl(null);
    setFailed(false);
    dinoApi.getDatasetImageBlob(datasetId, imageKey)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [datasetId, imageKey]);

  if (failed) {
    return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontSize: 12 }}>missing</div>;
  }
  if (!url) {
    return <div style={{ ...style, display: 'flex', alignItems: 'center', justifyContent: 'center', color: MC.textMuted }}><Loader2 size={14} className="animate-spin" /></div>;
  }
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={url} alt={alt} style={style} />;
}

// ── Train column ─────────────────────────────────────────────────────────────

const BACKBONES: { id: Backbone; label: string; note: string }[] = [
  { id: 'dinov2-vits14', label: 'DINOv2 small', note: 'Faster and lighter: a good default for few labels.' },
  { id: 'dinov2-vitb14', label: 'DINOv2 base', note: 'More capacity, about four times the memory and time.' },
];

/** Model, learning rate, epochs and Train, in one block. The explanations are behind the info icons. */
function TrainingSection({
  backbone, onBackbone, lr, onLrChange, epochs, onEpochsChange, train, splitsReady, dataset, onTrain, yolo, tune,
}: {
  backbone: Backbone; onBackbone: (b: Backbone) => void;
  lr: number; onLrChange: (v: number) => void;
  epochs: number; onEpochsChange: (v: number) => void;
  train: { canTrain: boolean; busy: boolean; stale: boolean };
  splitsReady: boolean; onTrain: () => void; dataset: DinoDataset | undefined;
  /** Auto-tune and repeated runs, and the config already saved for this dataset + model. */
  tune: { value: TuneOptions; onChange: (v: TuneOptions) => void; saved: DinoTunedConfig | undefined; onForget: () => void; forgetting: boolean };
  /** YOLO: where to start from and how long each stage runs. Replaces the model, rate and epochs. */
  yolo?: {
    bases: { pretrained: { id: string; name: string }[]; earlier: { id: string; name: string }[] } | undefined;
    base: string; onBase: (b: string) => void; stage1: number; onStage1: (n: number) => void; stage2: number; onStage2: (n: number) => void;
    lr1: number; onLr1: (n: number) => void; lr2: number; onLr2: (n: number) => void;
  };
}) {
  const disabled = !train.canTrain;
  // With auto-tune on, the search owns the learning rate and (for the DINOv2 heads) the epochs: they show the saved tuned
  // values if there are any, otherwise the starting point, and cannot be edited. YOLO's stage lengths stay yours.
  const locked = tune.value.autoTune;
  const savedParams = tune.saved && !tune.saved.is_stale && !tune.value.retune ? tune.saved.best_params : undefined;
  const shown = (key: string, v: number) => (locked ? savedParams?.[key] ?? v : v);
  const lockedStyle: React.CSSProperties = locked ? { ...hpInputStyle, opacity: 0.6, cursor: 'not-allowed' } : hpInputStyle;
  const lockedNote = locked ? (savedParams ? 'Saved tuned values for this dataset. Turn auto-tune off to edit.' : 'Chosen by the search. Turn auto-tune off to edit.') : undefined;
  const field = (label: string, tip: string, id: string, children: React.ReactNode) => (
    <div style={{ minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 3 }}>
        <label style={{ ...hpLabelStyle, marginBottom: 0 }} htmlFor={id}>{label}</label>
        <InfoTip text={tip} size={12} />
      </div>
      {children}
    </div>
  );
  return (
    <section style={{ flexShrink: 0, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 8, borderBottom: `1px solid ${MC.border}` }}>
      {yolo ? (
        <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)', gap: 8 }}>
          <div style={{ gridColumn: '1 / -1' }}>
            {field('Start from', 'The pretrained weights to start from, or an earlier YOLO model to add classes to it: the classes it knew keep their weights and a new class starts fresh. The head has one output per class you chose, not 80.', 'th-base',
              <select id="th-base" value={yolo.base} onChange={(e) => yolo.onBase(e.target.value)} style={hpInputStyle}>
                {(yolo.bases?.pretrained ?? [{ id: 'yolo26l.pt', name: 'yolo26l' }]).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                {(yolo.bases?.earlier.length ?? 0) > 0 && <optgroup label="Earlier models">{yolo.bases!.earlier.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</optgroup>}
              </select>)}
          </div>
          {field('Stage 1 epochs', 'Epochs with the backbone frozen: only the neck and head adapt to your classes, so the pretrained features are not disturbed.', 'th-s1',
            <input id="th-s1" type="number" min={0} max={500} value={yolo.stage1} onChange={(e) => yolo.onStage1(Math.max(0, Number(e.target.value) || 0))} style={hpInputStyle} />)}
          {field('Stage 1 rate', 'Learning rate for stage 1 (AdamW).', 'th-lr1',
            <input id="th-lr1" type="number" step="0.0001" min={0.000001} max={0.1} value={shown('stage1_lr', yolo.lr1)} disabled={locked} title={lockedNote} onChange={(e) => yolo.onLr1(Number(e.target.value) || yolo.lr1)} style={lockedStyle} />)}
          <label style={{ gridColumn: '1 / -1', display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: MC.text, cursor: 'pointer' }}>
            <input type="checkbox" checked={yolo.stage2 > 0} onChange={(e) => yolo.onStage2(e.target.checked ? 40 : 0)} />
            Stage 2: unfreeze all layers
            <InfoTip text="A second run with every layer trainable at a lower learning rate, to refine the backbone for your imagery. Turn it off to keep the pretrained backbone as it is (stage 1 only)." size={12} />
          </label>
          {yolo.stage2 > 0 && (<>
            {field('Stage 2 epochs', 'Epochs with all layers unfrozen.', 'th-s2',
              <input id="th-s2" type="number" min={1} max={500} value={yolo.stage2} onChange={(e) => yolo.onStage2(Math.max(1, Number(e.target.value) || 1))} style={hpInputStyle} />)}
            {field('Stage 2 rate', 'Learning rate for stage 2 (AdamW). Keep it well below stage 1: too high and the pretrained features are overwritten.', 'th-lr2',
              <input id="th-lr2" type="number" step="0.0001" min={0.000001} max={0.1} value={shown('stage2_lr', yolo.lr2)} disabled={locked} title={lockedNote} onChange={(e) => yolo.onLr2(Number(e.target.value) || yolo.lr2)} style={lockedStyle} />)}
          </>)}
        </div>
      ) : (
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.5fr) minmax(0, 1.1fr) minmax(0, 0.8fr)', gap: 8 }}>
        {field('Model', `${BACKBONES.find((b) => b.id === backbone)?.note} The backbone stays frozen and a small head is trained on top.`, 'th-backbone',
          <select id="th-backbone" value={backbone} onChange={(e) => onBackbone(e.target.value as Backbone)} style={hpInputStyle}>
            {BACKBONES.map((b) => <option key={b.id} value={b.id}>{b.label}</option>)}
          </select>)}
        {field('Rate', 'Learning rate. 1e-4 with more epochs is usually steadier.', 'th-lr',
          <input id="th-lr" type="number" step="0.00001" min={0.000001} max={1} value={shown('lr', lr)} disabled={locked} title={lockedNote} onChange={(e) => onLrChange(Number(e.target.value) || lr)} style={lockedStyle} />)}
        {field('Epochs', 'The eval split is the validation set: the best-validation epoch is the one kept.', 'th-epochs',
          <input id="th-epochs" type="number" min={1} max={2000} value={shown('epochs', epochs)} disabled={locked} title={lockedNote} onChange={(e) => onEpochsChange(Number(e.target.value) || epochs)} style={lockedStyle} />)}
      </div>
      )}
      {locked && <p style={{ ...noteStyle, fontSize: 12 }}>{yolo ? 'The two learning rates are chosen automatically. Stage lengths stay as set.' : `The learning rate and epochs are found by the search (epochs up to ${SEARCH_MAX_EPOCHS}). Turn it off to set them yourself.`}</p>}
      <TuningOptions
        value={tune.value} onChange={tune.onChange} saved={tune.saved} onForget={tune.onForget} forgetting={tune.forgetting}
        yolo={!!yolo} disabled={disabled}
      />
      <button
        type="button"
        disabled={disabled}
        onClick={onTrain}
        title={!splitsReady ? 'Generate splits first' : dataset ? `Trains on ${dataset.name}` : undefined}
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8, height: 34, borderRadius: 6, fontSize: 15, fontWeight: 700,
          border: `1px solid ${disabled ? MC.border : MC.accent}`, background: disabled ? 'transparent' : MC.accent,
          color: disabled ? MC.textMuted : '#fff', cursor: disabled ? 'not-allowed' : 'pointer',
        }}
      >
        {train.busy ? <Loader2 size={16} className="animate-spin" /> : <GraduationCap size={16} />}
        {train.busy ? 'Training…' : train.stale ? 'Train on out-of-date splits' : 'Train'}
      </button>
    </section>
  );
}

/** Live state of the training job started from this workspace. */
function TrainJobCard({ job, busy }: { job: DinoFinetuneJobRead | undefined; busy: boolean }) {
  if (!job || !busy) return null; // the outcome is a toast, not a card
  const failed = job.status === 'failed';
  const done = job.status === 'completed';
  return (
    <section style={{ margin: '8px 14px 0', flexShrink: 0, border: `1px solid ${failed ? '#dc2626' : done ? '#16a34a' : MC.accent}`, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6, background: MC.accentDim }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, color: MC.text }}>
        {busy ? <Loader2 size={15} className="animate-spin" color={MC.accent} /> : failed ? <AlertCircle size={15} color="#dc2626" /> : <CheckCircle2 size={15} color="#16a34a" />}
        {busy ? 'Training…' : failed ? 'Training failed' : 'Training finished'}
      </div>
      {busy && job.progress != null && (
        <div style={{ height: 5, borderRadius: 3, background: MC.border, overflow: 'hidden' }}>
          <div style={{ width: `${Math.round(job.progress * 100)}%`, height: '100%', background: MC.accent, transition: 'width 0.4s ease-out' }} />
        </div>
      )}
      {failed && job.logs && <p style={{ ...noteStyle, color: '#dc2626', fontFamily: 'monospace' }}>{job.logs.slice(0, 200)}</p>}
      {done && <p style={noteStyle}>{runMetrics(job) || job.config?.result?.note || 'See the report below.'}</p>}
    </section>
  );
}

function runMetrics(run: DinoFinetuneJobRead): string {
  const e = run.config?.result?.eval_result;
  return [
    e?.ap50 != null ? `AP50 ${fmt(e.ap50)}` : null,
    e?.f1 != null ? `F1 ${fmt(e.f1)}` : null,
    e?.accuracy != null ? `acc ${fmt(e.accuracy)}` : null,
  ].filter(Boolean).join(' · ');
}

/** 2×2 of what the classifier said against what was there. */
function Confusion({ tp, fp, tn, fn }: { tp: number; fp: number; tn: number; fn: number }) {
  const cell = (n: number, good: boolean, label: string): React.ReactNode => (
    <div style={{ padding: '6px 9px', borderRadius: 6, background: n === 0 ? 'transparent' : good ? 'rgba(22,163,74,0.14)' : 'rgba(220,38,38,0.12)', border: `1px solid ${MC.border}` }}>
      <div style={{ fontSize: 17, fontWeight: 700, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{n}</div>
      <div style={{ fontSize: 11, color: MC.textMuted }}>{label}</div>
    </div>
  );
  const head: React.CSSProperties = { fontSize: 12, fontWeight: 600, color: MC.textMuted, alignSelf: 'end', paddingBottom: 2 };
  return (
    <div role="table" aria-label="Predictions against the labels" style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr 1fr', gap: 6, width: 232, margin: '0 auto', alignItems: 'stretch' }}>
      <span />
      <span style={{ ...head, textAlign: 'center' }}>Said present</span>
      <span style={{ ...head, textAlign: 'center' }}>Said absent</span>
      <span style={{ ...head, alignSelf: 'center', paddingRight: 4 }}>Present</span>
      {cell(tp, true, 'Found')}
      {cell(fn, false, 'Missed')}
      <span style={{ ...head, alignSelf: 'center', paddingRight: 4 }}>Absent</span>
      {cell(fp, false, 'False alarm')}
      {cell(tn, true, 'Correct')}
    </div>
  );
}

/** The report of one run. The settings are behind the info icon; the model actions are in one "…" menu. */
function RunDetail({ run, label, embedded = false }: { run: DinoFinetuneJobRead; label: string; embedded?: boolean }) {
  const req = run.config?.request;
  const result = run.config?.result;
  const failed = run.status === 'failed';
  const completed = run.status === 'completed';
  const e = result?.eval_result;
  const tr = result?.train_result;
  const hp = result?.hyperparameters;
  const taskKind = (req?.task ?? result?.task ?? 'detect') as DinoTask;
  const isDetect = taskKind !== 'classify'; // detector and segmenter are scored on matched objects
  const metric = (label: string, v: number | null | undefined, lead = false) =>
    v == null ? null : <Stat key={label} label={label} value={v.toFixed(3)} raw={v} lead={lead} />;
  const stats = (isDetect
    ? [metric('AP50', e?.ap50, true), metric('Precision', e?.precision), metric('Recall', e?.recall), metric('Mean IoU', e?.mean_iou_tp)]
    : [metric('F1', e?.f1, true), metric('Accuracy', e?.accuracy), metric('Precision', e?.precision), metric('Recall', e?.recall)]
  ).filter(Boolean);
  const settings = [
    `${TASK_NAME[taskKind]}${hp?.backbone ? ` on ${hp.backbone}` : ''}.`,
    tr?.stages
      ? `Stage 1: ${tr.stages.stage1_epochs} epochs${tr.stages.stage1_lr ? `, learning rate ${tr.stages.stage1_lr}` : ''}, with ${tr.stages.frozen_layers} backbone layers frozen. ${tr.stages.stage2_epochs > 0 ? `Stage 2: ${tr.stages.stage2_epochs} epochs, all layers, learning rate ${tr.stages.stage2_lr}.` : 'Stage 2 off.'}`
      : `Learning rate ${hp?.lr ?? req?.lr ?? 'default'}, ${hp?.epochs ?? req?.epochs ?? 'default'} epochs${hp?.weight_decay != null ? `, weight decay ${hp.weight_decay.toPrecision(2)}` : ''}.`,
    result ? `Splits build b${result.dataset_build_no}${result.patch_span_m ? `, ${result.patch_span_m} m tiles` : ''}, ${result.train_items} / ${result.eval_items} / ${result.test_items} tiles (train / eval / test).` : '',
    tr?.best_epoch != null ? `Best epoch ${tr.best_epoch}${tr.best_val_loss != null ? ` (validation loss ${fmt(tr.best_val_loss)})` : ''}.` : '',
    tr?.final_loss != null ? `Final loss ${fmt(tr.final_loss)}.` : '',
    result?.timings ? `Trained in ${result.timings.train_seconds}s.` : '',
    e ? `${e.num_images} test images.` : '',
  ].filter(Boolean).join(' ');
  const showConfusion = !isDetect && e?.tp != null && e.fp != null && e.tn != null && e.fn != null;
  const hasCurve = !!tr && tr.epoch_losses.length > 1;
  const canExport = completed && !!result?.training_triggered && !!tr?.artifact_key;
  const extra = [
    isDetect && e?.num_ground_truth != null ? `${e.num_predictions ?? 0} predicted against ${e.num_ground_truth} labelled objects${e.iou_thresh != null ? ` at IoU ${e.iou_thresh}` : ''}.` : '',
    taskKind === 'segment' && e?.pixel_iou != null
      ? `Pixels: IoU ${fmt(e.pixel_iou)}, Dice ${fmt(e.dice)}. Count off by ${fmt(e.count_mae, 2)} per tile${e.area_err_pct != null ? `, area off by ${e.area_err_pct}%` : ''}.` : '',
  ].filter(Boolean).join(' ');

  // What an experiment's own pages do not show: per-class scores and the confusion matrix.
  const extras = (
    <>
      {(e?.per_class?.length ?? 0) > 1 && (
        <div style={{ flexShrink: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.6fr) repeat(3, minmax(0, 0.7fr)) minmax(0, 0.7fr)', gap: '2px 8px', fontSize: 13, fontVariantNumeric: 'tabular-nums', alignItems: 'baseline' }}>
            {['Class', 'AP50', 'Precision', 'Recall', 'Objects'].map((h, i) => <span key={h} style={{ fontSize: 12, color: MC.textMuted, textAlign: i ? 'right' : 'left' }}>{h}</span>)}
            {e!.per_class!.map((c) => (
              <div key={c.name} style={{ display: 'contents' }}>
                <span style={{ fontWeight: 600, color: MC.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={c.name}>{c.name}</span>
                <span style={{ textAlign: 'right' }}>{c.ap50.toFixed(2)}</span>
                <span style={{ textAlign: 'right' }}>{c.precision.toFixed(2)}</span>
                <span style={{ textAlign: 'right' }}>{c.recall.toFixed(2)}</span>
                <span style={{ textAlign: 'right', color: MC.textMuted }}>{c.instances}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {showConfusion && <Confusion tp={e!.tp!} fp={e!.fp!} tn={e!.tn!} fn={e!.fn!} />}
    </>
  );
  if (embedded) {
    return (e?.per_class?.length ?? 0) > 1 || showConfusion ? (
      <section style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: MC.text }}>{showConfusion ? 'What the classifier said' : 'By class'}</h3>
        {extras}
      </section>
    ) : null;
  }

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '10px 14px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <Tip text={failed ? 'Failed' : completed ? 'Completed' : 'Running'}>
          {failed ? <AlertCircle size={15} color="#dc2626" /> : completed ? <CheckCircle2 size={15} color="#16a34a" /> : <Loader2 size={15} className="animate-spin" color={MC.accent} />}
        </Tip>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 15, fontWeight: 700, color: MC.text }}>{label}</span>
          <span style={{ fontSize: 12, color: MC.textMuted }}>{new Date(run.created_at).toLocaleString()}{runMetrics(run) ? ` · ${runMetrics(run)}` : ''}</span>
        </div>
        <InfoTip text={[settings, extra].filter(Boolean).join(' ')} />
        {canExport && !embedded && <TrainHeadModelActions runId={run.id} result={result!} />}
      </div>

      {failed && <p style={{ margin: 0, fontSize: 13, color: '#dc2626', fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>{run.logs?.slice(0, 400) || 'The run failed.'}</p>}
      {completed && result && !result.training_triggered && <p style={{ margin: 0, fontSize: 14, color: '#dc2626' }}>{result.note || result.error || 'Not trained'}</p>}

      {stats.length > 0 && result?.multirun && (
        <span style={{ fontSize: 12, color: MC.textMuted, flexShrink: 0 }}>Kept model: seed {result.multirun.selected_seed}, test split. The mean ± std over all seeds is below.</span>
      )}
      {stats.length > 0 && <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 8, flexShrink: 0 }}>{stats}</div>}
      {!embedded && <RunHyperparameters result={result} task={taskKind} />}
      {!embedded && <RunTuningReport tuning={result?.tuning} multirun={result?.multirun} />}
      {hasCurve && <LossChart train={tr!.epoch_losses} val={tr!.val_losses} bestEpoch={tr!.best_epoch} stageAt={tr!.stages && tr!.stages.stage1_epochs > 0 && tr!.stages.stage2_epochs > 0 ? tr!.stages.stage1_epochs : undefined} />}
      {extras}
    </div>
  );
}

function DatasetBrowser({ datasetId, build }: { datasetId: string | null; build: number }) {
  const [split, setSplit] = useState<SplitFilter>('all');
  const [scaleFilter, setScaleFilter] = useState<number | 'all'>('all');
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  // `build` is part of the key so a rebuild refetches the new tiles.
  const { data, isLoading, error } = useQuery({
    queryKey: ['train-head-dataset-items', datasetId, build],
    queryFn: () => dinoApi.getDatasetItems(datasetId as string),
    enabled: !!datasetId,
  });

  useEffect(() => { setSplit('all'); setScaleFilter('all'); setLightboxIndex(null); }, [datasetId]);

  if (!datasetId) {
    return (
      <div style={{
        flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
        color: MC.textMuted, fontSize: 13, fontStyle: 'italic', padding: 20, textAlign: 'center',
      }}>
        Generate the splits above to review their tiles here before training.
      </div>
    );
  }

  if (isLoading) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, color: MC.textMuted, fontSize: 13 }}>
        <Loader2 size={12} className="animate-spin" /> Loading tiles…
      </div>
    );
  }

  if (error || !data) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#dc2626', fontSize: 13, padding: 20, textAlign: 'center' }}>
        Couldn&apos;t load this dataset&apos;s tiles (its files may have been removed from storage).
      </div>
    );
  }

  const scalesPresent = [...new Set(data.items.map((i) => i.scale_m).filter((v): v is number => v != null))].sort((a, b) => a - b);
  const byScale = scaleFilter === 'all' ? data.items : data.items.filter((i) => i.scale_m === scaleFilter);
  // Tiles in a stable order (train, eval, test), so the lightbox walks them the way the grid reads.
  const groups = SPLITS.map((k) => ({ split: k, items: byScale.filter((i) => i.split === k) })).filter((g) => split === 'all' || g.split === split);
  const shown = groups.flatMap((g) => g.items);
  const countIn = (k: SplitFilter, sc: number | 'all') =>
    data.items.filter((i) => (k === 'all' || i.split === k) && (sc === 'all' || i.scale_m === sc)).length;
  let offset = 0;

  const seg = (on: boolean, first: boolean, last: boolean): React.CSSProperties => ({
    height: 28, padding: '0 12px', fontSize: 13, fontWeight: 600, cursor: 'pointer', textTransform: 'capitalize', marginLeft: first ? 0 : -1,
    border: `1px solid ${on ? MC.accent : MC.border}`, background: on ? MC.accentDim : 'transparent', color: MC.text,
    borderRadius: first ? '6px 0 0 6px' : last ? '0 6px 6px 0' : 0,
  });

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* One quiet row: which split, and which scale when there are several. The counts are in the tooltips. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', borderBottom: `1px solid ${MC.border}`, flexShrink: 0 }}>
        <div role="group" aria-label="Split" style={{ display: 'flex' }}>
          {(['all', 'train', 'eval', 'test'] as const).map((k, i, arr) => (
            <button key={k} type="button" aria-pressed={split === k} onClick={() => setSplit(k)} title={`${countIn(k, scaleFilter)} tiles`} style={seg(split === k, i === 0, i === arr.length - 1)}>
              {k}
            </button>
          ))}
        </div>
        {scalesPresent.length > 1 && (
          <select aria-label="Scale" value={String(scaleFilter)} onChange={(e) => setScaleFilter(e.target.value === 'all' ? 'all' : Number(e.target.value))}
            style={{ height: 28, fontSize: 13, fontWeight: 600, color: MC.text, background: 'transparent', border: `1px solid ${MC.border}`, borderRadius: 6, padding: '0 6px', cursor: 'pointer' }}>
            <option value="all">All scales</option>
            {scalesPresent.map((sc) => <option key={sc} value={sc}>{sc} m ({countIn(split, sc)})</option>)}
          </select>
        )}
        <span style={{ marginLeft: 'auto', fontSize: 13, color: MC.textMuted, fontVariantNumeric: 'tabular-nums' }}>
          {shown.length} tile{shown.length === 1 ? '' : 's'}{data.truncated ? ` (first ${data.items.length})` : ''}
        </span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto', padding: '10px 14px 14px', display: 'flex', flexDirection: 'column', gap: 14 }}>
        {groups.map((g) => {
          const start = offset;
          offset += g.items.length;
          return (
            <section key={g.split} aria-label={`${g.split} tiles`}>
              {split === 'all' && (
                <h3 style={{ margin: '0 0 6px', fontSize: 13, fontWeight: 700, color: MC.textMuted, textTransform: 'capitalize' }}>
                  {g.split} <span style={{ fontWeight: 500, color: MC.textMuted }}>· {g.items.length} tile{g.items.length === 1 ? '' : 's'}</span>
                </h3>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 10, alignContent: 'start' }}>
                {g.items.map((item, i) => (
                  <ImageTile key={item.item_id + item.image_key} datasetId={datasetId} item={item} onClick={() => setLightboxIndex(start + i)} />
                ))}
                {g.items.length === 0 && <p style={{ gridColumn: '1 / -1', fontSize: 14, color: MC.textMuted, fontStyle: 'italic', margin: 0 }}>No tiles{scaleFilter !== 'all' ? ` at ${scaleFilter} m` : ''}.</p>}
              </div>
            </section>
          );
        })}
      </div>

      {lightboxIndex !== null && shown[lightboxIndex] && (
        <Lightbox
          datasetId={datasetId}
          items={shown}
          index={lightboxIndex}
          onIndexChange={setLightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
}

/** The label shown on a tile: how many objects it holds, or whether the class is present. */
function tileBadge(item: DinoDatasetItem): string | null {
  if (item.polygons) return `${item.polygons.length} mask${item.polygons.length === 1 ? '' : 's'}`;
  if (item.box_count != null) return `${item.box_count} box${item.box_count === 1 ? '' : 'es'}`;
  return item.label != null ? (item.label ? 'positive' : 'negative') : null;
}

/** Object outlines (flat normalized polygons) drawn over a tile image. */
function Outlines({ polygons, width }: { polygons?: number[][] | null; width: number }) {
  if (!polygons?.length) return null;
  return (
    <svg viewBox="0 0 1 1" preserveAspectRatio="none" aria-hidden style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
      {polygons.map((flat, i) => (
        <polygon
          key={i}
          points={flat.reduce<string[]>((acc, v, k) => (k % 2 === 0 ? [...acc, `${v},${flat[k + 1]}`] : acc), []).join(' ')}
          fill="rgba(34,197,94,0.22)" stroke="#22c55e" strokeWidth={width} vectorEffect="non-scaling-stroke" strokeLinejoin="round"
        />
      ))}
    </svg>
  );
}

function ImageTile({ datasetId, item, onClick }: { datasetId: string; item: DinoDatasetItem; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  const badge = tileBadge(item);
  const isNegative = item.box_count === 0 || item.label === 0;
  const showBadge = !!badge && (!item.polygons || hover);

  return (
    <button
      type="button"
      onClick={onClick}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      style={{
        position: 'relative', aspectRatio: '1', borderRadius: 6, overflow: 'hidden',
        border: `1px solid ${MC.border}`, padding: 0, cursor: 'pointer', background: MC.inputBg ?? '#1e2518',
      }}
      title={`${item.split} · ${badge ?? ''}${item.scale_m ? ` · ${item.scale_m} m` : ''}`}
    >
      <AuthedImg
        datasetId={datasetId} imageKey={item.image_key} alt={badge ?? item.split}
        style={{ width: '100%', height: '100%', objectFit: item.polygons ? 'fill' : 'cover', display: 'block' }}
      />
      <Outlines polygons={item.polygons} width={1.5} />
      {hover && item.scale_m != null && (
        <span style={{ position: 'absolute', top: 6, left: 6, fontSize: 12, fontWeight: 700, padding: '2px 6px', borderRadius: 4, background: 'rgba(0,0,0,0.6)', color: '#fff' }}>
          {item.scale_m} m
        </span>
      )}
      {showBadge && (
        <span style={{
          position: 'absolute', bottom: 6, left: 6, right: 6,
          fontSize: 13, fontWeight: 700, padding: '2px 6px', borderRadius: 4,
          background: isNegative ? 'rgba(0,0,0,0.65)' : 'rgba(22,163,74,0.85)',
          color: '#fff', textAlign: 'center', textOverflow: 'ellipsis', overflow: 'hidden', whiteSpace: 'nowrap',
        }}>
          {badge}
        </span>
      )}
    </button>
  );
}

function Lightbox({
  datasetId, items, index, onIndexChange, onClose,
}: {
  datasetId: string; items: DinoDatasetItem[]; index: number;
  onIndexChange: (i: number) => void; onClose: () => void;
}) {
  const item = items[index];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'ArrowLeft') onIndexChange((index - 1 + items.length) % items.length);
      if (e.key === 'ArrowRight') onIndexChange((index + 1) % items.length);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [index, items.length, onIndexChange, onClose]);

  if (!item) return null;

  const badge = tileBadge(item);

  return (
    <div
      onClick={onClose}
      style={{
        position: 'absolute', inset: 0, zIndex: 10,
        background: 'rgba(0,0,0,0.85)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}
    >
      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onIndexChange((index - 1 + items.length) % items.length); }}
        style={{ position: 'absolute', left: 10, background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 8 }}
      >
        <ChevronLeft size={22} />
      </button>

      <div onClick={(e) => e.stopPropagation()} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, maxHeight: '92%', maxWidth: '92%' }}>
        {/* position:relative + inline-block shrink-wraps exactly to the
            <img>'s own rendered box (no fixed width/height forcing a
            stretch — maxWidth/maxHeight alone preserve aspect), so the
            percentage-positioned box overlays line up with the image
            regardless of its final on-screen size. */}
        <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', maxHeight: '82vh' }}>
          <AuthedImg
            datasetId={datasetId} imageKey={item.image_key} alt={badge ?? item.split}
            style={{ display: 'block', maxWidth: '82vw', maxHeight: '82vh', borderRadius: 4 }}
          />
          <Outlines polygons={item.polygons} width={2} />
          {!item.polygons && item.boxes?.map(([cx, cy, w, h], i) => (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: `${Math.max(0, (cx - w / 2) * 100)}%`,
                top: `${Math.max(0, (cy - h / 2) * 100)}%`,
                width: `${Math.min(100, w * 100)}%`,
                height: `${Math.min(100, h * 100)}%`,
                border: '2px solid #22c55e',
                boxShadow: '0 0 0 1px rgba(0,0,0,0.6)',
                pointerEvents: 'none',
              }}
            />
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#fff', fontSize: 12 }}>
          <span style={{ textTransform: 'capitalize', fontWeight: 700 }}>{item.split}</span>
          {badge && <span style={{ color: '#ccc' }}>· {badge}</span>}
          {item.scale_m ? <span style={{ color: '#ccc' }}>· {item.scale_m} m tile</span> : null}
          <span style={{ color: '#888' }}>· {index + 1} / {items.length}</span>
        </div>
      </div>

      <button
        type="button"
        onClick={(e) => { e.stopPropagation(); onIndexChange((index + 1) % items.length); }}
        style={{ position: 'absolute', right: 10, background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 8 }}
      >
        <ChevronRight size={22} />
      </button>

      <button
        type="button"
        onClick={onClose}
        style={{ position: 'absolute', top: 10, right: 10, background: 'transparent', border: 'none', color: '#fff', cursor: 'pointer', padding: 8 }}
      >
        <X size={18} />
      </button>
    </div>
  );
}
