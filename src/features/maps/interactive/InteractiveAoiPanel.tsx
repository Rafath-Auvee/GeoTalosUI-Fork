'use client';

import { useEffect } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useMapLayersStore } from '@/stores/mapLayersStore';
import { MC } from '../mapColors';
import { STAGES } from './types';
import { useInteractiveStore, visibleMasks } from './store';
import { useResolveImagery } from './useResolveImagery';
import { StageRail } from './StageRail';
import { CompletenessStrip } from './CompletenessStrip';
import { ProposeStage } from './ProposeStage';
import { GroupStage } from './GroupStage';
import { CleanStage } from './CleanStage';
import { reviewQueue, selectMasks } from './selection';
import { ExitSheet } from './ExitSheet';
import { SaveSheet } from './SaveSheet';
import { Button, note } from './ui';

const NEXT: Record<string, string> = {
};

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Right-hand panel for Interactive annotation mode. Owns its header; replaces the AOI panel while active. */
export function InteractiveAoiPanel() {
  const stage = useInteractiveStore((s) => s.stage);
  const aoiName = useInteractiveStore((s) => s.aoiName);
  const exitPrompt = useInteractiveStore((s) => s.exitPrompt);
  const requestExit = useInteractiveStore((s) => s.requestExit);
  const lastSavedAt = useInteractiveStore((s) => s.lastSavedAt);
  const setStage = useInteractiveStore((s) => s.setStage);
  const hasMasks = useInteractiveStore((s) => s.masks.some((m) => !m.deleted));
  const saveOpen = useInteractiveStore((s) => s.save.open);
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const inPlay = visibleMasks(masks, strictness, scaleHidden);
  const labelled = inPlay.filter((m) => m.classId).length;
  const unlabelledCount = inPlay.length - labelled;
  useResolveImagery();

  // The draft is the only thing to look at while this mode is open: hide every vector annotation set
  // on the map (the set being cleaned is one of them, and the draft stands in for it), then put back
  // exactly the ones that were showing when the mode closes.
  useEffect(() => {
    const store = useMapLayersStore.getState();
    const hidden = Object.values(store.layers)
      .filter((l) => l.sourceType === 'annotation_set' && !l.isRasterMask && l.visible)
      .map((l) => l.id);
    hidden.forEach((id) => store.setLayerVisible(id, false));
    return () => {
      const cur = useMapLayersStore.getState();
      hidden.forEach((id) => { if (cur.layers[id]) cur.setLayerVisible(id, true); });
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
      const st = useInteractiveStore.getState();
      if (st.pick.active) {
        if (e.key === 'Enter' && st.pick.pending) { e.preventDefault(); st.acceptPending(); return; }
        if (e.key === '+' || e.key === '=') { st.setPickMode(1); return; }
        if (e.key === '-' || e.key === '_') { st.setPickMode(0); return; }
        if (e.key === 'Backspace' && st.pick.points.length) { e.preventDefault(); void st.undoPoint(); return; }
        if (e.key === 'Escape') { e.preventDefault(); if (st.pick.points.length || st.pick.pending) st.resetPick(); else st.cancelPick(); return; }
      }
      // Group and Clean: act on what is selected or under review.
      if (st.stage === 'group' || st.stage === 'clean') {
        if (e.key === 'Delete' || e.key === 'Backspace') {
          if (selectMasks(visibleMasks(st.masks, st.strictness, st.scaleHidden), st.selection, st.similar).length) { e.preventDefault(); st.deleteSelection(); }
          return;
        }
        if (e.key === 'Escape' && st.selection.picked.length) { e.preventDefault(); st.clearSelection(); return; }
      }
      if (st.stage === 'clean') {
        const q = reviewQueue(visibleMasks(st.masks, st.strictness, st.scaleHidden), st.review.filter);
        const i = Math.min(st.review.index, Math.max(0, q.length - 1));
        const cur = q[i];
        if (e.key === 'ArrowRight') { e.preventDefault(); st.setReviewIndex(Math.min(q.length - 1, i + 1)); return; }
        if (e.key === 'ArrowLeft') { e.preventDefault(); st.setReviewIndex(Math.max(0, i - 1)); return; }
        if (cur && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (!cur.classId && !st.labelClassId) return; st.keepMask(cur.id); st.setReviewIndex(Math.min(q.length - 1, i + 1)); return; }
        if (cur && (e.key === 'd' || e.key === 'D')) { e.preventDefault(); st.deleteMask(cur.id); return; }
      }
      const s = STAGES.find((x) => x.key === e.key);
      if (s) { e.preventDefault(); setStage(s.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setStage]);

  return (
    <div style={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Header — dark like every panel, with a gold rule: this is a different mode */}
      <div
        style={{
          height: 40, display: 'flex', alignItems: 'center', gap: 8, padding: '0 8px 0 6px', flexShrink: 0,
          background: MC.navBg, borderBottom: `2px solid ${MC.accent}`,
        }}
      >
        <button
          type="button"
          onClick={requestExit}
          title="Exit to the AOI panel"
          style={{ display: 'flex', alignItems: 'center', gap: 4, height: 26, padding: '0 7px', background: 'transparent', border: `1px solid ${MC.navTextMuted}`, borderRadius: 4, color: MC.navText, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
        >
          <ArrowLeft size={12} /> Exit
        </button>
        <span style={{ flex: 1, minWidth: 0, fontSize: 11, fontWeight: 700, color: MC.navText, letterSpacing: '0.06em', textTransform: 'uppercase', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Interactive · {aoiName}
        </span>
        <span
          title="Everything here is a local draft. Nothing is saved to the project until you commit."
          style={{ fontSize: 10, fontWeight: 700, color: MC.accent, border: `1px solid ${MC.accent}`, borderRadius: 10, padding: '2px 8px', whiteSpace: 'nowrap' }}
        >
          Draft · not saved
        </span>
      </div>

      <StageRail />
      {/* Nothing to measure until masks exist, so no row of zeros. */}
      {hasMasks && <CompletenessStrip />}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px 16px' }}>
        {stage === 'propose' ? (
          <ProposeStage />
        ) : stage === 'group' ? (
          <GroupStage />
        ) : stage === 'clean' ? (
          <CleanStage />
        ) : (
          <p style={{ ...note, padding: '10px 0' }}>
            {NEXT[stage]} <br />
            <span style={{ color: MC.textSecondary }}>This stage arrives in the next build slice.</span>
          </p>
        )}
      </div>

      {/* Saving is the end of Clean: Propose and Group stay about finding and narrowing masks. */}
      {stage === 'clean' && (
        <div style={{ flexShrink: 0, borderTop: `1px solid ${MC.border}`, padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 4 }}>
          <Button primary disabled={labelled === 0} onClick={() => useInteractiveStore.getState().openSave(true)} title={labelled === 0 ? 'Label some masks first' : undefined}>
            Save {labelled} verified annotation{labelled === 1 ? '' : 's'}
          </Button>
          {unlabelledCount > 0 && labelled > 0 && <span style={note}>{unlabelledCount} unlabelled mask{unlabelledCount === 1 ? '' : 's'} to label or delete first.</span>}
        </div>
      )}

      <div style={{ flexShrink: 0, borderTop: `1px solid ${MC.border}`, padding: '6px 14px', display: 'flex', justifyContent: 'space-between', ...note }}>
        <span>{lastSavedAt ? `Autosaved in this browser ${new Date(lastSavedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'Autosaves in this browser after each run'}</span>
        <span>Keys 1–3: stages</span>
      </div>

      {exitPrompt && <ExitSheet />}
      {saveOpen && <SaveSheet />}
    </div>
  );
}
