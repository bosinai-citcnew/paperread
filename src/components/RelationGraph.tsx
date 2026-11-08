import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db';
import type { Card, RelationType } from '../types';
import { openReader } from '../App';
import Icon from './Icons';
import Sheet from './Sheet';
import '../views/research.css';

const ForceGraph2D = lazy(() => import('react-force-graph-2d'));

export const REL_LABEL: Record<RelationType, string> = {
  cites: '引用', 'co-cited': '共被引', coupled: '書目耦合', similar: '相似', supports: '支持', contradicts: '矛盾',
};
const REL_VAR: Record<RelationType, string> = {
  cites: '--muted', 'co-cited': '--k-voice', coupled: '--k-quote', similar: '--k-keep', supports: '--accent', contradicts: '--danger',
};
const ALL_TYPES: RelationType[] = ['cites', 'coupled', 'similar', 'co-cited', 'supports', 'contradicts'];
const DEFAULT_TYPES = new Set<RelationType>(['cites', 'coupled', 'supports', 'contradicts']);
const PALETTE = ['#2f6f5e', '#5b7fa6', '#b07a1c', '#8e4f8e', '#c0634e', '#4f8f8a', '#7a7f3a', '#6b6a63'];
const STOPK = new Set(['the', 'and', 'of', 'in', 'for', 'to', 'with']);

interface GNode { id: string; card: Card; r: number; cluster: number; alpha: number; x?: number; y?: number }
interface GLink { source: string | GNode; target: string | GNode; type: RelationType; weight: number; note?: string }

const cssVar = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';

