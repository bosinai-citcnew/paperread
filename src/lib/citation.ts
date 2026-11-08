import type { Card, CitationStyle, PaperLanguage, Section } from '../types';

export interface Seg { t: string; i?: boolean }
export type Lang = 'zh-TW' | 'en';

const CJK = /[㐀-鿿豈-﫿]/;
export const isCJK = (s: string) => CJK.test(s);
export const segText = (segs: Seg[]) => segs.map(s => s.t).join('');
export const segMarkdown = (segs: Seg[]) => segs.map(s => (s.i && s.t.trim() ? `*${s.t}*` : s.t)).join('');

export const NEED_EVIDENCE: Record<Lang, string> = { 'zh-TW': '【待補證據】', en: '[EVIDENCE NEEDED]' };
export const bodyLang = (l?: PaperLanguage): Lang => (l === 'en' ? 'en' : 'zh-TW');

const authorsOf = (c: Card) => (c.paper?.authors ?? []).map(a => a.trim()).filter(Boolean);
const yearOf = (c: Card) => (c.paper?.year ? String(c.paper.year) : 'n.d.');
const chineseCard = (c: Card) => { const a = authorsOf(c); return a.length ? isCJK(a[0]) : isCJK(c.title); };

export function surname(a: string): string {
  if (isCJK(a)) return a.replace(/\s+/g, '');
  if (a.includes(',')) return a.split(',')[0].trim();
  const p = a.trim().split(/\s+/);
  return p[p.length - 1];
}
function givenOf(a: string): string {
  if (a.includes(',')) return a.split(',').slice(1).join(' ').trim();
  const p = a.trim().split(/\s+/);
  return p.slice(0, -1).join(' ');
}
function initials(given: string): string {
  return given.split(/[\s.]+/).filter(Boolean).map(w => w.split('-').map(x => x[0].toUpperCase() + '.').join('-')).join(' ');
}
/** "Lee, K. J." */
export function apaName(a: string): string {
  if (isCJK(a)) return a.replace(/\s+/g, '');
  const s = surname(a); const g = givenOf(a);
  return g ? `${s}, ${initials(g)}` : s;
}
/** "K. J. Lee" (IEEE) */
function ieeeName(a: string): string {
  if (isCJK(a)) return a.replace(/\s+/g, '');
  const g = givenOf(a);
  return g ? `${initials(g)} ${surname(a)}` : surname(a);
}
/** "Kevin J. Lee" / "Lee, Kevin" first in Chicago */
function chicagoName(a: string, first: boolean): string {
  if (isCJK(a)) return a.replace(/\s+/g, '');
  const g = givenOf(a);
  if (!g) return surname(a);
  return first ? `${surname(a)}, ${g}` : `${g} ${surname(a)}`;
}

function doiUrl(c: Card): string | undefined {
  const p = c.paper;
  if (p?.doi) return /^https?:/i.test(p.doi) ? p.doi : `https://doi.org/${p.doi.replace(/^doi:\s*/i, '')}`;
  return p?.url;
}

// ---------- in-text ----------
function who(c: Card, style: CitationStyle, narrative: boolean): string {
  const a = authorsOf(c);
  if (!a.length) return c.title.length > 20 ? c.title.slice(0, 20) + '…' : c.title;
  if (chineseCard(c)) return a.length === 1 ? surname(a[0]) : a.length === 2 ? `${surname(a[0])}${narrative ? '與' : '、'}${surname(a[1])}` : `${surname(a[0])}等人`;
  if (a.length === 1) return surname(a[0]);
  if (a.length === 2) return `${surname(a[0])} ${narrative || style === 'chicago-ad' ? 'and' : '&'} ${surname(a[1])}`;
  return `${surname(a[0])} et al.`;
}
const lastIsCJK = (s: string) => isCJK(s.slice(-1));
const sepFor = (c: Card, style: CitationStyle, lang: Lang) => (style === 'chicago-ad' && !chineseCard(c) ? ' ' : lang === 'en' || !chineseCard(c) ? ', ' : '，');

export interface CiteItem { card: Card; loc?: string }

