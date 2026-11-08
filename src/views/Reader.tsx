import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import { openReader } from '../App';
import { surname } from '../lib/citation';
import {
  KIND_LABEL, KIND_ORDER, extractKeyPoints, getFullText, linkPointsAcrossPapers, newPointId,
  savePastedText, savePdfFile, saveReading,
} from '../lib/reading';
import { getSettings } from '../db';
import type { Card, FullText, KeyPoint, KeyPointKind, Relation } from '../types';
import './reader.css';

interface Props { cardId: string; pointId?: string; onClose: () => void }
type Tab = 'points' | 'full';
type Status = 'unread' | 'reading' | 'done';
const STATUS_LABEL: Record<Status, string> = { unread: '未讀', reading: '閱讀中', done: '已讀' };
const NEXT: Record<Status, Status> = { unread: 'reading', reading: 'done', done: 'unread' };
const KIND_COLOR: Record<KeyPointKind, string> = {
  question: 'var(--k-quote)', method: 'var(--k-paper)', sample: 'var(--k-note)', finding: 'var(--k-voice)',
  limitation: 'var(--k-gap)', contribution: 'var(--k-idea)', quote: 'var(--k-keep)', note: 'var(--k-note)',
};
const REL_LABEL: Record<string, string> = { supports: '支持', contradicts: '矛盾', similar: '關鍵詞相近', coupled: '共同引用', 'co-cited': '共被引用', cites: '引用' };
const CJK = /[㐀-鿿豈-﫿]/;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const quoteRx = (q: string) => new RegExp(q.trim().split(/\s+/).map(esc).join('\\s+'));
const squeeze = (s: string) => s.replace(/\s+/g, '').toLowerCase();

function label(c: Card): string {
  const a = c.paper?.authors?.[0];
  const who = a ? surname(a) + ((c.paper?.authors?.length ?? 0) > 1 ? ' 等' : '') : c.title.slice(0, 12);
  return `${who} (${c.paper?.year ?? 'n.d.'})`;
}

function flash(el: Element | null) {
  if (!el) return;
  el.classList.remove('rd-flash');
  void (el as HTMLElement).offsetWidth;
  el.classList.add('rd-flash');
  setTimeout(() => el.classList.remove('rd-flash'), 2000);
}

interface Link { rel: Relation; other: Card; point?: KeyPoint }

