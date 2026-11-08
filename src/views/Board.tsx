import { useCallback, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import {
  DndContext, DragOverlay, KeyboardSensor, PointerSensor, TouchSensor, closestCenter, closestCorners,
  pointerWithin, useSensor, useSensors,
  type CollisionDetection, type DragEndEvent, type DragOverEvent, type DragStartEvent,
} from '@dnd-kit/core';
import {
  SortableContext, arrayMove, horizontalListSortingStrategy, sortableKeyboardCoordinates,
  useSortable, verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { addCard, db, uid } from '../db';
import type { Card, CardKind, Column } from '../types';
import CardItem, { CardView, KIND_LABEL } from '../components/CardItem';
import CardEditor from '../components/CardEditor';
import Icon from '../components/Icons';
import Menu from '../components/Menu';
import Sheet from '../components/Sheet';
import './board.css';

const COL = 'col:';
const isCol = (id: unknown) => String(id).startsWith(COL);

function midOrder(prev?: number, next?: number): number {
  if (prev != null && next != null) return (prev + next) / 2;
  if (prev != null) return prev + 1;
  if (next != null) return next - 1;
  return 0;
}

const collision: CollisionDetection = args => {
  if (isCol(args.active.id)) {
    return closestCenter({ ...args, droppableContainers: args.droppableContainers.filter(c => isCol(c.id)) });
  }
  const hits = pointerWithin(args);
  if (hits.length) {
    const cardHit = hits.filter(h => !isCol(h.id));
    return cardHit.length ? cardHit : hits;
  }
  return closestCorners(args);
};

export default function Board() {
  const columns = useLiveQuery(() => db.columns.orderBy('order').toArray(), []) ?? [];
  const cards = useLiveQuery(() => db.cards.orderBy('order').toArray(), []) ?? [];
  const topics = useLiveQuery(() => db.topics.toArray(), []) ?? [];

  const [q, setQ] = useState('');
  const [kind, setKind] = useState<CardKind | ''>('');
  const [tag, setTag] = useState('');
  const [topic, setTopic] = useState('');
  const [sort, setSort] = useState<'manual' | 'latest'>('manual');
  const [filterOpen, setFilterOpen] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [activeCol, setActiveCol] = useState(0);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [dragItems, setDragItems] = useState<Record<string, string[]> | null>(null);
  const startRef = useRef<{ col: string; idx: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const cardMap = useMemo(() => new Map(cards.map(c => [c.id, c])), [cards]);
  const allTags = useMemo(() => [...new Set(cards.flatMap(c => c.tags))].sort(), [cards]);

  const base = useMemo(() => {
    const s = q.trim().toLowerCase();
    const out: Record<string, string[]> = {};
    columns.forEach(c => { out[c.id] = []; });
    const inbox = columns.find(c => c.id === 'inbox')?.id ?? columns[0]?.id;
    const list = cards.filter(c => c.columnId !== 'library' &&
      (!kind || c.kind === kind) && (!tag || c.tags.includes(tag)) && (!topic || c.topicId === topic) &&
      (!s || c.title.toLowerCase().includes(s) || c.body.toLowerCase().includes(s) ||
        c.tags.some(t => t.toLowerCase().includes(s))));
    if (sort === 'latest') list.sort((a, b) => b.updatedAt - a.updatedAt);
    for (const c of list) (out[c.columnId] ?? out[inbox!])?.push(c.id);
    return out;
  }, [cards, columns, q, kind, tag, topic, sort]);

  const lists = dragItems ?? base;
  const activeFilters = (kind ? 1 : 0) + (tag ? 1 : 0) + (topic ? 1 : 0) + (sort !== 'manual' ? 1 : 0);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const findContainer = (id: string, l: Record<string, string[]>) =>
    isCol(id) ? String(id).slice(COL.length) : Object.keys(l).find(k => l[k].includes(id));

  const onDragStart = (e: DragStartEvent) => {
    const id = String(e.active.id);
    setActiveId(id);
    if (!isCol(id)) {
      const col = findContainer(id, base)!;
      startRef.current = { col, idx: base[col].indexOf(id) };
      setDragItems(base);
    }
  };

  const onDragOver = (e: DragOverEvent) => {
    const { active, over } = e;
    if (!over || isCol(active.id) || !dragItems) return;
    const aId = String(active.id), oId = String(over.id);
    const from = findContainer(aId, dragItems), to = findContainer(oId, dragItems);
    if (!from || !to || from === to) return;
    const target = dragItems[to].filter(i => i !== aId);
    let idx = target.length;
    if (!isCol(oId)) {
      const oi = target.indexOf(oId);
      const r = active.rect.current.translated;
      const below = !!r && r.top > over.rect.top + over.rect.height / 2;
      idx = oi + (below ? 1 : 0);
    }
    target.splice(idx, 0, aId);
    setDragItems({ ...dragItems, [from]: dragItems[from].filter(i => i !== aId), [to]: target });
  };

  const renormalize = async (colId: string) => {
    const list = (await db.cards.where('columnId').equals(colId).sortBy('order'));
    await db.cards.bulkUpdate(list.map((c, i) => ({ key: c.id, changes: { order: i } })));
  };

  const onDragEnd = async (e: DragEndEvent) => {
    const { active, over } = e;
    const aId = String(active.id);
    setActiveId(null);
    const items = dragItems;
    setDragItems(null);
    if (!over) return;
    const oId = String(over.id);

    if (isCol(aId)) {
      if (!isCol(oId) || aId === oId) return;
      const ids = columns.map(c => COL + c.id);
      const from = ids.indexOf(aId), to = ids.indexOf(oId);
      const moved = arrayMove(columns, from, to);
      const i = moved.findIndex(c => COL + c.id === aId);
      await db.columns.update(aId.slice(COL.length), {
        order: midOrder(moved[i - 1]?.order, moved[i + 1]?.order),
      });
      return;
    }

    if (!items) return;
    let list = items;
    const col = findContainer(aId, items);
    if (!col) return;
    if (!isCol(oId) && findContainer(oId, items) === col) {
      const oi = items[col].indexOf(oId), ai = items[col].indexOf(aId);
      if (oi !== ai) list = { ...items, [col]: arrayMove(items[col], ai, oi) };
    }
    const arr = list[col];
    const idx = arr.indexOf(aId);
    const st = startRef.current;
    if (st && st.col === col && st.idx === idx) return;
    if (sort === 'latest' && st?.col === col) return;
    const prev = arr[idx - 1] ? cardMap.get(arr[idx - 1])?.order : undefined;
    const next = arr[idx + 1] ? cardMap.get(arr[idx + 1])?.order : undefined;
    const order = midOrder(prev, next);
    await db.cards.update(aId, { columnId: col, order });
    if (prev != null && next != null && Math.abs(next - prev) < 1e-9) await renormalize(col);
  };

  const onDragCancel = () => { setActiveId(null); setDragItems(null); };

  const onScroll = () => {
    const el = scrollRef.current;
    if (el && el.clientWidth) setActiveCol(Math.round(el.scrollLeft / el.clientWidth));
  };
  const goCol = (i: number) => {
    setActiveCol(i);
    const el = scrollRef.current;
    el?.scrollTo({ left: i * el.clientWidth, behavior: 'smooth' });
  };

  const open = useCallback((id: string) => setEditing(id), []);
  const dragging = activeId != null;
  const activeCard = activeId && !isCol(activeId) ? cardMap.get(activeId) : undefined;
  const activeColumn = activeId && isCol(activeId) ? columns.find(c => COL + c.id === activeId) : undefined;

  const addColumn = async () => {
    const name = prompt('新欄位名稱')?.trim();
    if (!name) return;
    await db.columns.put({ id: uid(), name, order: (columns.at(-1)?.order ?? -1) + 1 });
  };
  const renameColumn = async (c: Column) => {
    const name = prompt('欄位名稱', c.name)?.trim();
    if (name) await db.columns.update(c.id, { name });
  };
  const deleteColumn = async (c: Column) => {
    if (c.id === 'inbox') return;
    if (!confirm(`刪除欄位「${c.name}」？其中的卡片會移到收件匣。`)) return;
    await db.transaction('rw', db.cards, db.columns, async () => {
      const inbox = await db.cards.where('columnId').equals('inbox').toArray();
      let o = inbox.length ? Math.max(...inbox.map(x => x.order)) + 1 : 0;
      const moving = await db.cards.where('columnId').equals(c.id).sortBy('order');
      for (const m of moving) await db.cards.update(m.id, { columnId: 'inbox', order: o++ });
      await db.columns.delete(c.id);
    });
  };
  const shiftColumn = async (c: Column, dir: -1 | 1) => {
    const i = columns.findIndex(x => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= columns.length) return;
    const moved = arrayMove(columns, i, j);
    await db.columns.update(c.id, { order: midOrder(moved[j - 1]?.order, moved[j + 1]?.order) });
  };

  const addToColumn = useCallback(async (columnId: string, title: string) => {
    await addCard({ title, columnId, topicId: topic || undefined });
  }, [topic]);

  const colIds = columns.map(c => COL + c.id);

  return (
    <div className="board-root">
      <div className="board-bar">
        <div className="search board-search">
          <Icon name="search" size={20} />
          <input className="input" type="search" placeholder="搜尋標題、內容、標籤…" value={q} onChange={e => setQ(e.target.value)} />
        </div>
        <button className="icon-btn board-filter-btn" aria-label="篩選" onClick={() => setFilterOpen(true)}>
          <Icon name="filter" />{activeFilters > 0 && <span className="badge">{activeFilters}</span>}
        </button>
      </div>

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="篩選與排序"
        footer={<>
          <button className="btn" onClick={() => { setKind(''); setTag(''); setTopic(''); setSort('manual'); }}>重設</button>
          <button className="btn btn-primary" onClick={() => setFilterOpen(false)}>完成</button>
        </>}>
        <div className="section-label" style={{ marginTop: 0 }}>類型</div>
        <div className="chips">
          <button className={'chip' + (!kind ? ' on' : '')} onClick={() => setKind('')}>全部</button>
          {(Object.keys(KIND_LABEL) as CardKind[]).map(k => (
            <button key={k} className={'chip' + (kind === k ? ' on' : '')} onClick={() => setKind(k)}>{KIND_LABEL[k]}</button>
          ))}
        </div>
        <div className="section-label">標籤與主題</div>
        <div className="board-filter-selects">
          <select className="select" value={tag} onChange={e => setTag(e.target.value)} aria-label="標籤">
            <option value="">全部標籤</option>
            {allTags.map(t => <option key={t} value={t}>#{t}</option>)}
          </select>
          <select className="select" value={topic} onChange={e => setTopic(e.target.value)} aria-label="主題">
            <option value="">全部主題</option>
            {topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </div>
        <div className="section-label">排序</div>
        <div className="chips">
          <button className={'chip' + (sort === 'manual' ? ' on' : '')} onClick={() => setSort('manual')}>手動</button>
          <button className={'chip' + (sort === 'latest' ? ' on' : '')} onClick={() => setSort('latest')}>最新</button>
        </div>
        <div className="section-label">欄位</div>
        <button className="btn" onClick={() => { setFilterOpen(false); void addColumn(); }}>＋ 新增欄位</button>
      </Sheet>

      <div className="board-tabs" role="tablist">
        {columns.map((c, i) => (
          <button key={c.id} role="tab" aria-selected={i === activeCol}
            className={'board-tab' + (i === activeCol ? ' active' : '')} onClick={() => goCol(i)}>
            {c.name} <span className="board-count">{lists[c.id]?.length ?? 0}</span>
          </button>
        ))}
      </div>

      <DndContext sensors={sensors} collisionDetection={collision}
        onDragStart={onDragStart} onDragOver={onDragOver} onDragEnd={onDragEnd} onDragCancel={onDragCancel}>
        <div className={'board-cols' + (dragging ? ' is-dragging' : '')} ref={scrollRef} onScroll={onScroll}>
          <SortableContext items={colIds} strategy={horizontalListSortingStrategy}>
            {columns.map((c, i) => (
              <BoardColumn key={c.id} column={c} index={i} total={columns.length}
                cards={(lists[c.id] ?? []).map(id => cardMap.get(id)).filter((x): x is Card => !!x)}
                columns={columns} onOpen={open} cardsDisabled={sort === 'latest'}
                onAdd={addToColumn} onRename={renameColumn} onDelete={deleteColumn} onShift={shiftColumn} />
            ))}
          </SortableContext>
        </div>
        <DragOverlay dropAnimation={{ duration: 160 }}>
          {activeCard && <CardView card={activeCard} overlay />}
          {activeColumn && <div className="board-col-ghost">{activeColumn.name}</div>}
        </DragOverlay>
      </DndContext>

      <CardEditor cardId={editing} onClose={() => setEditing(null)} />
    </div>
  );
}

interface ColProps {
  column: Column; index: number; total: number; cards: Card[]; columns: Column[];
  onOpen: (id: string) => void; cardsDisabled: boolean;
  onAdd: (columnId: string, title: string) => void;
  onRename: (c: Column) => void; onDelete: (c: Column) => void; onShift: (c: Column, d: -1 | 1) => void;
}

function BoardColumn({ column, index, total, cards, columns, onOpen, cardsDisabled, onAdd, onRename, onDelete, onShift }: ColProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: COL + column.id, data: { type: 'column' },
  });
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState('');

  const submit = () => {
    const t = title.trim();
    if (t) onAdd(column.id, t);
    setTitle('');
  };

  return (
    <section ref={setNodeRef} className={'board-col' + (isDragging ? ' is-dragging' : '')}
      style={{ transform: CSS.Translate.toString(transform), transition }}>
      <header className="board-col-head">
        <span className="board-col-handle" {...attributes} {...listeners} title="拖曳排序欄位">⠿</span>
        <span className="board-col-name">{column.name}</span>
        <span className="board-count">{cards.length}</span>
        <Menu small label="欄位選單" items={[
          { label: '重新命名', onClick: () => onRename(column) },
          { label: '左移', disabled: index === 0, onClick: () => onShift(column, -1) },
          { label: '右移', disabled: index === total - 1, onClick: () => onShift(column, 1) },
          { label: '刪除欄位', danger: true, hidden: column.id === 'inbox', onClick: () => onDelete(column) },
        ]} />
      </header>
      <div className="board-col-body">
        {adding ? (
          <div className="board-add">
            <input className="input" autoFocus value={title} placeholder="卡片標題，Enter 新增"
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) submit();
                if (e.key === 'Escape') { setAdding(false); setTitle(''); }
              }}
              onBlur={() => { if (!title.trim()) setAdding(false); }} />
          </div>
        ) : (
          <button className="board-add-btn" onClick={() => setAdding(true)}>＋ 新增卡片</button>
        )}
        <SortableContext items={cards.map(c => c.id)} strategy={verticalListSortingStrategy}>
          <div className="board-cards">
            {cards.map(c => (
              <CardItem key={c.id} card={c} columns={columns} onOpen={onOpen} disabled={cardsDisabled} />
            ))}
            {cards.length === 0 && <div className="board-empty muted">還沒有卡片</div>}
          </div>
        </SortableContext>
      </div>
    </section>
  );
}
