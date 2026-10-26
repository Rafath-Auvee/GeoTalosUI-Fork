'use client';

import { MC } from '../../mapColors';

export function fmt(v: number | null | undefined, digits = 3): string | null {
  return v == null ? null : v.toFixed(digits);
}

/** A tick step of 1, 2 or 5 × 10ⁿ, so the axes read in round numbers. */
function niceStep(range: number, target: number): number {
  const raw = range / Math.max(1, target);
  const pow = 10 ** Math.floor(Math.log10(raw));
  const f = raw / pow;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * pow;
}

/** The top of a loss axis: the real maximum unless a few early spikes would flatten everything else, then a bit above the 95th percentile. */
function robustMax(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const max = sorted[sorted.length - 1];
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))];
  return max > p95 * 2.5 ? p95 * 1.15 : max;
}

/** Loss per epoch with labelled axes. Fixed aspect and a width cap; the best-validation epoch is marked. */
export function LossChart({ train, val, bestEpoch, stageAt }: { train: number[]; val?: number[]; bestEpoch?: number; stageAt?: number }) {
  const W = 420, H = 270, L = 54, R = 12, T = 10, B = 44;
  const all = [...train, ...(val ?? [])].filter((v) => Number.isFinite(v));
  if (train.length < 2 || all.length === 0) return null;
  const lo = Math.min(...all), hi = robustMax(all);
  const step = niceStep(hi - lo || Math.abs(hi) || 1, 5);
  const yMin = Math.max(0, Math.floor(lo / step) * step), yMax = Math.ceil(hi / step) * step || step;
  const n = train.length;
  const x = (epoch: number) => L + ((epoch - 1) / Math.max(1, n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (Math.min(v, yMax) - yMin) / (yMax - yMin || 1)) * (H - T - B); // spikes above the axis are drawn at its top edge
  const line = (ys: number[]) => ys.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) yTicks.push(Number(v.toFixed(6)));
  const xStep = niceStep(n - 1, 6);
  const xTicks = [1];
  for (let e = xStep; e < n; e += xStep) xTicks.push(Math.round(e));
  if (xTicks[xTicks.length - 1] !== n) xTicks.push(n);
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
  const hasVal = !!val && val.length > 1;
  const best = bestEpoch && bestEpoch >= 1 && bestEpoch <= n ? bestEpoch : null;

  return (
    <figure style={{ margin: '0 auto', width: '100%', maxWidth: 720, flexShrink: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Training and validation loss per epoch" style={{ display: 'block', width: '100%', height: 'auto', maxHeight: 'min(330px, 34vh)' }}>
        {yTicks.map((v) => (
          <g key={`y${v}`}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={MC.border} strokeWidth={1} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill={MC.textMuted} style={{ fontVariantNumeric: 'tabular-nums' }}>{v.toFixed(decimals)}</text>
          </g>
        ))}
        {xTicks.map((e) => (
          <g key={`x${e}`}>
            <line x1={x(e)} x2={x(e)} y1={H - B} y2={H - B + 5} stroke={MC.textMuted} strokeWidth={1} />
            <text x={x(e)} y={H - B + 19} textAnchor="middle" fontSize={12} fill={MC.textMuted} style={{ fontVariantNumeric: 'tabular-nums' }}>{e}</text>
          </g>
        ))}
        <line x1={L} x2={L} y1={T} y2={H - B} stroke={MC.textMuted} strokeWidth={1} />
        <line x1={L} x2={W - R} y1={H - B} y2={H - B} stroke={MC.textMuted} strokeWidth={1} />
        {best && hasVal && (
          <>
            <line x1={x(best)} x2={x(best)} y1={T} y2={H - B} stroke="#16a34a" strokeWidth={1} strokeDasharray="2 3" />
            <circle cx={x(best)} cy={y(val![best - 1])} r={4.5} fill="#16a34a" stroke={MC.panelBg} strokeWidth={1.5} />
          </>
        )}
        {stageAt != null && stageAt > 0 && stageAt < n && (
          <g>
            <line x1={x(stageAt + 0.5)} x2={x(stageAt + 0.5)} y1={T} y2={H - B} stroke={MC.textMuted} strokeWidth={1} strokeDasharray="1 4" />
            <text x={x(stageAt + 0.5) + 6} y={T + 12} fontSize={12} fill={MC.textMuted}>Stage 2</text>
          </g>
        )}
        {hasVal && <polyline points={line(val!)} fill="none" stroke={MC.textMuted} strokeWidth={2} strokeDasharray="5 4" strokeLinejoin="round" />}
        <polyline points={line(train)} fill="none" stroke={MC.accent} strokeWidth={2.5} strokeLinejoin="round" />
        <text x={(L + W - R) / 2} y={H - 8} textAnchor="middle" fontSize={13} fontWeight={600} fill={MC.text}>Epoch</text>
        <text transform={`translate(13 ${(T + H - B) / 2}) rotate(-90)`} textAnchor="middle" fontSize={13} fontWeight={600} fill={MC.text}>Loss</text>
      </svg>
      <figcaption style={{ display: 'flex', gap: 16, flexWrap: 'wrap', justifyContent: 'center', marginTop: 2, fontSize: 12, color: MC.textMuted }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={MC.accent} strokeWidth={2.5} /></svg>Training</span>
        {hasVal && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg width="22" height="8" aria-hidden><line x1="0" x2="22" y1="4" y2="4" stroke={MC.textMuted} strokeWidth={2} strokeDasharray="5 4" /></svg>Validation</span>}
        {best && hasVal && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><span style={{ width: 9, height: 9, borderRadius: 5, background: '#16a34a' }} />Best epoch {best}</span>}
      </figcaption>
    </figure>
  );
}

/** One metric: the value, and where it sits between 0 and 1. */
export function Stat({ label, value, raw, lead }: { label: string; value: string; raw?: number | null; lead?: boolean }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3, padding: '7px 9px', border: `1px solid ${lead ? MC.accent : MC.border}`, borderRadius: 6, background: lead ? MC.accentDim : 'transparent', minWidth: 0 }}>
      <span style={{ fontSize: 12, color: MC.textMuted }}>{label}</span>
      <span style={{ fontSize: lead ? 22 : 18, fontWeight: 700, color: MC.text, fontVariantNumeric: 'tabular-nums', lineHeight: 1.1 }}>{value}</span>
      {raw != null && (
        <span aria-hidden style={{ height: 3, borderRadius: 2, background: MC.border, overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${Math.max(0, Math.min(1, raw)) * 100}%`, background: lead ? MC.accent : MC.textMuted }} />
        </span>
      )}
    </div>
  );
}

/* ── Charts for an experiment: the spread over seeds, the curves of all seeds, the search ── */

export interface CurveSeries { id: string; label: string; values: number[]; kept?: boolean }

/** Validation loss per epoch, one line per seed; the kept seed is the bold one. */
export function SeedCurves({ series }: { series: CurveSeries[] }) {
  const W = 400, H = 230, L = 46, R = 10, T = 10, B = 36;
  const usable = series.filter((s) => s.values.length > 1);
  if (usable.length === 0) return null;
  const all = usable.flatMap((s) => s.values).filter(Number.isFinite);
  const lo = Math.min(...all), hi = robustMax(all);
  const step = niceStep(hi - lo || Math.abs(hi) || 1, 4);
  const yMin = Math.max(0, Math.floor(lo / step) * step), yMax = Math.ceil(hi / step) * step || step;
  const n = Math.max(...usable.map((s) => s.values.length));
  const x = (e: number) => L + ((e - 1) / Math.max(1, n - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (Math.min(v, yMax) - yMin) / (yMax - yMin || 1)) * (H - T - B);
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) yTicks.push(Number(v.toFixed(6)));
  const xStep = niceStep(n - 1, 5);
  const xTicks = [1];
  for (let e = xStep; e < n; e += xStep) xTicks.push(Math.round(e));
  if (xTicks[xTicks.length - 1] !== n) xTicks.push(n);
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
  const line = (vs: number[]) => vs.map((v, i) => `${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const ordered = [...usable].sort((a, b) => Number(!!a.kept) - Number(!!b.kept)); // the kept one is drawn last, on top
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Validation loss per epoch for each seed" style={{ display: 'block', width: '100%', height: 'auto' }}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={MC.border} strokeWidth={1} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill={MC.textMuted} style={{ fontVariantNumeric: 'tabular-nums' }}>{v.toFixed(decimals)}</text>
          </g>
        ))}
        {xTicks.map((e) => <text key={e} x={x(e)} y={H - B + 17} textAnchor="middle" fontSize={12} fill={MC.textMuted} style={{ fontVariantNumeric: 'tabular-nums' }}>{e}</text>)}
        <text x={(L + W - R) / 2} y={H - 4} textAnchor="middle" fontSize={12} fontWeight={600} fill={MC.text}>Epoch</text>
        {ordered.map((s) => (
          <polyline key={s.id} points={line(s.values)} fill="none" strokeLinejoin="round" strokeLinecap="round"
            stroke={s.kept ? MC.accent : MC.textMuted} strokeWidth={s.kept ? 2.6 : 1.4} opacity={s.kept ? 1 : 0.55} />
        ))}
      </svg>
      <figcaption style={{ display: 'flex', gap: 14, flexWrap: 'wrap', marginTop: 4, fontSize: 12, color: MC.textMuted }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg width="20" height="6" aria-hidden><line x1="0" x2="20" y1="3" y2="3" stroke={MC.accent} strokeWidth={2.6} /></svg>Best run</span>
        {usable.some((s) => !s.kept) && <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}><svg width="20" height="6" aria-hidden><line x1="0" x2="20" y1="3" y2="3" stroke={MC.textMuted} strokeWidth={1.4} opacity={0.55} /></svg>Other seeds</span>}
      </figcaption>
    </figure>
  );
}

/** Hyperparameter search: the validation loss of each trial and the best so far. */
export function TrialsChart({ trials, bestTrial }: { trials: { number: number; value: number | null }[]; bestTrial?: number }) {
  const pts = trials.filter((t) => t.value != null) as { number: number; value: number }[];
  if (pts.length < 2) return null;
  const W = 400, H = 170, L = 46, R = 12, T = 12, B = 34;
  const lo = Math.min(...pts.map((p) => p.value)), hi = Math.max(...pts.map((p) => p.value));
  const step = niceStep(hi - lo || hi || 1, 3);
  const yMin = Math.max(0, Math.floor(lo / step) * step), yMax = Math.ceil(hi / step) * step || step;
  const x = (i: number) => L + (pts.length === 1 ? 0.5 : i / (pts.length - 1)) * (W - L - R);
  const y = (v: number) => T + (1 - (v - yMin) / (yMax - yMin || 1)) * (H - T - B);
  const yTicks: number[] = [];
  for (let v = yMin; v <= yMax + step / 2; v += step) yTicks.push(Number(v.toFixed(6)));
  let run = Infinity;
  const bestSoFar = pts.map((p) => (run = Math.min(run, p.value)));
  const decimals = step < 0.01 ? 3 : step < 0.1 ? 2 : 1;
  return (
    <figure style={{ margin: 0 }}>
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Validation loss of each tuning trial" style={{ display: 'block', width: '100%', height: 'auto' }}>
        {yTicks.map((v) => (
          <g key={v}>
            <line x1={L} x2={W - R} y1={y(v)} y2={y(v)} stroke={MC.border} strokeWidth={1} />
            <text x={L - 8} y={y(v) + 4} textAnchor="end" fontSize={12} fill={MC.textMuted} style={{ fontVariantNumeric: 'tabular-nums' }}>{v.toFixed(decimals)}</text>
          </g>
        ))}
        <polyline points={bestSoFar.map((v, i) => `${x(i)},${y(v)}`).join(' ')} fill="none" stroke={MC.accent} strokeWidth={2} strokeDasharray="5 4" />
        {pts.map((p, i) => {
          const best = p.number === bestTrial;
          return (
            <g key={p.number}>
              <circle cx={x(i)} cy={y(p.value)} r={best ? 6 : 4.5} fill={best ? MC.accent : MC.panelBg} stroke={best ? MC.text : MC.textMuted} strokeWidth={1.5}><title>{`Trial ${p.number} · ${p.value.toFixed(4)}`}</title></circle>
              <text x={x(i)} y={H - B + 16} textAnchor="middle" fontSize={12} fill={best ? MC.text : MC.textMuted} fontWeight={best ? 700 : 400}>{p.number}</text>
            </g>
          );
        })}
        <text x={(L + W - R) / 2} y={H - 3} textAnchor="middle" fontSize={12} fontWeight={600} fill={MC.text}>Trial</text>
      </svg>
      <figcaption style={{ marginTop: 2, fontSize: 12, color: MC.textMuted }}>Validation loss, lower is better. The dashed line is the best so far; trial 0 is the starting values.</figcaption>
    </figure>
  );
}
