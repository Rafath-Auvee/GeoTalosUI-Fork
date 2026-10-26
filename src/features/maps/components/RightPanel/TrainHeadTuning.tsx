'use client';

import { useState } from 'react';
import { Copy, Check, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import type { DinoFinetuneResult, DinoMultirunReport, DinoTunedConfig, DinoTuningSummary } from '@/lib/api/dino';
import { MC } from '../../mapColors';
import { InfoTip } from './PanelControls';

/** Auto-tune and repeated-run choices in the Train block. Seeds are 0..count-1. */
export interface TuneOptions {
  autoTune: boolean;
  nTrials: number;
  /** Search again even though this dataset + model already has a saved config. */
  retune: boolean;
  multiRun: boolean;
  /** 3 to 5 */
  seedCount: number;
}

export const DEFAULT_TUNE: TuneOptions = { autoTune: true, nTrials: 6, retune: false, multiRun: true, seedCount: 5 };

/** The most epochs one search trial may train (the DINOv2 heads); mirrors EPOCH_CAP in geoops-service/app/tuning.py. */
export const SEARCH_MAX_EPOCHS = 120;

export const MIN_SEEDS = 3;
export const MAX_SEEDS = 5;

/** The fields POST /dino/finetune takes for these options. */
export function tunePayload(o: TuneOptions) {
  return {
    ...(o.autoTune ? { auto_tune: true, n_trials: o.nTrials, force_retune: o.retune } : {}),
    ...(o.multiRun ? { seeds: Array.from({ length: o.seedCount }, (_, i) => i) } : {}),
  };
}

export const METRIC_LABEL: Record<string, string> = {
  ap50: 'AP50', map: 'mAP50-95', precision: 'Precision', recall: 'Recall', f1: 'F1', accuracy: 'Accuracy',
  mean_iou_tp: 'Mean IoU', pixel_iou: 'Pixel IoU', dice: 'Dice',
};
const PARAM_LABEL: Record<string, string> = {
  lr: 'learning rate', weight_decay: 'weight decay', epochs: 'epochs', stage1_lr: 'stage 1 rate', stage2_lr: 'stage 2 rate',
};

function fmtParam(key: string, v: number): string {
  if (key === 'epochs') return String(Math.round(v));
  return v >= 0.01 ? v.toFixed(3) : v.toExponential(1);
}

export function describeParams(params: Record<string, number>): string {
  return Object.entries(params).map(([k, v]) => `${PARAM_LABEL[k] ?? k} ${fmtParam(k, v)}`).join(' · ');
}

const labelRow: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: MC.text, cursor: 'pointer' };
const smallInput: React.CSSProperties = {
  width: 52, padding: '2px 5px', borderRadius: 5, border: `1px solid ${MC.border}`, background: MC.inputBg ?? '#1e2518', color: MC.text, fontSize: 13,
};
const note: React.CSSProperties = { fontSize: 12, color: MC.textMuted, margin: 0, lineHeight: 1.4 };

