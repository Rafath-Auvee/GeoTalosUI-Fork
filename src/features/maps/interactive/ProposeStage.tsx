'use client';

import { AlertTriangle, Check, Crosshair, Eye, EyeOff, Loader2, RotateCcw, ScanSearch, Square, Undo2 } from 'lucide-react';
import { MC } from '../mapColors';
import {
  MAX_AOI_HECTARES, MAX_TILES, SCALE_LADDER_M, SECONDS_PER_TILE,
} from './config';
import { bboxHectares, bboxSizeM, fmtScale, nearestInLog, type Bbox } from './geo';
import { countDraft, qualityThreshold, useInteractiveStore } from './store';
import { Button, Chip, Section, note } from './ui';
import { useViewSpanM } from './useViewSpan';
import { TargetPicker } from './TargetPicker';

function estimate(bbox: Bbox, scales: number[]) {
  const { w, h } = bboxSizeM(bbox);
  const tiles = scales.reduce((sum, s) => sum + Math.ceil(w / s) * Math.ceil(h / s), 0);
  return { tiles, seconds: Math.max(1, Math.round(tiles * SECONDS_PER_TILE)) };
}

const linkBtn: React.CSSProperties = { background: 'transparent', border: 'none', padding: 0, fontSize: 10, fontWeight: 600, color: MC.accent, cursor: 'pointer', textDecoration: 'underline', textUnderlineOffset: 2 };
const fmtTime = (s: number) => (s < 90 ? `~${s} s` : `~${Math.round(s / 60)} min`);
const fmtSpan = (m: number) => (m >= 100 ? `${Math.round(m)} m` : `${m.toFixed(m < 10 ? 1 : 0)} m`);

const kbd: React.CSSProperties = {
  fontFamily: 'inherit', fontSize: 10, fontWeight: 700, padding: '0 4px', borderRadius: 3, lineHeight: '14px',
  border: `1px solid ${MC.borderLight}`, background: MC.inputBg, color: MC.textSecondary, marginLeft: 3,
};

function ModeButton({
  active, sign, label, color, onClick,
}: { active: boolean; sign: string; label: string; color: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      style={{
        flex: 1, height: 30, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 5,
        fontSize: 11, fontWeight: 700, cursor: 'pointer',
        border: `2px solid ${active ? color : MC.border}`,
        background: active ? MC.panelBg : 'transparent',
        color: active ? MC.text : MC.textSecondary,
        boxShadow: active ? `0 1px 0 ${color}` : 'none',
      }}
    >
      <span aria-hidden="true" style={{ fontSize: 15, fontWeight: 800, lineHeight: 1, color }}>{sign}</span>
      {label}
    </button>
  );
}

