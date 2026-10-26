'use client';

import { cloneElement, isValidElement, useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, Info } from 'lucide-react';
import { MC } from '../../mapColors';
import type { BandInfo } from '@/types/api';

/** Human label for a raster band — shared by every band picker. */
export function bandLabel(band: BandInfo): string {
  if (band.spectral_name) return `${band.index}: ${band.spectral_name}`;
  if (band.description) return `${band.index}: ${band.description}`;
  return `Band ${band.index}`;
}

/** Hover / focus bubble drawn in a portal, so no panel's overflow can clip it. */
function useBubble<T extends HTMLElement = HTMLButtonElement>(text: string) {
  const ref = useRef<T>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (r) setPos({ x: Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150), y: r.top });
  };
  const hide = () => setPos(null);
  const bubble = pos && typeof document !== 'undefined' ? createPortal(
    <div
      role="tooltip"
      style={{
        position: 'fixed', left: pos.x, top: pos.y - 8, transform: 'translate(-50%, -100%)', zIndex: 2400,
        width: 'max-content', maxWidth: 280, padding: '7px 10px', borderRadius: 6, pointerEvents: 'none',
        background: '#1f2619', color: '#f1ede2', fontSize: 12, fontWeight: 500, lineHeight: 1.45,
        textTransform: 'none', letterSpacing: 0, boxShadow: '0 6px 20px rgba(0,0,0,0.3)',
      }}
    >
      {text}
    </div>,
    document.body,
  ) : null;
  const handlers = {
    onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide,
    onKeyDown: (e: React.KeyboardEvent) => { if (e.key === 'Escape') hide(); },
  };
  return { ref, bubble, handlers, hide };
}

/** A small "i" that explains something on hover or keyboard focus, so the explanation does not take space on the page. */
export function InfoTip({ text, size = 13 }: { text: string; size?: number }) {
  const { ref, bubble, handlers } = useBubble(text);
  return (
    <>
      <button
        ref={ref}
        type="button"
        aria-label={text}
        {...handlers}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          width: size + 4, height: size + 4, padding: 0, border: 'none', background: 'transparent',
          color: MC.textMuted, cursor: 'help', borderRadius: '50%',
        }}
      >
        <Info size={size} />
      </button>
      {bubble}
    </>
  );
}

/** Wraps any small element (an icon, a badge) so a short explanation appears on hover. */
export function Tip({ text, children }: { text: string; children: React.ReactNode }) {
  const { ref, bubble, handlers } = useBubble<HTMLSpanElement>(text);
  return (
    <>
      <span ref={ref} {...handlers} style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0, cursor: 'default' }}>{children}</span>
      {bubble}
    </>
  );
}

/** Closes a popover or menu on an outside click or Escape. Attach the returned ref to the element that wraps both trigger and popover. */
export function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) close(); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => { document.removeEventListener('mousedown', onDown); window.removeEventListener('keydown', onKey, true); };
  }, [open, close]);
  return ref;
}

/** Style of a small popover or menu panel. Position it with top / left / right. */
export const popoverStyle: React.CSSProperties = {
  position: 'absolute', zIndex: 20, background: MC.panelBg, border: `1px solid ${MC.border}`, borderRadius: 8,
  boxShadow: '0 8px 24px rgba(0,0,0,0.2)', padding: 4,
};

/** One row of a "…" menu. */
export function MenuItem({ icon, label, hint, onClick, danger, disabled }: {
  icon: React.ReactNode; label: string; hint?: string; onClick: () => void; danger?: boolean; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 8, width: '100%', textAlign: 'left', padding: '7px 10px', borderRadius: 5,
        border: 'none', background: 'transparent', color: danger ? '#dc2626' : MC.text, fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
      }}
    >
      <span style={{ display: 'flex', flexShrink: 0 }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>{label}</span>
      {hint && <span style={{ fontSize: 12, color: MC.textMuted }}>{hint}</span>}
    </button>
  );
}

/** An icon-only button whose name appears on hover or focus. */
export function IconButton({
  label, onClick, children, active, danger, disabled, size = 28, type = 'button',
}: {
  label: string; onClick?: () => void; children: React.ReactNode; active?: boolean; danger?: boolean;
  disabled?: boolean; size?: number; type?: 'button' | 'submit';
}) {
  const { ref, bubble, handlers, hide } = useBubble(label);
  const tone = danger ? '#dc2626' : MC.text;
  return (
    <>
      <button
        ref={ref}
        type={type}
        aria-label={label}
        aria-pressed={active}
        disabled={disabled}
        onClick={() => { hide(); onClick?.(); }}
        {...handlers}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
          width: size, height: size, padding: 0, borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer',
          border: `1px solid ${active ? (danger ? '#dc2626' : MC.accent) : MC.border}`,
          background: active ? (danger ? 'rgba(220,38,38,0.12)' : MC.accentDim) : 'transparent',
          color: disabled ? MC.textMuted : tone, opacity: disabled ? 0.5 : 1,
        }}
      >
        {children}
      </button>
      {bubble}
    </>
  );
}

/** Field caption + control. Ties the label to its first child via htmlFor. `hint` is shown behind an info icon. */
export function PanelField({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  const id = useId();
  const child = isValidElement<{ id?: string }>(children)
    ? cloneElement(children, { id: children.props.id ?? id })
    : children;
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 2, marginBottom: 3 }}>
        <label
          htmlFor={id}
          style={{
            fontSize: 10, fontWeight: 700, letterSpacing: '0.06em',
            textTransform: 'uppercase', color: MC.textMuted,
          }}
        >
          {label}
        </label>
        {hint && <InfoTip text={hint} size={12} />}
      </div>
      {child}
    </div>
  );
}

type SelectProps = Omit<React.SelectHTMLAttributes<HTMLSelectElement>, 'style'> & {
  height?: number;
};

/** Native select with the panel look: one height, one chevron. */
export function PanelSelect({ height = 28, children, ...rest }: SelectProps) {
  return (
    <div style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <select
        {...rest}
        style={{
          width: '100%', height, fontSize: 11, padding: '0 20px 0 8px',
          borderRadius: 4, border: `1px solid ${MC.border}`,
          background: MC.inputBg, color: MC.text, cursor: 'pointer',
          appearance: 'none', outline: 'none',
        }}
      >
        {children}
      </select>
      <ChevronDown
        size={10}
        style={{
          position: 'absolute', right: 6, top: '50%',
          transform: 'translateY(-50%)', color: MC.textMuted, pointerEvents: 'none',
        }}
      />
    </div>
  );
}

/** Band dropdown row used for RGB channels and spectral-index roles. */
export function BandSelectRow({
  label, color, labelWidth = 16, bands, value, onChange,
}: {
  label: string;
  color?: string;
  labelWidth?: number;
  bands: BandInfo[];
  value: number;
  onChange: (index: number) => void;
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
      <span style={{
        width: labelWidth, fontSize: 11, fontWeight: 700, flexShrink: 0,
        color: color ?? MC.textSecondary, textAlign: 'center',
      }}>
        {label}
      </span>
      <PanelSelect
        height={26}
        aria-label={`${label} band`}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        onClick={(e) => e.stopPropagation()}
      >
        {bands.map((b) => (
          <option key={b.index} value={b.index}>{bandLabel(b)}</option>
        ))}
      </PanelSelect>
    </div>
  );
}