/** Two switches under the training fields: pick the hyperparameters automatically, and repeat the run over several seeds. */
export function TuningOptions({ value, onChange, saved, onForget, forgetting, yolo, disabled }: {
  value: TuneOptions;
  onChange: (v: TuneOptions) => void;
  /** This dataset + model's saved config, if it has one. */
  saved: DinoTunedConfig | undefined;
  onForget: () => void;
  forgetting: boolean;
  yolo: boolean;
  disabled?: boolean;
}) {
  const set = (patch: Partial<TuneOptions>) => onChange({ ...value, ...patch });
  const reuse = !!saved && !saved.is_stale && !value.retune;
  const space = yolo ? 'the two stage learning rates' : 'the learning rate, weight decay and the number of epochs';
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, opacity: disabled ? 0.6 : 1 }}>
      <label style={labelRow}>
        <input type="checkbox" checked={value.autoTune} disabled={disabled} onChange={(e) => set({ autoTune: e.target.checked })} />
        Hyperparameter search (Optuna)
        <InfoTip size={12} text={`Optuna searches ${space} on the validation split (never the test split). A trial trains in steps of 30 epochs (up to 120) and stops as soon as its validation loss stops improving, keeping its best epoch; a trial that is clearly behind the others is cut short. The best trial's epoch becomes the epochs of the final runs. The values shown are trial 0, so the result is never worse than not tuning. It is done once per dataset build and model; later runs reuse the saved config.`} />
      </label>
      {value.autoTune && (
        <div style={{ marginLeft: 22, display: 'flex', flexDirection: 'column', gap: 4 }}>
          {saved && !saved.is_stale ? (
            <>
              <p style={note}>Saved for this dataset ({describeParams(saved.best_params)}). {reuse ? 'No new search: it will be reused.' : 'A new search will replace it.'}</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <label style={labelRow}>
                  <input type="checkbox" checked={value.retune} disabled={disabled} onChange={(e) => set({ retune: e.target.checked })} />
                  Search again
                </label>
                <button
                  type="button" disabled={disabled || forgetting} onClick={onForget}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: MC.textMuted, background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                >
                  <RotateCcw size={11} /> Forget saved config
                </button>
              </div>
            </>
          ) : (
            <>
              {saved?.is_stale && <p style={note}>The saved config is for an older build of this dataset, so it will be searched again.</p>}
              <label style={labelRow}>
                Optuna trials
                <input
                  type="number" min={1} max={20} value={value.nTrials} disabled={disabled}
                  onChange={(e) => set({ nTrials: Math.min(20, Math.max(1, Math.round(Number(e.target.value)) || 1)) })} style={smallInput}
                />
                <InfoTip size={12} text="How many learning rates Optuna tries before choosing the best one. Each is a full training run, one after the other. This is only the search: the final runs below are separate and use the best setting found." />
              </label>
            </>
          )}
        </div>
      )}
      <label style={labelRow}>
        <input type="checkbox" checked={value.multiRun} disabled={disabled} onChange={(e) => set({ multiRun: e.target.checked })} />
        Final runs with the best hyperparameters
        <InfoTip size={12} text="After the search, trains the model this many times with the best settings (a different random seed each time), scores each on the test split and reports mean ± standard deviation. The model kept is the run with the best validation loss." />
      </label>
      {value.multiRun && (
        <label style={{ ...labelRow, marginLeft: 22 }}>
          Number of runs
          <input
            type="number" min={MIN_SEEDS} max={MAX_SEEDS} value={value.seedCount} disabled={disabled}
            onChange={(e) => set({ seedCount: Math.min(MAX_SEEDS, Math.max(MIN_SEEDS, Math.round(Number(e.target.value)) || MIN_SEEDS)) })} style={smallInput}
          />
          <span style={note}>({MIN_SEEDS} to {MAX_SEEDS})</span>
        </label>
      )}
      <p style={{ ...note, marginTop: 2 }} aria-live="polite">
        {(() => {
          const search = value.autoTune ? (reuse ? 'search skipped (saved config)' : `${value.nTrials} search trials`) : null;
          const final = value.multiRun ? `${value.seedCount} final runs` : '1 final run';
          const total = (value.autoTune && !reuse ? value.nTrials : 0) + (value.multiRun ? value.seedCount : 1);
          return `${[search, final].filter(Boolean).join(' + ')} = ${total} training${total === 1 ? "" : "s"}. Only the final runs are tested and reported.`;
        })()}
      </p>
    </div>
  );
}

function pm(mean: number | null, std: number | null, digits = 3): string {
  if (mean == null) return '–';
  return `${mean.toFixed(digits)} ± ${(std ?? 0).toFixed(digits)}`;
}

/** A multi-run report as plain text, for pasting into a paper's table. */
function reportText(report: DinoMultirunReport): string {
  const lines = Object.entries(report.summary).filter(([, s]) => s.n > 0).map(([k, s]) => `${METRIC_LABEL[k] ?? k}: ${pm(s.mean, s.std)}`);
  return `${lines.join('\n')}\n(n = ${report.n_runs} seeds, sample standard deviation)`;
}

const th: React.CSSProperties = { fontSize: 12, color: MC.textMuted, textAlign: 'right', fontWeight: 500 };
const td: React.CSSProperties = { textAlign: 'right', fontVariantNumeric: 'tabular-nums' };

