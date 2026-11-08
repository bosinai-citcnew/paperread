import { db, uid, getSettings } from '../db';
import { chatJSON } from './llm';
import type { Card, FullText, KeyPoint, KeyPointKind, ReadingNotes, Relation } from '../types';

type Para = FullText['paragraphs'][number];

export const KIND_LABEL: Record<KeyPointKind, string> = {
  question: '研究問題', method: '方法', sample: '樣本', finding: '發現',
  limitation: '限制', contribution: '貢獻', quote: '摘錄', note: '筆記',
};
export const KIND_ORDER: KeyPointKind[] = ['question', 'method', 'sample', 'finding', 'contribution', 'limitation', 'quote', 'note'];

// ───────────────────────── PDF parsing ─────────────────────────

export interface RawItem { str: string; x: number; y: number; w: number; size: number; eol?: boolean }
export interface Line { text: string; y: number; x: number; size: number; page: number }

const CJK_RE = /[㐀-鿿豈-﫿]/;

/** Join text items (in stream order) into visual lines. */
export function groupLines(items: RawItem[], page: number): Line[] {
  const lines: Line[] = [];
  let cur: { parts: string[]; y: number; x: number; size: number; end: number } | null = null;
  const flush = () => {
    if (cur) {
      const text = cur.parts.join('').replace(/\s+/g, ' ').trim();
      if (text) lines.push({ text, y: cur.y, x: cur.x, size: cur.size, page });
    }
    cur = null;
  };
  for (const it of items) {
    if (!it.str.trim() && !cur) continue;
    const size = it.size || 10;
    if (cur && Math.abs(it.y - cur.y) > 0.5 * Math.max(size, cur.size)) flush();
    if (!cur) {
      cur = { parts: [it.str], y: it.y, x: it.x, size, end: it.x + it.w };
    } else {
      const gap = it.x - cur.end;
      const prev = cur.parts[cur.parts.length - 1];
      const bothCjk = CJK_RE.test(prev.slice(-1)) && CJK_RE.test(it.str.slice(0, 1));
      if (gap > size * 0.15 && !bothCjk && !/\s$/.test(prev) && !/^\s/.test(it.str)) cur.parts.push(' ');
      cur.parts.push(it.str);
      cur.size = Math.max(cur.size, size);
      cur.end = it.x + it.w;
    }
    if (it.eol) flush();
  }
  flush();
  return lines;
}

const median = (a: number[]) => {
  if (!a.length) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.floor(s.length / 2)];
};

