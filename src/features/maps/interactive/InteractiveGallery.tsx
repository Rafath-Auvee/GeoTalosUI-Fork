'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, X } from 'lucide-react';
import { flyToMask } from './mapActions';
import { MC, MAP_Z } from '../mapColors';
import { useInteractiveStore, visibleMasks } from './store';
import { selectMasks } from './selection';
import { maskSpanM, orderByProximity } from './geo';
import { useThumbs } from './useThumbs';

const MAX_SHOWN = 300; // the thumbnail endpoint returns at most this many per request
/** Thumbnail size: large enough to judge a mask at a glance. */
const TILE = 128;

/**
* Thumbnail strip along the bottom of the map: the masks the combined filters select
 * (size, look groups, look-alikes). Click a thumbnail to fly the map to that mask. Collapsible, so the
 * full imagery is one click away.
 */
export function InteractiveGallery() {
  const active = useInteractiveStore((s) => s.active);
  const stage = useInteractiveStore((s) => s.stage);
  const similar = useInteractiveStore((s) => s.similar);
  const selection = useInteractiveStore((s) => s.selection);
  const masks = useInteractiveStore((s) => s.masks);
  const strictness = useInteractiveStore((s) => s.strictness);
  const scaleHidden = useInteractiveStore((s) => s.scaleHidden);
  const classes = useInteractiveStore((s) => s.classes);
  const references = useInteractiveStore((s) => s.references);
  const [collapsed, setCollapsed] = useState(false);
  const [order, setOrder] = useState<'nearby' | 'size'>('nearby');
  const rowRef = useRef<HTMLDivElement>(null);

  // Whatever the combined filters select, in a FIXED order: neighbours on the map sit next to each
  // other (or biggest first). Selecting or deleting a mask never reshuffles the row; the strip
  // scrolls to the selected one instead.
  const items = useMemo(() => {
    const picked = selectMasks(visibleMasks(masks, strictness, scaleHidden), selection, similar);
    return order === 'nearby'
      ? orderByProximity(picked)
      : [...picked].sort((a, b) => maskSpanM(b.geometry) - maskSpanM(a.geometry) || a.id.localeCompare(b.id));
  }, [masks, strictness, scaleHidden, selection, similar, order]);

  // In Propose the strip shows the reference objects the user has outlined; later it shows the selection.
  const refMasks = useMemo(
    () => references.map((r) => masks.find((m) => m.id === r.maskId)).filter((m): m is NonNullable<typeof m> => !!m && !m.deleted),
    [references, masks],
  );
  const isRefs = stage === 'propose';
  const list = isRefs ? refMasks : items;

  // Up to MAX_SHOWN thumbnails at a time. The window starts at the beginning unless the selected mask
  // lies beyond it, in which case it moves just far enough to include it.
  const pickedIdx = selection.picked.length ? list.findIndex((m) => m.id === selection.picked[selection.picked.length - 1]) : -1;
  const start = pickedIdx >= MAX_SHOWN ? Math.min(Math.max(0, pickedIdx - Math.floor(MAX_SHOWN / 2)), Math.max(0, list.length - MAX_SHOWN)) : 0;
  const shown = list.slice(start, start + MAX_SHOWN);
  const thumbs = useThumbs(shown);
  // Slide to the selected thumbnail's own place in the row (only if it isn't already in view).
  const lastPicked = selection.picked.length ? selection.picked[selection.picked.length - 1] : null;
  useEffect(() => {
    const row = rowRef.current;
    if (!row || !lastPicked) return;
    const tile = row.querySelector<HTMLElement>(`[data-mask-id="${CSS.escape(lastPicked)}"]`);
    if (!tile) return;
    const margin = 16;
    const visible = tile.offsetLeft - margin >= row.scrollLeft && tile.offsetLeft + tile.offsetWidth + margin <= row.scrollLeft + row.clientWidth;
    if (!visible) row.scrollTo({ left: tile.offsetLeft - (row.clientWidth - tile.offsetWidth) / 2, behavior: 'smooth' });
  }, [lastPicked, collapsed, start]);

  if (!active || (stage !== 'group' && stage !== 'clean' && stage !== 'propose') || list.length === 0) return null;

  const nPicked = selection.picked.length;
  const title = isRefs ? `Reference objects · ${list.length}` : `Selection · ${list.length} masks${nPicked ? ` · ${nPicked} picked` : ''}`;
  const clear = () => useInteractiveStore.getState().clearSelection();

  const select = (id: string, additive: boolean) => {
    const m = masks.find((x) => x.id === id);
    if (!isRefs) useInteractiveStore.getState().pickMask(id, additive);
    if (m) flyToMask(m.geometry);
  };

  return (
    <div
      style={{
        position: 'absolute', left: 76, right: 408, bottom: 12, zIndex: MAP_Z.dropdown,
        background: MC.panelBg, border: `1px solid ${MC.panelBorder}`, borderRadius: 8, boxShadow: MC.shadowMd, overflow: 'hidden',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 6px 4px 10px', background: MC.navBg, color: MC.navText }}>
        <span style={{ flex: 1, fontSize: 11, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' }}>
          {title}
        </span>
        {list.length > MAX_SHOWN && <span style={{ fontSize: 10, color: MC.navTextMuted }}>showing {start + 1}–{start + shown.length}</span>}
        {!isRefs && <button
          type="button"
          onClick={() => setOrder((o) => (o === 'nearby' ? 'size' : 'nearby'))}
          title={order === 'nearby' ? 'Ordered so masks that are close together are next to each other. Click to order by size.' : 'Ordered biggest first. Click to order by position.'}
          style={{ ...headerBtn, width: 'auto', padding: '0 8px', fontSize: 10, fontWeight: 700 }}
        >
          {order === 'nearby' ? 'Nearby first' : 'Biggest first'}
        </button>}
        <button type="button" onClick={() => setCollapsed((v) => !v)} aria-label={collapsed ? 'Expand gallery' : 'Collapse gallery'} style={headerBtn}>
          {collapsed ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        <button type="button" onClick={clear} aria-label="Close gallery" style={headerBtn}><X size={14} /></button>
      </div>
      {!collapsed && (
        <div ref={rowRef} style={{ display: 'flex', gap: 10, padding: '14px 12px 12px', overflowX: 'auto' }}>
          {shown.map((m) => {
            const src = thumbs[m.id];
            const cls = m.classId ? classes[m.classId] : null;
            const picked = selection.picked.includes(m.id);
            return (
              <div key={m.id} data-mask-id={m.id} style={{ position: 'relative', flexShrink: 0, width: TILE, height: TILE }}>
                <button
                  type="button"
                  onClick={(e) => select(m.id, e.shiftKey)}
                  aria-pressed={picked}
                  title={`${m.scale_m} m scale${m.flags.length ? (m.flags.includes('suspect') ? ' · looks unlike your examples' : ' · unusual for its group') : ''}${cls ? ` · ${cls.name}` : ''}`}
                  style={{
                    position: 'absolute', inset: 0, padding: 0, borderRadius: 6, overflow: 'hidden', cursor: 'pointer', background: MC.border,
                    border: `${picked ? 4 : 2}px solid ${picked ? '#ffffff' : m.flags.length ? MC.danger : MC.border}`,
                    outline: picked ? `3px solid ${MC.accent}` : 'none', outlineOffset: 1,
                    // A picked thumbnail lifts out of the row so it is found at a glance.
                    transform: picked ? 'scale(1.07)' : 'none', zIndex: picked ? 2 : 1,
                    boxShadow: picked ? '0 6px 18px rgba(36,44,32,0.55)' : 'none', transition: 'transform 0.12s, box-shadow 0.12s',
                  }}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  {src ? <img src={src} alt="" width={TILE} height={TILE} style={{ display: 'block', width: '100%', height: '100%', objectFit: 'cover' }} /> : <MaskShape geometry={m.geometry} />}
                  {m.flags.length > 0 && <span style={{ position: 'absolute', top: 3, left: 3, background: MC.danger, color: '#fff', fontSize: 11, fontWeight: 800, padding: '0 5px', borderRadius: 3 }}>!</span>}
                  {cls && <span style={{ position: 'absolute', bottom: 3, left: 3, right: 3, background: 'rgba(36,44,32,0.78)', color: '#fff', fontSize: 10, fontWeight: 600, padding: '1px 5px', borderRadius: 3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cls.name}</span>}
                </button>
                {isRefs && (
                  <button
                    type="button"
                    aria-label="Remove this reference object"
                    title="Remove this reference object"
                    onClick={() => { const r = references.find((x) => x.maskId === m.id); if (r) useInteractiveStore.getState().removeReference(r.id); }}
                    style={{ position: 'absolute', top: -9, right: -9, zIndex: 3, width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', background: MC.danger, color: '#fff', border: '2px solid #fff', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.45)', padding: 0 }}
                  >
                    <X size={14} strokeWidth={3} />
                  </button>
                )}
                {/* The cross appears on the selected thumbnail, like on a selected annotation square. */}
                {picked && m.source !== 'manual' && (
                  <button
                    type="button"
                    aria-label="Delete this mask"
                    title="Delete this mask (Delete)"
                    onClick={() => useInteractiveStore.getState().deleteMask(m.id)}
                    style={{ position: 'absolute', top: -9, right: -9, zIndex: 3, width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', background: MC.danger, color: '#fff', border: '2px solid #fff', cursor: 'pointer', boxShadow: '0 2px 6px rgba(0,0,0,0.45)', padding: 0 }}
                  >
                    <X size={14} strokeWidth={3} />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const headerBtn: React.CSSProperties = { width: 24, height: 24, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'transparent', border: 'none', color: '#e8d8bc', cursor: 'pointer' };

/** Stand-in tile before thumbnails exist (no look grouping yet): the mask's own outline. */
function MaskShape({ geometry }: { geometry: unknown }) {
  const ring = (geometry as { coordinates: number[][][] }).coordinates[0];
  const xs = ring.map((p) => p[0]);
  const ys = ring.map((p) => p[1]);
  const w = Math.max(...xs) - Math.min(...xs) || 1e-9;
  const h = Math.max(...ys) - Math.min(...ys) || 1e-9;
  const k = 70 / Math.max(w, h);
  const pts = ring.map(([x, y]) => `${(x - Math.min(...xs)) * k + 5},${(Math.max(...ys) - y) * k + 5}`).join(' ');
  return (
    <svg viewBox="0 0 80 80" width="100%" height="100%" aria-hidden="true" style={{ display: 'block', background: MC.inputBg }}>
      <polygon points={pts} fill="rgba(245,196,81,0.35)" stroke="#f5c451" strokeWidth={2} />
    </svg>
  );
}