/** What tuning chose and how the repeated runs scored (mean ± std on the test split). */
export function RunTuningReport({ tuning, multirun }: { tuning?: DinoTuningSummary | null; multirun?: DinoMultirunReport | null }) {
  const [copied, setCopied] = useState(false);
  if (!tuning && !multirun) return null;
  const metrics = multirun ? Object.entries(multirun.summary).filter(([, s]) => s.n > 0) : [];
  const copy = async () => {
    if (!multirun) return;
    try {
      await navigator.clipboard.writeText(reportText(multirun));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error('Could not copy');
    }
  };
  return (
    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
      {tuning && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <span style={{ fontSize: 12, color: MC.textMuted }}>
            {tuning.cache_hit ? 'Reused the saved tuned config' : `Auto-tuned over ${tuning.n_trials ?? '?'} trials${tuning.seconds ? ` in ${Math.round(tuning.seconds)}s` : ''}`}
          </span>
          <span style={{ fontSize: 14, fontWeight: 600, color: MC.text }}>{describeParams(tuning.best_params) || 'No parameters changed'}</span>
          {tuning.trials && tuning.trials.length > 0 && (
            <details>
              <summary style={{ fontSize: 12, color: MC.textMuted, cursor: 'pointer' }}>Trials (validation loss, lower is better)</summary>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginTop: 4, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
                {tuning.trials.map((t) => (
                  <div key={t.number} style={{ display: 'flex', gap: 8, color: t.number === tuning.best_trial ? MC.text : MC.textMuted, fontWeight: t.number === tuning.best_trial ? 700 : 400 }}>
                    <span style={{ width: 18 }}>{t.number}</span>
                    <span style={{ width: 54 }}>{t.value != null ? t.value.toFixed(4) : '–'}</span>
                    <span style={{ minWidth: 0 }}>{describeParams(t.params)}{t.number === 0 ? ' (your settings)' : ''}</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>
      )}
      {multirun && metrics.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ flex: 1, fontSize: 12, color: MC.textMuted }}>
              Test split, {multirun.n_runs} seeds: mean ± standard deviation
            </span>
            <InfoTip size={12} text={`Sample standard deviation (n-1) over seeds ${multirun.seeds.join(', ')}. Seed ${multirun.selected_seed} was kept because it had the best validation loss, not the best test score.`} />
            <button
              type="button" onClick={copy} aria-label="Copy the table as text" title="Copy as text"
              style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', cursor: 'pointer', color: MC.textMuted, padding: 2 }}
            >
              {copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1.2fr) minmax(0, 1.6fr) minmax(0, 1.2fr)', gap: '2px 8px', fontSize: 13, alignItems: 'baseline' }}>
            <span style={{ ...th, textAlign: 'left' }}>Metric</span>
            <span style={th}>Mean ± std</span>
            <span style={th}>Min – max</span>
            {metrics.map(([k, s]) => (
              <div key={k} style={{ display: 'contents' }}>
                <span style={{ fontWeight: 600, color: MC.text }}>{METRIC_LABEL[k] ?? k}</span>
                <span style={{ ...td, fontWeight: 700, color: MC.text }}>{pm(s.mean, s.std)}</span>
                <span style={{ ...td, color: MC.textMuted }}>{s.min != null && s.max != null ? `${s.min.toFixed(3)} – ${s.max.toFixed(3)}` : '–'}</span>
              </div>
            ))}
          </div>
          <details>
            <summary style={{ fontSize: 12, color: MC.textMuted, cursor: 'pointer' }}>Each seed</summary>
            <div style={{ display: 'grid', gridTemplateColumns: `minmax(0, 0.6fr) minmax(0, 0.9fr) repeat(${metrics.length}, minmax(0, 1fr))`, gap: '2px 8px', marginTop: 4, fontSize: 12, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ ...th, textAlign: 'left' }}>Seed</span>
              <span style={th}>Val loss</span>
              {metrics.map(([k]) => <span key={k} style={th}>{METRIC_LABEL[k] ?? k}</span>)}
              {multirun.runs.map((r) => (
                <div key={r.seed} style={{ display: 'contents' }}>
                  <span style={{ fontWeight: r.seed === multirun.selected_seed ? 700 : 400, color: MC.text }}>{r.seed}{r.seed === multirun.selected_seed ? ' ✓' : ''}</span>
                  <span style={{ ...td, color: MC.textMuted }}>{r.best_val_loss != null ? r.best_val_loss.toFixed(4) : '–'}</span>
                  {metrics.map(([k]) => <span key={k} style={td}>{r.metrics[k] != null ? r.metrics[k]!.toFixed(3) : '–'}</span>)}
                </div>
              ))}
            </div>
          </details>
        </div>
      )}
    </div>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  manual: 'Set by hand',
  auto_tuned: 'Auto-tuned for this run',
  saved_config: 'Saved tuned config, reused',
};

/** The hyperparameters a run was trained with, always visible in its details. */
export function RunHyperparameters({ result, task }: { result: DinoFinetuneResult | undefined; task: string }) {
  const hp = result?.hyperparameters;
  const stages = result?.train_result?.stages ?? hp?.stages;
  if (!hp) return null;
  const rows: [string, string][] = [];
  rows.push([task === 'yolo' ? 'Started from' : 'Model', hp.backbone ?? '–']);
  if (stages) {
    rows.push(['Stage 1', stages.stage1_epochs > 0 ? `${stages.stage1_epochs} epochs · rate ${fmtParam('lr', stages.stage1_lr ?? 0)} · ${stages.frozen_layers} backbone layers frozen` : 'off']);
    rows.push(['Stage 2', stages.stage2_epochs > 0 ? `${stages.stage2_epochs} epochs · rate ${fmtParam('lr', stages.stage2_lr)} · all layers` : 'off']);
  } else {
    rows.push(['Learning rate', fmtParam('lr', hp.lr)]);
    rows.push(['Epochs', String(hp.epochs)]);
    if (hp.weight_decay != null) rows.push(['Weight decay', fmtParam('weight_decay', hp.weight_decay)]);
  }
  rows.push(['Runs', hp.seeds?.length ? `${hp.seeds.length} seeds (${hp.seeds.join(', ')})` : 'Single run']);
  const source = hp.source ? SOURCE_LABEL[hp.source] : undefined;
  return (
    <div style={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ fontSize: 12, color: MC.textMuted, textTransform: 'uppercase', letterSpacing: '0.05em', fontWeight: 700 }}>Hyperparameters</span>
        {source && <span style={{ fontSize: 12, color: MC.accent }}>{source}</span>}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'max-content minmax(0, 1fr)', gap: '2px 12px', fontSize: 13 }}>
        {rows.map(([k, v]) => (
          <div key={k} style={{ display: 'contents' }}>
            <span style={{ color: MC.textMuted }}>{k}</span>
            <span style={{ color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
