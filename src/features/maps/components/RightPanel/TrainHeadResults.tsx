'use client';

import { Fragment, useMemo, useState } from 'react';
import { AlertCircle, Check, CheckCircle2, ChevronLeft, ChevronRight, Copy, Loader2, Trophy } from 'lucide-react';
import { toast } from 'sonner';
import type { DinoFinetuneJobRead, DinoFinetuneResult, DinoMultirunReport, DinoTuningSummary } from '@/lib/api/dino';
import { MC } from '../../mapColors';
import { InfoTip } from './PanelControls';
import { LossChart, SeedCurves, TrialsChart } from './TrainHeadCharts';
import { TrainHeadModelActions } from './TrainHeadModelExport';
import { METRIC_LABEL, describeParams } from './TrainHeadTuning';

/*
 * Results of Train Head, two levels:
 *   experiment = one training job (a plain run, or an auto-tuned one that also did several final runs);
 *   run        = what is inside it: the final runs (Trial 1..N, each with its own random seed), and the hyperparameter search.
 * One dropdown picks the experiment (history). A second one picks the page inside it (Summary, search, Trial N), with
 * arrows to step. There are no tabs: the dropdown is the only run picker.
 */

type RenderRun = (run: DinoFinetuneJobRead, label: string, embedded: boolean) => React.ReactNode;

const TASK_NAME: Record<string, string> = { detect: 'Detector', classify: 'Classifier', segment: 'Segmenter', yolo: 'YOLO detector' };
const SOURCE_NAME: Record<string, string> = { manual: 'set by hand', auto_tuned: 'auto-tuned', saved_config: 'saved tuned config' };
/** Metrics shown per task, headline first. */
const KEYS: Record<string, string[]> = {
  classify: ['f1', 'accuracy', 'precision', 'recall'],
  detect: ['ap50', 'precision', 'recall', 'mean_iou_tp'],
  segment: ['ap50', 'precision', 'recall', 'mean_iou_tp', 'pixel_iou', 'dice'],
  yolo: ['ap50', 'map', 'precision', 'recall'],
};

const f3 = (v: number | null | undefined) => (v == null ? '–' : v.toFixed(3));
const ms = (mean: number | null | undefined, std: number | null | undefined) => (mean == null ? '–' : `${mean.toFixed(3)} ± ${(std ?? 0).toFixed(3)}`);

/** One experiment, flattened into what the dropdown and the pages show. */
interface Experiment {
  run: DinoFinetuneJobRead;
  /** 1 = the oldest. */
  n: number;
  result: DinoFinetuneResult | undefined;
  task: string;
  keys: string[];
  done: boolean;
  failed: boolean;
  running: boolean;
  lead: number | null;
  leadStd: number | null;
  when: string;
}

/** One run inside an experiment: a seed of a multi-seed experiment, or the only run of a plain one. */
interface Entry {
  seed: number | null;
  kept: boolean;
  metrics: Record<string, number | null>;
  valLoss: number | null;
  bestEpoch: number | null;
  train: number[] | null;
  val: number[] | null;
}

function toExperiment(run: DinoFinetuneJobRead, n: number): Experiment {
  const result = run.config?.result;
  const task = result?.task ?? run.config?.request?.task ?? 'detect';
  const keys = KEYS[task] ?? KEYS.detect;
  const e = result?.eval_result as Record<string, number | null | undefined> | undefined;
  const summary = result?.multirun?.summary?.[keys[0]];
  return {
    run, n, result, task, keys,
    done: run.status === 'completed' && !!result?.training_triggered,
    failed: run.status === 'failed',
    running: run.status !== 'completed' && run.status !== 'failed',
    lead: summary && summary.n > 0 ? summary.mean : e?.[keys[0]] ?? null,
    leadStd: summary && summary.n > 1 ? summary.std : null,
    when: new Date(run.created_at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).replace(',', ''),
  };
}

