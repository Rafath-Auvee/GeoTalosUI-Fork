'use client';

import { MC } from '../mapColors';
import { countDraft, useInteractiveStore } from './store';
import { Button } from './ui';

/** Confirms leaving with an unsaved draft. Rendered inside the panel, not as a browser dialog. */
export function ExitSheet() {
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const cancel = useInteractiveStore((s) => s.cancelExit);
  const exit = useInteractiveStore((s) => s.exit);
  const c = countDraft(masks, strictness);
  const n = c.total + c.filteredOut;

  return (
    <div
      role="alertdialog"
      aria-label="Exit interactive annotation"
      style={{ position: 'absolute', inset: 0, background: 'rgba(36,44,32,0.55)', display: 'flex', alignItems: 'flex-end', zIndex: 5 }}
    >
      <div style={{ width: '100%', background: MC.panelBg, borderTop: `2px solid ${MC.accent}`, padding: 14, display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: MC.text }}>Leave with {n} unsaved masks?</div>
          <p style={{ fontSize: 10, color: MC.textMuted, margin: '4px 0 0', lineHeight: 1.45 }}>
            Nothing has been saved to the project. Keep the draft to restore it next time you open this AOI, or discard it.
          </p>
        </div>
        <Button primary onClick={cancel}>Keep working</Button>
        <div style={{ display: 'flex', gap: 6 }}>
          <Button onClick={() => exit()}>Exit, keep draft</Button>
          <Button onClick={() => exit({ discard: true })}>Discard draft</Button>
        </div>
      </div>
    </div>
  );
}