/** Parenthetical citation. Items are ordered like the reference list; prefix (e.g. "見"/"see") goes inside the same parentheses. */
export function formatInText(input: (Card | CiteItem)[], style: CitationStyle, lang: Lang, numbering?: Map<string, number>, prefix?: string): string {
  const items: CiteItem[] = input.map(x => ('card' in x ? x : { card: x }));
  if (!items.length) return '';
  const pre = prefix?.trim() ?? '';
  if (style === 'ieee') {
    const sorted = [...items].sort((x, y) => (numbering?.get(x.card.id) ?? 0) - (numbering?.get(y.card.id) ?? 0));
    const body = sorted.map(i => `${numbering?.get(i.card.id) ?? '?'}${i.loc ? ', ' + i.loc : ''}`).join(', ');
    return `[${pre ? pre + ' ' : ''}${body}]`;
  }
  const order = sortReferences(items.map(i => i.card), style, lang);
  const sorted = order.map(c => items.find(i => i.card.id === c.id)!);
  const parts = sorted.map(i => `${who(i.card, style, false)}${sepFor(i.card, style, lang)}${yearOf(i.card)}${i.loc ? sepFor(i.card, style, lang) + i.loc : ''}`);
  const [l, r, sep] = lang === 'en' ? ['(', ')', '; '] : ['（', '）', '；'];
  const joiner = pre && !(lastIsCJK(pre) && isCJK(parts[0][0])) ? ' ' : '';
  return l + pre + joiner + parts.join(sep) + r;
}

/** Narrative citation: 王小明等人（2019） / Lee and Park (2020). */
export function formatNarrative(c: Card, style: CitationStyle, lang: Lang, numbering?: Map<string, number>): string {
  const w = who(c, style, true);
  if (style === 'ieee') return `${w} [${numbering?.get(c.id) ?? '?'}]`;
  return lang === 'en' ? `${w} (${yearOf(c)})` : `${w}（${yearOf(c)}）`;
}

// ---------- references ----------
function joinApaEn(names: string[]): string {
  let n = names;
  if (n.length > 20) n = [...n.slice(0, 19), '. . . ' + n[n.length - 1]];
  if (n.length === 1) return n[0];
  if (n.length === 2) return `${n[0]}, & ${n[1]}`;
  return n.slice(0, -1).join(', ') + ', & ' + n[n.length - 1];
}
const dot = (s: string) => (/[.。．?!？！]$/.test(s) ? s : s + '.');

export function formatReference(c: Card, style: CitationStyle, _lang: Lang, index?: number): Seg[] {
  const a = authorsOf(c); const p = c.paper; const zh = chineseCard(c);
  const title = c.title.replace(/[.。]$/, '');
  const link = doiUrl(c);
  const venue = p?.venue;
  const segs: Seg[] = [];
  const push = (t: string, i?: boolean) => segs.push(i ? { t, i } : { t });

  if (style === 'ieee') {
    push(`[${index ?? '?'}] `);
    const names = a.map(ieeeName);
    const who = names.length > 6 ? `${names[0]} et al.` : names.length > 2 ? names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1] : names.join(' and ');
    push(`${who || '佚名'}, “${title},” `);
    if (venue) push(venue, true);
    push(`${venue ? ', ' : ''}${yearOf(c)}${link ? (p?.doi ? ', doi: ' + link.replace(/^https?:\/\/doi\.org\//, '') : ', [Online]. Available: ' + link) : ''}.`);
    return segs;
  }
  if (style === 'chicago-ad') {
    if (zh) {
      push(`${a.map(x => x.replace(/\s+/g, '')).join('、') || '佚名'}。${yearOf(c)}。「${title}」。`);
      if (venue) { push(venue, true); push('。'); }
    } else {
      const names = a.map((x, i) => chicagoName(x, i === 0));
      const who = names.length > 10 ? names.slice(0, 7).join(', ') + ', et al' : names.length > 1 ? names.slice(0, -1).join(', ') + ', and ' + names[names.length - 1] : names[0] ?? 'Anon';
      push(`${dot(who)} ${yearOf(c)}. “${dot(title)}” `);
      if (venue) { push(venue, true); push('. '); }
    }
    if (link) push(link + (zh ? '' : '.'));
    return trimSegs(segs);
  }
  // APA 7
  if (zh) {
    push(`${a.map(x => x.replace(/\s+/g, '')).join('、') || '佚名'}（${yearOf(c)}）。${title}。`);
    if (venue) { push(venue, true); push('。'); }
    if (link) push(link);
  } else {
    const who = a.length ? joinApaEn(a.map(apaName)) : (c.title ? '' : 'Anon');
    if (who) push(`${dot(who)} (${yearOf(c)}). ${dot(title)} `);
    else push(`${dot(title)} (${yearOf(c)}). `);
    if (venue) { push(venue, true); push('. '); }
    if (link) push(link);
  }
  return trimSegs(segs);
}
function trimSegs(s: Seg[]): Seg[] {
  if (s.length) s[s.length - 1] = { ...s[s.length - 1], t: s[s.length - 1].t.replace(/\s+$/, '') };
  return s;
}

