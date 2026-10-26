'use client';

import { LogOut, ScanSearch } from 'lucide-react';
import { MC, MAP_Z } from '../mapColors';
import { useInteractiveStore } from './store';

/**
 * Always-visible mode marker on the map. It names the mode and carries the one
 * way out, since everything else in the editor is locked while it is on.
 */
export function InteractiveModeBanner() {
  const active = useInteractiveStore((s) => s.active);
  const aoiName = useInteractiveStore((s) => s.aoiName);
  const requestExit = useInteractiveStore((s) => s.requestExit);
  const picking = useInteractiveStore((s) => s.pick.active);
  const mode = useInteractiveStore((s) => s.pick.mode);
  const hasPoints = useInteractiveStore((s) => s.pick.points.length > 0);
  if (!active) return null;

  return (
    <>
    {picking && (
      // The instructions live next to the pointer, not only in the side panel.
      <div
        style={{
          position: 'absolute', bottom: 14, left: '50%', transform: 'translateX(-50%)', zIndex: MAP_Z.dropdown,
          display: 'flex', alignItems: 'center', gap: 10, padding: '6px 12px', borderRadius: 6, whiteSpace: 'nowrap',
          background: MC.navBg, border: `1px solid ${MC.accent}`, boxShadow: MC.shadowMd, color: MC.navText,
          fontSize: 11, pointerEvents: 'none',
        }}
      >
        <b style={{ color: mode === 1 ? '#6fd884' : '#ff8a8e' }}>{mode === 1 ? '+ Include' : '− Exclude'}</b>
        <span>{hasPoints ? 'Click to refine the outline' : 'Click the object'}</span>
        <span style={{ color: MC.navTextMuted }}>Shift-click excludes · Enter accepts · Esc cancels</span>
      </div>
    )}
    <div
      role="status"
      style={{
        position: 'absolute', top: 10, left: '50%', transform: 'translateX(-50%)', zIndex: MAP_Z.dropdown,
        display: 'flex', alignItems: 'center', gap: 10, padding: '5px 6px 5px 12px',
        background: MC.navBg, border: `2px solid ${MC.accent}`, borderRadius: 8, boxShadow: MC.shadowLg,
        color: MC.navText, whiteSpace: 'nowrap',
      }}
    >
      <ScanSearch size={14} color={MC.accent} />
      <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        Interactive annotation · {aoiName}
      </span>
      <span style={{ fontSize: 10, color: MC.navTextMuted }}>Other tools are locked</span>
      <button
        type="button"
        onClick={requestExit}
        style={{
          display: 'flex', alignItems: 'center', gap: 5, height: 28, padding: '0 11px', borderRadius: 5,
          background: MC.accent, color: MC.navBg, border: 'none', fontSize: 11, fontWeight: 700, cursor: 'pointer',
        }}
      >
        <LogOut size={12} /> Exit mode
      </button>
    </div>
    </>
  );
}
