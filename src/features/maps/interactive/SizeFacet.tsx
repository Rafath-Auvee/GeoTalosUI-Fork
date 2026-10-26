'use client';

import { MC } from '../mapColors';
import { sizeHistogram } from './selection';
import { useInteractiveStore, visibleMasks } from './store';
import { maskSpanM } from './geo';
import { note } from './ui';

const BINS = 14;
const fmtM = (m: number) => (m >= 100 ? `${Math.round(m)}` : m >= 10 ? m.toFixed(0) : m.toFixed(1));

/**
 * Group by size: a histogram of mask sizes (longer side, log axis). Click a bar to
 * select that size band, Shift-click to extend the band, or type exact limits. Size
 * is one filter among several, so it combines with the look groups below.
 */
export function SizeFacet() {
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const range = useInteractiveStore((s) => s.selection.sizeRange);
  const set = useInteractiveStore.getState().setSizeRange;

  const inPlay = visibleMasks(masks, strictness, scaleHidden);
  const hist = sizeHistogram(inPlay, BINS);
  if (!hist) return <p style={note}>No masks to measure yet.</p>;

  const { edges, counts } = hist;
  const max = Math.max(...counts);
  const lo = edges[0];
  const hi = edges[edges.length - 1];
  const inRange = range ? inPlay.filter((m) => { const s = maskSpanM(m.geometry); return s >= range[0] && s <= range[1]; }).length : null;
  const binOn = (i: number) => !!range && Math.sqrt(edges[i] * edges[i + 1]) >= range[0] && Math.sqrt(edges[i] * edges[i + 1]) <= range[1];

  const clickBin = (i: number, shift: boolean) => {
    const bin: [number, number] = [edges[i], edges[i + 1]];
    if (shift && range) return set([Math.min(range[0], bin[0]), Math.max(range[1], bin[1])]);
    const onlyThis = range && Math.abs(range[0] - bin[0]) < 1e-9 && Math.abs(range[1] - bin[1]) < 1e-9;
    set(onlyThis ? null : bin);
  };
  const setLimit = (which: 0 | 1, v: number) => {
    if (Number.isNaN(v)) return;
    const cur: [number, number] = range ?? [lo, hi];
    const next: [number, number] = which === 0 ? [v, Math.max(v, cur[1])] : [Math.min(cur[0], v), v];
    set(next);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div role="group" aria-label="Mask size histogram" style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 52 }}>
        {counts.map((c, i) => (
          <button
            key={i}
            type="button"
            aria-pressed={binOn(i)}
            aria-label={`${fmtM(edges[i])} to ${fmtM(edges[i + 1])} metres, ${c} masks`}
            title={`${fmtM(edges[i])}–${fmtM(edges[i + 1])} m · ${c} masks`}
            onClick={(e) => clickBin(i, e.shiftKey)}
            style={{ flex: 1, height: '100%', display: 'flex', alignItems: 'flex-end', padding: 0, background: 'transparent', border: 'none', cursor: 'pointer' }}
          >
            <span style={{ display: 'block', width: '100%', height: `${Math.max(3, (c / Math.max(1, max)) * 100)}%`, borderRadius: '2px 2px 0 0', background: binOn(i) ? MC.accent : range ? MC.border : MC.textMuted, opacity: c === 0 ? 0.25 : 1 }} />
          </button>
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', ...note, fontVariantNumeric: 'tabular-nums' }}>
        <span>{fmtM(lo)} m</span><span>size (log scale)</span><span>{fmtM(hi)} m</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input aria-label="Smallest size, metres" type="number" min={0} step={0.1} value={range ? Number(range[0].toFixed(2)) : ''} placeholder={fmtM(lo)} onChange={(e) => setLimit(0, Number(e.target.value))} style={inputStyle} />
        <span style={note}>to</span>
        <input aria-label="Largest size, metres" type="number" min={0} step={0.1} value={range ? Number(range[1].toFixed(2)) : ''} placeholder={fmtM(hi)} onChange={(e) => setLimit(1, Number(e.target.value))} style={inputStyle} />
        <span style={note}>m</span>
        {range && <button type="button" onClick={() => set(null)} style={{ background: 'transparent', border: 'none', color: MC.accent, fontSize: 10, fontWeight: 600, cursor: 'pointer', textDecoration: 'underline' }}>Clear</button>}
      </div>
      <p style={note}>
        {range ? `${inRange} of ${inPlay.length} masks are in this size range.` : 'Click a bar for a size band, Shift-click to widen it, or type limits.'}
      </p>
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  width: 64, height: 26, padding: '0 6px', borderRadius: 4, fontSize: 11, border: `1px solid ${MC.inputBorder}`,
  background: MC.inputBg, color: MC.text, fontVariantNumeric: 'tabular-nums',
};