const NUM_HEAD = /^(\d{1,2}(\.\d{1,2}){0,3}\.?|[IVX]{1,5}\.|第[一二三四五六七八九十]+[章節])\s*\S/;
const KNOWN_HEAD = /^(abstract|introduction|background|related work|literature review|method(s|ology)?|materials and methods|results?|discussion|conclusions?|limitations?|acknowledg?ements?|references|bibliography|摘要|緒論|前言|文獻探討|研究方法|研究結果|結果|討論|結論|參考文獻)$/i;
const REF_HEAD = /^(\d+\.?\s*)?(references|bibliography|參考文獻|參考資料|引用文獻)$/i;
const TERMINAL = /[.!?。！？:;：；」”"')\]）]$/;

/** Build paragraphs (headings flagged) from per-page lines. Drops repeated headers/footers and splits off references. */
export function buildParagraphs(pages: Line[][]): { paragraphs: Para[]; references: string[] } {
  const n = pages.length;
  const norm = (t: string) => t.toLowerCase().replace(/\d+/g, '#').replace(/\s+/g, ' ').trim();
  // repeated header/footer detection
  const counts = new Map<string, number>();
  for (const pg of pages) {
    const edge = [...pg.slice(0, 2), ...pg.slice(-2)];
    for (const k of new Set(edge.map(l => norm(l.text)))) counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  const repeated = (t: string) => n >= 3 && (counts.get(norm(t)) ?? 0) >= Math.max(3, Math.ceil(n * 0.4));
  const pageNum = (t: string) => /^(page\s*)?\d{1,4}(\s*(of|\/)\s*\d{1,4})?$/i.test(t.trim()) || /^[-–—]\s*\d+\s*[-–—]$/.test(t.trim());

  const bodySize = median(pages.flat().map(l => l.size));
  const kept: Line[] = [];
  pages.forEach(pg => pg.forEach((l, i) => {
    const edge = i < 2 || i >= pg.length - 2;
    if (edge && ((repeated(l.text) && l.size <= bodySize * 1.1) || pageNum(l.text))) return;
    kept.push(l);
  }));
  if (!kept.length) return { paragraphs: [], references: [] };

  const body = median(kept.map(l => l.size));
  const gaps: number[] = [];
  for (let i = 1; i < kept.length; i++) {
    const g = kept[i - 1].y - kept[i].y;
    if (kept[i - 1].page === kept[i].page && g > 0 && g < body * 3) gaps.push(g);
  }
  // line spacing = a low quantile (headings / paragraph gaps are the larger outliers)
  const lineGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length * 0.3)] : body * 1.2;

  const isHeading = (l: Line) => {
    const t = l.text;
    if (t.length > 100 || t.length < 2) return false;
    if (KNOWN_HEAD.test(t.replace(/^\d+(\.\d+)*\.?\s*/, ''))) return true;
    if (l.size >= body * 1.15 && !/[。.]$/.test(t)) return true;
    if (NUM_HEAD.test(t) && t.length < 80 && !/[.。,，;；]$/.test(t.replace(/^\S+\s/, '')) && /^\S+\s+[A-Z一-鿿]/.test(t)) return true;
    return false;
  };

  const out: Para[] = [];
  const refs: string[] = [];
  let inRefs = false;
  let buf: { text: string; page: number } | null = null;
  const flush = () => {
    if (buf && buf.text.trim()) { if (inRefs) refs.push(buf.text.trim()); else out.push({ text: buf.text.trim(), page: buf.page }); }
    buf = null;
  };
  const join = (a: string, b: string) => {
    if (/[A-Za-z]-$/.test(a) && /^[a-z]/.test(b)) return a.slice(0, -1) + b;
    if (CJK_RE.test(a.slice(-1)) || CJK_RE.test(b[0])) return a + b;
    return a + ' ' + b;
  };

  kept.forEach((l, i) => {
    const prev = i > 0 ? kept[i - 1] : null;
    if (isHeading(l) && (!prev || true)) {
      flush();
      if (REF_HEAD.test(l.text.trim()) && out.length > 0) { inRefs = true; return; }
      if (inRefs) { // another heading after references (e.g. Appendix) ends them
        if (/^(appendix|appendices|附錄)/i.test(l.text.trim())) inRefs = false; else return;
      }
      out.push({ text: l.text, page: l.page, heading: true });
      return;
    }
    if (inRefs) {
      const newRef = !buf || prev!.y - l.y > lineGap * 1.3 || /^\[?\d+\]|^[A-Z][a-z]+,\s[A-Z]\./.test(l.text);
      if (newRef) flush();
      buf = buf ? { ...buf, text: join(buf.text, l.text) } : { text: l.text, page: l.page };
      return;
    }
    let breakHere = !buf;
    if (buf && prev) {
      const g = prev.y - l.y;
      if (prev.page === l.page) {
        if (g > lineGap * 1.45 || g < 0) breakHere = true;
        else if (TERMINAL.test(prev.text) && l.x - prev.x > body * 0.8 && g > 0) breakHere = true; // indented new paragraph
      } else if (TERMINAL.test(prev.text)) breakHere = true;
    }
    if (breakHere) { flush(); buf = { text: l.text, page: l.page }; }
    else buf = { ...buf!, text: join(buf!.text, l.text) };
  });
  flush();
  return { paragraphs: out, references: refs };
}

let pdfjsPromise: Promise<typeof import('pdfjs-dist')> | null = null;
async function pdfjs() {
  if (!pdfjsPromise) {
    pdfjsPromise = (async () => {
      const lib = await import('pdfjs-dist');
      const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
      lib.GlobalWorkerOptions.workerSrc = worker;
      return lib;
    })();
  }
  return pdfjsPromise;
}

export interface ParsedPdf { paragraphs: Para[]; references: string[]; pages: number }

export async function parsePdf(input: File | Blob | ArrayBuffer): Promise<ParsedPdf> {
  const buf = input instanceof ArrayBuffer ? input : await input.arrayBuffer();
  const lib = await pdfjs();
  const task = lib.getDocument({ data: new Uint8Array(buf) });
  const doc = await task.promise;
  const numPages = doc.numPages;
  const pages: Line[][] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const tc = await page.getTextContent();
    const items: RawItem[] = [];
    for (const it of tc.items as any[]) {
      if (typeof it.str !== 'string') continue;
      items.push({ str: it.str, x: it.transform[4], y: it.transform[5], w: it.width ?? 0, size: Math.abs(it.transform[3]) || it.height || 10, eol: !!it.hasEOL });
    }
    pages.push(groupLines(items, p));
  }
  await task.destroy();
  const { paragraphs, references } = buildParagraphs(pages);
  return { paragraphs, references, pages: numPages };
}

// ───────────────────────── Full text store ─────────────────────────

export interface FullTextResult { fulltext: FullText | null; reason?: string }