export default function Reader({ cardId, pointId, onClose }: Props) {
  const card = useLiveQuery(() => db.cards.get(cardId), [cardId]);
  const data = useLiveQuery(async () => {
    const rels = [...await db.relations.where('from').equals(cardId).toArray(), ...await db.relations.where('to').equals(cardId).toArray()];
    const ids = [...new Set(rels.map(r => (r.from === cardId ? r.to : r.from)))];
    const cards = (await db.cards.bulkGet(ids)).filter((c): c is Card => !!c);
    return { rels, byId: new Map(cards.map(c => [c.id, c])) };
  }, [cardId]);

  const [tab, setTab] = useState<Tab>('points');
  const [ft, setFt] = useState<FullText | null>(null);
  const [ftReason, setFtReason] = useState<string | undefined>();
  const [ftLoading, setFtLoading] = useState(true);
  const [open, setOpen] = useState<string | null>(pointId ?? null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ text: '', kind: 'note' as KeyPointKind });
  const [newText, setNewText] = useState('');
  const [menu, setMenu] = useState(false);
  const [paste, setPaste] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const [toast, setToast] = useState('');
  const [sel, setSel] = useState<{ x: number; y: number; text: string; page?: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fullRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<Card | undefined>(undefined);
  const skipRestore = useRef(false);
  const inited = useRef(false);
  cardRef.current = card;

  const reading = card?.reading;
  const points = useMemo(() => reading?.keyPoints ?? [], [reading]);
  const status: Status = reading?.status ?? 'unread';

  const say = useCallback((m: string) => { setToast(m); setTimeout(() => setToast(''), 2200); }, []);

  // load full text once
  const loadFt = useCallback(async (c: Card, skipCache = false) => {
    setFtLoading(true);
    const r = await getFullText(c, { skipCache });
    setFt(r.fulltext); setFtReason(r.reason); setFtLoading(false);
  }, []);
  useEffect(() => {
    if (!card || inited.current) return;
    inited.current = true;
    loadFt(card);
    if (!card.reading || card.reading.status === 'unread') saveReading(card.id, { status: 'reading' });
  }, [card, loadFt]);

  // Esc closes (menu / paste first)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (paste !== null) setPaste(null); else if (menu) setMenu(false); else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, paste, onClose]);

  // jump to a given key point on open
  useEffect(() => {
    if (!pointId || !card || !points.length) return;
    const t = setTimeout(() => {
      const el = document.getElementById('rd-kp-' + pointId);
      el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(el);
    }, 150);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pointId, !!card]);

  // restore reading progress when entering 全文
  useEffect(() => {
    if (tab !== 'full' || !ft) return;
    if (skipRestore.current) { skipRestore.current = false; return; }
    const t = setTimeout(() => {
      const el = scrollRef.current; const p = cardRef.current?.reading?.progress ?? 0;
      if (el) el.scrollTop = p * (el.scrollHeight - el.clientHeight);
    }, 40);
    return () => clearTimeout(t);
  }, [tab, ft]);

  const progTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const onScroll = () => {
    if (tab !== 'full') return;
    clearTimeout(progTimer.current);
    progTimer.current = setTimeout(() => {
      const el = scrollRef.current; if (!el) return;
      const max = el.scrollHeight - el.clientHeight;
      if (max > 0) saveReading(cardId, { progress: Math.min(1, Math.max(0, el.scrollTop / max)) });
    }, 600);
    setSel(null);
  };
  useEffect(() => () => clearTimeout(progTimer.current), []);

  // floating "加為重點" on text selection
  useEffect(() => {
    if (tab !== 'full') { setSel(null); return; }
    let t: ReturnType<typeof setTimeout> | undefined;
    const onSel = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const s = window.getSelection();
        const root = fullRef.current;
        if (!s || s.isCollapsed || !root || !root.contains(s.anchorNode) || !root.contains(s.focusNode)) { setSel(null); return; }
        const text = s.toString().replace(/\s+/g, ' ').trim();
        if (text.length < 6) { setSel(null); return; }
        const r = s.getRangeAt(0).getBoundingClientRect();
        const pEl = (s.anchorNode instanceof Element ? s.anchorNode : s.anchorNode?.parentElement)?.closest('[data-i]') as HTMLElement | null;
        const page = pEl ? ft?.paragraphs[Number(pEl.dataset.i)]?.page : undefined;
        const x = Math.min(Math.max(r.left + r.width / 2, 60), window.innerWidth - 60);
        const y = r.bottom + 44 > window.innerHeight ? Math.max(r.top - 44, 8) : r.bottom + 10;
        setSel({ x, y, text, page });
      }, 180);
    };
    document.addEventListener('selectionchange', onSel);
    return () => { clearTimeout(t); document.removeEventListener('selectionchange', onSel); };
  }, [tab, ft]);

  // ----- derived: highlights -----
  const marks = useMemo(() => {
    const out = new Map<number, { s: number; e: number; id: string }[]>();
    if (!ft) return out;
    ft.paragraphs.forEach((p, i) => {
      if (p.heading) return;
      const ranges: { s: number; e: number; id: string }[] = [];
      for (const k of points) {
        if (!k.quote) continue;
        const m = quoteRx(k.quote).exec(p.text);
        if (m) ranges.push({ s: m.index, e: m.index + m[0].length, id: k.id });
      }
      ranges.sort((a, b) => a.s - b.s);
      const clean: typeof ranges = [];
      for (const r of ranges) if (!clean.length || r.s >= clean[clean.length - 1].e) clean.push(r);
      if (clean.length) out.set(i, clean);
    });
    return out;
  }, [ft, points]);

  // ----- links per point -----
  const linksByPoint = useMemo(() => {
    const m = new Map<string, Link[]>();
    if (!data) return m;
    for (const rel of data.rels) {
      const mine = rel.from === cardId ? rel.fromPoint : rel.toPoint;
      if (!mine) continue;
      const other = data.byId.get(rel.from === cardId ? rel.to : rel.from);
      if (!other) continue;
      const op = rel.from === cardId ? rel.toPoint : rel.fromPoint;
      const point = other.reading?.keyPoints.find(k => k.id === op);
      if (!point) continue;
      (m.get(mine) ?? m.set(mine, []).get(mine)!).push({ rel, other, point });
    }
    return m;
  }, [data, cardId]);

  const relatedPapers = useMemo(() => {
    if (!data) return [];
    return [...data.byId.values()].filter(c => c.paper).slice(0, 12);
  }, [data]);

  // ----- actions -----
  const setPoints = (next: KeyPoint[]) => saveReading(cardId, { keyPoints: next });
  const patchPoint = (id: string, patch: Partial<KeyPoint>) => setPoints(points.map(k => (k.id === id ? { ...k, ...patch } : k)));
  const removePoint = async (id: string) => {
    await setPoints(points.filter(k => k.id !== id));
    const stale = (data?.rels ?? []).filter(r => (r.from === cardId && r.fromPoint === id) || (r.to === cardId && r.toPoint === id));
    if (stale.length) await db.relations.bulkDelete(stale.map(r => r.id));
  };
  const addPoint = async () => {
    const t = newText.trim(); if (!t) return;
    setNewText('');
    await setPoints([...points, { id: newPointId(points), kind: 'note', text: t, confirmed: true, createdAt: Date.now() }]);
  };
  const addFromSelection = async () => {
    if (!sel) return;
    const quote = sel.text;
    const text = quote.length > 140 ? quote.slice(0, 140) + '…' : quote;
    await setPoints([...points, { id: newPointId(points), kind: 'quote', text, quote, page: sel.page, confirmed: true, createdAt: Date.now() }]);
    window.getSelection()?.removeAllRanges(); setSel(null); say('已加為重點');
  };
  const viewInFull = (k: KeyPoint) => {
    if (!k.quote || !ft) return;
    skipRestore.current = true; setTab('full');
    setTimeout(() => {
      const root = fullRef.current; if (!root) return;
      let el: Element | null = root.querySelector(`[data-kp="${k.id}"]`);
      if (!el) {
        const q = squeeze(k.quote!);
        const i = ft.paragraphs.findIndex(p => squeeze(p.text).includes(q));
        if (i >= 0) el = root.querySelector(`[data-i="${i}"]`);
      }
      if (el) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(el); } else say('在全文中找不到這段原句');
    }, 80);
  };
  const jumpToPoint = (id: string) => {
    setTab('points'); setOpen(id);
    setTimeout(() => { const el = document.getElementById('rd-kp-' + id); el?.scrollIntoView({ block: 'center', behavior: 'smooth' }); flash(el); }, 80);
  };

  const organise = async () => {
    if (!card) return;
    setErr('');
    try {
      let f = ft;
      if (!f) { setBusy('取得全文中…'); const r = await getFullText(card); f = r.fulltext; setFt(f); }
      if (!f) throw new Error('沒有可用的全文或摘要，請先上傳 PDF 或貼上全文');
      setBusy('整理重點中…');
      const lang = (await getSettings()).language;
      const r = await extractKeyPoints(card, f, lang);
      // keep what the user confirmed or wrote; unconfirmed suggestions are replaced
      const merged = points.filter(k => k.confirmed || k.kind === 'quote' || k.kind === 'note');
      for (const k of r.keyPoints) {
        if (merged.some(m => m.quote && k.quote && m.quote === k.quote)) continue;
        merged.push(merged.some(m => m.id === k.id) ? { ...k, id: newPointId(merged) } : k);
      }
      await saveReading(cardId, { summary: r.summary || reading?.summary, keyPoints: merged });
      if (!r.keyPoints.length) say('沒有找到明確的重點句，可到「全文」選取文字手動加入');
      setBusy('比對相關文獻中…');
      const l = await linkPointsAcrossPapers(cardId);
      if (l.linked) say(`已連結 ${l.linked} 組相關重點`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally { setBusy(null); }
  };
  const relink = async () => {
    setMenu(false); setErr('');
    setBusy('比對相關文獻中…');
    try {
      const l = await linkPointsAcrossPapers(cardId);
      say(l.related ? (l.linked ? `已連結 ${l.linked} 組相關重點` : '沒有找到對應的重點') : '還沒有相關文獻（或相關文獻尚未整理重點）');
    } catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); }
  };
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setErr(''); setBusy('解析 PDF 中…');
    try { const r = await savePdfFile(cardId, f); setFt(r); setFtReason(undefined); setTab('full'); say('已匯入全文'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); } finally { setBusy(null); if (fileRef.current) fileRef.current.value = ''; }
  };
  const onPaste = async () => {
    if (!paste?.trim()) return;
    try { const r = await savePastedText(cardId, paste); setFt(r); setFtReason(undefined); setPaste(null); setTab('full'); say('已儲存全文'); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const link = card?.paper?.url || card?.paper?.pdfUrl || (card?.paper?.doi ? (/^https?:/i.test(card.paper.doi) ? card.paper.doi : `https://doi.org/${card.paper.doi}`) : undefined);
  const hasRealText = !!ft && ft.source !== 'abstract';

  if (card === undefined) return <div className="rd-root"><div className="rd-load">載入中…</div></div>;
  if (!card) return <div className="rd-root"><div className="rd-load">找不到這張卡片<br /><button className="btn" onClick={onClose}>返回</button></div></div>;

  const grouped = KIND_ORDER.map(k => ({ kind: k, items: points.filter(p => p.kind === k) })).filter(g => g.items.length);

  return (
    <div className="rd-root" role="dialog" aria-label="精讀">
      <header className="rd-head">
        <div className="rd-head-in">
          <button className="rd-icon" onClick={onClose} aria-label="返回">‹</button>
          <div className="rd-title">{card.title}</div>
          <button className={'rd-pill rd-' + status} onClick={() => saveReading(cardId, { status: NEXT[status] })} title="點一下切換閱讀狀態">{STATUS_LABEL[status]}</button>
          <div className="rd-menu-wrap">
            <button className="rd-icon" onClick={() => setMenu(m => !m)} aria-label="更多">⋯</button>
            {menu && (
              <>
                <div className="rd-scrim" onClick={() => setMenu(false)} />
                <div className="rd-menu" role="menu">
                  <button onClick={() => { setMenu(false); fileRef.current?.click(); }}>上傳 PDF</button>
                  <button onClick={() => { setMenu(false); setPaste(''); }}>貼上全文</button>
                  {link && <a href={link} target="_blank" rel="noreferrer" onClick={() => setMenu(false)}>開啟原文連結</a>}
                  <button disabled={!!busy} onClick={() => { setMenu(false); organise(); }}>重新整理重點</button>
                  <button disabled={!!busy || !points.length} onClick={relink}>比對相關文獻</button>
                </div>
              </>
            )}
          </div>
        </div>
        <div className="rd-tabs-wrap">
          <div className="rd-tabs" role="tablist">
            <button role="tab" aria-selected={tab === 'points'} className={tab === 'points' ? 'on' : ''} onClick={() => setTab('points')}>重點</button>
            <button role="tab" aria-selected={tab === 'full'} className={tab === 'full' ? 'on' : ''} onClick={() => setTab('full')}>全文</button>
          </div>
        </div>
        <input ref={fileRef} type="file" accept="application/pdf" hidden onChange={e => onFile(e.target.files?.[0])} />
      </header>

      <div className="rd-scroll" ref={scrollRef} onScroll={onScroll}>
        <div className="rd-col">
          {err && <p className="rd-note"><span className="error">{err}</span></p>}
          {busy && <p className="rd-busy"><span className="rd-spin" />{busy}</p>}

          {tab === 'points' && (
            <section>
              {reading?.summary && <p className="rd-summary">{reading.summary}</p>}

              {!points.length && (
                <div className="rd-empty">
                  <p className="rd-empty-t">還沒有重點</p>
                  <p className="muted">從全文或摘要挑出研究問題、方法、樣本、發現與限制的原句，供你確認，並連到相關文獻的重點。</p>
                  <button className="btn btn-primary" disabled={!!busy || ftLoading} onClick={organise}>整理重點</button>
                  <p className="rd-hint">或到「全文」選取文字，手動加為重點</p>
                </div>
              )}

              {grouped.map(g => (
                <div key={g.kind} className="rd-group">
                  <div className="rd-kind" style={{ ['--kc' as string]: KIND_COLOR[g.kind] }}><i />{KIND_LABEL[g.kind]}</div>
                  {g.items.map(k => {
                    const isOpen = open === k.id; const links = linksByPoint.get(k.id) ?? [];
                    return (
                      <article key={k.id} id={'rd-kp-' + k.id} className={'rd-point' + (isOpen ? ' open' : '')}>
                        {editing === k.id ? (
                          <div className="rd-edit">
                            <textarea className="textarea" autoFocus value={draft.text} onChange={e => setDraft({ ...draft, text: e.target.value })} />
                            <div className="rd-edit-row">
                              <select className="select" value={draft.kind} onChange={e => setDraft({ ...draft, kind: e.target.value as KeyPointKind })}>
                                {KIND_ORDER.map(x => <option key={x} value={x}>{KIND_LABEL[x]}</option>)}
                              </select>
                              <button className="btn btn-sm" onClick={() => setEditing(null)}>取消</button>
                              <button className="btn btn-sm btn-primary" onClick={() => { patchPoint(k.id, { text: draft.text.trim() || k.text, kind: draft.kind, confirmed: true }); setEditing(null); }}>儲存</button>
                            </div>
                          </div>
                        ) : (
                          <>
                            <button className="rd-ptext" onClick={() => setOpen(isOpen ? null : k.id)} aria-expanded={isOpen}>
                              <span>{k.text}</span>
                              {!k.confirmed && <em className="rd-ai">{k.ai ? 'AI' : '建議'}</em>}
                              {!isOpen && links.length > 0 && <em className="rd-cnt">↔ {links.length}</em>}
                            </button>
                            {isOpen && (
                              <div className="rd-more">
                                {k.quote && <blockquote className="rd-quote">{k.quote}{k.page ? <span> — p.{k.page}</span> : null}</blockquote>}
                                <div className="rd-acts">
                                  {k.quote && ft && <button className="rd-link" onClick={() => viewInFull(k)}>在全文中查看</button>}
                                  {!k.confirmed && <button className="rd-link" onClick={() => patchPoint(k.id, { confirmed: true })}>✓ 確認</button>}
                                  <button className="rd-link" onClick={() => { setEditing(k.id); setDraft({ text: k.text, kind: k.kind }); }}>編輯</button>
                                  <button className="rd-link rd-del" onClick={() => removePoint(k.id)}>刪除</button>
                                </div>
                                {links.length > 0 && (
                                  <div className="rd-rel">
                                    <div className="rd-rel-h">相關文獻</div>
                                    {links.map(l => (
                                      <button key={l.rel.id} className="rd-rel-i" onClick={() => openReader(l.other.id, l.point!.id)}>
                                        <i className={'rd-dot ' + l.rel.type} title={REL_LABEL[l.rel.type] ?? '相關'} />
                                        <span><b>{label(l.other)}</b>：{l.point!.text}<small>{l.rel.type === 'supports' || l.rel.type === 'contradicts' ? REL_LABEL[l.rel.type] + (l.rel.note ? '：' + l.rel.note : '') : (l.rel.note || REL_LABEL[l.rel.type])}</small></span>
                                      </button>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                          </>
                        )}
                      </article>
                    );
                  })}
                </div>
              ))}

              <form className="rd-add" onSubmit={e => { e.preventDefault(); addPoint(); }}>
                <input className="input" value={newText} onChange={e => setNewText(e.target.value)} placeholder="＋ 寫下一個重點" />
                {newText.trim() && <button className="btn btn-sm btn-primary" type="submit">加入</button>}
              </form>

              {relatedPapers.length > 0 && (
                <div className="rd-papers">
                  <h3>與本篇相關的文獻</h3>
                  {relatedPapers.map(c => (
                    <button key={c.id} className="rd-paper" onClick={() => openReader(c.id)}>
                      <b>{label(c)}</b>
                      <span className="rd-pt">{c.title}</span>
                      {(c.reading?.keyPoints ?? []).slice(0, 2).map(k => <span key={k.id} className="rd-pp">・{k.text}</span>)}
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {tab === 'full' && (
            <section className="rd-full" ref={fullRef}>
              {ftLoading && <p className="muted">取得全文中…</p>}
              {!ftLoading && ft && ft.paragraphs.map((p, i) => {
                const zh = CJK.test(p.text);
                if (p.heading) return <h3 key={i} data-i={i} className={'rd-h ' + (zh ? 'rd-zh' : 'rd-en')}>{p.text}</h3>;
                const ms = marks.get(i);
                let body: React.ReactNode = p.text;
                if (ms) {
                  const parts: React.ReactNode[] = []; let at = 0;
                  ms.forEach(m => {
                    if (m.s > at) parts.push(p.text.slice(at, m.s));
                    parts.push(<mark key={m.id} data-kp={m.id} onClick={() => jumpToPoint(m.id)}>{p.text.slice(m.s, m.e)}</mark>);
                    at = m.e;
                  });
                  if (at < p.text.length) parts.push(p.text.slice(at));
                  body = parts;
                }
                return <p key={i} data-i={i} className={zh ? 'rd-zh' : 'rd-en'}>{body}</p>;
              })}
              {!ftLoading && !hasRealText && (
                <div className="rd-empty">
                  <p className="rd-empty-t">{ft ? '目前只有摘要' : '還沒有全文'}</p>
                  <p className="muted">{ftReason ? ftReason + '。' : ''}上傳 PDF 或貼上全文，就能在這裡精讀並標記重點。</p>
                  <div className="row" style={{ justifyContent: 'center' }}>
                    <button className="btn btn-primary" onClick={() => fileRef.current?.click()}>上傳 PDF</button>
                    <button className="btn" onClick={() => setPaste('')}>貼上全文</button>
                  </div>
                </div>
              )}
            </section>
          )}
        </div>
      </div>

      {sel && tab === 'full' && (
        <button className="rd-float" style={{ left: sel.x, top: sel.y }} onMouseDown={e => e.preventDefault()} onClick={addFromSelection}>加為重點</button>
      )}
      {toast && <div className="rd-toast">{toast}</div>}

      {paste !== null && (
        <div className="rd-sheetbg" onClick={() => setPaste(null)}>
          <div className="rd-sheet" onClick={e => e.stopPropagation()}>
            <h3>貼上全文</h3>
            <textarea className="textarea" autoFocus value={paste} onChange={e => setPaste(e.target.value)} placeholder="把論文內文貼在這裡，段落之間空一行" />
            <div className="row" style={{ justifyContent: 'flex-end' }}>
              <button className="btn" onClick={() => setPaste(null)}>取消</button>
              <button className="btn btn-primary" disabled={!paste.trim()} onClick={onPaste}>儲存</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
