'use client';

import { AlertTriangle, Loader2, Sparkles, Undo2 } from 'lucide-react';
import { MC } from '../mapColors';
import { useInteractiveStore, visibleMasks } from './store';
import { Button, Section, note } from './ui';

/**
 * Propose step for "Clean a set": the user's reference objects stand for what a good mask looks like.
 * Existing masks that look unlike them are flagged, and SAM 3 gets a second go at only those.
 */
export function ExistingCheck() {
  const target = useInteractiveStore((s) => s.target);
  const references = useInteractiveStore((s) => s.references);
  const suspect = useInteractiveStore((s) => s.suspect);
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const canUndo = useInteractiveStore((s) => s.history.length > 0);
  const st = useInteractiveStore.getState;
  if (!target) return null;
  // Say why there is nothing to check, rather than disappearing.
  if (target.status !== 'ready' || target.count === 0) {
    return (
      <Section label="Check existing masks">
        <p style={note}>
          {target.status === 'loading' ? 'Loading the set’s annotations…'
            : target.status === 'error' ? 'The set could not be loaded. Pick it again in Propose.'
              : 'No annotations of this set fall inside the AOI, so there is nothing to check.'}
        </p>
      </Section>
    );
  }

  const existing = visibleMasks(masks, strictness, scaleHidden).filter((m) => m.source === 'existing');
  const flagged = existing.filter((m) => m.flags.includes('suspect')).length;
  const scoring = suspect.status === 'scoring';
  const ready = suspect.status === 'ready';
  const r = suspect.refine;
  const refining = r.status === 'running';
  const fewSamples = references.length > 0 && references.length < 3;

  return (
    <Section label="Check existing masks" right={ready ? <span style={{ ...note, fontVariantNumeric: 'tabular-nums' }}>{flagged} of {existing.length} flagged</span> : undefined}>
      <p style={note}>
        Outline 5–10 good examples in Propose. Existing masks that look unlike them are flagged, and SAM 3 re-segments only those.
      </p>

      <Button
        icon={scoring ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
        disabled={references.length === 0 || scoring || refining}
        onClick={() => void st().findSuspects()}
        title={references.length === 0 ? 'Outline at least one example object first' : undefined}
      >
        {scoring ? 'Comparing masks…' : ready ? 'Check again' : 'Find suspect masks'}
      </Button>
      {references.length === 0 && <p style={note}>Outline an example object first.</p>}
      {fewSamples && !ready && <p style={note}>With only {references.length} example{references.length === 1 ? '' : 's'} the comparison is rough. 5–10 works better.</p>}

      {suspect.status === 'error' && (
        <p role="alert" style={{ ...note, color: MC.danger, display: 'flex', gap: 5, alignItems: 'flex-start' }}>
          <AlertTriangle size={12} style={{ flexShrink: 0, marginTop: 1 }} /> {suspect.error}
        </p>
      )}

      {ready && (
        <>
          <input
            type="range" min={0} max={1} step={0.01} value={suspect.threshold}
            aria-label="Flag masks less similar than this to your examples"
            onChange={(e) => st().setSuspectThreshold(Number(e.target.value))}
            style={{ width: '100%', accentColor: MC.accent }}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', ...note }}>
            <span>Flag fewer</span><span>Flag more</span>
          </div>

          <Button
            primary
            icon={refining ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
            disabled={flagged === 0 || refining}
            onClick={() => void st().refineSuspects()}
          >
            {refining ? `Re-segmenting ${r.done} of ${r.total}…` : `Re-segment ${flagged} flagged with SAM 3`}
          </Button>
          <p style={note}>Each flagged mask is replaced by what SAM 3 finds from 1–2 points inside it, when that is plausibly the same object. Others are left as they are.</p>

          {r.status === 'done' && (
            <p style={note}>
              <b style={{ color: MC.text, fontVariantNumeric: 'tabular-nums' }}>{r.changed}</b> replaced, {r.unchanged} left as they were.{(r.absorbed ?? 0) > 0 && ` ${r.absorbed} overlapping fragment${r.absorbed === 1 ? '' : 's'} removed.`}
              {r.changed > 0 && ' Flagged masks are in Clean for review.'}
              {r.unchanged > 0 && r.reasons && ` (${Object.entries(r.reasons).sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n}: ${why}`).join('; ')})`}
            </p>
          )}
          {r.status === 'error' && <p role="alert" style={{ ...note, color: MC.danger }}>{r.error}</p>}
          {canUndo && r.status === 'done' && r.changed > 0 && (
            <Button icon={<Undo2 size={12} />} onClick={() => st().undo()} title="Revert the whole re-segmentation">Undo re-segmentation</Button>
          )}
        </>
      )}
    </Section>
  );
}