function arxivPdfUrl(card: Card): string | undefined {
  const p = card.paper;
  const hay = [p?.arxivId, p?.doi, p?.url, p?.pdfUrl].filter(Boolean).join(' ');
  if (!/arxiv/i.test(hay) && !p?.arxivId) return undefined;
  const id = p?.arxivId
    ?? /arxiv\.org\/(?:abs|pdf)\/([^\s?#]+?)(?:\.pdf)?(?:[?#\s]|$)/i.exec(hay)?.[1]
    ?? /arxiv[.:/]\s*(\d{4}\.\d{4,5}(?:v\d+)?)/i.exec(hay)?.[1];
  return id ? `https://arxiv.org/pdf/${id}` : undefined;
}

async function fetchPdf(url: string): Promise<FullText> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  if (new TextDecoder().decode(buf.slice(0, 5)) !== '%PDF-') throw new Error('不是 PDF 檔');
  const { paragraphs } = await parsePdf(buf);
  if (!paragraphs.length) throw new Error('PDF 沒有可擷取的文字（可能是掃描檔）');
  return { cardId: '', source: 'oa-pdf', paragraphs, fetchedAt: Date.now() };
}

export async function getFullText(card: Card, opts: { skipCache?: boolean } = {}): Promise<FullTextResult> {
  if (!opts.skipCache) {
    const cached = await db.fulltexts.get(card.id);
    if (cached) return { fulltext: cached };
  }
  const reasons: string[] = [];
  const urls = [card.paper?.pdfUrl, arxivPdfUrl(card)].filter((u, i, a): u is string => !!u && a.indexOf(u) === i);
  for (const u of urls) {
    try {
      const ft = { ...(await fetchPdf(u)), cardId: card.id };
      await db.fulltexts.put(ft);
      return { fulltext: ft };
    } catch (e) {
      const m = e instanceof Error ? e.message : String(e);
      reasons.push(/Failed to fetch|NetworkError|Load failed/i.test(m) ? '來源網站不允許直接下載（CORS）' : m);
    }
  }
  const abs = (card.paper?.abstract || '').trim();
  const reason = reasons.length ? reasons[0] : urls.length ? undefined : '這篇沒有開放全文連結';
  if (abs) {
    return { fulltext: { cardId: card.id, source: 'abstract', paragraphs: [{ text: abs }], fetchedAt: Date.now() }, reason };
  }
  return { fulltext: null, reason: reason ?? '沒有可用的全文或摘要' };
}

export async function savePdfFile(cardId: string, file: File | Blob): Promise<FullText> {
  const { paragraphs } = await parsePdf(file);
  if (!paragraphs.length) throw new Error('PDF 沒有可擷取的文字（可能是掃描檔）');
  const ft: FullText = { cardId, source: 'pdf-upload', paragraphs, fetchedAt: Date.now() };
  await db.fulltexts.put(ft);
  return ft;
}

export async function savePastedText(cardId: string, text: string): Promise<FullText> {
  const paragraphs: Para[] = text.replace(/\r/g, '').split(/\n\s*\n+/).map(s => s.replace(/\s*\n\s*/g, ' ').trim()).filter(Boolean)
    .map(t => (t.length < 80 && (NUM_HEAD.test(t) || KNOWN_HEAD.test(t)) && !/[.。]$/.test(t) ? { text: t, heading: true } : { text: t }));
  if (!paragraphs.length) throw new Error('內容是空的');
  const ft: FullText = { cardId, source: 'paste', paragraphs, fetchedAt: Date.now() };
  await db.fulltexts.put(ft);
  return ft;
}

// ───────────────────────── Reading notes ─────────────────────────

export function newPointId(existing: KeyPoint[] = []): string {
  const used = new Set(existing.map(k => k.id));
  for (;;) {
    const id = 'kp' + Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    if (!used.has(id)) return id;
  }
}

export async function saveReading(cardId: string, patch: Partial<ReadingNotes>) {
  const card = await db.cards.get(cardId);
  if (!card) return;
  const cur: ReadingNotes = card.reading ?? { status: 'unread', keyPoints: [], updatedAt: Date.now() };
  await db.cards.update(cardId, { reading: { ...cur, ...patch, updatedAt: Date.now() }, updatedAt: Date.now() });
}

const squeeze = (s: string) => s.replace(/\s+/g, '').toLowerCase();
export function quoteInText(quote: string, paragraphs: Para[]): boolean {
  const q = squeeze(quote);
  if (q.length < 8) return false;
  return paragraphs.some(p => squeeze(p.text).includes(q));
}

const KINDS = ['question', 'method', 'sample', 'finding', 'limitation', 'contribution'] as const;
const KIND_LIST: readonly KeyPointKind[] = KINDS;

// ───────────────────────── Heuristic (no-AI) extraction ─────────────────────────

const PROT = '∯';
const ABBR = /\b(e\.g|i\.e|et al|Figs?|Eqs?|vs|cf|Dr|Prof|Mr|Mrs|Ms|approx|Refs?|Sec|Vol|pp|Inc|Ltd|U\.S|U\.K)\./gi;

/** Split text into sentences (English + Chinese) without breaking on abbreviations, initials or decimals. */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim()
    .replace(ABBR, m => m.replace(/\./g, PROT))
    .replace(/\bNo\.(?=\s*\d)/g, 'No' + PROT)
    .replace(/\b([A-Z])\.(?=\s[A-Z])/g, '$1' + PROT);
  const out: string[] = [];
  for (const chunk of t.replace(/([。！？；])/g, '$1\u0001').split('\u0001')) {
    const rx = /[.!?]["'”’)\]]*\s+(?=["'“‘(\[]?[A-Z0-9])/g;
    let at = 0; let m: RegExpExecArray | null;
    while ((m = rx.exec(chunk))) { out.push(chunk.slice(at, m.index + m[0].length)); at = m.index + m[0].length; }
    out.push(chunk.slice(at));
  }
  return out.map(x => x.replace(new RegExp(PROT, 'g'), '.').trim()).filter(Boolean);
}

type Prior = { kind?: KeyPointKind; intro?: boolean; skip?: boolean };

const CUES: Record<(typeof KINDS)[number], RegExp[]> = {
  question: [
    /\b(this|the present|the current) (study|paper|article|research|work|review)\b.{0,40}\b(aims?|seeks?|investigat\w+|examin\w+|explor\w+|addresses|focus\w*|asks?|tests?)\b/i,
    /\bwe (investigat\w+|examin\w+|explor\w+|seek|aim|ask|address|test|ask)\b/i,
    /\bresearch questions?\b|\bhypothes[ie]s\b|\b(aim|purpose|objective|goal)s? (of|is|was)\b|\bin this (study|paper)\b/i,
    /本研究(旨在|目的|探討|欲|試圖)|研究目的|研究問題|旨在|探討|試圖|欲探究|研究假設/,
  ],
  method: [
    /\bwe (conducted|collected|used|employed|adopted|performed|administered|developed|analy[sz]ed|surveyed|interviewed)\b/i,
    /\b(regression|interviews?|surveys?|questionnaires?|experiments?|randomi[sz]ed|semi-structured|thematic analysis|mixed[- ]methods?|qualitative|quantitative|case stud(y|ies)|structural equation|anova|meta-analysis|systematic review|methodology|data (were|was) (collected|gathered|analy[sz]ed)|(was|were) (measured|assessed|coded))\b/i,
    /採用|方法|問卷|訪談|實驗|迴歸|質性|量化|分析法|資料蒐集|研究設計|施測/,
  ],
  sample: [
    /\b(participants|respondents|volunteers|informants)\b/i,
    /\bsample (of|size|consist\w*|comprised|included)\b|\bN\s*=\s*\d|\bn\s*=\s*\d|\b(recruited|enrolled)\b|\bstudents (from|at|in)\b/i,
    /\b\d[\d,]*\s+(\w+\s+)?(students|participants|adults|patients|teachers|employees|respondents|children|women|men|individuals|workers|users|schools|firms|countries)\b/i,
    /樣本|受試者|參與者|受訪者|研究對象|共\s*\d+\s*(名|位|人)|有效問卷/,
  ],
  finding: [
    /\bresults? (show|showed|indicate\w*|reveal\w*|suggest\w*|demonstrate\w*)\b|\b(findings?|analyses|analysis) (show|showed|indicate\w*|reveal\w*|suggest\w*)\b/i,
    /\bwe (found|find|observed|observe|show|demonstrate|report)\b|\b(was|were|is|are) (found|shown) to\b/i,
    /\bsignificant(ly)?\b|\boutperform\w*|\bp\s*[<=]\s*\.?\d|\b(increased|decreased|reduced|improved)\b|\bassociated with\b|\bpositive(ly)? (related|associated|affect\w*)\b/i,
    /結果顯示|發現|顯著|研究結果|結果指出|分析結果|結果發現|相關|影響/,
  ],
  limitation: [
    /\blimitations?\b|\bfuture (research|work|studies|study)\b|\bcaution\b|\bcannot (be )?generali[sz]\w*|\bcaveats?\b|\bsmall sample\b|\bself-report\w*|\bwere not able\b/i,
    /限制|未來研究|後續研究|無法推論|不足|有待/,
  ],
  contribution: [
    /\bcontribut\w+|\bimplications?\b|\bwe propose\b|\bnovel\b|\bextends?\b|\badvances?\b|\btheoretical\b|\bpractical\b|\bfirst (study|to)\b|\bprovides? (new |important )?(insights?|evidence)\b|\boffers?\b/i,
    /貢獻|意涵|啟示|建議|創新|首次|提供/,
  ],
};

const LABELS: [RegExp, Prior][] = [
  [/^(objectives?|aims?|purpose|research questions?|目的|研究目的|研究問題)$/i, { kind: 'question' }],
  [/^(background|introduction|context|背景|緒論|前言)$/i, { intro: true }],
  [/^(methods?|methodology|methods and materials|materials and methods|design|setting|approach|研究方法|方法|研究設計)$/i, { kind: 'method' }],
  [/^(participants|subjects|sample|samples|研究對象)$/i, { kind: 'sample' }],
  [/^(results?|findings|outcomes?|main outcomes?|結果|研究結果|研究發現)$/i, { kind: 'finding' }],
  [/^(conclusions?|discussion|implications?|significance|結論|研究結論|討論)$/i, { kind: 'contribution' }],
  [/^(limitations?|研究限制|限制)$/i, { kind: 'limitation' }],
];
const priorOf = (name: string): Prior | undefined => {
  const n = name.trim().replace(/\s+/g, ' ');
  for (const [rx, p] of LABELS) if (rx.test(n)) return p;
  return undefined;
};
const HEAD_SKIP = /^(\d+\.?\s*)?(references|bibliography|acknowledg\w+|appendix|appendices|參考文獻|致謝|附錄)\b/i;
const headPrior = (h: string): Prior | undefined => {
  const t = h.trim().replace(/^(\d+(\.\d+)*\.?|[IVX]+\.|第[一二三四五六七八九十]+[章節])\s*/, '');
  if (HEAD_SKIP.test(h.trim()) || HEAD_SKIP.test(t)) return { skip: true };
  if (/^(abstract|摘要)/i.test(t)) return {};
  if (/limitation|限制/i.test(t)) return { kind: 'limitation' };
  if (/participants|sample|subjects|研究對象|樣本/i.test(t)) return { kind: 'sample' };
  if (/method|procedure|materials|design|研究方法|研究設計/i.test(t)) return { kind: 'method' };
  if (/result|finding|analysis|研究結果|結果|發現/i.test(t)) return { kind: 'finding' };
  if (/discussion|conclusion|implication|討論|結論|意涵/i.test(t)) return { kind: 'contribution' };
  if (/introduction|background|literature|緒論|前言|文獻/i.test(t)) return { intro: true };
  return undefined;
};

const LABEL_WORDS = 'Background|Objectives?|Aims?|Purpose|Research Questions?|Introduction|Context|Methods?|Methodology|Methods and Materials|Materials and Methods|Design|Setting|Approach|Participants|Subjects|Samples?|Results?|Findings|Outcomes?|Main Outcomes?|Conclusions?|Discussion|Implications?|Significance|Limitations?';
const LABEL_RE = new RegExp(`(^|[.!?]["')]?\\s+)((?:${LABEL_WORDS}|${LABEL_WORDS.toUpperCase()})(?:\\s*(?:and|&|/)\\s*(?:${LABEL_WORDS}))?|背景|目的|研究目的|研究問題|研究方法|方法|研究設計|研究對象|研究結果|研究發現|結果|研究結論|結論|討論|研究限制)\\s*[:：]\\s*`, 'g');

interface Seg { text: string; prior?: Prior; labelled: boolean }
/** Split a paragraph into structured-abstract segments ("Background: … Methods: …"). */
function labelSegments(text: string): Seg[] {
  const segs: Seg[] = [];
  let at = 0; let cur: Prior | undefined; let curLabelled = false;
  let m: RegExpExecArray | null;
  LABEL_RE.lastIndex = 0;
  while ((m = LABEL_RE.exec(text))) {
    const pr = priorOf(m[2].replace(/\s*(and|&|\/)\s*.*/i, ''));
    if (!pr) continue;
    const pre = text.slice(at, m.index + m[1].length);
    if (pre.trim()) segs.push({ text: pre, prior: cur, labelled: curLabelled });
    at = m.index + m[0].length; cur = pr; curLabelled = true;
  }
  const rest = text.slice(at);
  if (rest.trim()) segs.push({ text: rest, prior: cur, labelled: curLabelled });
  return segs;
}

interface Sent { text: string; page?: number; idx: number; kind?: KeyPointKind; score: number; intro: boolean; inAbstract: boolean }

const cjkCount = (s: string) => (s.match(/[㐀-鿿]/g) ?? []).length;
const goodSentence = (s: string) => {
  const zh = cjkCount(s) > s.length * 0.3;
  if (zh ? s.length < 12 || s.length > 220 : s.length < 40 || s.length > 450) return false;
  if (/^(keywords?|key words|關鍵詞|關鍵字|copyright|©|table|figure|fig\.)\b/i.test(s) || /^[©]/.test(s)) return false;
  if (/[:：]$/.test(s)) return false;
  return true;
};
const informative = (s: string) => goodSentence(s) && !/^(received|accepted|published|doi|https?:)/i.test(s) && !/\b(all rights reserved|licen[sc]e)\b/i.test(s);

/** Pure, offline extraction: verbatim sentences classified by cue phrases + section context. */
export function heuristicExtract(ft: Pick<FullText, 'source' | 'paragraphs'>): { summary: string; keyPoints: KeyPoint[] } {
  const sents: Sent[] = [];
  const intro: string[] = [];
  const abstractSents: string[] = [];
  const labelled: { text: string; kind?: KeyPointKind; intro: boolean }[] = [];
  let headPr: Prior | undefined;
  let headName = '';
  let paraNo = 0;
  ft.paragraphs.forEach(p => {
    if (p.heading) { headPr = headPrior(p.text); headName = p.text; return; }
    if (headPr?.skip) return;
    paraNo++;
    const isAbs = ft.source === 'abstract' || /^(abstract|摘要)/i.test(headName.trim().replace(/^\d+\.?\s*/, '')) || (!headName && paraNo <= 2);
    for (const seg of labelSegments(p.text)) {
      for (const text of splitSentences(seg.text)) {
        if (isAbs && informative(text) && abstractSents.length < 12) abstractSents.push(text);
        if (isAbs && seg.labelled && informative(text)) labelled.push({ text, kind: seg.prior?.kind, intro: !!seg.prior?.intro });
        if (headPr?.intro && informative(text) && intro.length < 3) intro.push(text);
        if (!goodSentence(text)) continue;
        const prior = seg.labelled ? seg.prior : headPr;
        const bonus = seg.labelled ? 2 : 1.5;
        let best: KeyPointKind | undefined; let bestScore = 0; let bestCue = -1;
        for (const k of KINDS) {
          let cue = 0;
          for (const rx of CUES[k]) if (rx.test(text)) cue += 2;
          const sc = cue + (prior?.kind === k && (cue > 0 || seg.labelled) ? bonus : 0); // a heading alone is not evidence
          if (sc > bestScore || (sc === bestScore && sc > 0 && cue > bestCue)) { best = k; bestScore = sc; bestCue = cue; }
        }
        if (!best || bestScore < 2) continue;
        let score = bestScore;
        if (text.length >= 60 && text.length <= 320) score += 0.5;
        if (isAbs) score += 0.5;
        sents.push({ text, page: p.page, idx: sents.length, kind: best, score, intro: !!prior?.intro, inAbstract: isAbs });
      }
    }
  });

  sents.sort((a, b) => b.score - a.score || a.idx - b.idx);
  const per = new Map<KeyPointKind, number>();
  const picked: Sent[] = [];
  const seen = new Set<string>();
  for (const cap of [2, 3]) {
    for (const s of sents) {
      if (picked.length >= 10) break;
      if (seen.has(s.text) || (per.get(s.kind!) ?? 0) >= cap) continue;
      if (cap === 3 && picked.length >= 6) break;
      seen.add(s.text); picked.push(s); per.set(s.kind!, (per.get(s.kind!) ?? 0) + 1);
    }
    if (picked.length >= 6) break;
  }
  picked.sort((a, b) => KIND_LIST.indexOf(a.kind!) - KIND_LIST.indexOf(b.kind!) || a.idx - b.idx);
  const kps: KeyPoint[] = [];
  for (const s of picked) {
    kps.push({ id: newPointId(kps), kind: s.kind!, text: s.text, quote: s.text, page: s.page, ai: false, createdAt: Date.now() });
  }
  let summary: string;
  if (labelled.length >= 3) {
    // structured abstract: background → result → conclusion, each verbatim
    const first = (f: (x: (typeof labelled)[number]) => boolean) => labelled.find(f)?.text;
    summary = [first(x => x.intro), first(x => x.kind === 'finding'), first(x => x.kind === 'contribution')]
      .filter((x, i, a): x is string => !!x && a.indexOf(x) === i).join(' ');
    if (!summary) summary = abstractSents.slice(0, 3).join(' ');
  } else summary = (abstractSents.length ? abstractSents : intro).slice(0, 3).join(' ');
  return { summary, keyPoints: kps };
}

export async function extractKeyPoints(card: Card, ft: FullText, lang: 'zh-TW' | 'en' = 'zh-TW'): Promise<{ summary: string; keyPoints: KeyPoint[] }> {
  const key = (await getSettings()).llmApiKey;
  if (!key || !key.trim()) return heuristicExtract(ft);
  try {
    return await extractWithAI(card, ft, lang);
  } catch {
    return heuristicExtract(ft); // AI failed (network, quota…): fall back to the free path
  }
}

async function extractWithAI(card: Card, ft: FullText, lang: 'zh-TW' | 'en'): Promise<{ summary: string; keyPoints: KeyPoint[] }> {
  const full = ft.paragraphs.map(p => (p.heading ? `\n## ${p.text}\n` : p.text)).join('\n');
  const text = full.length > 30000 ? full.slice(0, 22000) + '\n…\n' + full.slice(-8000) : full;
  const zh = lang === 'zh-TW';
  const sys = zh
    ? '你是嚴謹的學術閱讀助理。閱讀論文後，回傳 JSON：{"summary": string, "points": [{"kind": "question|method|sample|finding|limitation|contribution", "text": string, "quote": string}]}。summary 為繁體中文一段摘要（約 120 至 200 字）。points 共 6 至 12 個，涵蓋研究問題、方法、樣本、發現、限制、貢獻；每點 text 是一句精簡的繁體中文。quote 必須是原文中「逐字照抄」的一句支持句（不可改寫、不可翻譯、不可省略），若找不到逐字句子就不要列出該點。只能使用提供的內容，不可編造。'
    : 'You are a rigorous academic reading assistant. Return JSON: {"summary": string, "points": [{"kind": "question|method|sample|finding|limitation|contribution", "text": string, "quote": string}]}. summary is one paragraph (80-150 words). 6 to 12 points covering question, method, sample, finding, limitation, contribution; each text is one concise sentence. quote must be ONE sentence copied VERBATIM from the text (no paraphrase); omit points without a verbatim quote. Use only the provided content.';
  const r = await chatJSON<{ summary?: string; points?: { kind?: string; text?: string; quote?: string }[] }>([
    { role: 'system', content: sys },
    { role: 'user', content: `${zh ? '標題' : 'Title'}: ${card.title}\n\n${text}` },
  ]);
  const abstractOnly = ft.source === 'abstract';
  const kps: KeyPoint[] = [];
  for (const p of r.points ?? []) {
    const t = String(p.text ?? '').trim();
    if (!t) continue;
    const quote = String(p.quote ?? '').trim();
    const found = quote ? quoteInText(quote, ft.paragraphs) : false;
    if (!found && !abstractOnly) continue;
    const kind = KIND_LIST.includes(p.kind as KeyPointKind) ? (p.kind as KeyPointKind) : 'finding';
    kps.push({ id: newPointId(kps), kind, text: t, quote: found ? quote : undefined, ai: true, createdAt: Date.now(),
      page: found ? ft.paragraphs.find(x => squeeze(x.text).includes(squeeze(quote)))?.page : undefined });
    if (kps.length >= 12) break;
  }
  return { summary: String(r.summary ?? '').trim(), keyPoints: kps };
}

// ───────────────────────── Cross-paper linking ─────────────────────────

const STOP = new Set('the and for are was were with that this from have has had not but can may also than then their which these those into such over under between using used use study paper results result based been being its our they them more most other some both each'.split(' '));
export function tokens(s: string): Set<string> {
  const out = new Set<string>();
  for (const w of s.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) if (!STOP.has(w)) out.add(w.replace(/(ing|ed|es|s)$/, ''));
  for (const run of s.match(/[㐀-鿿]+/g) ?? []) for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  return out;
}
export function overlap(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const x of a) if (b.has(x)) n++;
  return n / Math.sqrt(a.size * b.size);
}

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, '');
/** Human-readable terms two texts share (English words + merged CJK bigram runs). */
export function sharedTerms(a: string, b: string, max = 4): string[] {
  const tb = tokens(b);
  const out: string[] = [];
  for (const w of a.toLowerCase().match(/[a-z][a-z-]{3,}/g) ?? []) {
    if (!STOP.has(w) && tb.has(stem(w)) && !out.includes(w)) out.push(w);
  }
  for (const run of a.match(/[㐀-鿿]+/g) ?? []) {
    let cur = '';
    for (let i = 0; i < run.length - 1; i++) {
      if (tb.has(run.slice(i, i + 2))) cur = cur && cur.endsWith(run[i]) ? cur + run[i + 1] : run.slice(i, i + 2);
      else { if (cur && !out.includes(cur)) out.push(cur); cur = ''; }
    }
    if (cur && !out.includes(cur)) out.push(cur);
  }
  return out.slice(0, max);
}

