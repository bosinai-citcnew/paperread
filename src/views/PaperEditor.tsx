import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { marked } from 'marked';
import { DndContext, PointerSensor, TouchSensor, closestCenter, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, arrayMove, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { db, getSettings, uid } from '../db';
import { openReader } from '../App';
import Icon from '../components/Icons';
import Menu from '../components/Menu';
import Sheet from '../components/Sheet';
import {
  LANG_LABELS, PATTERN_LABELS, STYLE_LABELS, buildOutline, countWords, ctxFor, docLang, docStyle, docToMarkdown, draftSection,
  findSection, firstAuthorLabel, generateAbstract, generateAll, leafSections, loadCards, newDoc, relabelHeadings, templates,
  toPrintHtml, translateText,
} from '../lib/paperGen';
import { bodyLang, renderCitations } from '../lib/citation';
import { exportDocx } from '../lib/docxExport';
import type { Card, CitationStyle, FrontMatter, PaperDoc, PaperLanguage, PaperPattern, Section } from '../types';
import './paper.css';

const PATTERNS = Object.keys(PATTERN_LABELS) as PaperPattern[];

// ---------- pure tree ops (operate on a cloned tree) ----------
const clone = <T,>(x: T): T => structuredClone(x);

interface Loc { list: Section[]; idx: number; parent: Section | null }
function locate(sections: Section[], id: string, parent: Section | null = null): Loc | null {
  for (let i = 0; i < sections.length; i++) {
    if (sections[i].id === id) return { list: sections, idx: i, parent };
    const r = locate(sections[i].children, id, sections[i]);
    if (r) return r;
  }
  return null;
}
function moveSection(secs: Section[], id: string, dir: 'up' | 'down' | 'in' | 'out'): boolean {
  const loc = locate(secs, id);
  if (!loc) return false;
  const { list, idx, parent } = loc;
  if (dir === 'up' && idx > 0) { [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]]; return true; }
  if (dir === 'down' && idx < list.length - 1) { [list[idx + 1], list[idx]] = [list[idx], list[idx + 1]]; return true; }
  if (dir === 'in' && idx > 0) { const [s] = list.splice(idx, 1); list[idx - 1].children.push(s); return true; }
  if (dir === 'out' && parent) {
    const pl = locate(secs, parent.id)!;
    const [s] = list.splice(idx, 1);
    pl.list.splice(pl.idx + 1, 0, s);
    return true;
  }
  return false;
}

function sanitize(html: string): string {
  const d = new DOMParser().parseFromString(html, 'text/html');
  d.querySelectorAll('script,iframe,object,embed,style,link').forEach(n => n.remove());
  d.querySelectorAll('*').forEach(el => {
    for (const a of [...el.attributes]) {
      if (/^on/i.test(a.name) || (/^(href|src)$/i.test(a.name) && /^\s*javascript:/i.test(a.value))) el.removeAttribute(a.name);
    }
  });
  return d.body.innerHTML;
}
const renderMd = (md: string) => sanitize(marked.parse(md, { async: false }) as string);

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------- outline node ----------
interface NodeProps {
  s: Section; num: string; selected: string; onSelect: (id: string) => void;
  onReorder: (e: DragEndEvent) => void;
  sensors: ReturnType<typeof useSensors>;
}
function OutlineList({ list, prefix, ...rest }: Omit<NodeProps, 's' | 'num'> & { list: Section[]; prefix: number[] }) {
  return (
    <DndContext sensors={rest.sensors} collisionDetection={closestCenter} onDragEnd={rest.onReorder}>
      <SortableContext items={list.map(s => s.id)} strategy={verticalListSortingStrategy}>
        <ul className="pe-tree">
          {list.map((s, i) => <OutlineNode key={s.id} s={s} num={[...prefix, i + 1].join('.')} {...rest} />)}
        </ul>
      </SortableContext>
    </DndContext>
  );
}
function OutlineNode(p: NodeProps) {
  const { s, num, selected, onSelect } = p;
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id: s.id });
  return (
    <li ref={setNodeRef} style={{ transform: CSS.Transform.toString(transform), transition, opacity: isDragging ? 0.5 : 1 }}>
      <div className={'pe-node' + (selected === s.id ? ' active' : '')}>
        <span className="pe-handle" {...attributes} {...listeners} aria-label="拖曳排序">⋮⋮</span>
        <button className="pe-node-label" onClick={() => onSelect(s.id)}>
          <span className="pe-num">{num}</span> {s.heading || '（未命名）'}
          {s.content.trim() && <span className="pe-done" title="已有內容"> ●</span>}
        </button>
      </div>
      {s.children.length > 0 && (
        <OutlineList list={s.children} prefix={num.split('.').map(Number)} selected={selected} onSelect={onSelect}
          onReorder={p.onReorder} sensors={p.sensors} />
      )}
    </li>
  );
}

