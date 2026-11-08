import JSZip from 'jszip';
import { db, uid } from '../db';
import type { Card } from '../types';

/** Google Keep note as exported by Google Takeout (Keep/*.json). Only fields we use are typed. */
interface KeepListItem { text?: string; isChecked?: boolean }
interface KeepNote {
  title?: string;
  textContent?: string;
  listContent?: KeepListItem[];
  labels?: { name?: string }[];
  isTrashed?: boolean;
  isArchived?: boolean;
  isPinned?: boolean;
  createdTimestampUsec?: number;
  userEditedTimestampUsec?: number;
  color?: string;
}

export interface KeepImportResult { imported: number; skipped: number }

const KEEP_ENTRY = /Keep\/.*\.json$/i;

function usecToMs(usec: unknown): number | undefined {
  const n = typeof usec === 'string' ? Number(usec) : usec;
  return typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.round(n / 1000) : undefined;
}

function parseNotes(text: string): KeepNote[] {
  try {
    const data: unknown = JSON.parse(text.replace(/^﻿/, ''));
    const list = Array.isArray(data) ? data : [data];
    return list.filter((x): x is KeepNote => typeof x === 'object' && x !== null);
  } catch {
    return [];
  }
}

function firstLine(s: string): string {
  return s.split('\n').map(l => l.trim()).find(Boolean) ?? '';
}

function noteToCard(note: KeepNote, now: number): Card {
  const createdAt = usecToMs(note.createdTimestampUsec) ?? now;
  const updatedAt = usecToMs(note.userEditedTimestampUsec) ?? createdAt;
  const text = (note.textContent ?? '').trim();
  const listLines = (note.listContent ?? []).flatMap(item => {
    const t = item.text?.trim();
    return t ? [`- [${item.isChecked ? 'x' : ' '}] ${t}`] : [];
  });
  const body = [text, listLines.join('\n')].filter(Boolean).join('\n\n');
  const title = note.title?.trim()
    || firstLine(text)
    || (note.listContent?.find(i => i.text?.trim())?.text?.trim() ?? '')
    || '未命名 Keep 筆記';
  const labels = (note.labels ?? []).map(l => l.name?.trim() ?? '').filter(Boolean);
  const tags = [...new Set([...labels, 'keep'])];

  const card: Card = {
    id: uid(),
    kind: 'keep',
    title,
    body,
    tags,
    columnId: 'inbox',
    order: 0, // assigned by caller
    source: 'keep',
    createdAt,
    updatedAt,
  };
  if (note.isPinned) card.pinned = true;
  return card;
}

/** Dedupe key: Keep notes are identified by title + creation time. */
const keyOf = (title: string, createdAt: number) => `${title}\u0000${createdAt}`;

/**
 * Imports Google Keep notes from a Takeout .zip (entries matching Keep/*.json) and/or
 * loose .json files. Trashed notes are skipped; notes already imported (source 'keep',
 * same title + createdAt) are skipped. Archived notes are imported.
 */
export async function importKeepFiles(files: File[]): Promise<KeepImportResult> {
  const notes: KeepNote[] = [];
  for (const file of files) {
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      const zip = await JSZip.loadAsync(file);
      const entries = Object.values(zip.files).filter(f => !f.dir && KEEP_ENTRY.test(f.name));
      for (const entry of entries) notes.push(...parseNotes(await entry.async('string')));
    } else if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      notes.push(...parseNotes(await file.text()));
    }
  }

  const existing = await db.cards.filter(c => c.source === 'keep').toArray();
  const seen = new Set(existing.map(c => keyOf(c.title, c.createdAt)));
  const inbox = await db.cards.where('columnId').equals('inbox').sortBy('order');
  let order = inbox.length ? inbox[0].order : 0;

  const now = Date.now();
  const cards: Card[] = [];
  let skipped = 0;
  for (const note of notes) {
    if (note.isTrashed) { skipped++; continue; }
    const card = noteToCard(note, now);
    const key = keyOf(card.title, card.createdAt);
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    order -= 1;
    card.order = order;
    cards.push(card);
  }
  if (cards.length) await db.cards.bulkPut(cards);
  return { imported: cards.length, skipped };
}

/** Plain text suitable for pasting into Google Keep (title, then body; checklists as ☐/☑). */
export function cardToKeepText(card: Pick<Card, 'title' | 'body'>): string {
  const body = card.body
    .split('\n')
    .map(line => line
      .replace(/^\s*- \[x\]\s?/i, '☑ ')
      .replace(/^\s*- \[ \]\s?/, '☐ ')
      .replace(/^#{1,6}\s+/, '')
      .replace(/\*\*(.+?)\*\*/g, '$1'))
    .join('\n')
    .trim();
  return [card.title.trim(), body].filter(Boolean).join('\n\n');
}
