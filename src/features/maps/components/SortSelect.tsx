'use client';

import { ArrowDownWideNarrow } from 'lucide-react';
import { MC } from '../mapColors';
import { SORT_OPTIONS, type SortKey } from '../utils/sortData';

/** Compact sort control used above the Library lists and in the AOI data picker. */
export function SortSelect({ value, onChange, height = 28 }: { value: SortKey; onChange: (k: SortKey) => void; height?: number }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height, padding: '0 8px', borderRadius: 5, border: `1px solid ${MC.inputBorder}`, background: MC.inputBg, color: MC.textSecondary, fontSize: 11, fontWeight: 600 }}>
      <ArrowDownWideNarrow size={12} aria-hidden="true" />
      <span className="sr-only">Sort by</span>
      <select
        aria-label="Sort by"
        value={value}
        onChange={(e) => onChange(e.target.value as SortKey)}
        style={{ background: 'transparent', border: 'none', outline: 'none', color: MC.text, fontSize: 11, fontWeight: 600, cursor: 'pointer' }}
      >
        {SORT_OPTIONS.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
      </select>
    </label>
  );
}
