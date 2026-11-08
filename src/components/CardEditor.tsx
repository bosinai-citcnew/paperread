import { useCallback, useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { marked } from 'marked';
import { db, uid, updateCard } from '../db';
import type { Card, CardKind, Relation, RelationType } from '../types';
import { KIND_LABEL, deleteCardCascade, nextOrderEnd } from './CardItem';
import { openReader } from '../App';
import Menu from './Menu';
import Sheet from './Sheet';
import '../views/board.css';

interface Props { cardId: string | null; onClose(): void }

interface Draft {
  title: string; body: string; tags: string[]; kind: CardKind;
  columnId: string; pinned: boolean; topicId: string;
}

const REL_LABEL: Record<RelationType, string> = {
  cites: '引用', 'co-cited': '共被引', coupled: '耦合', similar: '相似', supports: '支持', contradicts: '反駁',
};

function sanitize(html: string): string {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  doc.querySelectorAll('script,style,iframe,object,embed,link,meta,form').forEach(n => n.remove());
  doc.querySelectorAll('*').forEach(el => {
    for (const a of Array.from(el.attributes)) {
      const v = a.value.trim().toLowerCase();
      if (a.name.startsWith('on') || ((a.name === 'href' || a.name === 'src') && v.startsWith('javascript:'))) {
        el.removeAttribute(a.name);
      }
    }
    if (el.tagName === 'A') { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
  });
  return doc.body.innerHTML;
}

export default function CardEditor({ cardId, onClose }: Props) {
  const card = useLiveQuery(() => (cardId ? db.cards.get(cardId) : undefined), [cardId]);
  const columns = useLiveQuery(() => db.columns.orderBy('order').toArray(), []) ?? [];
  const topics = useLiveQuery(() => db.topics.toArray(), []) ?? [];
  const [d, setD] = useState<Draft | null>(null);
  const [preview, setPreview] = useState(false);
  const [tagInput, setTagInput] = useState('');
  const [toast, setToast] = useState('');
  const loadedFor = useRef<string | null>(null);
  const dirty = useRef(false);
  const latest = useRef<{ card?: Card; d: Draft | null }>({ d: null });
  latest.current = { card, d };

  useEffect(() => {
    if (!cardId) { setD(null); loadedFor.current = null; return; }
    if (card && loadedFor.current !== card.id) {
      loadedFor.current = card.id;
      dirty.current = false;
      setPreview(false);
      setD({
        title: card.title, body: card.body, tags: card.tags, kind: card.kind,
        columnId: card.columnId, pinned: !!card.pinned, topicId: card.topicId ?? '',
      });
    }
  }, [card, cardId]);

  const save = useCallback(async () => {
    const { card: c, d: dr } = latest.current;
    if (!c || !dr || !dirty.current) return;
    dirty.current = false;
    const patch: Partial<Card> = {
      title: dr.title.trim() || '（無標題）', body: dr.body, tags: dr.tags, kind: dr.kind,
      pinned: dr.pinned, topicId: dr.topicId || undefined,
    };
    if (dr.columnId !== c.columnId) { patch.columnId = dr.columnId; patch.order = await nextOrderEnd(dr.columnId); }
    await updateCard(c.id, patch);
  }, []);

  useEffect(() => {
    if (!d || !dirty.current) return;
    const t = setTimeout(() => { save(); }, 600);
    return () => clearTimeout(t);
  }, [d, save]);

  const close = useCallback(async () => { await save(); onClose(); }, [save, onClose]);

  const patch = (p: Partial<Draft>) => { dirty.current = true; setD(prev => (prev ? { ...prev, ...p } : prev)); };
  const flash = (m: string) => { setToast(m); setTimeout(() => setToast(''), 1800); };

  const addTag = (raw: string) => {
    const t = raw.trim().replace(/^#/, '');
    if (t && d && !d.tags.includes(t)) patch({ tags: [...d.tags, t] });
    setTagInput('');
  };

  const plain = d ? `${d.title}\n\n${d.body}` : '';
  const copyKeep = async () => {
    try { await navigator.clipboard.writeText(plain); flash('已複製，可貼到 Google Keep'); }
    catch { flash('複製失敗'); }
  };
  const share = async () => {
    try { await navigator.share({ title: d?.title, text: d?.body }); } catch { /* cancelled */ }
  };
  const remove = async () => {
    if (!card || !confirm(`刪除「${card.title}」？此動作無法復原。`)) return;
    dirty.current = false;
    await deleteCardCascade(card.id);
    onClose();
  };

  const read = async () => { if (!card) return; await save(); onClose(); openReader(card.id); };

  if (!cardId) return null;
  const p = card?.paper;
  const kpCount = card?.reading?.keyPoints?.length ?? 0;

  return (
    <Sheet open wide onClose={close} label="編輯卡片"
      title={d ? <input className="board-ed-title" value={d.title} placeholder="標題" onChange={e => patch({ title: e.target.value })} /> : ''}
      headerRight={card && d && (
        <Menu label="更多動作" items={[
          { label: '複製到 Keep', onClick: copyKeep },
          { label: '分享', hidden: typeof navigator.share !== 'function', onClick: share },
          'sep',
          { label: '刪除卡片', danger: true, onClick: remove },
        ]} />
      )}>
      {!card || !d ? (
        <div className="muted" style={{ padding: 24, textAlign: 'center' }}>{card === undefined ? '載入中…' : '找不到卡片'}</div>
      ) : (
        <div className="board-ed">
          {card.kind === 'paper' && (
            <button className="btn btn-primary board-ed-read" onClick={read}>
              精讀{kpCount > 0 && <span className="board-ed-kp">{kpCount} 個重點</span>}
            </button>
          )}

          <div className="board-ed-meta">
            <select className="select" aria-label="欄位" value={d.columnId} onChange={e => patch({ columnId: e.target.value })}>
              {columns.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <select className="select" aria-label="類型" value={d.kind} onChange={e => patch({ kind: e.target.value as CardKind })}>
              {(Object.keys(KIND_LABEL) as CardKind[]).map(k => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
          </div>

          <div className="row" style={{ justifyContent: 'space-between', margin: '16px 0 8px' }}>
            <span className="section-label" style={{ margin: 0 }}>內容</span>
            <button className="btn btn-ghost btn-sm" onClick={() => setPreview(v => !v)}>{preview ? '編輯' : '預覽 Markdown'}</button>
          </div>
          {preview ? (
            <div className="board-ed-preview"
              dangerouslySetInnerHTML={{ __html: sanitize(marked.parse(d.body || '*（空白）*', { async: false }) as string) }} />
          ) : (
            <textarea className="textarea board-ed-body" value={d.body} placeholder="支援 Markdown…"
              onChange={e => patch({ body: e.target.value })} />
          )}

          <div className="board-ed-tags">
            {d.tags.map(t => (
              <span key={t} className="tag board-ed-chip">#{t}
                <button aria-label={`移除 ${t}`} onClick={() => patch({ tags: d.tags.filter(x => x !== t) })}>×</button>
              </span>
            ))}
            <input className="board-ed-taginput" value={tagInput} placeholder="＋ 標籤"
              onChange={e => { const v = e.target.value; if (/[,，]$/.test(v)) addTag(v.slice(0, -1)); else setTagInput(v); }}
              onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) { e.preventDefault(); addTag(tagInput); } }}
              onBlur={() => tagInput && addTag(tagInput)} />
          </div>

          {p && (
            <details className="board-ed-details">
              <summary>論文資訊</summary>
              <div className="board-ed-paper">
                {p.authors?.length > 0 && <div>作者：{p.authors.join('、')}</div>}
                {(p.year || p.venue) && <div>{[p.year, p.venue].filter(Boolean).join(' · ')}</div>}
                {(p.url || p.doi) && (
                  <div>連結：<a href={p.url ?? `https://doi.org/${p.doi}`} target="_blank" rel="noopener noreferrer">
                    {p.url ?? p.doi}</a></div>
                )}
                {p.citedByCount != null && <div className="muted">被引 {p.citedByCount} 次</div>}
                {p.abstract && <p>{p.abstract}</p>}
              </div>
            </details>
          )}

          <details className="board-ed-details">
            <summary>更多屬性</summary>
            <div className="board-ed-more">
              <label className="field">主題
                <select className="select" value={d.topicId} onChange={e => patch({ topicId: e.target.value })}>
                  <option value="">（無）</option>
                  {topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </label>
              <label className="toggle-row">釘選<input type="checkbox" checked={d.pinned} onChange={e => patch({ pinned: e.target.checked })} /></label>
            </div>
          </details>

          <Relations card={card} />
          {toast && <div className="toast">{toast}</div>}
        </div>
      )}
    </Sheet>
  );
}

function Relations({ card }: { card: Card }) {
  const rels = useLiveQuery(async () => {
    const [a, b] = await Promise.all([
      db.relations.where('from').equals(card.id).toArray(),
      db.relations.where('to').equals(card.id).toArray(),
    ]);
    const map = new Map<string, Relation>();
    [...a, ...b].forEach(r => map.set(r.id, r));
    const list = [...map.values()];
    const others = list.map(r => (r.from === card.id ? r.to : r.from));
    const cards = await db.cards.bulkGet(others);
    return list.map((r, i) => ({ r, other: cards[i] }));
  }, [card.id]) ?? [];
  const [q, setQ] = useState('');
  const [type, setType] = useState<RelationType>('similar');
  const results = useLiveQuery(async () => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    const all = await db.cards.toArray();
    return all.filter(c => c.id !== card.id && c.title.toLowerCase().includes(s)).slice(0, 8);
  }, [q, card.id]) ?? [];

  const add = async (other: Card) => {
    const exists = rels.some(x => x.other?.id === other.id && x.r.type === type);
    if (!exists) {
      await db.relations.put({ id: uid(), topicId: card.topicId, from: card.id, to: other.id, type, weight: 1, manual: true });
    }
    setQ('');
  };

  return (
    <details className="board-ed-details board-ed-rel">
      <summary>關聯卡片（{rels.length}）</summary>
      {rels.map(({ r, other }) => (
        <div key={r.id} className="board-ed-relrow">
          <span className="tag">{REL_LABEL[r.type]}</span>
          <span className="board-ed-reltitle">{other?.title ?? '（已刪除）'}</span>
          {r.manual && <button className="btn btn-sm" aria-label="移除關聯" onClick={() => db.relations.delete(r.id)}>×</button>}
        </div>
      ))}
      <div className="row" style={{ marginTop: 6 }}>
        <input className="input" style={{ flex: 1, minWidth: 140 }} value={q} placeholder="搜尋卡片標題以建立關聯"
          onChange={e => setQ(e.target.value)} />
        <select className="select" style={{ width: 'auto' }} value={type} onChange={e => setType(e.target.value as RelationType)}>
          <option value="similar">相似</option>
          <option value="supports">支持</option>
          <option value="contradicts">反駁</option>
        </select>
      </div>
      {results.map(c => (
        <button key={c.id} className="board-ed-result" onClick={() => add(c)}>＋ {c.title}</button>
      ))}
    </details>
  );
}
