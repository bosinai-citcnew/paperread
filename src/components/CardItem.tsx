import { memo } from 'react';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { db } from '../db';
import { openReader } from '../App';
import Menu from './Menu';
import type { Card, CardKind, Column } from '../types';

export const KIND_LABEL: Record<CardKind, string> = {
  note: '筆記', paper: '論文', gap: '缺口', idea: '想法', quote: '引文', keep: 'Keep', voice: '語音',
};

/** Strip markdown syntax for plain previews. */
export function stripMd(s: string): string {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.|- \[[ x]\])\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

/** Order that places a card at the end of a column. */
export async function nextOrderEnd(columnId: string): Promise<number> {
  const list = await db.cards.where('columnId').equals(columnId).toArray();
  return list.length ? Math.max(...list.map(c => c.order)) + 1 : 0;
}

export async function moveCardToColumn(id: string, columnId: string) {
  const order = await nextOrderEnd(columnId);
  await db.cards.update(id, { columnId, order });
}

export async function deleteCardCascade(id: string) {
  await db.transaction('rw', db.cards, db.relations, async () => {
    await db.relations.where('from').equals(id).delete();
    await db.relations.where('to').equals(id).delete();
    await db.cards.delete(id);
  });
}

interface ViewProps {
  card: Card;
  columns?: Column[];
  onOpen?: (id: string) => void;
  dragging?: boolean;
  overlay?: boolean;
}

/** Pure visual card (also used inside DragOverlay). */
export function CardView({ card, columns, onOpen, dragging, overlay }: ViewProps) {
  const preview = stripMd(card.body);
  const p = card.paper;
  const meta = p && [p.authors?.[0], p.year].filter(Boolean).join(' · ');
  return (
    <div
      className={'board-card' + (dragging ? ' is-dragging' : '') + (overlay ? ' is-overlay' : '')}
      style={{ ['--kc' as string]: `var(--k-${card.kind})` }}
      onClick={() => onOpen?.(card.id)}
      role="button"
      tabIndex={0}
      onKeyDown={e => { if (e.key === 'Enter') onOpen?.(card.id); }}
    >
      <div className="board-card-head">
        <span className="board-card-kind"><i className="board-card-dot" />{KIND_LABEL[card.kind]}</span>
        {card.pinned && <span className="board-card-pin">已釘選</span>}
        {!overlay && (
          <Menu small label="更多" items={[
            { label: '精讀', hidden: card.kind !== 'paper', onClick: () => openReader(card.id) },
            { label: card.pinned ? '取消釘選' : '釘選', onClick: () => { void db.cards.update(card.id, { pinned: !card.pinned }); } },
            { title: '移到欄位' },
            ...(columns ?? []).map(c => ({
              label: c.name + (c.id === card.columnId ? '（目前）' : ''), disabled: c.id === card.columnId,
              onClick: () => { void moveCardToColumn(card.id, c.id); },
            })),
            'sep',
            { label: '刪除', danger: true, onClick: () => { if (confirm(`刪除「${card.title || '無標題'}」？`)) void deleteCardCascade(card.id); } },
          ]} />
        )}
      </div>
      <div className="board-card-title">{card.title || '（無標題）'}</div>
      {meta && <div className="board-card-meta">{meta}</div>}
      {preview && <div className="board-card-body">{preview}</div>}
      {card.tags.length > 0 && (
        <div className="board-card-tags">
          {card.tags.slice(0, 3).map(t => <span key={t} className="tag">#{t}</span>)}
          {card.tags.length > 3 && <span className="tag">+{card.tags.length - 3}</span>}
        </div>
      )}
    </div>
  );
}

interface ItemProps {
  card: Card;
  columns: Column[];
  onOpen: (id: string) => void;
  disabled?: boolean;
}

function CardItemInner({ card, columns, onOpen, disabled }: ItemProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: card.id, disabled, data: { type: 'card' },
  });
  return (
    <div
      ref={setNodeRef}
      className="board-card-wrap"
      style={{ transform: CSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
    >
      <CardView card={card} columns={columns} onOpen={onOpen} dragging={isDragging} />
    </div>
  );
}

const CardItem = memo(CardItemInner);
export default CardItem;
