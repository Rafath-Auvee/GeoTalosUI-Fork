'use client';

import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { MC } from '../mapColors';

/** Client-side paging for a list that is already loaded. Goes back to page 1 when `resetKey` changes. */
export function usePaged<T>(items: readonly T[], pageSize: number, resetKey: string) {
  const [page, setPage] = useState(0);
  useEffect(() => { setPage(0); }, [resetKey]);
  const pages = Math.max(1, Math.ceil(items.length / pageSize));
  const safe = Math.min(page, pages - 1);
  const pageItems = useMemo(() => items.slice(safe * pageSize, safe * pageSize + pageSize), [items, safe, pageSize]);
  return { page: safe, setPage, pages, pageItems, total: items.length, pageSize };
}

const btn = (disabled: boolean) => ({
  width: 26, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', borderRadius: 5,
  border: `1px solid ${MC.border}`, background: 'transparent', color: disabled ? MC.textMuted : MC.text,
  cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
}) as const;

export function Pager({ page, pages, total, pageSize, onPage }: { page: number; pages: number; total: number; pageSize: number; onPage: (p: number) => void }) {
  if (total <= pageSize) return null;
  const from = page * pageSize + 1;
  const to = Math.min(total, from + pageSize - 1);
  return (
    <nav aria-label="Pagination" style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderTop: `1px solid ${MC.border}`, flexShrink: 0 }}>
      <span style={{ flex: 1, fontSize: 11, color: MC.textSecondary, fontVariantNumeric: 'tabular-nums' }}>
        {from}–{to} of {total.toLocaleString()}
      </span>
      <button type="button" aria-label="Previous page" disabled={page === 0} onClick={() => onPage(page - 1)} style={btn(page === 0)}><ChevronLeft size={13} /></button>
      <span style={{ fontSize: 11, color: MC.textSecondary, fontVariantNumeric: 'tabular-nums', minWidth: 44, textAlign: 'center' }}>
        {page + 1} / {pages}
      </span>
      <button type="button" aria-label="Next page" disabled={page >= pages - 1} onClick={() => onPage(page + 1)} style={btn(page >= pages - 1)}><ChevronRight size={13} /></button>
    </nav>
  );
}