// ---------- create dialog ----------
function CreateDialog({ initialTopic, onClose, onCreated }: { initialTopic?: string; onClose: () => void; onCreated: (id: string) => void }) {
  const topics = useLiveQuery(() => db.topics.orderBy('updatedAt').reverse().toArray(), []) ?? [];
  const [mode, setMode] = useState<'blank' | 'topic'>(initialTopic ? 'topic' : 'blank');
  const [topicId, setTopicId] = useState(initialTopic ?? '');
  const [pattern, setPattern] = useState<PaperPattern>('thematic-review');
  const [language, setLanguage] = useState<PaperLanguage>('zh-TW');
  const [style, setStyle] = useState<CitationStyle>('apa7');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (mode === 'topic' && !topicId && topics.length) setTopicId(topics[0].id); }, [mode, topicId, topics]);

  const create = async () => {
    setBusy(true);
    try {
      const topic = mode === 'topic' ? topics.find(t => t.id === topicId) : undefined;
      const hl: PaperLanguage = language === 'en' ? 'en' : 'zh-TW';
      const sections = topic ? await buildOutline(topic.id, pattern, hl) : templates(pattern, hl);
      const doc = newDoc(title.trim() || topic?.name || '未命名論文', pattern, sections, topic?.id, language, style);
      await db.papers.put(doc);
      onCreated(doc.id);
    } finally { setBusy(false); }
  };
  const [adv, setAdv] = useState(false);
  return (
    <Sheet open onClose={onClose} title="新增論文"
      footer={<>
        <button className="btn" onClick={onClose}>取消</button>
        <button className="btn btn-primary" disabled={busy || (mode === 'topic' && !topicId)} onClick={create}>建立</button>
      </>}>
      <div className="pe-seg">
        <button className={'chip' + (mode === 'blank' ? ' on' : '')} onClick={() => setMode('blank')}>空白架構</button>
        <button className={'chip' + (mode === 'topic' ? ' on' : '')} onClick={() => setMode('topic')}>從研究主題</button>
      </div>
      {mode === 'topic' && (
        <label className="field">研究主題
          {topics.length ? (
            <select className="select" value={topicId} onChange={e => setTopicId(e.target.value)}>
              {topics.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>
          ) : <span className="muted">尚無研究主題，請先到「研究」建立。</span>}
        </label>
      )}
      <label className="field">標題（可留空）
        <input className="input" value={title} onChange={e => setTitle(e.target.value)} placeholder="論文標題" />
      </label>
      <label className="field">論文類型
        <select className="select" value={pattern} onChange={e => setPattern(e.target.value as PaperPattern)}>
          {PATTERNS.map(p => <option key={p} value={p}>{PATTERN_LABELS[p]}</option>)}
        </select>
      </label>
      <button className="btn btn-ghost btn-sm" onClick={() => setAdv(a => !a)}>{adv ? '收合進階' : '進階（語言／引用格式）'}</button>
      {adv && (
        <>
          <label className="field">語言
            <select className="select" value={language} onChange={e => setLanguage(e.target.value as PaperLanguage)}>
              {(Object.keys(LANG_LABELS) as PaperLanguage[]).map(k => <option key={k} value={k}>{LANG_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="field">引用格式
            <select className="select" value={style} onChange={e => setStyle(e.target.value as CitationStyle)}>
              {(Object.keys(STYLE_LABELS) as CitationStyle[]).map(k => <option key={k} value={k}>{STYLE_LABELS[k]}</option>)}
            </select>
          </label>
        </>
      )}
    </Sheet>
  );
}

// ---------- evidence picker ----------
function Evidence({ section, onChange, onInsert, disabled }: { section: Section; onChange: (ids: string[]) => void; onInsert: (id: string) => void; disabled: boolean }) {
  const linked = useLiveQuery(() => db.cards.bulkGet(section.cardIds), [section.cardIds.join(',')]);
  const all = useLiveQuery(() => db.cards.where('kind').equals('paper').toArray(), []) ?? [];
  const [q, setQ] = useState('');
  const results = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return [];
    return all.filter(c => !section.cardIds.includes(c.id) &&
      (c.title.toLowerCase().includes(t) || c.tags.some(g => g.toLowerCase().includes(t)) ||
        (c.paper?.authors ?? []).some(a => a.toLowerCase().includes(t)))).slice(0, 8);
  }, [q, all, section.cardIds]);
  return (
    <details className="pe-evidence" open={section.cardIds.length > 0 && section.cardIds.length <= 3}>
      <summary className="pe-label">證據文獻（{section.cardIds.length}）</summary>
      {(linked ?? []).map((c, i) => (
        <div key={section.cardIds[i]} className="pe-ev">
          <span className="pe-ev-title">{c ? <><b>{firstAuthorLabel(c)}</b> {c.title}</> : <span className="muted">（卡片已刪除）</span>}</span>
          <Menu small label="文獻動作" items={[
            { label: '精讀', hidden: !c, onClick: () => c && openReader(c.id) },
            { label: '在游標處插入引用', hidden: !c, disabled: disabled, onClick: () => c && onInsert(c.id) },
            { label: '移除', danger: true, disabled: disabled, onClick: () => onChange(section.cardIds.filter(x => x !== section.cardIds[i])) },
          ]} />
        </div>
      ))}
      <input className="input" placeholder="搜尋文獻卡（標題／作者／標籤）以加入" value={q} onChange={e => setQ(e.target.value)} disabled={disabled} />
      {results.map((c: Card) => (
        <button key={c.id} className="pe-result" onClick={() => { onChange([...section.cardIds, c.id]); setQ(''); }}>
          ＋ <b>{firstAuthorLabel(c)}</b> {c.title}
        </button>
      ))}
      {q.trim() && !results.length && <div className="muted pe-small">找不到符合的文獻卡</div>}
    </details>
  );
}

// ---------- main ----------
export default function PaperEditor() {
  const docs = useLiveQuery(() => db.papers.orderBy('updatedAt').reverse().toArray(), []);
  const [docId, setDocId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingTopic, setPendingTopic] = useState<string | undefined>();

  useEffect(() => {
    try {
      const t = localStorage.getItem('paperread:pendingTopic');
      if (t) { localStorage.removeItem('paperread:pendingTopic'); setPendingTopic(t); setCreating(true); }
    } catch { /* ignore */ }
  }, []);

  const dlg = creating && (
    <CreateDialog initialTopic={pendingTopic} onClose={() => { setCreating(false); setPendingTopic(undefined); }}
      onCreated={id => { setCreating(false); setPendingTopic(undefined); setDocId(id); }} />
  );

  if (docId) return <>{<Editor key={docId} docId={docId} onBack={() => setDocId(null)} />}{dlg}</>;

  return (
    <div className="page pe-page">
      <div className="row pe-between">
        <h1 className="page-title">論文</h1>
        <button className="btn btn-primary" onClick={() => setCreating(true)}>新增論文</button>
      </div>
      {docs && !docs.length && <div className="empty">尚無論文。<br />可從空白架構開始，或由研究主題的整理結果自動產生大綱。</div>}
      <div className="pe-doclist">
        {(docs ?? []).map(d => (
          <div key={d.id} className="pe-doc" onClick={() => setDocId(d.id)}>
            <div className="pe-doc-main">
              <div className="pe-doc-title">{d.title}</div>
              <div className="muted pe-small">{PATTERN_LABELS[d.pattern]} · {countWordsDoc(d)} 字 · {new Date(d.updatedAt).toLocaleDateString('zh-TW')}</div>
            </div>
            <Menu small label="更多" items={[{ label: '刪除', danger: true, onClick: async () => {
              if (confirm(`刪除「${d.title}」？此動作無法復原。`)) await db.papers.delete(d.id);
            } }]} />
          </div>
        ))}
      </div>
      {dlg}
    </div>
  );
}

function countWordsDoc(d: PaperDoc): number {
  let n = 0;
  const w = (ss: Section[]) => ss.forEach(s => { n += countWords(s.content); w(s.children); });
  w(d.sections);
  return n;
}

function Editor({ docId, onBack }: { docId: string; onBack: () => void }) {
  const [doc, setDoc] = useState<PaperDoc | null>(null);
  const [selected, setSelected] = useState('');
  const [drawer, setDrawer] = useState(false);
  const [preview, setPreview] = useState(false);
  const [busy, setBusy] = useState<string>(''); // section id being drafted
  const [progress, setProgress] = useState<{ done: number; total: number; heading: string } | null>(null);
  const [msg, setMsg] = useState<{ text: string } | null>(null);
  const hasAI = useLiveQuery(async () => !!(await getSettings()).llmApiKey?.trim(), [], false);
  const [toast, setToast] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const timer = useRef<number | undefined>(undefined);
  const dirty = useRef<PaperDoc | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 150, tolerance: 6 } }),
  );

  useEffect(() => {
    db.papers.get(docId).then(d => { if (d) { setDoc(d); setSelected(s => s || d.sections[0]?.id || ''); } });
  }, [docId]);

  const flush = useCallback(async () => {
    window.clearTimeout(timer.current);
    const d = dirty.current;
    if (d) { dirty.current = null; await db.papers.put(d); }
  }, []);
  useEffect(() => () => { abortRef.current?.abort(); void flush(); }, [flush]);

  const edit = useCallback((fn: (d: PaperDoc) => void) => {
    setDoc(prev => {
      if (!prev) return prev;
      const next = clone(prev);
      fn(next);
      next.updatedAt = Date.now();
      dirty.current = next;
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => { void flush(); }, 600);
      return next;
    });
  }, [flush]);

  const cites = useLiveQuery(async () => (doc ? loadCards(doc) : []), [doc?.sections && JSON.stringify(doc.sections.map(function f(s: Section): unknown { return [s.cardIds, s.children.map(f)]; }))]) ?? [];

  if (!doc) return <div className="loading">載入中…</div>;
  const sel = findSection(doc.sections, selected);
  const locked = !!progress;
  const flash = (t: string) => { setToast(t); window.setTimeout(() => setToast(''), 2000); };

  const handleErr = (e: unknown) => {
    if ((e as Error)?.name === 'AbortError') return;
    setMsg({ text: errMsg(e) });
  };

  const onMove = (id: string, d: 'up' | 'down' | 'in' | 'out') => edit(x => { moveSection(x.sections, id, d); });
  const onReorder = (e: DragEndEvent) => {
    const { active, over } = e;
    if (!over || active.id === over.id) return;
    edit(x => {
      const a = locate(x.sections, String(active.id)); const o = locate(x.sections, String(over.id));
      if (a && o && a.list === o.list) {
        const moved = arrayMove(a.list, a.idx, o.idx);
        a.list.splice(0, a.list.length, ...moved);
      }
    });
  };
  const addSection = (asChild: boolean) => {
    const ns: Section = { id: uid(), heading: '新章節', content: '', cardIds: [], children: [], targetWords: 400 };
    edit(x => {
      if (sel && asChild) findSection(x.sections, sel.id)!.children.push(ns);
      else if (sel) { const l = locate(x.sections, sel.id)!; l.list.splice(l.idx + 1, 0, ns); }
      else x.sections.push(ns);
    });
    setSelected(ns.id);
  };
  const deleteSection = () => {
    if (!sel || !confirm(`刪除「${sel.heading}」及其子章節？`)) return;
    const l = locate(doc.sections, sel.id)!;
    const next = l.list[l.idx + 1] ?? l.list[l.idx - 1] ?? l.parent;
    edit(x => { const loc = locate(x.sections, sel.id)!; loc.list.splice(loc.idx, 1); });
    setSelected(next?.id ?? '');
  };
  const setField = (patch: Partial<Section>) => sel && edit(x => Object.assign(findSection(x.sections, sel.id)!, patch));

  const aiDraft = async () => {
    if (!sel) return;
    if (sel.content.trim() && !confirm('此節已有內容，重新撰寫會覆蓋，是否繼續？')) return;
    setMsg(null); setBusy(sel.id);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      await flush();
      const text = await draftSection(doc, sel.id, { signal: ac.signal });
      edit(x => { findSection(x.sections, sel.id)!.content = text; });
      if (!hasAI && /【待補|\[TODO/.test(text)) flash('已產生結構化草稿，請補寫標示【待補】之處');
    } catch (e) { handleErr(e); } finally { setBusy(''); abortRef.current = null; }
  };
  const aiAll = async () => {
    const empty = leafSections(doc.sections).filter(l => !l.content.trim()).length;
    const overwrite = empty === 0;
    if (overwrite && !confirm('所有章節皆已有內容，要全部重新產生並覆蓋嗎？')) return;
    setMsg(null);
    const ac = new AbortController(); abortRef.current = ac;
    setProgress({ done: 0, total: 1, heading: '' });
    try {
      await flush();
      const result = await generateAll(doc, (done, total, heading) => {
        setProgress({ done, total, heading });
        void db.papers.get(doc.id).then(d => { if (d) setDoc(d); });
      }, ac.signal, { overwrite });
      setDoc(result);
    } catch (e) {
      handleErr(e);
      const d = await db.papers.get(doc.id); if (d) setDoc(d);
    } finally { setProgress(null); abortRef.current = null; }
  };
  const cancel = () => abortRef.current?.abort();

  const bl = bodyLang(docLang(doc));
  const paper = doc.front?.pageSize ?? 'A4';
  const professional = !!doc.front?.professional;
  const setPaper = (v: 'A4' | 'Letter') => setFront({ pageSize: v });
  const setProfessional = (v: boolean) => setFront({ professional: v });
  const front = (doc.front ?? { authors: [] }) as FrontMatter;
  const setFront = (patch: Partial<FrontMatter>) => edit(x => { x.front = { ...(x.front ?? { authors: [] }), ...patch }; });
  const changeLanguage = (lang: PaperLanguage) => {
    const relabel = confirm('是否同時將預設章節標題轉為' + (lang === 'en' ? '英文' : '中文') + '？（自訂標題不受影響）');
    edit(x => { x.language = lang; if (relabel) relabelHeadings(x.sections, lang === 'en' ? 'en' : 'zh-TW'); });
  };
  const aiAbstract = async (l: 'zh-TW' | 'en') => {
    setMsg(null); setBusy('abstract-' + l);
    const ac = new AbortController(); abortRef.current = ac;
    try {
      await flush();
      const r = await generateAbstract(doc, l, { signal: ac.signal });
      setFront(l === 'en' ? { abstractEn: r.abstract, keywordsEn: r.keywords } : { abstractZh: r.abstract, keywordsZh: r.keywords });
    } catch (e) { handleErr(e); } finally { setBusy(''); abortRef.current = null; }
  };
  const aiTranslate = async () => {
    if (!sel || !sel.content.trim()) return;
    const to = /[\u3400-\u9fff]/.test(sel.content) ? 'en' : 'zh-TW';
    if (!confirm(`將本節翻譯為${to === 'en' ? '英文' : '中文'}並覆蓋內容？（引用標記會保留）`)) return;
    setMsg(null); setBusy(sel.id);
    const ac = new AbortController(); abortRef.current = ac;
    try { const t = await translateText(sel.content, to, { signal: ac.signal }); edit(x => { findSection(x.sections, sel.id)!.content = t; }); }
    catch (e) { handleErr(e); } finally { setBusy(''); abortRef.current = null; }
  };
  const insertCite = (id: string) => {
    if (!sel) return;
    const ta = taRef.current; const tok = `[@${id}]`;
    const pos = ta ? ta.selectionStart : sel.content.length;
    const end = ta ? ta.selectionEnd : pos;
    setField({ content: sel.content.slice(0, pos) + tok + sel.content.slice(end) });
    setPreview(false);
  };
  const ctx = ctxFor(doc, cites, bl);

  // export
  const getMd = async () => { await flush(); return docToMarkdown(dirty.current ?? doc); };
  const copyMd = async () => { try { await navigator.clipboard.writeText(await getMd()); flash('已複製 Markdown'); } catch { flash('複製失敗'); } };
  const fileName = (ext: string) => `${doc.title.replace(/[\\/:*?"<>|]/g, '_') || 'paper'}.${ext}`;
  const download = async () => {
    const blob = new Blob([await getMd()], { type: 'text/markdown;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = fileName('md');
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const print = async () => {
    await flush();
    const d = dirty.current ?? doc;
    const html = toPrintHtml(d, await loadCards(d), renderMd, paper);
    const w = window.open('', '_blank');
    if (!w) { flash('無法開啟列印視窗（請允許彈出視窗）'); return; }
    w.document.write(html);
    w.document.close(); w.focus(); setTimeout(() => w.print(), 400);
  };
  const downloadDocx = async () => {
    await flush();
    const d = dirty.current ?? doc;
    try { await exportDocx(d, await loadCards(d), { paper, professional }); flash('已產生 .docx'); } catch (e) { setMsg({ text: 'Word 匯出失敗：' + errMsg(e) }); }
  };
  const share = async () => {
    const md = await getMd();
    try { await navigator.share({ title: doc.title, text: md }); } catch { /* cancelled */ }
  };

  const total = countWordsDoc(doc);
  const setTarget = () => {
    if (!sel) return;
    const v = prompt('本節目標字數（留空取消目標）', sel.targetWords ? String(sel.targetWords) : '');
    if (v === null) return;
    setField({ targetWords: v.trim() && Number(v) > 0 ? Number(v) : undefined });
  };
  const selMove = (d: 'up' | 'down' | 'in' | 'out') => sel && onMove(sel.id, d);

  return (
    <div className="pe-root">
      <div className="pe-top">
        <button className="icon-btn" aria-label="返回列表" onClick={async () => { await flush(); onBack(); }}><Icon name="back" /></button>
        <input className="pe-title-input" value={doc.title} onChange={e => edit(x => { x.title = e.target.value; })} aria-label="論文標題" />
        <Menu label="更多" items={[
          { title: '匯出' },
          { label: '下載 Word (.docx)', onClick: downloadDocx },
          { label: '下載 Markdown (.md)', onClick: download },
          { label: '複製 Markdown', onClick: copyMd },
          { label: '列印／存 PDF', onClick: print },
          { label: '分享', hidden: typeof navigator.share !== 'function', onClick: share },
          'sep',
          { label: '文件設定（語言／引用／封面）', onClick: () => setShowSettings(true) },
          { label: '產生中文摘要與關鍵詞', hidden: docLang(doc) === 'en', disabled: !!busy || locked, onClick: () => aiAbstract('zh-TW') },
          { label: '產生英文摘要與關鍵詞', hidden: docLang(doc) === 'zh-TW', disabled: !!busy || locked, onClick: () => aiAbstract('en') },
        ]} />
      </div>

      <div className="pe-toolbar">
        {progress ? (
          <>
            <div className="pe-progress"><div style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} /></div>
            <span className="pe-small muted">{progress.done}/{progress.total} {progress.heading && `撰寫「${progress.heading}」`}</span>
            <button className="btn btn-sm" onClick={cancel}>取消</button>
          </>
        ) : (
          <>
            <button className="btn btn-primary" onClick={aiAll}><Icon name="sparkle" size={18} />一鍵產生全文</button>
            <span className="muted pe-small">{total} 字 · {LANG_LABELS[docLang(doc)]} · {STYLE_LABELS[docStyle(doc)]}</span>
            {busy.startsWith('abstract') && <button className="btn btn-sm" onClick={cancel}>取消產生摘要</button>}
          </>
        )}
      </div>

      <Sheet open={showSettings} onClose={() => setShowSettings(false)} title="文件設定" wide
        footer={<button className="btn btn-primary" onClick={() => setShowSettings(false)}>完成</button>}>
        <div className="pe-grid">
          <label className="field">語言
            <select className="select" value={docLang(doc)} onChange={e => changeLanguage(e.target.value as PaperLanguage)}>
              {(Object.keys(LANG_LABELS) as PaperLanguage[]).map(k => <option key={k} value={k}>{LANG_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="field">引用格式
            <select className="select" value={docStyle(doc)} onChange={e => edit(x => { x.citationStyle = e.target.value as CitationStyle; })}>
              {(Object.keys(STYLE_LABELS) as CitationStyle[]).map(k => <option key={k} value={k}>{STYLE_LABELS[k]}</option>)}
            </select>
          </label>
          <label className="field">紙張
            <select className="select" value={paper} onChange={e => setPaper(e.target.value as 'A4' | 'Letter')}>
              <option value="A4">A4</option><option value="Letter">Letter</option>
            </select>
          </label>
        </div>
        <label className="toggle-row"><span>專業論文格式（頁首 Running head）</span>
          <input type="checkbox" checked={professional} onChange={e => setProfessional(e.target.checked)} />
        </label>
        <details className="pe-adv">
          <summary>封面資訊</summary>
          <div className="pe-grid">
            {docLang(doc) !== 'en' && <label className="field">中文題名<input className="input" value={front.titleZh ?? ''} onChange={e => setFront({ titleZh: e.target.value })} /></label>}
            {docLang(doc) !== 'zh-TW' && <label className="field">English title<input className="input" value={front.titleEn ?? ''} onChange={e => setFront({ titleEn: e.target.value })} /></label>}
            <label className="field">作者（以逗號分隔）<input className="input" value={front.authors.join(', ')} onChange={e => setFront({ authors: e.target.value.split(/[,，、]\s*/).filter(Boolean) })} /></label>
            <label className="field">單位／學校<input className="input" value={front.affiliation ?? ''} onChange={e => setFront({ affiliation: e.target.value })} /></label>
            <label className="field">課程<input className="input" value={front.course ?? ''} onChange={e => setFront({ course: e.target.value })} /></label>
            <label className="field">指導教授<input className="input" value={front.instructor ?? ''} onChange={e => setFront({ instructor: e.target.value })} /></label>
            <label className="field">日期<input className="input" value={front.date ?? ''} onChange={e => setFront({ date: e.target.value })} /></label>
            <label className="field">Running head（≤50 字元）<input className="input" maxLength={50} value={front.runningHead ?? ''} onChange={e => setFront({ runningHead: e.target.value })} /></label>
          </div>
        </details>
        <details className="pe-adv">
          <summary>摘要與關鍵詞</summary>
          {docLang(doc) !== 'en' && (
            <div className="field">中文摘要（約 300–500 字）
              <textarea className="textarea" rows={4} value={front.abstractZh ?? ''} onChange={e => setFront({ abstractZh: e.target.value })} />
              <input className="input" placeholder="關鍵詞（以逗號分隔，3–5 個）" value={(front.keywordsZh ?? []).join('、')} onChange={e => setFront({ keywordsZh: e.target.value.split(/[,，、]\s*/).filter(Boolean) })} />
              <button className="btn btn-sm" disabled={!!busy || locked} onClick={() => aiAbstract('zh-TW')}>{busy === 'abstract-zh-TW' ? '產生中…' : '產生中文摘要與關鍵詞'}</button>
            </div>
          )}
          {docLang(doc) !== 'zh-TW' && (
            <div className="field">Abstract（≤250 words）
              <textarea className="textarea" rows={4} value={front.abstractEn ?? ''} onChange={e => setFront({ abstractEn: e.target.value })} />
              <input className="input" placeholder="Keywords (comma-separated, 3–5)" value={(front.keywordsEn ?? []).join(', ')} onChange={e => setFront({ keywordsEn: e.target.value.split(/[,，]\s*/).filter(Boolean) })} />
              <div className="muted pe-small">字數：{countWords(front.abstractEn ?? '')}</div>
              <button className="btn btn-sm" disabled={!!busy || locked} onClick={() => aiAbstract('en')}>{busy === 'abstract-en' ? 'Generating…' : '產生英文摘要與關鍵詞'}</button>
            </div>
          )}
          {busy.startsWith('abstract') && <button className="btn btn-sm" onClick={cancel}>取消</button>}
        </details>
      </Sheet>

      {toast && <div className="toast">{toast}</div>}
      {msg && (
        <div className="banner">
          <span className="error">{msg.text}</span>
          <button className="icon-btn sm" aria-label="關閉" onClick={() => setMsg(null)}><Icon name="close" size={18} /></button>
        </div>
      )}

      <button className="pe-drawer-toggle" onClick={() => setDrawer(o => !o)}>
        <span>{drawer ? '收合大綱' : `大綱：${sel?.heading ?? '未選'}`}</span><Icon name="down" size={18} />
      </button>

      <div className="pe-body">
        <aside className={'pe-outline' + (drawer ? ' open' : '')}>
          <div className="pe-outline-head">
            <span className="section-label" style={{ margin: 0 }}>大綱</span>
            <Menu small label="章節動作" items={[
              { label: '新增同層章節', onClick: () => addSection(false) },
              { label: '新增子章節', disabled: !sel, onClick: () => addSection(true) },
              'sep',
              { label: '上移', disabled: !sel, onClick: () => selMove('up') },
              { label: '下移', disabled: !sel, onClick: () => selMove('down') },
              { label: '提升層級', disabled: !sel, onClick: () => selMove('out') },
              { label: '降低層級', disabled: !sel, onClick: () => selMove('in') },
              'sep',
              { label: '刪除章節', danger: true, disabled: !sel, onClick: deleteSection },
            ]} />
          </div>
          {doc.sections.length ? (
            <OutlineList list={doc.sections} prefix={[]} selected={selected} sensors={sensors}
              onSelect={id => { setSelected(id); setDrawer(false); }} onReorder={onReorder} />
          ) : <div className="muted">尚無章節</div>}
        </aside>

        <section className="pe-pane">
          {!sel ? <div className="muted">請選擇或新增章節。</div> : (
            <>
              <input className="pe-heading-input" value={sel.heading} onChange={e => setField({ heading: e.target.value })} aria-label="章節標題" />
              <textarea className="pe-guidance" rows={2} value={sel.guidance ?? ''} placeholder="本節寫作指引（可編輯）"
                onChange={e => setField({ guidance: e.target.value })} />
              <div className="pe-wc">
                <WordCount n={countWords(sel.content)} target={sel.targetWords} onClick={setTarget} />
                <span className="pe-spacer" />
                <button className="btn btn-ghost btn-sm" onClick={() => setPreview(p => !p)}>{preview ? '編輯' : '預覽'}</button>
                <button className="btn btn-sm" disabled={!!busy || locked} onClick={aiDraft}>
                  {busy === sel.id ? '撰寫中…' : '撰寫此節'}
                </button>
                {busy === sel.id && <button className="btn btn-sm" onClick={cancel}>取消</button>}
                <Menu small label="本節選項" items={[
                  { label: '設定目標字數', onClick: setTarget },
                  { label: '中⇄英翻譯本節', hidden: !hasAI, disabled: !!busy || locked || !sel.content.trim(), onClick: aiTranslate },
                ]} />
              </div>
              {sel.children.length > 0 && <div className="muted pe-small">此節含子章節；內文會置於子章節之前。「一鍵產生全文」只撰寫最末層章節。</div>}
              {preview
                ? <div className="pe-preview" dangerouslySetInnerHTML={{ __html: renderMd(sel.content ? renderCitations(sel.content, ctx) : '*（尚無內容）*') }} />
                : <textarea ref={taRef} className="textarea pe-editor" value={sel.content} disabled={locked || busy === sel.id}
                    placeholder="以 Markdown 撰寫；從下方「證據文獻」插入 [@文獻id] 引用標記（依引用格式自動轉換）；缺證據處標註【待補證據】"
                    onChange={e => setField({ content: e.target.value })} />}
              <Evidence section={sel} disabled={locked} onInsert={insertCite} onChange={ids => setField({ cardIds: ids })} />
            </>
          )}
        </section>
      </div>
    </div>
  );
}

function WordCount({ n, target, onClick }: { n: number; target?: number; onClick?: () => void }) {
  const pct = target ? Math.min(1, n / target) : 0;
  const R = 13, C = 2 * Math.PI * R;
  return (
    <button type="button" className="pe-wcbox" onClick={onClick} title="設定目標字數">
      <svg width="32" height="32" viewBox="0 0 32 32" aria-hidden>
        <circle cx="16" cy="16" r={R} fill="none" stroke="var(--surface-2)" strokeWidth="3" />
        {target ? <circle cx="16" cy="16" r={R} fill="none" stroke="var(--accent)" strokeWidth="3" strokeLinecap="round"
          strokeDasharray={`${C * pct} ${C}`} transform="rotate(-90 16 16)" /> : null}
      </svg>
      <span className="pe-small">{n}{target ? ` / ${target}` : ''} 字</span>
    </button>
  );
}