function entriesOf(x: Experiment): Entry[] {
  const tr = x.result?.train_result;
  const mr = x.result?.multirun;
  if (mr) {
    return mr.runs.map((r) => {
      const kept = r.seed === mr.selected_seed;
      // Experiments from before the per-seed curves were stored still have the kept model's curves.
      return {
        seed: r.seed, kept, metrics: r.metrics, valLoss: r.best_val_loss, bestEpoch: r.best_epoch,
        train: r.epoch_losses ?? (kept ? tr?.epoch_losses ?? null : null), val: r.val_losses ?? (kept ? tr?.val_losses ?? null : null),
      };
    });
  }
  const e = x.result?.eval_result as Record<string, number | null | undefined> | undefined;
  return [{
    seed: null, kept: true, metrics: Object.fromEntries(x.keys.map((k) => [k, e?.[k] ?? null])),
    valLoss: tr?.best_val_loss ?? null, bestEpoch: tr?.best_epoch ?? null, train: tr?.epoch_losses ?? null, val: tr?.val_losses ?? null,
  }];
}

/** The 1-based number a final run is shown with (its random seed is a separate detail). */
function trialNo(mr: DinoMultirunReport | null | undefined, seed: number): number {
  const i = mr?.runs.findIndex((r) => r.seed === seed) ?? -1;
  return i < 0 ? seed + 1 : i + 1;
}

function statusIcon(x: Experiment, size = 14) {
  return x.failed ? <AlertCircle size={size} color="#dc2626" /> : x.running ? <Loader2 size={size} className="animate-spin" color={MC.accent} /> : <CheckCircle2 size={size} color="#16a34a" />;
}

function optionText(x: Experiment): string {
  if (x.failed) return `${x.n} · ${x.when} · failed`;
  if (x.running) return `${x.n} · ${x.when} · running`;
  const label = METRIC_LABEL[x.keys[0]] ?? x.keys[0];
  const seeds = x.result?.multirun?.n_runs ?? 0;
  return `${x.n} · ${x.when}${seeds > 1 ? ` · ${seeds} runs` : ''}${x.lead != null ? ` · ${label} ${x.lead.toFixed(3)}` : ''}`;
}

const control: React.CSSProperties = {
  height: 32, minWidth: 0, fontSize: 13, fontWeight: 500, color: MC.text, background: MC.inputBg ?? 'transparent',
  border: `1px solid ${MC.border}`, borderRadius: 6, padding: '0 10px', cursor: 'pointer',
};
const heading: React.CSSProperties = { margin: 0, fontSize: 14, fontWeight: 700, color: MC.text, lineHeight: 1.3 };
const muted: React.CSSProperties = { margin: 0, fontSize: 12, color: MC.textMuted, lineHeight: 1.45 };
const page: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: 'auto', padding: '18px 18px 24px', display: 'flex', flexDirection: 'column', gap: 26 };

function Section({ title, hint, right, children }: { title: string; hint?: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12, minWidth: 0 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <h3 style={heading}>{title}</h3>
        {hint && <span style={muted}>{hint}</span>}
        <span style={{ flex: 1 }} />
        {right}
      </div>
      {children}
    </section>
  );
}

/** The whole results area: pick an experiment from the history, then a page inside it. */
export function ResultsPane({ runs, loading, expId, onExp, renderRun }: {
  runs: DinoFinetuneJobRead[] | undefined;
  loading: boolean;
  /** The chosen experiment; null = the newest. */
  expId: string | null;
  onExp: (id: string) => void;
  /** One run's full detail page. ``embedded`` renders only what the experiment pages do not already show (per-class table, confusion matrix). */
  renderRun: RenderRun;
}) {
  const list = useMemo(() => (runs ?? []).map((r, i, all) => toExperiment(r, all.length - i)), [runs]);
  if (loading) return <p style={{ ...muted, padding: 18, fontSize: 13 }}>Loading…</p>;
  if (list.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: MC.textMuted, fontSize: 14 }}>
        Train a model and its results appear here.
      </div>
    );
  }
  const active = list.find((x) => x.run.id === expId) ?? list[0];
  return (
    <div style={{ flex: 1, minHeight: 460, display: 'flex', flexDirection: 'column' }}>
      <ExperimentView key={active.run.id} x={active} list={list} onExp={onExp} renderRun={renderRun} />
    </div>
  );
}

interface PageDef { id: string; label: string; group: 'Overview' | 'Runs' }

