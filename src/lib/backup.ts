import type { Table } from 'dexie';
import { db, DEFAULT_SETTINGS } from '../db';
import type { Card, Column, PaperDoc, Relation, Settings, Topic } from '../types';

export const BACKUP_VERSION = 1;

export type BackupSettings = Omit<Settings, 'llmApiKey' | 'openalexApiKey'>;

export interface BackupFile {
  version: typeof BACKUP_VERSION;
  exportedAt: string;
  cards: Card[];
  columns: Column[];
  topics: Topic[];
  relations: Relation[];
  papers: PaperDoc[];
  settings: BackupSettings | null; // llmApiKey and openalexApiKey are never exported
}

export interface ImportCounts { added: number; updated: number; skipped: number }

function backupFilename(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `paperread-backup-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
}

/** Export every table as one JSON blob (API key excluded). */
export async function exportAll(): Promise<Blob> {
  const [cards, columns, topics, relations, papers, settings] = await Promise.all([
    db.cards.toArray(),
    db.columns.toArray(),
    db.topics.toArray(),
    db.relations.toArray(),
    db.papers.toArray(),
    db.settings.get('settings'),
  ]);
  let safeSettings: BackupSettings | null = null;
  if (settings) {
    const copy: Partial<Settings> = { ...settings };
    delete copy.llmApiKey;
    delete copy.openalexApiKey;
    safeSettings = copy as BackupSettings;
  }
  const data: BackupFile = {
    version: BACKUP_VERSION,
    exportedAt: new Date().toISOString(),
    cards,
    columns,
    topics,
    relations,
    papers,
    settings: safeSettings,
  };
  return new Blob([JSON.stringify(data)], { type: 'application/json' });
}

function saveBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Download the backup as a file. */
export async function downloadBackup(): Promise<void> {
  saveBlob(await exportAll(), backupFilename());
}

/**
 * Share the backup file via the OS share sheet (e.g. "儲存到 Google Drive" on Android).
 * Falls back to a download when file sharing is unavailable.
 */
export async function shareBackup(): Promise<'shared' | 'downloaded' | 'cancelled'> {
  const blob = await exportAll();
  const name = backupFilename();
  const file = new File([blob], name, { type: 'application/json' });
  if (typeof navigator !== 'undefined' && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'PaperRead 備份' });
      return 'shared';
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return 'cancelled';
      throw err;
    }
  }
  saveBlob(blob, name);
  return 'downloaded';
}

/**
 * Merge a backup file into the local database.
 * - Tables with updatedAt (cards, topics, papers): incoming row wins only if its updatedAt is newer.
 * - Tables without updatedAt (columns, relations): put only if the id is missing locally.
 * - Settings: non-secret fields are taken from the file; the local llmApiKey and openalexApiKey are kept.
 */
export async function importBackup(file: File): Promise<ImportCounts> {
  let data: Partial<BackupFile>;
  try {
    data = JSON.parse(await file.text()) as Partial<BackupFile>;
  } catch {
    throw new Error('備份檔不是有效的 JSON');
  }
  if (!data || data.version !== BACKUP_VERSION) {
    throw new Error('不是有效的 PaperRead 備份檔（版本不符）');
  }

  const counts: ImportCounts = { added: 0, updated: 0, skipped: 0 };

  async function mergeTimed<T extends { id: string; updatedAt: number }>(table: Table<T, string>, rows: T[] | undefined) {
    const incoming = rows ?? [];
    const locals = await table.bulkGet(incoming.map(r => r.id));
    const toPut: T[] = [];
    incoming.forEach((row, i) => {
      const local = locals[i];
      if (!local) { toPut.push(row); counts.added++; }
      else if (row.updatedAt > local.updatedAt) { toPut.push(row); counts.updated++; }
      else counts.skipped++;
    });
    if (toPut.length) await table.bulkPut(toPut);
  }

  async function mergeUntimed<T extends { id: string }>(table: Table<T, string>, rows: T[] | undefined) {
    const incoming = rows ?? [];
    const locals = await table.bulkGet(incoming.map(r => r.id));
    const toPut: T[] = [];
    incoming.forEach((row, i) => {
      if (!locals[i]) { toPut.push(row); counts.added++; }
      else counts.skipped++;
    });
    if (toPut.length) await table.bulkPut(toPut);
  }

  await db.transaction('rw', [db.cards, db.columns, db.topics, db.relations, db.papers, db.settings], async () => {
    await mergeTimed(db.cards, data.cards);
    await mergeUntimed(db.columns, data.columns);
    await mergeTimed(db.topics, data.topics);
    await mergeUntimed(db.relations, data.relations);
    await mergeTimed(db.papers, data.papers);

    if (data.settings) {
      const local = (await db.settings.get('settings')) ?? DEFAULT_SETTINGS;
      const incoming: Partial<Settings> = { ...data.settings };
      delete incoming.llmApiKey;
      delete incoming.openalexApiKey;
      await db.settings.put({
        ...local,
        ...incoming,
        id: 'settings',
        llmApiKey: local.llmApiKey,
        openalexApiKey: local.openalexApiKey,
      });
      counts.updated++;
    }
  });
  return counts;
}