type Stance = 'supports' | 'contradicts' | 'extends' | 'similar';
interface Cand { mine: string; theirCard: string; theirs: string; stance: Stance; note: string; weight: number }

export async function linkPointsAcrossPapers(cardId: string): Promise<{ linked: number; usedLLM: boolean; related: number }> {
  const card = await db.cards.get(cardId);
  const mine = card?.reading?.keyPoints ?? [];
  if (!card || !mine.length) return { linked: 0, usedLLM: false, related: 0 };
  const rels = [...await db.relations.where('from').equals(cardId).toArray(), ...await db.relations.where('to').equals(cardId).toArray()];
  const otherIds = [...new Set(rels.map(r => (r.from === cardId ? r.to : r.from)).filter(i => i !== cardId))];
  const others = (await db.cards.bulkGet(otherIds)).filter((c): c is Card => !!c && !!c.reading?.keyPoints.length);
  if (!others.length) return { linked: 0, usedLLM: false, related: 0 };

  let cands: Cand[] = [];
  let usedLLM = false;
  const hasKey = !!((await getSettings()).llmApiKey || '').trim();
  if (hasKey) try {
    const fmt = (c: Card) => (c.reading?.keyPoints ?? []).slice(0, 12).map(k => `${c.id}#${k.id} (${k.kind}) ${k.text}`).join('\n');
    const r = await chatJSON<{ links?: { mine?: string; theirs?: string; stance?: string; note?: string }[] }>([
      { role: 'system', content: '你是學術文獻比對助理。給定「本篇」的重點與數篇相關論文的重點，找出彼此真正對應的重點配對（同一概念、同一現象或同一方法）。stance 為 supports（支持/一致）、contradicts（矛盾/不一致）或 extends（延伸/補充）。只回傳確實有關聯者，最多 15 組。回傳 JSON：{"links":[{"mine":"本篇重點id","theirs":"cardId#kpId","stance":"supports|contradicts|extends","note":"一句繁體中文說明"}]}' },
      { role: 'user', content: `本篇重點：\n${mine.map(k => `${k.id} (${k.kind}) ${k.text}`).join('\n')}\n\n相關論文重點：\n${others.map(fmt).join('\n')}` },
    ]);
    usedLLM = true;
    const mineIds = new Set(mine.map(k => k.id));
    for (const l of r.links ?? []) {
      const [oc, op] = String(l.theirs ?? '').split('#');
      const oCard = others.find(c => c.id === oc);
      if (!l.mine || !mineIds.has(l.mine) || !oCard || !oCard.reading?.keyPoints.some(k => k.id === op)) continue;
      const stance: Stance = l.stance === 'contradicts' || l.stance === 'extends' ? l.stance : 'supports';
      cands.push({ mine: l.mine, theirCard: oc, theirs: op, stance, note: String(l.note ?? '').trim(), weight: 0.7 });
    }
  } catch {
    usedLLM = false;
  }
  if (!usedLLM) {
    // Free path: keyword overlap only says "similar" — never claims support/contradiction.
    cands = [];
    for (const k of mine) {
      const tk = tokens(k.text);
      const scored: Cand[] = [];
      for (const c of others) for (const o of c.reading!.keyPoints) {
        const to = tokens(o.text);
        let shared = 0;
        for (const x of tk) if (to.has(x)) shared++;
        if (shared < 3) continue;
        const s = overlap(tk, to) + (k.kind === o.kind ? 0.06 : 0);
        if (s < 0.22) continue;
        const terms = sharedTerms(k.text, o.text);
        if (!terms.length) continue;
        scored.push({ mine: k.id, theirCard: c.id, theirs: o.id, stance: 'similar', note: `關鍵詞相近：${terms.join('、')}`, weight: Math.min(0.6, s) });
      }
      scored.sort((a, b) => b.weight - a.weight);
      cands.push(...scored.slice(0, 2));
    }
  }

  // replace this card's earlier auto point-links, keep manual ones
  const old = (await db.relations.where('from').equals(cardId).toArray()).filter(r => !r.manual && r.fromPoint && r.toPoint);
  await db.relations.bulkDelete(old.map(r => r.id));
  const seen = new Set<string>();
  const fresh: Relation[] = [];
  const manual = rels.filter(r => r.manual && r.fromPoint && r.toPoint);
  for (const c of cands) {
    const key = `${c.mine}|${c.theirCard}|${c.theirs}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (manual.some(r => (r.from === cardId ? r.fromPoint === c.mine && r.to === c.theirCard && r.toPoint === c.theirs : r.toPoint === c.mine && r.from === c.theirCard && r.fromPoint === c.theirs))) continue;
    fresh.push({
      id: uid(), topicId: card.topicId, from: cardId, to: c.theirCard, fromPoint: c.mine, toPoint: c.theirs,
      type: c.stance === 'supports' || c.stance === 'contradicts' ? c.stance : 'similar', weight: c.weight, manual: false,
      note: (c.stance === 'extends' ? '延伸：' : '') + c.note,
    });
  }
  await db.relations.bulkPut(fresh);
  return { linked: fresh.length, usedLLM, related: others.length };
}