function ExperimentView({ x, list, onExp, renderRun }: { x: Experiment; list: Experiment[]; onExp: (id: string) => void; renderRun: RenderRun }) {
  const [current, setCurrent] = useState('summary');
  const mr = x.result?.multirun ?? null;
  const tuning = x.result?.tuning ?? null;
  const canExport = x.done && !!x.result?.train_result?.artifact_key;

  const pages: PageDef[] = x.done
    ? [
        { id: 'summary', label: 'Summary', group: 'Overview' },
        ...(tuning?.trials?.length ? [{ id: 'tuning', label: 'Hyperparameter search trials', group: 'Overview' as const }] : []),
        ...(mr?.runs.map((r, i) => ({ id: `seed:${r.seed}`, label: `Trial ${i + 1}${r.seed === mr.selected_seed ? ' · best' : ''}`, group: 'Runs' as const })) ?? []),
      ]
    : [];
  const index = Math.max(0, pages.findIndex((p) => p.id === current));
  const go = (i: number) => pages[i] && setCurrent(pages[i].id);

  return (
    <>
      <header style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8, padding: '12px 16px', borderBottom: `1px solid ${MC.border}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {(x.failed || x.running) && statusIcon(x, 16)}
          <select aria-label="Experiment" value={x.run.id} onChange={(e) => onExp(e.target.value)} style={{ ...control, flex: 1 }}>
            {list.map((e) => <option key={e.run.id} value={e.run.id}>{`Exp. ${optionText(e)}`}</option>)}
          </select>
        </div>
        {(pages.length > 1 || canExport) && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
            {pages.length > 1 && (
              <>
                <StepButton label="Previous page" disabled={index === 0} onClick={() => go(index - 1)}><ChevronLeft size={16} /></StepButton>
                <select aria-label="Page of this experiment" value={pages[index].id} onChange={(e) => setCurrent(e.target.value)} style={{ ...control, flex: 1 }}>
                  {(['Overview', 'Runs'] as const).map((g) => {
                    const opts = pages.filter((p) => p.group === g);
                    return opts.length ? (
                      <optgroup key={g} label={g}>{opts.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}</optgroup>
                    ) : null;
                  })}
                </select>
                <StepButton label="Next page" disabled={index === pages.length - 1} onClick={() => go(index + 1)}><ChevronRight size={16} /></StepButton>
              </>
            )}
            {/* The model of the page you are on: the kept one on the summary, that seed's on a seed page. */}
            {canExport && (() => {
              const seed = pages[index]?.id.startsWith('seed:') ? Number(pages[index].id.slice(5)) : undefined;
              const best = mr?.selected_seed;
              return (
                <TrainHeadModelActions
                  runId={x.run.id} result={x.result!} seed={seed} label={seed != null ? `Export trial ${trialNo(mr, seed)}` : 'Export'}
                  title={seed != null ? `Export the model of trial ${trialNo(mr, seed)}` : `Export the best run's model${best != null ? ` (trial ${trialNo(mr, best)})` : ''}`}
                />
              );
            })()}
          </div>
        )}
      </header>

      {!x.done ? (
        // Still running, or failed: the run's own state, nothing to summarise yet.
        renderRun(x.run, `Experiment ${x.n}`, false)
      ) : pages[index].id === 'tuning' && tuning ? (
        <TuningPage tuning={tuning} />
      ) : pages[index].id.startsWith('seed:') && mr ? (
        <SeedPage key={pages[index].id} x={x} mr={mr} seed={Number(pages[index].id.slice(5))} renderRun={renderRun} />
      ) : (
        <SummaryPage x={x} mr={mr} tuning={tuning} onBest={() => mr && setCurrent(`seed:${mr.selected_seed}`)} onTuning={() => setCurrent('tuning')} renderRun={renderRun} />
      )}
    </>
  );
}