export function ProposeStage() {
  const aoiBbox = useInteractiveStore((s) => s.aoiBbox);
  const scales = useInteractiveStore((s) => s.scales);
  const masks = useInteractiveStore((s) => s.masks);
  const run = useInteractiveStore((s) => s.run);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const restorable = useInteractiveStore((s) => s.restorable);
  const references = useInteractiveStore((s) => s.references);
  const scalesAuto = useInteractiveStore((s) => s.scalesAuto);
  const pick = useInteractiveStore((s) => s.pick);
  const imagery = useInteractiveStore((s) => s.imagery);
  const st = useInteractiveStore.getState;
  const viewSpan = useViewSpanM(true);

  if (!aoiBbox) return null;
  const ha = bboxHectares(aoiBbox);
  const est = estimate(aoiBbox, scales);
  const tooBig = ha > MAX_AOI_HECTARES;
  const tooManyTiles = est.tiles > MAX_TILES;
  const running = run.status === 'running';
  const autoScales = scalesAuto && references.length > 0;
  const plus = pick.points.filter((p) => p.label === 1).length;
  const minus = pick.points.length - plus;
  const hasMasks = masks.some((m) => m.source !== 'manual' && m.source !== 'existing') || (masks.length > 0 && run.status !== 'idle');
  const counts = countDraft(masks, strictness);
  const threshold = qualityThreshold(strictness);

  const ladder = [...new Set([...SCALE_LADDER_M, ...scales])].sort((a, b) => a - b);
  const suggested = viewSpan ? nearestInLog(viewSpan, ladder) : null;

  const perScale = [...new Set(masks.filter((m) => m.source === 'auto' || m.source === 'refined').map((m) => m.scale_m))].sort((a, b) => a - b).map((sc) => {
    const all = masks.filter((m) => (m.source === 'auto' || m.source === 'refined') && m.scale_m === sc && !m.deleted);
    return { sc, total: all.length, shown: all.filter((m) => m.score >= threshold).length };
  });
  const maxShown = Math.max(1, ...perScale.map((p) => p.total));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {restorable && !hasMasks && (
        <div style={{ border: `1px solid ${MC.accent}`, background: MC.accentDim, borderRadius: 6, padding: 9, display: 'flex', flexDirection: 'column', gap: 7 }}>
          <span style={{ fontSize: 11, fontWeight: 600, color: MC.text }}>
            Restore draft · {restorable.count} masks
          </span>
          <span style={note}>Saved in this browser {new Date(restorable.savedAt).toLocaleString()}.</span>
          <div style={{ display: 'flex', gap: 6 }}>
            <Button primary onClick={() => void st().restoreDraft()}>Restore</Button>
            <Button onClick={() => st().discardRestorable()}>Discard</Button>
          </div>
        </div>
      )}

      <TargetPicker />

      <Section label="Reference objects">
        <p style={note}>Click an object to outline it with SAM 3. Click the next object and the previous one is saved for you. Click near an outline to refine it, Shift-click to exclude. Sizes set the scales below.</p>

        {references.length > 0 && (
          <p style={{ ...note, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>
            <b>{references.length}</b> outlined, {fmtSpan(Math.min(...references.map((r) => r.spanM)))}
            {references.length > 1 && ` to ${fmtSpan(Math.max(...references.map((r) => r.spanM)))}`} across. They are in the strip below the map.
          </p>
        )}

        {pick.active ? (
          <div style={{ border: `1.5px solid ${MC.accent}`, borderRadius: 6, padding: 9, display: 'flex', flexDirection: 'column', gap: 8, background: MC.accentDim }}>
            {/* What the next click does. Colour is paired with a + / − sign, never the only cue. */}
            <div role="group" aria-label="What a click does" style={{ display: 'flex', gap: 6 }}>
              <ModeButton active={pick.mode === 1} sign="+" label="Include" color="#2f9d49" onClick={() => st().setPickMode(1)} />
              <ModeButton active={pick.mode === 0} sign="−" label="Exclude" color="#d23a40" onClick={() => st().setPickMode(0)} />
            </div>

            <div role="status" aria-live="polite" style={{ minHeight: 30, display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11, color: MC.text }}>
              {pick.busy ? (
                <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <Loader2 size={12} className="animate-spin" color={MC.accent} /> Outlining…
                </span>
              ) : pick.pending ? (
                <span style={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
                  ≈ {fmtSpan(pick.pending.spanM)} across · {pick.pending.areaM2.toFixed(pick.pending.areaM2 < 10 ? 1 : 0)} m²
                  {pick.pending.score != null && <span style={{ color: MC.textMuted, fontWeight: 500 }}> · {Math.round(pick.pending.score * 100)}% sure</span>}
                </span>
              ) : (
                <span>{pick.points.length === 0 ? 'Click the object on the map.' : 'Click again to adjust.'}</span>
              )}
              {pick.points.length > 0 && (
                <span style={{ ...note, fontVariantNumeric: 'tabular-nums' }}>
                  <b style={{ color: '#2f9d49' }}>+{plus}</b> included{minus > 0 && <> · <b style={{ color: '#d23a40' }}>−{minus}</b> excluded</>}
                </span>
              )}
              {pick.hint && <span style={{ ...note, color: MC.danger }}>{pick.hint}</span>}
              {viewSpan != null && viewSpan > 150 && pick.points.length === 0 && (
                <span style={{ ...note, color: MC.danger }}>This view is {fmtSpan(viewSpan)} wide. Zoom in for a sharper outline.</span>
              )}
              {!imagery && <span style={{ ...note, color: MC.danger }}>Looking up the AOI&apos;s imagery…</span>}
            </div>

            <Button primary icon={<Check size={12} />} disabled={!pick.pending || pick.busy} onClick={() => st().acceptPending()}>
              Accept outline <kbd style={kbd}>Enter</kbd>
            </Button>
            <div style={{ display: 'flex', gap: 6 }}>
              <Button icon={<Undo2 size={12} />} disabled={pick.points.length === 0 || pick.busy} onClick={() => void st().undoPoint()} title="Remove the last click (Backspace)">
                Undo
              </Button>
              <Button icon={<RotateCcw size={12} />} disabled={pick.points.length === 0} onClick={() => st().resetPick()} title="Clear this outline and start again (Esc)">
                Reset
              </Button>
              <Button onClick={() => st().cancelPick()} title="Stop picking objects">Done</Button>
            </div>
            <p style={note}>Shift-click or right-click excludes. <kbd style={kbd}>+</kbd> <kbd style={kbd}>−</kbd> switch mode, <kbd style={kbd}>Esc</kbd> cancels.</p>
          </div>
        ) : (
          <Button
            primary={references.length === 0}
            icon={<Crosshair size={12} />}
            disabled={running}
            onClick={() => st().startPick()}
          >
            {references.length === 0 ? 'Pick an object on the map' : 'Pick another object'}
          </Button>
        )}
      </Section>

      <Section
        label="Scales"
        right={
          references.length > 0 ? (
            autoScales ? (
              <button type="button" onClick={() => st().setScalesAuto(false)} style={linkBtn}>Customize</button>
            ) : (
              <button type="button" onClick={() => st().setScalesAuto(true)} style={linkBtn}>Use references</button>
            )
          ) : undefined
        }
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
          {ladder.map((m) => (
            <Chip key={m} on={scales.includes(m)} onClick={() => st().toggleScale(m)} disabled={running || autoScales}>
              {m}
            </Chip>
          ))}
          <span style={{ ...note, alignSelf: 'center' }}>metres per tile</span>
        </div>
        {scales.length === 0 && <p style={{ ...note, color: MC.danger }}>Pick a reference object, or choose at least one scale.</p>}
        <p style={note}>
          {autoScales
            ? `Set by your ${references.length} reference object${references.length === 1 ? '' : 's'}, from the smallest to the largest. An object reads best when it is about a third of the tile.`
            : references.length === 0
              ? 'Without a reference object, choose the tile sizes yourself. An object reads best when it is about a third of the tile.'
              : 'Customized. Switch back to follow your reference objects.'}
        </p>
        {!autoScales && viewSpan != null && suggested != null && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 5, border: `1px solid ${MC.border}`, background: MC.inputBg }}>
            <span style={{ ...note, flex: 1 }}>
              Your view is about <b style={{ color: MC.text }}>{fmtSpan(viewSpan)}</b> across, which suits the{' '}
              <b style={{ color: MC.text }}>{fmtScale(suggested)}</b> scale.
            </span>
            <Button
              fullWidth={false}
              disabled={running || scales.includes(suggested)}
              onClick={() => st().addScale(suggested)}
            >
              {scales.includes(suggested) ? 'Added' : `Add ${suggested} m`}
            </Button>
          </div>
        )}
      </Section>

      <Section label="Run">
        <div style={{ ...note, display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '2px 10px', fontVariantNumeric: 'tabular-nums' }}>
          <span>AOI</span>
          <span style={{ color: tooBig ? MC.danger : MC.textSecondary }}>
            {ha.toFixed(ha < 10 ? 2 : 1)} ha{tooBig ? ` — over the ${MAX_AOI_HECTARES} ha limit` : ` (limit ${MAX_AOI_HECTARES} ha)`}
          </span>
          <span>Estimate</span>
          <span style={{ color: MC.textSecondary }}>
            {est.tiles.toLocaleString()} tiles · {fmtTime(est.seconds)}{tooManyTiles ? ` — over the ${MAX_TILES.toLocaleString()} tile limit` : ''}
          </span>
        </div>

        {(tooBig || tooManyTiles) && (
          <p style={{ ...note, color: MC.danger, display: 'flex', gap: 5, alignItems: 'flex-start' }}>
            <AlertTriangle size={11} style={{ flexShrink: 0, marginTop: 1 }} />
            {tooBig
              ? 'This AOI is too large for interactive mode. Shrink it to run Segment all.'
              : 'Too many tiles for one run. Drop a fine scale or use larger ones.'}
          </p>
        )}

        {running ? (
          <>
            <div role="progressbar" aria-valuemin={0} aria-valuemax={Math.max(1, run.tilesTotal)} aria-valuenow={run.tilesDone}
              style={{ height: 6, borderRadius: 3, background: MC.border, overflow: 'hidden' }}>
              <div style={{ width: `${(run.tilesDone / Math.max(1, run.tilesTotal)) * 100}%`, height: '100%', background: MC.accent, transition: 'width 0.4s' }} />
            </div>
            <p style={{ ...note, display: 'flex', alignItems: 'center', gap: 6, fontVariantNumeric: 'tabular-nums' }}>
              <Loader2 size={11} className="animate-spin" color={MC.accent} />
              {run.tilesTotal > 0 ? `${run.tilesDone} of ${run.tilesTotal} tiles` : 'Starting SAM 3'} · scale {Math.min(run.doneScales + 1, run.totalScales)} of {run.totalScales} · {masks.filter((m) => m.source === 'auto' || m.source === 'refined').length} masks so far
            </p>
            <Button icon={<Square size={11} />} onClick={() => st().cancelRun()}>Cancel</Button>
          </>
        ) : (
          <Button
            primary
            icon={hasMasks ? <RotateCcw size={11} /> : <ScanSearch size={12} />}
            disabled={tooBig || tooManyTiles || scales.length === 0}
            onClick={() => st().startRun()}
          >
            {hasMasks ? `Re-run at ${scales.length} scale${scales.length === 1 ? '' : 's'}` : `Segment all at ${scales.length} scale${scales.length === 1 ? '' : 's'}`}
          </Button>
        )}
        {run.status === 'cancelled' && hasMasks && <p style={note}>Cancelled. {masks.length} masks from the finished part are kept.</p>}
        {run.status === 'error' && <p style={{ ...note, color: MC.danger }}>{run.error ?? 'The run failed.'} Try again.</p>}
        {run.status === 'done' && !hasMasks && (
          <p style={note}>No masks were found at these scales. Try other scales or a different part of the AOI.</p>
        )}
      </Section>

      {hasMasks && (
        <>
          <Section label="Quality filter" right={<span style={{ ...note, fontVariantNumeric: 'tabular-nums' }}>showing {counts.total} of {counts.total + counts.filteredOut}</span>}>
            <input
              type="range" min={0} max={1} step={0.01} value={strictness}
              aria-label="Quality filter, loose to strict"
              onChange={(e) => st().setStrictness(Number(e.target.value))}
              style={{ width: '100%', accentColor: MC.accent }}
            />
            <div style={{ display: 'flex', justifyContent: 'space-between', ...note }}>
              <span>Loose</span><span>Strict</span>
            </div>
            <p style={note}>Weak masks are hidden, not deleted. Loosen the filter any time to bring them back.</p>
          </Section>

          <Section label="Masks by scale">
            <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {perScale.map(({ sc, total, shown }) => {
                const hidden = !!scaleHidden[String(sc)];
                return (
                  <li key={sc} style={{ display: 'flex', alignItems: 'center', gap: 8, opacity: hidden ? 0.5 : 1 }}>
                    <button
                      type="button"
                      aria-label={`${hidden ? 'Show' : 'Hide'} ${fmtScale(sc)} masks`}
                      title={hidden ? 'Show on map' : 'Hide on map'}
                      onClick={() => st().toggleScaleVisible(sc)}
                      style={{ width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: MC.textSecondary, cursor: 'pointer' }}
                    >
                      {hidden ? <EyeOff size={13} /> : <Eye size={13} />}
                    </button>
                    <span style={{ width: 44, fontSize: 11, fontWeight: 600, color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{fmtScale(sc)}</span>
                    <div style={{ flex: 1, height: 6, borderRadius: 3, background: MC.border, overflow: 'hidden' }}>
                      <div style={{ width: `${(shown / maxShown) * 100}%`, height: '100%', background: MC.accent }} />
                    </div>
                    <span style={{ width: 54, textAlign: 'right', fontSize: 10, color: MC.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
                      {shown}{shown !== total ? ` / ${total}` : ''}
                    </span>
                  </li>
                );
              })}
            </ul>
          </Section>

          <Button onClick={() => st().clearMasks()} title="Remove every proposed mask from the draft">Clear proposals</Button>
        </>
      )}
    </div>
  );
}
