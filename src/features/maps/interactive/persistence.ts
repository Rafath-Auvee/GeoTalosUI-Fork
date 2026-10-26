/**
 * Local-only draft storage (IndexedDB). A draft never leaves the browser; it
 * exists so a long cleaning session survives a reload or crash. Everything
 * here is best-effort: private windows or blocked storage just mean no restore.
 */
import type { CleanTarget, DraftMask, GroupMode, LabelClass, ReferenceObject, Stage } from './types';

const DB_NAME = 'af-interactive-drafts';
const STORE = 'drafts';
const VERSION = 1;

export interface PersistedDraft {
  version: 1;
  savedAt: number;
  stage: Stage;
  scales: number[];
  strictness: number;
  masks: DraftMask[];
  references?: ReferenceObject[];
  scalesAuto?: boolean;
  group?: { jobId: string | null; mode: GroupMode; k: number };
  classes?: Record<string, LabelClass>;
  labelSchemaId?: string | null;
  /** Set when the draft edits an existing annotation set in place. */
  target?: CleanTarget | null;
}

export function draftKey(mapId: string, aoiLayerId: string): string {
  return `${mapId}:${aoiLayerId}`;
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) {
      reject(e);
    }
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T | null> {
  try {
    const db = await open();
    return await new Promise<T | null>((resolve) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
      tx.oncomplete = () => db.close();
    });
  } catch {
    return null;
  }
}

export const saveDraft = (key: string, draft: PersistedDraft) => run('readwrite', (s) => s.put(draft, key));
export const deleteDraft = (key: string) => run('readwrite', (s) => s.delete(key));
export const loadDraft = (key: string) => run<PersistedDraft>('readonly', (s) => s.get(key));

export { VERSION as DRAFT_DB_VERSION };
