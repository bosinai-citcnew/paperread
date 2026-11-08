import { useEffect, useMemo, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db, uid, updateCard } from '../db';
import { navigate, openReader } from '../App';
import Icon from '../components/Icons';
import Menu from '../components/Menu';
import Sheet from '../components/Sheet';
import type { Card, ConceptGroup, Topic } from '../types';
import {
  buildBoolean, computeRelations, computeSignals, expandFromPaper, expandTopic, GAP_LABEL, judgeRelations,
  LLMNotConfigured, migrateToLibrary, runSearch, saveGapsAsCards, synthesizeAI, synthesizeBibliometric,
} from '../lib/research';
import { getBudget, onBudgetChange, type Budget } from '../lib/scholar';
import RelationGraph from '../components/RelationGraph';
import './research.css';

type Tab = 'papers' | 'graph' | 'gaps';
type SortKey = 'relevance' | 'year' | 'citations';
const LS_TOPIC = 'paperread:researchTopic';

function readLS(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function writeLS(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

/** Small muted text: remaining OpenAlex budget seen in the last response headers. */
function useBudget(): Budget {
  const [b, setB] = useState<Budget>(getBudget());
  useEffect(() => onBudgetChange(setB), []);
  return b;
}

export default function Research() {
  const topics = useLiveQuery(() => db.topics.orderBy('updatedAt').reverse().toArray(), []);
  const [topicId, setTopicId] = useState<string | null>(() => readLS(LS_TOPIC));
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState<Tab>('papers');
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState('');
  const budget = useBudget();
  const aiKey = useLiveQuery(async () => !!(await db.settings.get('settings'))?.llmApiKey?.trim(), [], false);

  const topic = topics?.find(t => t.id === topicId);
  const cards = useLiveQuery(
    () => topicId ? db.cards.where('topicId').equals(topicId).filter(c => c.kind === 'paper').toArray() : Promise.resolve([] as Card[]),
    [topicId],
  );

  useEffect(() => { if (topicId) void migrateToLibrary(topicId); }, [topicId]);

  const select = (t: Topic | null) => {
    setTopicId(t?.id ?? null);
    writeLS(LS_TOPIC, t?.id ?? '');
    setQuery(t?.name ?? '');
    setError(''); setProgress('');
  };

  // sync query box when topics first load with a remembered selection
  const [synced, setSynced] = useState(false);
  if (!synced && topics) {
    setSynced(true);
    const t = topics.find(x => x.id === topicId);
    if (t) setQuery(t.name); else if (topicId) setTopicId(null);
  }

  async function run(fn: () => Promise<unknown>) {
    setBusy(true); setError('');
    try { await fn(); } catch (e) {
      setError(e instanceof LLMNotConfigured ? '此功能需要 AI 金鑰（選用），可到「設定」填入' : (e as Error).message);
    } finally { setBusy(false); }
  }

  async function dig() {
    const q = query.trim();
    if (!q) return;
    await run(async () => {
      let t = topic && topic.name === q ? topic : undefined;
      if (!t) {
        const now = Date.now();
        t = { id: uid(), name: q, concepts: [], createdAt: now, updatedAt: now };
        await db.topics.put(t);
        select(t);
      }
      if (!t.concepts.length) {
        setProgress('展開關鍵字…');
        const ex = await expandTopic(q);
        if (ex.error) setError(ex.error);
        await db.topics.update(t.id, { concepts: ex.concepts, booleanQuery: ex.booleanQuery, updatedAt: Date.now() });
      }
      await runSearch(t.id, setProgress);
      setProgress('計算論文關聯…');
      await computeRelations(t.id);
      setProgress(p => p.startsWith('計算') ? '完成' : p);
    });
  }

  async function reExpand() {
    if (!topic) return;
    await run(async () => {
      setProgress('重新展開關鍵字…');
      const ex = await expandTopic(topic.name);
      if (ex.error) setError(ex.error);
      await db.topics.update(topic.id, { concepts: ex.concepts, booleanQuery: ex.booleanQuery, updatedAt: Date.now() });
      setProgress('');
    });
  }

  async function removeTopic(t: Topic) {
    if (!confirm(`刪除主題「${t.name}」？論文卡片會保留在知識卡，但解除與主題的關聯。`)) return;
    const ids = await db.cards.where('topicId').equals(t.id).primaryKeys();
    await db.transaction('rw', db.cards, db.relations, db.topics, async () => {
      await db.cards.where('topicId').equals(t.id).modify({ topicId: undefined });
      await db.relations.where('topicId').equals(t.id).delete();
      await db.topics.delete(t.id);
    });
    void ids;
    select(null);
  }

  async function saveConcepts(concepts: ConceptGroup[]) {
    if (!topic) return;
    await db.topics.update(topic.id, { concepts, booleanQuery: buildBoolean(concepts), updatedAt: Date.now() });
  }

  const [conceptsOpen, setConceptsOpen] = useState(false);
  const topicItems = [
    ...(topics ?? []).map(t => ({ label: (t.id === topicId ? '✓ ' : '') + t.name, onClick: () => select(t) })),
    ...(topics?.length ? ['sep' as const] : []),
    { label: '＋ 新主題', onClick: () => select(null) },
  ];

  return (
    <div className="page rs-page">
      <div className="rs-head">
        <h1 className="page-title">研究</h1>
        <span className="rs-head-actions">
          {(topics?.length ?? 0) > 0 && (
            <Menu items={topicItems} label="切換主題" className="rs-topic-btn">
              <span className="rs-topic-name">{topic?.name ?? '新主題'}</span><Icon name="down" size={16} />
            </Menu>
          )}
          {topic && (
            <Menu label="主題選單" items={[
              { label: '編輯關鍵字', onClick: () => setConceptsOpen(true) },
              { label: aiKey ? 'AI 重新展開關鍵字' : '重新展開關鍵字', disabled: busy, onClick: reExpand },
              'sep',
              { label: '刪除主題', danger: true, disabled: busy, onClick: () => removeTopic(topic) },
            ]} />
          )}
        </span>
      </div>

      <div className="rs-search">
        <div className="search">
          <Icon name="search" size={20} />
          <input className="input rs-input" value={query} placeholder="輸入研究主題，例如：遠距工作對生產力的影響"
            onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && !busy && dig()} />
        </div>
        <button className="btn btn-primary rs-dig" disabled={busy || !query.trim()} onClick={dig}>{busy ? '處理中…' : '深入挖掘'}</button>
      </div>

      {progress && <div className="rs-progress">{progress}</div>}
      {error && <div className="error small" style={{ margin: '8px 0' }}>{error}</div>}

      {topic && (
        <>
          <div className="rs-concepts-line">
            {topic.concepts.length > 0 ? (
              <div className="chips scroll rs-concept-chips">
                {topic.concepts.map(c => <span key={c.concept} className="chip">{c.concept}</span>)}
              </div>
            ) : <span className="muted small rs-concepts-hint">按「深入挖掘」會自動展開關鍵字</span>}
            <button className="btn btn-ghost btn-sm" onClick={() => setConceptsOpen(true)}>編輯</button>
          </div>

          <Sheet open={conceptsOpen} onClose={() => setConceptsOpen(false)} title="關鍵字概念" wide
            footer={<button className="btn btn-primary" onClick={() => setConceptsOpen(false)}>完成</button>}>
            <ConceptEditor concepts={topic.concepts} onChange={saveConcepts} />
            {topic.booleanQuery && (<><div className="section-label">布林查詢</div><div className="rs-bool">{topic.booleanQuery}</div></>)}
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn btn-sm" disabled={busy} onClick={() => { setConceptsOpen(false); void reExpand(); }}>{aiKey ? 'AI 重新展開' : '重新展開'}</button>
            </div>
          </Sheet>

          <div className="rs-tabs" role="tablist">
            {([['papers', `論文 ${cards?.length ?? 0}`], ['graph', '關聯圖'], ['gaps', '缺口與建議']] as [Tab, string][]).map(([k, l]) => (
              <button key={k} role="tab" aria-selected={tab === k} className={'rs-tab' + (tab === k ? ' active' : '')} onClick={() => setTab(k)}>{l}</button>
            ))}
          </div>

          {tab === 'papers' && <PapersTab topic={topic} cards={cards ?? []} busy={busy} run={run} setProgress={setProgress} />}
          {tab === 'graph' && (
            <RelationGraph topicId={topic.id} busy={busy}
              onCompute={() => run(async () => { setProgress('計算關聯…'); const n = await computeRelations(topic.id); setProgress(`已建立 ${n} 條關聯`); })}
              onJudge={aiKey ? () => run(async () => { await judgeRelations(topic.id, setProgress); }) : undefined} />
          )}
          {tab === 'gaps' && <GapsTab topic={topic} cards={cards ?? []} busy={busy} run={run} setProgress={setProgress} aiKey={!!aiKey} />}
        </>
      )}
      {budget.remainingUsd !== undefined && (
        <div className="rs-budget muted small">OpenAlex 今日剩餘額度約 ${budget.remainingUsd.toFixed(3)}</div>
      )}
      {!topic && !busy && (
        <div className="empty rs-empty">
          <div className="rs-empty-title">從一個研究主題開始</div>
          <div className="small">輸入主題後按「深入挖掘」：自動拆解關鍵字、分層搜尋 OpenAlex、追蹤引用並找出研究缺口。完全免費，不需要 AI。</div>
        </div>
      )}
    </div>
  );
}

// ───────────── concept editor ─────────────

function ConceptEditor({ concepts, onChange }: { concepts: ConceptGroup[]; onChange: (c: ConceptGroup[]) => void }) {
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [newConcept, setNewConcept] = useState('');
  const set = (i: number, g: ConceptGroup | null) => onChange(concepts.flatMap((c, j) => j === i ? (g ? [g] : []) : [c]));
  return (
    <div className="rs-concepts">
      {concepts.map((g, i) => (
        <div key={i} className="rs-concept">
          <span className="rs-concept-name">{g.concept}</span>
          <button className="btn btn-sm" aria-label="移除概念" onClick={() => set(i, null)}>✕</button>
          {g.synonyms.map(s => (
            <span key={s} className="rs-chip">{s}
              <button aria-label={`移除 ${s}`} onClick={() => set(i, { ...g, synonyms: g.synonyms.filter(x => x !== s) })}>✕</button>
            </span>
          ))}
          <input className="input rs-chip-add" placeholder="＋同義詞" value={drafts[i] ?? ''}
            onChange={e => setDrafts({ ...drafts, [i]: e.target.value })}
            onKeyDown={e => {
              const v = (drafts[i] ?? '').trim();
              if (e.key === 'Enter' && v) { set(i, { ...g, synonyms: [...new Set([...g.synonyms, v])] }); setDrafts({ ...drafts, [i]: '' }); }
            }} />
        </div>
      ))}
      {concepts.length > 0 && concepts.length < 5 && (
        <input className="input rs-chip-add" style={{ width: 140 }} placeholder="＋新概念" value={newConcept}
          onChange={e => setNewConcept(e.target.value)}
          onKeyDown={e => {
            const v = newConcept.trim();
            if (e.key === 'Enter' && v) { onChange([...concepts, { concept: v, synonyms: [] }]); setNewConcept(''); }
          }} />
      )}
    </div>
  );
}

// ───────────── papers tab ─────────────

interface TabProps {
  topic: Topic; cards: Card[]; busy: boolean;
  run: (fn: () => Promise<unknown>) => Promise<void>;
  setProgress: (s: string) => void;
}

const SORT_LABEL: Record<SortKey, string> = { relevance: '相關度', year: '年份', citations: '被引次數' };

function PapersTab({ topic, cards, busy, run, setProgress }: TabProps) {
  const [sort, setSort] = useState<SortKey>('relevance');
  const [filter, setFilter] = useState('');
  const [filterOpen, setFilterOpen] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [bulkMsg, setBulkMsg] = useState('');
  const lib = cards.filter(c => c.columnId === 'library').sort((a, b) => (b.paper?.relevance ?? 0) - (a.paper?.relevance ?? 0));
  async function addTop(n: number) {
    const pick = lib.slice(0, n);
    for (const c of pick) await updateCard(c.id, { columnId: 'inbox' });
    setBulkMsg(`已加入 ${pick.length} 篇到看板收件匣`);
    window.setTimeout(() => setBulkMsg(''), 2600);
  }

  const list = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const l = cards.filter(c => !f || (c.title + ' ' + (c.paper?.authors ?? []).join(' ') + ' ' + c.tags.join(' ')).toLowerCase().includes(f));
    const key = (c: Card) => sort === 'year' ? (c.paper?.year ?? 0) : sort === 'citations' ? (c.paper?.citedByCount ?? 0) : (c.paper?.relevance ?? 0);
    return l.sort((a, b) => key(b) - key(a));
  }, [cards, sort, filter]);

  const activeFilters = (filter.trim() ? 1 : 0) + (sort !== 'relevance' ? 1 : 0);

  if (!cards.length) return <div className="empty rs-empty">尚無論文。按上方「深入挖掘」開始搜尋。</div>;
  return (
    <>
      <div className="rs-toolbar">
        <span className="muted small">{list.length === cards.length ? `${cards.length} 篇` : `${list.length} / ${cards.length} 篇`}　排序：{SORT_LABEL[sort]}</span>
        <span className="rs-toolbar-actions">
          <button className="icon-btn" aria-label="篩選與排序" onClick={() => setFilterOpen(true)}>
            <Icon name="filter" />{activeFilters > 0 && <span className="badge">{activeFilters}</span>}
          </button>
          <Menu label="更多" items={[
            { title: '加入看板收件匣' },
            ...[5, 10, 20, 30].map(n => ({ label: `前 ${Math.min(n, lib.length)} 篇`, disabled: !lib.length, onClick: () => { void addTop(n); } })),
          ]} />
        </span>
      </div>
      {bulkMsg && <div className="rs-note small">{bulkMsg}</div>}

      <Sheet open={filterOpen} onClose={() => setFilterOpen(false)} title="篩選與排序"
        footer={<>
          <button className="btn" onClick={() => { setFilter(''); setSort('relevance'); }}>重設</button>
          <button className="btn btn-primary" onClick={() => setFilterOpen(false)}>完成</button>
        </>}>
        <div className="search"><Icon name="search" size={20} />
          <input className="input" placeholder="標題／作者／標籤" value={filter} onChange={e => setFilter(e.target.value)} />
        </div>
        <div className="section-label">排序</div>
        <div className="chips">
          {(Object.keys(SORT_LABEL) as SortKey[]).map(k => (
            <button key={k} className={'chip' + (sort === k ? ' on' : '')} onClick={() => setSort(k)}>{SORT_LABEL[k]}</button>
          ))}
        </div>
      </Sheet>

      <div className="rs-list">
        {list.map(c => {
          const p = c.paper!;
          const isOpen = open === c.id;
          return (
            <div key={c.id} className={'rs-paper' + (isOpen ? ' open' : '')}>
              <button className="rs-paper-head" onClick={() => setOpen(isOpen ? null : c.id)} aria-expanded={isOpen}>
                <div className="rs-paper-title">{c.columnId === 'key' && <span className="rs-star" aria-label="重點">★ </span>}{c.title}</div>
                <div className="rs-meta">
                  {p.authors?.slice(0, 2).join('、')}{(p.authors?.length ?? 0) > 2 ? ' 等' : ''} · {p.year ?? '?'} · 被引 {p.citedByCount ?? 0}
                </div>
                <div className="rs-bar"><i style={{ width: `${Math.round((p.relevance ?? 0) * 100)}%` }} /></div>
              </button>
              {isOpen && (
                <div className="rs-paper-body">
                  {(p.venue || p.doi) && <div className="rs-meta">{p.venue}{p.doi ? ` · DOI ${p.doi}` : ''}</div>}
                  <div className="rs-actions" style={{ marginTop: 12 }}>
                    <button className="btn btn-primary" onClick={() => openReader(c.id)}>精讀</button>
                    <Menu label="論文動作" items={[
                      { label: '加到收件匣', hidden: c.columnId === 'inbox' || c.columnId === 'key', onClick: () => { void updateCard(c.id, { columnId: 'inbox' }); } },
                      { label: '加到重點', hidden: c.columnId === 'key', onClick: () => { void updateCard(c.id, { columnId: 'key' }); } },
                      { label: '從此篇延伸', disabled: busy || !p.openalexId,
                        onClick: () => { void run(async () => { await expandFromPaper(topic.id, c.id, setProgress); await computeRelations(topic.id); }); } },
                      'sep',
                      { label: '開啟原文', hidden: !p.url, onClick: () => { window.open(p.url, '_blank', 'noreferrer'); } },
                      { label: '開啟 PDF', hidden: !p.pdfUrl, onClick: () => { window.open(p.pdfUrl, '_blank', 'noreferrer'); } },
                    ]} />
                  </div>
                  <p className="rs-abs">{p.abstract || '（無摘要）'}</p>
                  {c.tags.length > 0 && <div className="chips" style={{ marginBottom: 12 }}>{c.tags.map(t => <span key={t} className="tag">{t}</span>)}</div>}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </>
  );
}

// ───────────── gaps tab ─────────────

function Bars({ rows }: { rows: { label: string; value: number; text: string }[] }) {
  const max = Math.max(0.0001, ...rows.map(r => r.value));
  return (
    <div className="rs-bars">
      {rows.map(r => (
        <div key={r.label} className="rs-brow">
          <span className="rs-blabel">{r.label}</span>
          <span className="rs-btrack"><i style={{ width: `${(r.value / max) * 100}%` }} /></span>
          <span className="rs-bval">{r.text}</span>
        </div>
      ))}
    </div>
  );
}

function countryLabel(code: string) {
  try { return new Intl.DisplayNames(['zh-TW'], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

function GapsTab({ topic, cards, busy, run, setProgress, aiKey }: TabProps & { aiKey: boolean }) {
  const syn = topic.synthesis;
  const stats = syn?.stats;
  const sig = useMemo(() => computeSignals(topic, cards), [topic, cards]);
  const titles = useMemo(() => new Map(cards.map(c => [c.id, c.title])), [cards]);
  const [saved, setSaved] = useState('');
  const STATUS = { convergent: '一致', divergent: '分歧', silent: '缺口' } as const;
  const generate = () => run(() => synthesizeBibliometric(topic.id, setProgress));
  const generateAI = () => run(() => synthesizeAI(topic.id, setProgress));

  const nowY = new Date().getFullYear();
  const years = stats?.years?.length ? stats.years : sig.yearHistogram;
  const shown = years.filter(y => y.year >= nowY - 24);
  const yTotal = years.reduce((n, y) => n + y.count, 0);
  const recentShare = yTotal ? years.filter(y => y.year >= nowY - 4).reduce((n, y) => n + y.count, 0) / yTotal : 0;
  const maxCount = Math.max(1, ...shown.map(h => h.count));
  const countryRows = (stats?.countries ?? []).slice(0, 6).map(c => ({
    label: countryLabel(c.code), value: c.count, text: stats?.total ? `${Math.round((c.count / stats.total) * 100)}%` : String(c.count),
  }));
  const methodRows = (stats?.methods ?? []).map(m => ({
    label: m.label, value: m.count, text: stats?.methodBase ? `${Math.round((m.count / stats.methodBase) * 100)}%` : String(m.count),
  }));

  const gapTypes = syn ? [...new Set(syn.gaps.map(g => g.type))] : [];
  return (
    <>
      {!syn && (
        <div className="empty rs-empty">
          <div className="rs-empty-title">找出研究缺口</div>
          <div className="small">{cards.length < 3 ? '至少需要 3 篇論文才能分析。' : '依 OpenAlex 的年份、國家、類型統計，以及已收集論文的摘要，找出尚待研究之處。免費，不需要 AI。'}</div>
          <button className="btn btn-primary" disabled={busy || cards.length < 3} onClick={generate}>產生缺口分析</button>
        </div>
      )}

      {syn && (
        <div className="rs-gap-head">
          <span className="muted small">{syn.source === 'ai' ? 'AI 綜合' : '統計分析'} · 更新於 {new Date(syn.generatedAt).toLocaleString()}</span>
          <Menu label="分析選項" items={[
            { label: '重新產生分析', disabled: busy || cards.length < 3, onClick: () => { void generate(); } },
            { label: '用 AI 綜合（選用）', hidden: !aiKey, disabled: busy || cards.length < 3, onClick: () => { void generateAI(); } },
            { label: '存成知識卡', onClick: async () => { const n = await saveGapsAsCards(topic.id); setSaved(n ? `已存成 ${n} 張知識卡` : '沒有新的卡片（已存過）'); window.setTimeout(() => setSaved(''), 2600); } },
          ]} />
        </div>
      )}
      {saved && <div className="rs-note small">{saved}</div>}

      {shown.length > 0 && (
        <div className="panel rs-section">
          <div className="rs-card-title">年份分布 <span className="muted small">近五年占 {(recentShare * 100).toFixed(0)}%{stats?.total ? ` · OpenAlex 共 ${stats.total} 篇` : ''}</span></div>
          <div className="rs-hist">
            {shown.map(h => <div key={h.year} title={`${h.year}：${h.count}`} style={{ height: `${(h.count / maxCount) * 100}%` }} />)}
          </div>
          <div className="rs-meta">{shown[0].year} → {shown[shown.length - 1].year}</div>
          {sig.silentConcepts.length > 0 && (
            <div className="rs-meta" style={{ marginTop: 8 }}>覆蓋不足的概念（&lt;2 篇）：{sig.silentConcepts.map(c => `${c.concept}(${c.count})`).join('、')}</div>
          )}
        </div>
      )}
      {countryRows.length > 0 && (
        <div className="panel rs-section">
          <div className="rs-card-title">國家分布 <span className="muted small">含該國機構作者的論文占比</span></div>
          <Bars rows={countryRows} />
        </div>
      )}
      {methodRows.length > 0 && (
        <div className="panel rs-section">
          <div className="rs-card-title">研究方法 <span className="muted small">已收集 {stats?.methodBase} 篇摘要用語</span></div>
          <Bars rows={methodRows} />
        </div>
      )}

      {syn && (
        <>
          {syn.themes.length > 0 && <div className="section-label">主題</div>}
          <div className="rs-stack">
            {syn.themes.map((t, i) => (
              <div key={i} className="panel rs-card">
                <div className="rs-card-title"><span className={'rs-badge ' + t.status}>{STATUS[t.status]}</span>{t.name}</div>
                <p>{t.summary}</p>
                {t.cardIds.length > 0 && <ul className="rs-ev">{t.cardIds.slice(0, 4).map(id => <li key={id}>{titles.get(id) ?? '（已刪除）'}</li>)}</ul>}
              </div>
            ))}
          </div>

          <div className="section-label">研究缺口</div>
          {!syn.gaps.length && <div className="muted small">依目前的統計與論文，未發現有明確數據支持的缺口。</div>}
          {gapTypes.map(type => (
            <div key={type} className="rs-stack rs-gaptype">
              <div className="rs-gap-type">{GAP_LABEL[type]}</div>
              {syn.gaps.filter(g => g.type === type).map((g, i) => (
                <div key={i} className="panel rs-card">
                  <div className="rs-card-title">{g.description}</div>
                  <p><span className="muted">意義　</span>{g.implication}</p>
                  <p><span className="muted">建議　</span>{g.suggestion}</p>
                  {g.evidence.length > 0
                    ? <ul className="rs-ev">{g.evidence.map(id => <li key={id}>{titles.get(id) ?? '（已刪除）'}</li>)}</ul>
                    : syn.source !== 'ai' && <div className="rs-meta">依據：OpenAlex 統計</div>}
                </div>
              ))}
            </div>
          ))}

          {syn.directions.length > 0 && (
            <>
              <div className="section-label">未來研究方向</div>
              <div className="panel"><ol className="rs-dir">{syn.directions.map((d, i) => <li key={i}>{d}</li>)}</ol></div>
            </>
          )}

          <div className="rs-cta">
            <button className="btn btn-primary" onClick={() => { writeLS('paperread:pendingTopic', topic.id); navigate('paper'); }}>用這個產生論文</button>
          </div>
        </>
      )}
    </>
  );
}