function mixWhite(hex: string, t: number): string {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map(v => Math.round(v + (255 - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}


interface GraphProps { topicId: string; busy?: boolean; onCompute?: () => void; onJudge?: () => void }

export default function RelationGraph({ topicId, busy, onCompute, onJudge }: GraphProps) {
  const cards = useLiveQuery(() => db.cards.where('topicId').equals(topicId).filter(c => c.kind === 'paper').toArray(), [topicId]);
  const rels = useLiveQuery(() => db.relations.where('topicId').equals(topicId).toArray(), [topicId]);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(340);
  const [enabled, setEnabled] = useState<Set<RelationType>>(new Set(['cites', 'coupled', 'supports', 'contradicts']));
  const [selected, setSelected] = useState<string | null>(null);
  const [dark, setDark] = useState(() => window.matchMedia('(prefers-color-scheme: dark)').matches);
  const [hideIso, setHideIso] = useState(true);
  const [setOpen, setSetOpen] = useState(false);
  const hoverRef = useRef<string | null>(null);
  const fgRef = useRef<any>(null); // eslint-disable-line @typescript-eslint/no-explicit-any
  const fitted = useRef(false);
  const forcesSet = useRef<unknown>(null);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(Math.max(200, Math.floor(el.clientWidth))));
    ro.observe(el);
    setWidth(Math.max(200, Math.floor(el.clientWidth)));
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const f = () => setDark(mq.matches);
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, []);
  useEffect(() => { fitted.current = false; setSelected(null); }, [topicId]);

  const theme = useMemo(() => {
    const rel = {} as Record<RelationType, string>;
    for (const t of ALL_TYPES) rel[t] = cssVar(REL_VAR[t]);
    return {
      rel, text: cssVar('--text'), surface: cssVar('--surface'), muted: cssVar('--muted'), accent: cssVar('--accent'),
      palette: PALETTE.map(c => (dark ? mixWhite(c, 0.3) : c)),
    };
  }, [dark]);

  // clusters from cites/coupled edges (independent of legend toggles)
  const clusterInfo = useMemo(() => {
    // Theme clusters from keyword co-occurrence: pick up to 7 distinctive keywords (not topic-wide,
    // not rare, low overlap with each other), then assign each paper to its most specific chosen keyword.
    const list = cards ?? [];
    const N = list.length || 1;
    const kw = new Map<string, Set<string>>(); // keyword -> card ids
    for (const c of list) for (const k of new Set((c.paper?.concepts ?? []).map(x => x.toLowerCase().trim())))
      if (k.length >= 3 && !STOPK.has(k)) (kw.get(k) ?? kw.set(k, new Set()).get(k)!).add(c.id);
    const cands = [...kw.entries()].filter(([, s]) => s.size >= 3 && s.size <= N * 0.5).sort((a, b) => b[1].size - a[1].size);
    const chosen: [string, Set<string>][] = [];
    for (const [k, s] of cands) {
      if (chosen.length >= PALETTE.length - 1) break;
      const overlaps = chosen.some(([ck, cs]) => {
        let inter = 0; for (const id of s) if (cs.has(id)) inter++;
        return inter / (s.size + cs.size - inter) > 0.4 || ck.includes(k) || k.includes(ck);
      });
      if (!overlaps) chosen.push([k, s]);
    }
    const of = new Map<string, number>();
    const sizes = new Array(PALETTE.length).fill(0);
    for (const c of list) {
      let best = -1;
      chosen.forEach(([, s], i) => { if (s.has(c.id) && (best < 0 || s.size < chosen[best][1].size)) best = i; });
      const idx = best < 0 ? PALETTE.length - 1 : best;
      of.set(c.id, idx); sizes[idx]++;
    }
    const legend = chosen.map(([k], i) => ({ idx: i, size: sizes[i], name: k })).filter(l => l.size > 0).sort((a, b) => b.size - a.size);
    if (sizes[PALETTE.length - 1]) legend.push({ idx: PALETTE.length - 1, size: sizes[PALETTE.length - 1], name: '其他' });
    return { of, legend };
  }, [cards, rels]);

  const data = useMemo(() => {
    const list = cards ?? [];
    const years = list.map(c => c.paper?.year).filter((y): y is number => !!y);
    const lo = Math.min(...years, 3000), hi = Math.max(...years, 0);
    const nodes: GNode[] = list.map(c => {
      const y = c.paper?.year;
      const t = y && hi > lo ? (y - lo) / (hi - lo) : 1;
      return {
        id: c.id, card: c, cluster: clusterInfo.of.get(c.id) ?? 0, alpha: 0.55 + 0.45 * t,
        r: Math.min(16, 4 + 3 * Math.log10((c.paper?.citedByCount ?? 0) + 1)),
      };
    });
    const ids = new Set(nodes.map(n => n.id));
    const links: GLink[] = (rels ?? [])
      .filter(r => enabled.has(r.type) && ids.has(r.from) && ids.has(r.to))
      .map(r => ({ source: r.from, target: r.to, type: r.type, weight: r.weight, note: r.note }));
    let shown = nodes;
    if (hideIso) {
      const linked = new Set<string>();
      for (const l of links) { linked.add(l.source as string); linked.add(l.target as string); }
      shown = nodes.filter(n => linked.has(n.id));
    }
    const adj = new Map<string, Set<string>>();
    for (const l of links) {
      (adj.get(l.source as string) ?? adj.set(l.source as string, new Set()).get(l.source as string)!).add(l.target as string);
      (adj.get(l.target as string) ?? adj.set(l.target as string, new Set()).get(l.target as string)!).add(l.source as string);
    }
    const top = new Set([...shown].sort((a, b) => (b.card.paper?.citedByCount ?? 0) - (a.card.paper?.citedByCount ?? 0)).slice(0, 8).map(n => n.id));
    return { nodes: shown, links, adj, top, lo, hi };
  }, [cards, rels, enabled, hideIso, clusterInfo]);

  const toggle = (t: RelationType) => setEnabled(prev => {
    const n = new Set(prev);
    if (n.has(t)) n.delete(t); else n.add(t);
    return n;
  });
  const counts = useMemo(() => {
    const m = new Map<RelationType, number>();
    for (const r of rels ?? []) m.set(r.type, (m.get(r.type) ?? 0) + 1);
    return m;
  }, [rels]);

  const dataRef = useRef(data);
  dataRef.current = data;
  const fit = useCallback(() => {
    const ns = dataRef.current.nodes as GNode[];
    const pts = ns.filter(n => n.x !== undefined);
    if (!pts.length) { fgRef.current?.zoomToFit(400, 40); return; }
    const mx = pts.reduce((s, n) => s + (n.x ?? 0), 0) / pts.length, my = pts.reduce((s, n) => s + (n.y ?? 0), 0) / pts.length;
    const ds = pts.map(n => Math.hypot((n.x ?? 0) - mx, (n.y ?? 0) - my)).sort((a, b) => a - b);
    const lim = Math.max(60, ds[Math.floor(ds.length * 0.8)] * 1.5);
    fgRef.current?.zoomToFit(400, 40, (n: GNode) => Math.hypot((n.x ?? 0) - mx, (n.y ?? 0) - my) <= lim);
  }, []);
  const focusNode = (id: string) => {
    setSelected(id);
    const n = data.nodes.find(x => x.id === id);
    if (n && n.x !== undefined && fgRef.current) { fgRef.current.centerAt(n.x, n.y, 400); fgRef.current.zoom(3, 400); }
  };

  const sel = selected ? cards?.find(c => c.id === selected) : undefined;
  const selRels = useMemo(() => {
    if (!sel) return [];
    const byId = new Map((cards ?? []).map(c => [c.id, c]));
    return (rels ?? []).filter(r => r.from === sel.id || r.to === sel.id)
      .map(r => ({ r, other: byId.get(r.from === sel.id ? r.to : r.from) }))
      .filter(x => x.other).sort((a, b) => b.r.weight - a.r.weight).slice(0, 12);
  }, [sel, rels, cards]);

  const drawNode = useCallback((n: object, ctx: CanvasRenderingContext2D, scale: number) => {
    const node = n as GNode;
    const x = node.x ?? 0, y = node.y ?? 0;
    const focus = hoverRef.current ?? selected;
    const isFocus = node.id === focus;
    const near = !!focus && (isFocus || data.adj.get(focus)?.has(node.id));
    const alpha = focus && !near ? 0.15 : node.alpha;
    const color = theme.palette[node.cluster] ?? theme.palette[7];
    ctx.save();
    ctx.globalAlpha = alpha;
    if (node.id === selected) {
      ctx.beginPath(); ctx.arc(x, y, node.r + 3.5, 0, 2 * Math.PI);
      ctx.strokeStyle = theme.accent; ctx.lineWidth = 3; ctx.stroke();
    }
    ctx.shadowColor = 'rgba(0,0,0,0.15)'; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.arc(x, y, node.r, 0, 2 * Math.PI);
    ctx.fillStyle = color; ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowColor = 'transparent';
    ctx.lineWidth = 1.5; ctx.strokeStyle = theme.surface; ctx.stroke();
    ctx.restore();

    const showLabel = data.top.has(node.id) || isFocus || (near && scale > 0.8);
    if (!showLabel || (focus && !near && !data.top.has(node.id))) return;
    const t = node.card.title;
    const label = t.length > 28 ? t.slice(0, 28) + '…' : t;
    const fs = 11 / scale;
    ctx.save();
    ctx.globalAlpha = focus && !near ? 0.25 : 1;
    ctx.font = `${fs}px -apple-system, "PingFang TC", sans-serif`;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    const w = ctx.measureText(label).width + 8 / scale, h = fs + 5 / scale;
    const px = x - w / 2, py = y + node.r + 3 / scale;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(px, py, w, h, h / 2); else ctx.rect(px, py, w, h);
    ctx.fillStyle = theme.surface; ctx.globalAlpha *= 0.92; ctx.fill();
    ctx.globalAlpha = focus && !near ? 0.25 : 1;
    ctx.lineWidth = 0.6 / scale; ctx.strokeStyle = theme.muted; ctx.stroke();
    ctx.fillStyle = theme.text; ctx.fillText(label, x, py + h / 2 + 0.5 / scale);
    ctx.restore();
  }, [data, theme, selected]);

  const drawLink = useCallback((l: object, ctx: CanvasRenderingContext2D, scale: number) => {
    const link = l as GLink;
    const s = link.source as GNode, t = link.target as GNode;
    if (typeof s !== 'object' || typeof t !== 'object' || s.x === undefined || t.x === undefined) return;
    const focus = hoverRef.current ?? selected;
    const touches = !!focus && (s.id === focus || t.id === focus);
    const strong = link.type === 'supports' || link.type === 'contradicts';
    const color = touches || strong ? theme.rel[link.type] : theme.muted;
    const alpha = touches ? 0.9 : focus ? 0.05 : strong ? 0.7 : 0.18;
    const sx = s.x, sy = s.y ?? 0, tx = t.x, ty = t.y ?? 0;
    const dx = tx - sx, dy = ty - sy, dist = Math.hypot(dx, dy) || 1;
    const curve = link.type === 'coupled' || link.type === 'similar' ? 0.15 : 0;
    const cx = (sx + tx) / 2 - dy * curve, cy = (sy + ty) / 2 + dx * curve;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = color; ctx.lineWidth = Math.min(1.2, 0.6 + link.weight * 0.6) * (touches ? 1.5 : 1);
    ctx.setLineDash(link.type === 'contradicts' ? [4 / scale + 1, 3 / scale + 1] : link.type === 'similar' ? [2, 2] : []);
    ctx.beginPath(); ctx.moveTo(sx, sy);
    if (curve) ctx.quadraticCurveTo(cx, cy, tx, ty); else ctx.lineTo(tx, ty);
    ctx.stroke();
    if (link.type === 'cites') {
      const ux = dx / dist, uy = dy / dist, ax = tx - ux * (t.r + 1.5), ay = ty - uy * (t.r + 1.5), a = 3.2;
      ctx.setLineDash([]); ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(ax, ay);
      ctx.lineTo(ax - ux * a - uy * a * 0.5, ay - uy * a + ux * a * 0.5);
      ctx.lineTo(ax - ux * a + uy * a * 0.5, ay - uy * a - ux * a * 0.5);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }, [theme, selected]);

  if (!cards) return <div className="muted">載入中…</div>;
  if (!cards.length) return <div className="muted rs-empty">尚無論文，請先到「論文」分頁深入挖掘。</div>;

  const height = Math.max(380, Math.min(720, window.innerHeight - 300));
  const hiddenCount = cards.length - data.nodes.length;
  const selCluster = sel ? clusterInfo.legend.find(l => l.idx === (clusterInfo.of.get(sel.id) ?? 0)) : undefined;
  const activeCount = ALL_TYPES.filter(t => enabled.has(t) !== DEFAULT_TYPES.has(t)).length + (hideIso ? 0 : 1);

  return (
    <div className="rg-wrap">
      <div className="rg-stage">
        <div className="rg-tools">
          <button className="icon-btn rg-tool" aria-label="置中" onClick={fit}><Icon name="fit" size={20} /></button>
          <button className="icon-btn rg-tool" aria-label="圖譜設定" onClick={() => setSetOpen(true)}>
            <Icon name="sliders" size={20} />{activeCount > 0 && <span className="badge">{activeCount}</span>}
          </button>
        </div>
        <div ref={wrapRef} className="rg-canvas" style={{ height }}>
          <Suspense fallback={<div className="loading">載入圖譜…</div>}>
            <ForceGraph2D
              ref={fgRef}
              width={width}
              height={height}
              graphData={data}
              backgroundColor="rgba(0,0,0,0)"
              autoPauseRedraw={false}
              nodeLabel={() => ''}
              nodeCanvasObject={drawNode}
              nodePointerAreaPaint={(n: object, color: string, ctx: CanvasRenderingContext2D) => {
                const node = n as GNode;
                ctx.fillStyle = color; ctx.beginPath(); ctx.arc(node.x ?? 0, node.y ?? 0, node.r + 4, 0, 2 * Math.PI); ctx.fill();
              }}
              linkCanvasObject={drawLink}
              linkCanvasObjectMode={() => 'replace'}
              cooldownTicks={120}
              onEngineTick={() => {
                const fg = fgRef.current;
                if (fg && forcesSet.current !== fg) {
                  forcesSet.current = fg;
                  fg.d3Force('charge')?.strength(-110);
                  fg.d3Force('link')?.distance((l: GLink) => 60 - 30 * Math.min(1, l.weight));
                }
              }}
              onEngineStop={() => { if (!fitted.current) { fitted.current = true; fit(); } }}
              onNodeHover={(n: object | null) => { hoverRef.current = n ? (n as GNode).id : null; }}
              onNodeClick={(n: object) => setSelected((n as GNode).id)}
              onBackgroundClick={() => setSelected(null)}
            />
          </Suspense>
        </div>
        {clusterInfo.legend.length > 0 && (
          <div className="rg-clusters">
            {clusterInfo.legend.map(l => (
              <span key={l.idx} className="rg-cl"><span className="rg-dot" style={{ background: theme.palette[l.idx] }} />{l.name} <span className="muted">{l.size}</span></span>
            ))}
          </div>
        )}
        {sel && (
          <div className="panel rg-detail">
            <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'nowrap' }}>
              <strong>{sel.title}</strong>
              <button className="icon-btn sm" aria-label="關閉" onClick={() => setSelected(null)}><Icon name="close" size={18} /></button>
            </div>
            <div className="muted rs-meta">
              {sel.paper?.authors?.slice(0, 3).join('、')} · {sel.paper?.year ?? '?'}{sel.paper?.venue ? ` · ${sel.paper.venue}` : ''} · 被引 {sel.paper?.citedByCount ?? 0}
            </div>
            {selCluster && (
              <div style={{ margin: '8px 0' }}>
                <span className="rg-cl"><span className="rg-dot" style={{ background: theme.palette[selCluster.idx] }} />{selCluster.name}</span>
              </div>
            )}
            {sel.paper?.abstract && <p className="rg-abs">{sel.paper.abstract.slice(0, 300)}{sel.paper.abstract.length > 300 ? '…' : ''}</p>}
            {selRels.length > 0 && (
              <ul className="rg-rels">
                {selRels.map(({ r, other }) => (
                  <li key={r.id}>
                    <button className="rg-rel-btn" onClick={() => focusNode(other!.id)}>
                      <span className="rg-dot" style={{ background: `var(${REL_VAR[r.type]})` }} />
                      <b>{REL_LABEL[r.type]}</b>
                      {r.type === 'cites' ? (r.from === sel.id ? '（引用）' : '（被引用）') : ` ${r.weight.toFixed(2)}`} → {other!.title}
                    </button>
                    {r.note && <div className="muted">{r.note}</div>}
                  </li>
                ))}
              </ul>
            )}
            <div className="rg-detail-actions">
              <button className="btn btn-primary" onClick={() => openReader(sel.id)}>精讀</button>
              {sel.paper?.url && <a className="btn" href={sel.paper.url} target="_blank" rel="noreferrer">開啟原文</a>}
            </div>
          </div>
        )}
      </div>
      {!(rels ?? []).length && <div className="muted rs-empty small">尚無關聯資料，請到圖譜設定按「計算關聯」。</div>}

      <Sheet open={setOpen} onClose={() => setSetOpen(false)} title="圖譜設定" footer={<button className="btn btn-primary" onClick={() => setSetOpen(false)}>完成</button>}>
        <div className="section-label" style={{ marginTop: 0 }}>顯示的關聯類型</div>
        {ALL_TYPES.map(t => (
          <label key={t} className="rg-set-row">
            <span className="rg-dot" style={{ background: `var(${REL_VAR[t]})` }} />
            <span className="rg-set-label">{REL_LABEL[t]} <span className="muted">{counts.get(t) ?? 0}</span></span>
            <input type="checkbox" checked={enabled.has(t)} onChange={() => toggle(t)} />
          </label>
        ))}
        <div className="section-label">節點</div>
        <label className="rg-set-row">
          <span className="rg-set-label">隱藏孤立節點{hideIso && hiddenCount > 0 ? `（${hiddenCount}）` : ''}</span>
          <input type="checkbox" checked={hideIso} onChange={e => setHideIso(e.target.checked)} />
        </label>
        {(onCompute || onJudge) && (
          <>
            <div className="section-label">分析</div>
            <div className="row">
              {onCompute && <button className="btn" disabled={busy} onClick={() => { setSetOpen(false); onCompute(); }}>計算關聯</button>}
              {onJudge && <button className="btn" disabled={busy} onClick={() => { setSetOpen(false); onJudge(); }}>AI 判讀支持/矛盾</button>}
            </div>
          </>
        )}
      </Sheet>
    </div>
  );
}