function StepButton({ label, disabled, onClick, children }: { label: string; disabled: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button" aria-label={label} title={label} disabled={disabled} onClick={onClick}
      style={{ ...control, width: 32, padding: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', opacity: disabled ? 0.4 : 1, cursor: disabled ? 'default' : 'pointer' }}
    >
      {children}
    </button>
  );
}

function SummaryPage({ x, mr, tuning, onBest, onTuning, renderRun }: {
  x: Experiment; mr: DinoMultirunReport | null; tuning: DinoTuningSummary | null; onBest: () => void; onTuning: () => void; renderRun: RenderRun;
}) {
  const [copied, setCopied] = useState(false);
  const entries = useMemo(() => entriesOf(x), [x]);
  const hp = x.result?.hyperparameters;
  const stages = x.result?.train_result?.stages ?? hp?.stages;
  const seconds = x.result?.timings?.total_seconds;
  const series = entries.filter((e) => e.val && e.val.length > 1).map((e) => ({ id: String(e.seed ?? 'run'), label: e.seed != null ? `Trial ${trialNo(mr, e.seed)}` : 'Run', values: e.val!, kept: e.kept }));
  const single = entries[0];
  const present = x.keys.filter((k) => entries.some((e) => e.metrics[k] != null));
  const shown = present.slice(0, 3);
  const more = present.slice(3);

  const sentence = [
    TASK_NAME[x.task],
    hp?.backbone,
    mr ? `${mr.n_runs} runs` : 'single run',
    hp?.source ? SOURCE_NAME[hp.source] : null,
    seconds != null ? (seconds >= 90 ? `${(seconds / 60).toFixed(1)} min` : `${Math.round(seconds)} s`) : null,
  ].filter(Boolean).join(' · ');

  const setting = (label: string, value: string) => (
    <div key={label} style={{ display: 'contents' }}>
      <dt style={{ color: MC.textMuted }}>{label}</dt>
      <dd style={{ margin: 0, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{value}</dd>
    </div>
  );
  const rate = (v: number | undefined) => (v == null ? '–' : v >= 0.01 ? v.toFixed(3) : v.toExponential(1));

  const copyTable = async () => {
    if (!mr) return;
    const head = ['Trial', 'Seed', 'Val loss', ...x.keys.map((k) => METRIC_LABEL[k] ?? k)];
    const lines = entries.map((e, i) => [i + 1, e.seed, f3(e.valLoss), ...x.keys.map((k) => f3(e.metrics[k]))].join('\t'));
    const mean = ['Mean ± std', '', ms(mr.best_val_loss.mean, mr.best_val_loss.std), ...x.keys.map((k) => ms(mr.summary[k]?.mean, mr.summary[k]?.std))].join('\t');
    try {
      await navigator.clipboard.writeText([head.join('\t'), ...lines, mean].join('\n'));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };

  return (
    <div style={page}>
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <h2 style={{ margin: 0, flex: 1, minWidth: 0, fontSize: 18, fontWeight: 700, color: MC.text, lineHeight: 1.25 }}>Experiment {x.n}</h2>
          {mr && (
            <button
              type="button" onClick={onBest}
              style={{ flexShrink: 0, display: 'inline-flex', alignItems: 'center', gap: 6, height: 32, padding: '0 12px 0 10px', borderRadius: 6, border: `1px solid ${MC.accent}`, background: MC.accent, color: MC.text, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}
            >
              <Trophy size={14} /> View best run
            </button>
          )}
        </div>
        <p style={{ ...muted, fontSize: 13 }}>{sentence}</p>
      </div>

      {(series.length > 0 || (single?.train && single.train.length > 1)) && (
        <Section title={mr ? (series.length > 1 ? 'Validation loss by trial' : 'Validation loss (best run)') : 'Training curve'}>
          {mr ? <SeedCurves series={series} /> : <LossChart train={single!.train!} val={single!.val ?? undefined} bestEpoch={single!.bestEpoch ?? undefined} stageAt={stages && stages.stage1_epochs > 0 && stages.stage2_epochs > 0 ? stages.stage1_epochs : undefined} />}
        </Section>
      )}

      <Section
        title="Test results"
        hint={mr ? `mean ± std over ${mr.n_runs} runs` : 'single run'}
        right={mr ? (
          <button type="button" onClick={copyTable} aria-label="Copy the table for a spreadsheet" title="Copy as tab-separated text" style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: MC.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 2 }}>
            {copied ? <Check size={13} /> : <Copy size={13} />} Copy
          </button>
        ) : undefined}
      >
        <RunsTable x={x} entries={entries} mr={mr} cols={shown} />
        {more.length > 0 && (
          <details>
            <summary style={{ fontSize: 13, fontWeight: 600, color: MC.text, cursor: 'pointer', padding: '2px 0 8px' }}>All metrics ({more.length} more)</summary>
            <RunsTable x={x} entries={entries} mr={mr} cols={more} showLoss={false} />
          </details>
        )}
        {mr && (
          <p style={muted}>
            Report the Mean ± std row. The best run is Trial {trialNo(mr, mr.selected_seed)} (lowest validation loss, not best test score): its model is the one Export gives, and View best run opens it.
          </p>
        )}
      </Section>

      <Section title="Settings">
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '6px 18px', fontSize: 13 }}>
          {hp && setting(x.task === 'yolo' ? 'Started from' : 'Model', hp.backbone ?? '–')}
          {hp && stages
            ? <>
                {setting('Stage 1', stages.stage1_epochs > 0 ? `${stages.stage1_epochs} epochs · rate ${rate(stages.stage1_lr)} · ${stages.frozen_layers} layers frozen` : 'off')}
                {setting('Stage 2', stages.stage2_epochs > 0 ? `${stages.stage2_epochs} epochs · rate ${rate(stages.stage2_lr)} · all layers` : 'off')}
              </>
            : hp && <>
                {setting('Learning rate', rate(hp.lr))}
                {setting('Epochs', String(hp.epochs))}
                {hp.weight_decay != null && setting('Weight decay', rate(hp.weight_decay))}
              </>}
          {mr && setting('Random seeds', mr.seeds.join(', '))}
          {tuning && setting('Search', tuning.cache_hit ? 'reused the saved config' : `${tuning.n_trials ?? '?'} trials${tuning.best_value != null ? ` · best validation loss ${tuning.best_value.toFixed(3)}` : ''}`)}
        </dl>
        {tuning?.trials?.length ? (
          <button type="button" onClick={onTuning} style={{ alignSelf: 'flex-start', background: 'none', border: 'none', padding: 0, color: MC.text, fontSize: 13, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 3 }}>
            See the search trials
          </button>
        ) : null}
      </Section>

      {/* Per-class table and confusion matrix of the kept model. */}
      {renderRun(x.run, `Experiment ${x.n}`, true)}
    </div>
  );
}

const th = (left = false): React.CSSProperties => ({ textAlign: left ? 'left' : 'right', padding: '7px 6px', fontSize: 12, fontWeight: 600, color: MC.textMuted, whiteSpace: 'nowrap' });
const tdBase: React.CSSProperties = { padding: '8px 6px', textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

function RunsTable({ x: _x, entries, mr, cols, showLoss = true, only }: { x: Experiment; entries: Entry[]; mr: DinoMultirunReport | null; cols: string[]; showLoss?: boolean; only?: { trial: number } }) {
  // The mean with its standard deviation under it, so a narrow column still holds both.
  const meanCell = (mean: number | null | undefined, std: number | null | undefined, muted = false) => (
    <td style={{ ...tdBase, color: muted ? MC.textMuted : MC.text, fontWeight: muted ? 500 : 700, whiteSpace: 'nowrap' }}>
      <div>{f3(mean)}</div>
      <div style={{ fontSize: 11, fontWeight: 500, color: MC.textMuted }}>± {f3(std)}</div>
    </td>
  );
  return (
    <div style={{ overflowX: 'auto', border: `1px solid ${MC.border}`, borderRadius: 8 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
        <thead>
          <tr style={{ background: MC.accentDim }}>
            <th scope="col" style={th(true)}>{mr ? 'Trial' : 'Run'}</th>
            {showLoss && <th scope="col" style={th()}>Val loss</th>}
            {cols.map((k) => <th key={k} scope="col" style={th()}>{METRIC_LABEL[k] ?? k}</th>)}
          </tr>
        </thead>
        <tbody>
          {entries.map((e, i) => (
            <tr key={e.seed ?? 'run'} style={{ borderTop: `1px solid ${MC.border}`, background: mr && e.kept && !only ? MC.accentDim : 'transparent' }}>
              <td style={{ ...tdBase, textAlign: 'left', fontWeight: 600, color: MC.text }}>
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{mr && e.kept && !only && <Trophy size={12} color={MC.accent} />}{only ? only.trial : mr ? i + 1 : 'Final'}</span>
              </td>
              {showLoss && <td style={{ ...tdBase, color: MC.textMuted }}>{f3(e.valLoss)}</td>}
              {cols.map((k, i) => <td key={k} style={{ ...tdBase, color: MC.text, fontWeight: i === 0 ? 700 : 400 }}>{f3(e.metrics[k])}</td>)}
            </tr>
          ))}
        </tbody>
        {mr && !only && (
          <tfoot>
            <tr style={{ borderTop: `2px solid ${MC.border}` }}>
              <td style={{ ...tdBase, textAlign: 'left', fontWeight: 700, color: MC.text, whiteSpace: 'nowrap', verticalAlign: 'top' }}>
                <div>Mean</div>
                <div style={{ fontSize: 11, fontWeight: 500, color: MC.textMuted }}>± std</div>
              </td>
              {showLoss && meanCell(mr.best_val_loss.mean, mr.best_val_loss.std, true)}
              {cols.map((k) => <Fragment key={k}>{meanCell(mr.summary[k]?.mean, mr.summary[k]?.std)}</Fragment>)}
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

function SeedPage({ x, mr, seed, renderRun }: { x: Experiment; mr: DinoMultirunReport; seed: number; renderRun: RenderRun }) {
  const entries = useMemo(() => entriesOf(x), [x]);
  const index = entries.findIndex((e) => e.seed === seed);
  const entry = entries[index];
  if (!entry || !x.result) return <div style={page}><p style={muted}>This run is not in the report.</p></div>;
  const present = x.keys.filter((k) => entries.some((e) => e.metrics[k] != null));
  const shown = present.slice(0, 3);
  const more = present.slice(3);
  const only = [entry];
  const hp = x.result.hyperparameters;
  const stages = x.result.train_result?.stages ?? hp?.stages;
  const rate = (v: number | undefined) => (v == null ? '–' : v >= 0.01 ? v.toFixed(3) : v.toExponential(1));
  const row = (label: string, value: string) => (
    <div key={label} style={{ display: 'contents' }}>
      <dt style={{ color: MC.textMuted }}>{label}</dt>
      <dd style={{ margin: 0, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{value}</dd>
    </div>
  );
  return (
    <div style={page}>
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: MC.text, lineHeight: 1.25, display: 'flex', alignItems: 'center', gap: 8 }}>
          Trial {index + 1}
          {entry.kept && <Trophy size={15} color={MC.accent} aria-label="Best run" />}
        </h2>
        <p style={{ ...muted, fontSize: 13 }}>{entry.kept ? 'Best run of this experiment: the lowest validation loss.' : 'One of the final runs with the best hyperparameters.'}</p>
      </div>

      <Section title="Test results">
        <RunsTable x={x} entries={only} mr={mr} cols={shown} only={{ trial: index + 1 }} />
        {more.length > 0 && (
          <details>
            <summary style={{ fontSize: 13, fontWeight: 600, color: MC.text, cursor: 'pointer', padding: '2px 0 8px' }}>All metrics ({more.length} more)</summary>
            <RunsTable x={x} entries={only} mr={mr} cols={more} showLoss={false} only={{ trial: index + 1 }} />
          </details>
        )}
      </Section>

      <Section title="Training curve">
        {entry.train && entry.train.length > 1 ? (
          <LossChart train={entry.train} val={entry.val ?? undefined} bestEpoch={entry.bestEpoch ?? undefined} />
        ) : (
          <p style={muted}>The loss curve was not saved for this run.</p>
        )}
      </Section>

      <Section title="Settings">
        <dl style={{ margin: 0, display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '6px 18px', fontSize: 13 }}>
          {hp && !stages && row('Learning rate', rate(hp.lr))}
          {hp && !stages && row('Epochs trained', String(hp.epochs))}
          {hp && !stages && hp.weight_decay != null && row('Weight decay', rate(hp.weight_decay))}
          {stages && row('Stage 1', stages.stage1_epochs > 0 ? `${stages.stage1_epochs} epochs · rate ${rate(stages.stage1_lr)}` : 'off')}
          {stages && row('Stage 2', stages.stage2_epochs > 0 ? `${stages.stage2_epochs} epochs · rate ${rate(stages.stage2_lr)}` : 'off')}
          {row('Random seed', String(seed))}
          {entry.bestEpoch != null && row('Best epoch', String(entry.bestEpoch))}
          {entry.valLoss != null && row('Validation loss', entry.valLoss.toFixed(3))}
        </dl>
      </Section>

      {entry.kept && renderRun(x.run, `Trial ${index + 1}`, true)}
    </div>
  );
}

const SHORT: Record<string, string> = { lr: 'lr', weight_decay: 'wd', epochs: 'ep', stage1_lr: 'lr1', stage2_lr: 'lr2' };
function shortParams(params: Record<string, number>, bestEpoch?: number | null, epochsRun?: number | null, prunedAt?: number | null): string {
  const parts = Object.entries(params).map(([k, v]) => `${SHORT[k] ?? k} ${k === 'epochs' ? Math.round(v) : v >= 0.01 ? v.toFixed(3) : v.toExponential(1)}`);
  if (prunedAt != null) parts.push(`cut short at epoch ${prunedAt}`);
  else if (bestEpoch != null) parts.push(`best epoch ${bestEpoch}${epochsRun != null && epochsRun > bestEpoch ? ` (stopped at ${epochsRun})` : ''}`);
  return parts.join(' · ');
}

function fixedText(fixed: Record<string, number> | undefined): string {
  if (!fixed) return '';
  if (fixed.max_epochs != null) return `A trial trains up to ${fixed.max_epochs} epochs and stops once validation loss has not improved for ${fixed.patience ?? 15} epochs, keeping its best epoch; trials clearly behind the others are cut short. The best trial's epoch is the epochs of the final runs.`;
  if (fixed.epochs != null) return `Every trial trains for ${fixed.epochs} epochs; only the learning rate and weight decay change.`;
  if (fixed.stage1_epochs != null) return `Every trial uses ${fixed.stage1_epochs} + ${fixed.stage2_epochs} epochs; only the learning rates change.`;
  return '';
}

function TuningPage({ tuning }: { tuning: DinoTuningSummary }) {
  const trials = tuning.trials ?? [];
  return (
    <div style={page}>
      <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: MC.text, lineHeight: 1.25 }}>Hyperparameter search</h2>
        <p style={{ ...muted, fontSize: 13 }}>
          {tuning.cache_hit
            ? 'Found earlier for this dataset and model, and reused: no new search.'
            : `${trials.length} trials, one after the other, each a full training run scored on the validation split, never the test split. ${fixedText(tuning.fixed)}`}
        </p>
      </div>

      <Section title="Chosen settings" right={<InfoTip size={12} text="The trial with the lowest validation loss. Trial 0 is the starting values, so the search can never end worse than not tuning." />}>
        <p style={{ margin: 0, fontSize: 15, fontWeight: 700, color: MC.text }}>{describeParams(tuning.best_params) || 'No parameters changed'}</p>
      </Section>

      <Section title="Validation loss by trial">
        <TrialsChart trials={trials} bestTrial={tuning.best_trial} />
      </Section>

      {trials.length > 0 && (
        <Section title="All trials">
          <div style={{ overflowX: 'auto', border: `1px solid ${MC.border}`, borderRadius: 8 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
              <thead>
                <tr style={{ background: MC.accentDim }}>
                  <th scope="col" style={th(true)}>Trial</th>
                  <th scope="col" style={th(true)}>Settings</th>
                  <th scope="col" style={th()}>Val loss</th>
                </tr>
              </thead>
              <tbody>
                {trials.map((t) => {
                  const best = t.number === tuning.best_trial;
                  return (
                    <tr key={t.number} style={{ borderTop: `1px solid ${MC.border}`, background: best ? MC.accentDim : 'transparent' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600, color: MC.text, whiteSpace: 'nowrap' }}>
                        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>{best && <Trophy size={12} color={MC.accent} />}{t.number}{t.number === 0 ? ' (start)' : ''}</span>
                      </td>
                      <td style={{ padding: '8px 10px', color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{shortParams(t.params, t.best_epoch, t.epochs_run, t.pruned_at)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                        <div style={{ fontWeight: best ? 700 : 400, color: t.value != null ? MC.text : MC.textMuted }}>{t.value != null ? t.value.toFixed(4) : t.pruned_at != null ? 'cut short' : '–'}</div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Section>
      )}
    </div>
  );
}
