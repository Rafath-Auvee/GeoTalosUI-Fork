/** Sorting shared by every list of rasters and annotation sets (Library, AOI picker). */
export type SortKey = 'modified' | 'created' | 'name';

export const SORT_OPTIONS: { id: SortKey; label: string }[] = [
  { id: 'modified', label: 'Recently modified' },
  { id: 'created', label: 'Newest first' },
  { id: 'name', label: 'Name A–Z' },
];

interface Sortable { name: string; created_at?: string | null; updated_at?: string | null }

const t = (v?: string | null) => (v ? Date.parse(v) || 0 : 0);

export function sortItems<T extends Sortable>(items: readonly T[], key: SortKey): T[] {
  const out = [...items];
  if (key === 'name') return out.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const when = (x: T) => (key === 'modified' ? t(x.updated_at) || t(x.created_at) : t(x.created_at));
  return out.sort((a, b) => when(b) - when(a));
}

/** "3 days ago", "just now"; empty when the date is unknown. */
export function ago(iso?: string | null): string {
  const ms = t(iso);
  if (!ms) return '';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 14) return `${Math.floor(s / 86400)} d ago`;
  if (s < 86400 * 60) return `${Math.floor(s / (86400 * 7))} wk ago`;
  if (s < 86400 * 365) return `${Math.floor(s / (86400 * 30.4))} mo ago`;
  return `${Math.floor(s / (86400 * 365))} y ago`;
}

export const fullDate = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : '');
