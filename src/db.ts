import Dexie, { type Table } from 'dexie';
import type { Card, Column, Topic, Relation, PaperDoc, Settings, FullText } from './types';

class PaperReadDB extends Dexie {
  cards!: Table<Card, string>;
  columns!: Table<Column, string>;
  topics!: Table<Topic, string>;
  relations!: Table<Relation, string>;
  papers!: Table<PaperDoc, string>;
  settings!: Table<Settings, string>;
  fulltexts!: Table<FullText, string>;

  constructor() {
    super('paperread');
    this.version(1).stores({
      cards: 'id, kind, columnId, topicId, updatedAt, *tags, paper.openalexId, paper.doi',
      columns: 'id, order',
      topics: 'id, updatedAt',
      relations: 'id, topicId, from, to, type',
      papers: 'id, topicId, updatedAt',
      settings: 'id',
    });
    this.version(2).stores({
      cards: 'id, kind, columnId, topicId, order, updatedAt, *tags, paper.openalexId, paper.doi, [columnId+order]',
    });
    this.version(3).stores({ fulltexts: 'cardId' });
  }
}

export const db = new PaperReadDB();

export const uid = () =>
  (crypto.randomUUID?.() ?? Math.random().toString(36).slice(2) + Date.now().toString(36));

export const DEFAULT_COLUMNS: Column[] = [
  { id: 'inbox', name: '收件匣', order: 0 },
  { id: 'reading', name: '閱讀中', order: 1 },
  { id: 'key', name: '重點', order: 2 },
  { id: 'done', name: '已整理', order: 3 },
];

export const DEFAULT_SETTINGS: Settings = {
  id: 'settings',
  llmBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  llmApiKey: '',
  llmModel: 'gemini-2.5-flash',
  language: 'zh-TW',
  voiceLang: 'zh-TW',
};

export async function ensureSeed() {
  if ((await db.columns.count()) === 0) await db.columns.bulkPut(DEFAULT_COLUMNS);
  if (!(await db.settings.get('settings'))) await db.settings.put(DEFAULT_SETTINGS);
}

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get('settings')) ?? DEFAULT_SETTINGS;
}

/** Create a card with sane defaults; returns the stored card. Puts it at top of its column. */
export async function addCard(partial: Partial<Card> & Pick<Card, 'title'>): Promise<Card> {
  const now = Date.now();
  const columnId = partial.columnId ?? 'inbox';
  const first = await db.cards.where('columnId').equals(columnId).sortBy('order');
  const card: Card = {
    id: uid(),
    kind: 'note',
    body: '',
    tags: [],
    order: first.length ? first[0].order - 1 : 0,
    createdAt: now,
    updatedAt: now,
    ...partial,
    columnId,
  };
  await db.cards.put(card);
  return card;
}

export async function updateCard(id: string, patch: Partial<Card>) {
  await db.cards.update(id, { ...patch, updatedAt: Date.now() });
}