const zhCollator = (() => { try { return new Intl.Collator('zh-Hant-TW-u-co-stroke'); } catch { return new Intl.Collator('zh-Hant-TW'); } })();
const enCollator = new Intl.Collator('en', { sensitivity: 'base' });

function sortKey(c: Card): string {
  const a = authorsOf(c);
  return a.length ? a.map(x => (isCJK(x) ? x.replace(/\s+/g, '') : apaName(x))).join(' ') : c.title;
}
/** Alphabetical for APA/Chicago (Chinese first by stroke, then English); IEEE keeps given order. */
export function sortReferences(cards: Card[], style: CitationStyle, _lang?: Lang): Card[] {
  if (style === 'ieee') return [...cards];
  const cmp = (x: Card, y: Card, col: Intl.Collator) => col.compare(sortKey(x), sortKey(y)) || yearOf(x).localeCompare(yearOf(y));
  const zh = cards.filter(chineseCard).sort((x, y) => cmp(x, y, zhCollator));
  const en = cards.filter(c => !chineseCard(c)).sort((x, y) => cmp(x, y, enCollator));
  return [...zh, ...en];
}

// ---------- document-level ----------
// Forms: [@id] parenthetical · @id narrative · [見 @id] / [see @id] prefix · [@id, p. 12] locator · [@a; @b] multiple
interface Item { id: string; loc?: string; point?: string }
interface Group { prefix?: string; items: Item[] }
const CITE_RE = /\[([^\[\]]*)\]|(?<![\w@])@([\w-]+)(?:#(\w+))?/g;
const HAS_AT = /(?:^|[\s;,；，])@[\w-]+/;

function parseGroup(inner: string): Group | null {
  if (!HAS_AT.test(inner)) return null;
  const parts = inner.split(/[;；]|[,，](?=\s*@)/);
  const items: Item[] = []; let prefix: string | undefined;
  parts.forEach((p, k) => {
    const m = /^\s*([^@]*?)\s*@([\w-]+)(?:#(\w+))?\s*(?:[,，]\s*(.+?))?\s*$/.exec(p);
    if (!m) return;
    if (k === 0 && m[1]) prefix = m[1].replace(/[,，]$/, '').trim();
    items.push({ id: m[2], point: m[3], loc: m[4] });
  });
  return items.length ? { prefix, items } : null;
}

/** Key-point citations `[@cardId#kpId]` / `@cardId#kpId` in text order (they render like a citation of cardId). */
export function citedPoints(text: string): { cardId: string; pointId: string }[] {
  const out: { cardId: string; pointId: string }[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    if (m[2]) { if (m[3]) out.push({ cardId: m[2], pointId: m[3] }); }
    else { const g = parseGroup(m[1]); if (g) for (const i of g.items) if (i.point) out.push({ cardId: i.id, pointId: i.point }); }
  }
  return out;
}

/** All cited ids in text order (any form). */
export function citationIds(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(CITE_RE)) {
    if (m[2]) out.push(m[2]);
    else { const g = parseGroup(m[1]); if (g) out.push(...g.items.map(i => i.id)); }
  }
  return out;
}
export function citedIdsInOrder(sections: Section[]): string[] {
  const out: string[] = []; const seen = new Set<string>();
  const w = (l: Section[]) => l.forEach(s => { for (const id of citationIds(s.content)) if (!seen.has(id)) { seen.add(id); out.push(id); } w(s.children); });
  w(sections);
  return out;
}
function linkedIds(sections: Section[]): string[] {
  const out: string[] = []; const seen = new Set<string>();
  const w = (l: Section[]) => l.forEach(s => { s.cardIds.forEach(i => { if (!seen.has(i)) { seen.add(i); out.push(i); } }); w(s.children); });
  w(sections);
  return out;
}

export interface CitationContext { numbering: Map<string, number>; refs: Card[]; style: CitationStyle; lang: Lang; byId: Map<string, Card> }

/** Reference list = every card cited in text or linked to a section. */
export function buildContext(sections: Section[], cards: Card[], style: CitationStyle, lang: Lang): CitationContext {
  const byId = new Map(cards.map(c => [c.id, c]));
  const ids = [...new Set([...citedIdsInOrder(sections), ...linkedIds(sections)])].filter(i => byId.get(i)?.paper);
  const numbering = new Map<string, number>();
  let refs: Card[];
  if (style === 'ieee') { refs = ids.map(i => byId.get(i)!); refs.forEach((c, i) => numbering.set(c.id, i + 1)); }
  else refs = sortReferences(ids.map(i => byId.get(i)!), style, lang);
  return { numbering, refs, style, lang, byId };
}

const looksLikeId = (id: string) => /^[0-9a-f-]{8,}$/i.test(id);

/** Render all citation forms. Unknown ids are dropped; a citation with no known id becomes the evidence marker. */
export function renderCitations(text: string, ctx: CitationContext): string {
  const out = text.replace(CITE_RE, (m, inner: string | undefined, bare: string | undefined) => {
    if (bare) {
      const c = ctx.byId.get(bare);
      if (c) return formatNarrative(c, ctx.style, ctx.lang, ctx.numbering);
      return looksLikeId(bare) ? NEED_EVIDENCE[ctx.lang] : m;
    }
    const g = parseGroup(inner ?? '');
    if (!g) return m;
    const known = g.items.filter(i => ctx.byId.has(i.id)).map(i => ({ card: ctx.byId.get(i.id)!, loc: i.loc }));
    if (!known.length) return NEED_EVIDENCE[ctx.lang];
    return formatInText(known, ctx.style, ctx.lang, ctx.numbering, g.prefix);
  });
  // Chinese text: no stray spaces before full-width punctuation/brackets
  return ctx.lang === 'zh-TW'
    ? out.replace(/[ \t\u00a0]+(?=[（）；，。、：！？」』])/g, '').replace(/([）】])[ \t\u00a0]+(?=[\u3400-\u9fff])/g, '$1')
    : out;
}

/** Keep only allowed ids; citations left with none become the evidence marker. Keeps the form of each citation. */
export function sanitizeCitations(text: string, allowed: Set<string>, lang: Lang): string {
  return text.replace(CITE_RE, (m, inner: string | undefined, bare: string | undefined) => {
    if (bare) return allowed.has(bare) ? m : looksLikeId(bare) ? NEED_EVIDENCE[lang] : m;
    const g = parseGroup(inner ?? '');
    if (!g) return m;
    const ok = g.items.filter(i => allowed.has(i.id));
    if (!ok.length) return NEED_EVIDENCE[lang];
    return `[${g.prefix ? g.prefix + ' ' : ''}${ok.map(i => `@${i.id}${i.point ? '#' + i.point : ''}${i.loc ? ', ' + i.loc : ''}`).join('; ')}]`;
  });
}
export const stripCitations = (t: string) => t.replace(CITE_RE, (m, inner: string | undefined, bare: string | undefined) => (bare ? '' : parseGroup(inner ?? '') ? '' : m));
