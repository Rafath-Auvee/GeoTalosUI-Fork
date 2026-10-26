'use client';

import type { CSSProperties, ReactNode } from 'react';
import { MC } from '../mapColors';

/** Field caption — same treatment as the AOI panel's field labels. */
export const caption: CSSProperties = {
  fontSize: 10, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase',
  color: MC.textMuted, display: 'block', marginBottom: 4,
};

export const note: CSSProperties = { fontSize: 10, color: MC.textMuted, margin: 0, lineHeight: 1.45 };

export function Chip({
  on, onClick, children, title, disabled,
}: { on?: boolean; onClick?: () => void; children: ReactNode; title?: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      aria-pressed={on}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{
        height: 26, minWidth: 40, padding: '0 9px', borderRadius: 5, fontSize: 11, fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
        border: `1px solid ${on ? MC.accent : MC.border}`,
        background: on ? MC.accentDim : 'transparent',
        color: on ? MC.text : MC.textSecondary,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        transition: 'background 0.12s, border-color 0.12s',
      }}
    >
      {children}
    </button>
  );
}

export function Button({
  children, onClick, primary, disabled, icon, title, fullWidth = true,
}: {
  children: ReactNode; onClick?: () => void; primary?: boolean; disabled?: boolean; icon?: ReactNode; title?: string; fullWidth?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
        width: fullWidth ? '100%' : undefined, height: 30, padding: '0 12px', borderRadius: 5,
        fontSize: 11, fontWeight: 600,
        border: `1px solid ${disabled ? MC.border : MC.accent}`,
        background: !disabled && primary ? MC.accent : 'transparent',
        color: disabled ? MC.textMuted : primary ? MC.navBg : MC.text,
        cursor: disabled ? 'not-allowed' : 'pointer', transition: 'background 0.12s',
      }}
    >
      {icon}
      {children}
    </button>
  );
}

export function Section({ label, children, right }: { label: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ ...caption, marginBottom: 0 }}>{label}</span>
        {right}
      </div>
      {children}
    </section>
  );
}
