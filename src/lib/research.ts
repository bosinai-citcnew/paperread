import { addCard, db, getSettings, uid } from '../db';
import { chatJSON, LLMNotConfigured } from './llm';
import { citingWorks, citingWorksOfMany, getWorks, groupBy, searchWorks, searchWorksWithCount, type GroupCount, type ScholarWork } from './scholar';
import type { Card, ConceptGroup, Gap, GapType, Relation, Synthesis, SynthesisStats, Theme, Topic } from '../types';

export { LLMNotConfigured };
export type Progress = (msg: string) => void;
const noop: Progress = () => {};

const GAP_TYPES: GapType[] = ['empirical', 'methodological', 'theoretical', 'temporal', 'geographic'];
export const GAP_LABEL: Record<GapType, string> = {
  empirical: '實證缺口', methodological: '方法缺口', theoretical: '理論缺口', temporal: '時間缺口', geographic: '地域缺口',
};

// ───────────────────────── keywords ─────────────────────────

const isAscii = (s: string) => /^[\x20-\x7e]+$/.test(s);
const uniq = <T,>(a: T[]) => Array.from(new Set(a));

export function buildBoolean(concepts: ConceptGroup[]): string {
  return concepts
    .filter(c => c.concept)
    .map(c => '(' + uniq([c.concept, ...c.synonyms].filter(Boolean)).map(t => `"${t}"`).join(' OR ') + ')')
    .join(' AND ');
}

function englishTerms(g: ConceptGroup, max = 4): string[] {
  return uniq([g.concept, ...g.synonyms].map(s => s.trim()).filter(s => s && isAscii(s))).slice(0, max);
}

/** Build an OpenAlex search string from English synonyms. Falls back to `fallback` when none are English. */
export function buildSearchString(concepts: ConceptGroup[], fallback: string, maxTerms = 4): string {
  const parts = concepts
    .map(g => englishTerms(g, maxTerms))
    .filter(t => t.length)
    .map(t => '(' + t.map(x => `"${x}"`).join(' OR ') + ')');
  return parts.length ? parts.join(' AND ') : fallback;
}

const cleanTerm = (t: string) => t.replace(/["',|:()]/g, ' ').replace(/\s+/g, ' ').trim();

/**
 * OpenAlex `title_and_abstract.search` expression: concepts AND-ed, English synonyms OR-ed.
 * Far more precise than the loose full-text `search=`. Returns '' when no concept has an English term.
 */
export function buildFilterExpr(concepts: ConceptGroup[], maxTerms = 4): string {
  const parts = concepts
    .map(g => uniq(englishTerms(g, maxTerms).map(cleanTerm).filter(Boolean)))
    .filter(t => t.length)
    .map(t => '(' + t.map(x => `"${x}"`).join(' OR ') + ')');
  return parts.join(' AND ');
}
export const filterOf = (expr: string) => `title_and_abstract.search:${expr}`;

const LS_FILTER = (topicId: string) => `paperread:rsFilter:${topicId}`;
function lsGet(k: string) { try { return localStorage.getItem(k); } catch { return null; } }
function lsSet(k: string, v: string) { try { localStorage.setItem(k, v); } catch { /* ignore */ } }

const STOP = new Set(('a an the of in on for to and or with without by from at as into about between among toward towards via using use '
  + 'is are be been its their this that these those versus vs how what why do does impact effect effects role').split(' '));
const isStop = (w: string) => STOP.has(w.toLowerCase());

export function fallbackConcepts(query: string): ConceptGroup[] {
  const q = query.trim();
  const phrases: string[] = [];
  // split on punctuation and CJK connectors first
  for (const seg of q.split(/[,，、;；/＋+()（）]+|(?:的|與|和|及|對於|對|之間|之|在)/)) {
    // within an English segment, split on stopwords to keep noun phrases
    let cur: string[] = [];
    const flush = () => { if (cur.length) phrases.push(cur.join(' ')); cur = []; };
    for (const w of seg.trim().split(/\s+/).filter(Boolean)) {
      if (isAscii(w) && isStop(w)) flush();
      else if (!isAscii(w)) { flush(); phrases.push(w); } // space-separated CJK words are separate concepts
      else cur.push(w);
    }
    flush();
  }
  const list = uniq(phrases.map(s => s.trim()).filter(s => s.length >= 2)).slice(0, 4);
  return (list.length ? list : [q]).map(t => ({ concept: t, synonyms: [] }));
}

export const needsEnglishHint = (concepts: ConceptGroup[]) =>
  concepts.length > 0 && concepts.every(g => englishTerms(g).length === 0);

export interface ExpandResult { concepts: ConceptGroup[]; booleanQuery: string; usedLLM: boolean; error?: string; llmMissing?: boolean }

export const hasAIKey = async () => !!(await getSettings()).llmApiKey?.trim();

/** Pilot-search works per raw query, reused by runSearch so the pilot costs nothing extra. */
const pilotCache = new Map<string, ScholarWork[]>();

const BROAD_FIELDS = new Set(['psychology', 'medicine', 'computer science', 'sociology', 'business', 'political science', 'economic', 'philosophy', 'biology', 'mathematic', 'engineering', 'art', 'geography', 'history', 'physic', 'chemistry', 'environmental science', 'materials science', 'pedagogy', 'psychiatry', 'nursing', 'internet privacy', 'world wide web', 'advertising', 'marketing', 'public relation', 'social psychology', 'developmental psychology', 'clinical psychology', 'law', 'linguistic']);
const GENERIC_TERMS = new Set(['research', 'education', 'study', 'analysis', 'review', 'survey', 'science', 'technology', 'humans', 'medicine']);
const tokOf = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !isStop(t));

/** OpenAlex topic labels ("Digital Marketing and Social Media") are broad and make noisy search synonyms; keywords are lowercase. */
const isTopicLabel = (t: string) => /\band\b|\bvia\b|\bof\b/i.test(t) || (t.split(/\s+/).length >= 3 && t.split(/\s+/).every(w => /^[A-Z]/.test(w)));

/** Pseudo-relevance feedback: weight keywords/topics of the top results by rank (and by their position in each paper). */
function harvestTerms(works: ScholarWork[]): { term: string; score: number; docs: number }[] {
  const acc = new Map<string, { term: string; score: number; docs: number }>();
  const n = works.length;
  works.forEach((w, i) => {
    const rankW = 1 - (0.6 * i) / Math.max(1, n - 1);
    const seen = new Set<string>();
    (w.meta.concepts ?? []).forEach((c, j) => {
      const term = c.trim();
      const key = term.toLowerCase();
      if (!term || !isAscii(term) || term.split(/\s+/).length > 5 || isTopicLabel(term) || GENERIC_TERMS.has(key) || seen.has(key)) return;
      seen.add(key);
      const e = acc.get(key) ?? { term, score: 0, docs: 0 };
      e.score += rankW / (1 + 0.12 * j); e.docs++;
      acc.set(key, e);
    });
  });
  return [...acc.values()].sort((a, b) => b.score - a.score);
}

async function expandByFeedback(query: string): Promise<{ concepts: ConceptGroup[]; pilot: ScholarWork[] }> {
  const concepts = fallbackConcepts(query).map(g => ({ ...g, synonyms: [...g.synonyms] }));
  const pilot: ScholarWork[] = [];
  const cjkIdx = concepts.map((g, i) => (englishTerms(g).length === 0 ? i : -1)).filter(i => i >= 0).slice(0, 3);

  if (!cjkIdx.length) {
    // all-English query: one pilot of the raw query; map harvested terms to the closest concept
    const works = await searchWorks(query, { perPage: 25 });
    pilot.push(...works);
    for (const h of harvestTerms(works).filter(h => h.docs >= 2)) {
      const ht = tokOf(h.term);
      let best = -1, bestOv = 0;
      concepts.forEach((g, i) => {
        const gt = new Set(englishTerms(g).flatMap(tokOf));
        const ov = ht.filter(t => gt.has(t)).length;
        if (ov > bestOv) { bestOv = ov; best = i; }
      });
      const g = concepts[best];
      if (g && g.synonyms.length < 4 && !termsOf(g).includes(h.term.toLowerCase())) g.synonyms.push(h.term);
    }
  } else {
    // Chinese (or other CJK) concepts: pilot each phrase, harvest the English terms OpenAlex attaches to the hits
    for (const i of cjkIdx) {
      const works = await searchWorks(`"${concepts[i].concept}"`, { perPage: 25 });
      pilot.push(...works);
      const hv = harvestTerms(works);
      const top = hv[0]?.docs ?? 0;
      const min = works.length >= 6 ? Math.max(2, Math.ceil(top * 0.25)) : 1;
      concepts[i].synonyms = hv.filter(h => h.docs >= min).slice(0, 4).map(h => h.term);
    }
  }
  const seen = new Set<string>();
  return { concepts, pilot: pilot.filter(w => { const k = w.meta.openalexId ?? w.title; if (seen.has(k)) return false; seen.add(k); return true; }) };
}

export async function expandTopic(query: string): Promise<ExpandResult> {
  let aiError: string | undefined;
  if (await hasAIKey()) {
    try {
      const out = await chatJSON<{ concepts?: ConceptGroup[] }>([
        {
          role: 'system',
          content:
            '你是學術文獻檢索專家。把使用者的研究主題拆解為 2 到 4 個核心概念，每個概念列出 3 到 6 個同義詞/相近術語，' +
            '必須同時包含英文與繁體中文的對應詞（英文詞要是文獻中常用的學術術語）。只輸出 JSON，格式：' +
            '{"concepts":[{"concept":"概念名稱","synonyms":["English term","同義詞","..."]}]}。不要輸出其他文字。',
        },
        { role: 'user', content: `研究主題：${query}` },
      ]);
      const concepts = (out.concepts ?? [])
        .filter(c => c && typeof c.concept === 'string' && c.concept.trim())
        .slice(0, 4)
        .map(c => ({ concept: c.concept.trim(), synonyms: uniq((c.synonyms ?? []).map(s => String(s).trim()).filter(Boolean)).slice(0, 8) }));
      if (!concepts.length) throw new Error('AI 沒有回傳概念');
      return { concepts, booleanQuery: buildBoolean(concepts), usedLLM: true };
    } catch (e) {
      aiError = 'AI 展開失敗，改用免費方法：' + (e as Error).message;
    }
  }
  try {
    const { concepts, pilot } = await expandByFeedback(query);
    pilotCache.set(query, pilot);
    return { concepts, booleanQuery: buildBoolean(concepts), usedLLM: false, error: aiError };
  } catch (e) {
    if ((e as Error).name === 'OpenAlexBudgetError') throw e;
    const concepts = fallbackConcepts(query);
    return { concepts, booleanQuery: buildBoolean(concepts), usedLLM: false, error: aiError ?? (e as Error).message };
  }
}

// ───────────────────────── scoring ─────────────────────────

const termsOf = (g: ConceptGroup) => uniq([g.concept, ...g.synonyms].map(s => s.trim().toLowerCase()).filter(s => s.length >= 2));

/** Phrase-level match: whole phrase, or (multi-word) at least ~2/3 of its content tokens. */
function termMatches(text: string, term: string): boolean {
  if (text.includes(term)) return true;
  if (!isAscii(term)) return false;
  const toks = term.split(/\s+/).filter(w => w.length >= 3 && !isStop(w));
  if (toks.length < 2) return false;
  const hit = toks.filter(t => text.includes(t)).length;
  return hit >= Math.ceil(toks.length * 0.67);
}
const groupMatches = (g: ConceptGroup, text: string) => termsOf(g).some(t => termMatches(text, t));

/** 0..1 relevance: concept phrase coverage (title weighs more), OpenAlex rank when known, log citations. */
export function scoreWork(w: ScholarWork, concepts: ConceptGroup[]): number {
  const title = w.title.toLowerCase();
  const rest = ((w.meta.abstract ?? '') + ' ' + (w.meta.concepts ?? []).join(' ')).toLowerCase();
  let cov = 0;
  for (const g of concepts) {
    if (groupMatches(g, title)) cov += 1;
    else if (groupMatches(g, rest)) cov += 0.6;
  }
  const coverage = concepts.length ? cov / concepts.length : 0;
  const cites = Math.min(1, Math.log10(1 + (w.meta.citedByCount ?? 0)) / 4);
  const score = w.rank !== undefined
    ? 0.5 * coverage + 0.3 * w.rank + 0.2 * cites
    : 0.7 * coverage + 0.3 * cites;
  return Math.round(score * 1000) / 1000;
}

function matchedConcepts(w: ScholarWork, concepts: ConceptGroup[]): string[] {
  const text = (w.title + ' ' + (w.meta.abstract ?? '') + ' ' + (w.meta.concepts ?? []).join(' ')).toLowerCase();
  return concepts.filter(g => groupMatches(g, text)).map(g => g.concept);
}

/** Suggest synonyms from the most frequent OpenAlex keywords/topics of top results, mapped to the closest concept. */
function suggestSynonyms(concepts: ConceptGroup[], works: ScholarWork[]): ConceptGroup[] {
  const freq = new Map<string, number>();
  for (const w of works.slice(0, 20)) for (const c of new Set((w.meta.concepts ?? []).map(x => x.toLowerCase()))) freq.set(c, (freq.get(c) ?? 0) + 1);
  const toks = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3 && !isStop(t));
  const out = concepts.map(g => ({ ...g, synonyms: [...g.synonyms] }));
  const cands = [...freq.entries()].filter(([, n]) => n >= 3).sort((a, b) => b[1] - a[1]);
  for (const [kw] of cands) {
    const kt = toks(kw);
    let best = -1, bestScore = 0;
    out.forEach((g, i) => {
      const gt = new Set(englishTerms(g).flatMap(toks));
      const ov = kt.filter(t => gt.has(t)).length;
      if (ov > bestScore) { bestScore = ov; best = i; }
    });
    if (best >= 0 && out[best].synonyms.length < 4 && !termsOf(out[best]).includes(kw)) out[best].synonyms.push(kw);
  }
  return out;
}

// ───────────────────────── ingest ─────────────────────────

async function touchTopic(topicId: string, patch: Partial<Topic>) {
  await db.topics.update(topicId, { ...patch, updatedAt: Date.now() });
}

/** Score, dedupe and save works as paper cards. Returns number of new cards. */
async function ingest(topic: Topic, works: ScholarWork[], minRelevance = 0, opts: { topN?: number; requireMatch?: boolean } = {}): Promise<number> {
  const seen = new Set<string>();
  const list: ScholarWork[] = [];
  for (const [i, w] of works.entries()) {
    const key = w.meta.openalexId || w.meta.doi || w.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    w.meta.relevance = scoreWork(w, topic.concepts);
    const top = opts.topN !== undefined && i < opts.topN;
    if (opts.requireMatch && !matchedConcepts(w, topic.concepts).length) continue;
    if (top || w.meta.relevance >= minRelevance) list.push(w);
  }
  const ids = list.map(w => w.meta.openalexId).filter((x): x is string => !!x);
  const existing = ids.length ? await db.cards.where('paper.openalexId').anyOf(ids).toArray() : [];
  const exMap = new Map(existing.map(c => [c.paper!.openalexId!, c]));
  const existingDoi = new Set((await db.cards.where('kind').equals('paper').toArray()).map(c => c.paper?.doi).filter(Boolean));
  let added = 0;
  for (const w of list.sort((a, b) => (b.meta.relevance ?? 0) - (a.meta.relevance ?? 0))) {
    const ex = w.meta.openalexId ? exMap.get(w.meta.openalexId) : undefined;
    if (ex) {
      if (!ex.topicId || ex.topicId === topic.id) {
        await db.cards.update(ex.id, {
          topicId: topic.id, paper: { ...ex.paper!, relevance: w.meta.relevance, referencedWorks: ex.paper!.referencedWorks?.length ? ex.paper!.referencedWorks : w.meta.referencedWorks },
        });
      }
      continue;
    }
    if (w.meta.doi && existingDoi.has(w.meta.doi)) continue;
    const tags = uniq((w.meta.concepts ?? []).map(t => t.trim()).filter(t => t.length >= 3 && !isStop(t))).slice(0, 5);
    await addCard({
      kind: 'paper', title: w.title, body: w.meta.abstract ?? '', tags, topicId: topic.id,
      columnId: 'library', paper: w.meta, source: 'openalex',
    });
    added++;
  }
  return added;
}

/** Layered search: keywords → backward chaining → forward tracking. */
export async function runSearch(topicId: string, onProgress: Progress = noop): Promise<{ added: number; total: number }> {
  const topic = await db.topics.get(topicId);
  if (!topic) throw new Error('找不到主題');
  if (!topic.concepts.length) {
    onProgress('展開關鍵字…');
    const ex = await expandTopic(topic.name);
    topic.concepts = ex.concepts; topic.booleanQuery = ex.booleanQuery;
    await touchTopic(topicId, { concepts: ex.concepts, booleanQuery: ex.booleanQuery });
  }
  let concepts = topic.concepts;

  // (a) keyword search: precise title+abstract boolean filter; hit-count heuristic relaxes at most twice
  onProgress('第 1 層：關鍵字搜尋…');
  const run = (cs: ConceptGroup[], terms = 4) => {
    const expr = buildFilterExpr(cs, terms);
    return expr
      ? searchWorksWithCount('', { perPage: 50, filter: filterOf(expr) }).then(r => ({ r, expr }))
      : searchWorksWithCount(topic.name, { perPage: 50 }).then(r => ({ r, expr: '' }));
  };
  let { r: res, expr: usedExpr } = await run(concepts);
  if (res.count < 20 && concepts.length > 1) {
    for (let n = concepts.length - 1; n >= Math.max(1, concepts.length - 2) && res.count < 20; n--) {
      onProgress(`結果僅 ${res.count} 筆，放寬條件（保留 ${n} 個概念）…`);
      ({ r: res, expr: usedExpr } = await run(concepts.slice(0, n)));
    }
  }
  if (usedExpr) lsSet(LS_FILTER(topicId), usedExpr);
  onProgress(`關鍵字搜尋取得 ${res.works.length} 筆（共 ${res.count} 筆符合）`);
  const all: ScholarWork[] = [...res.works];
  const have0 = new Set(all.map(w => w.meta.openalexId));
  for (const w of pilotCache.get(topic.name) ?? []) if (!have0.has(w.meta.openalexId) && matchedConcepts(w, concepts).length >= Math.min(2, concepts.length)) all.push(w); // free: already fetched by the pilot
  all.forEach((w, i) => { w.rank = all.length > 1 ? 1 - i / (all.length - 1) : 1; });
  // suggest synonyms for concepts that have none, from the keywords of top results
  if (concepts.some(g => g.synonyms.length === 0)) {
    const sug = suggestSynonyms(concepts, all);
    if (sug.some((g, i) => g.synonyms.length !== concepts[i].synonyms.length)) {
      topic.concepts = sug;
      concepts = sug;
      await touchTopic(topicId, { concepts: sug, booleanQuery: buildBoolean(sug) });
      onProgress('已依搜尋結果的關鍵字補充同義詞');
    }
  }
  for (const w of all) w.meta.relevance = scoreWork(w, concepts);
  const core = [...all].sort((a, b) => (b.meta.relevance ?? 0) - (a.meta.relevance ?? 0)).slice(0, 15);

  // (b) backward chaining: references cited by >=2 core papers
  onProgress('第 2 層：回溯引用（核心論文共同引用的文獻）…');
  const have = new Set(all.map(w => w.meta.openalexId));
  const refCount = new Map<string, number>();
  for (const w of core) for (const r of new Set(w.meta.referencedWorks ?? [])) refCount.set(r, (refCount.get(r) ?? 0) + 1);
  const backIds = [...refCount.entries()].filter(([id, n]) => n >= 2 && !have.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 30).map(([id]) => id);
  let backWorks: ScholarWork[] = [];
  try { backWorks = backIds.length ? await getWorks(backIds) : []; } catch (e) { if ((e as Error).name === 'OpenAlexBudgetError') throw e; onProgress('回溯引用失敗：' + (e as Error).message); }
  onProgress(`回溯引用取得 ${backWorks.length} 筆`);

  // (c) forward tracking: papers citing the top core papers (one cheap id-filter request)
  onProgress('第 3 層：前向追蹤（引用核心論文的文獻）…');
  let fwd: ScholarWork[] = [];
  try { fwd = await citingWorksOfMany(core.slice(0, 8).map(w => w.meta.openalexId).filter((x): x is string => !!x), 40); }
  catch (e) { if ((e as Error).name === 'OpenAlexBudgetError') throw e; onProgress('前向追蹤失敗：' + (e as Error).message); }
  onProgress(`前向追蹤取得 ${fwd.length} 筆`);

  onProgress('評分並儲存…');
  const added = (await ingest(topic, all, 0.25, { topN: 10 }))
    + (await ingest(topic, backWorks, 0.3, { requireMatch: true }))
    + (await ingest(topic, fwd, 0.3, { requireMatch: true }));
  await touchTopic(topicId, {});
  const total = await db.cards.where('topicId').equals(topicId).filter(c => c.kind === 'paper').count();
  onProgress(`完成：新增 ${added} 篇，主題共 ${total} 篇`);
  return { added, total };
}

/** Chain forward + backward from one paper card. */
export async function expandFromPaper(topicId: string, cardId: string, onProgress: Progress = noop): Promise<number> {
  const topic = await db.topics.get(topicId);
  const card = await db.cards.get(cardId);
  if (!topic || !card?.paper?.openalexId) throw new Error('此論文沒有 OpenAlex ID，無法延伸');
  onProgress('取得此篇的引用與被引…');
  const refIds = (card.paper.referencedWorks ?? []).slice(0, 40);
  const [back, fwd] = await Promise.all([
    refIds.length ? getWorks(refIds) : Promise.resolve([]),
    citingWorks(card.paper.openalexId, 30),
  ]);
  const added = (await ingest(topic, back, 0.3, { requireMatch: true })) + (await ingest(topic, fwd, 0.3, { requireMatch: true }));
  onProgress(`延伸完成：新增 ${added} 篇`);
  return added;
}

// ───────────────────────── relations ─────────────────────────

const STRUCTURAL = new Set(['cites', 'co-cited', 'coupled', 'similar']);

function jaccard<T>(a: Set<T>, b: Set<T>, shared?: number): number {
  let inter = shared ?? 0;
  if (shared === undefined) for (const x of a) if (b.has(x)) inter++;
  const uni = a.size + b.size - inter;
  return uni ? inter / uni : 0;
}

export async function paperCards(topicId: string): Promise<Card[]> {
  return db.cards.where('topicId').equals(topicId).filter(c => c.kind === 'paper').toArray();
}

/** Recompute structural relations (cites/coupled/similar). Keeps manual and LLM-judged ones. */
export async function computeRelations(topicId: string): Promise<number> {
  const cards = (await paperCards(topicId)).filter(c => c.paper);
  const byOA = new Map<string, Card>();
  for (const c of cards) if (c.paper!.openalexId) byOA.set(c.paper!.openalexId, c);
  const rels: Relation[] = [];

  // cites
  for (const c of cards) for (const r of new Set(c.paper!.referencedWorks ?? [])) {
    const t = byOA.get(r);
    if (t && t.id !== c.id) rels.push({ id: uid(), topicId, from: c.id, to: t.id, type: 'cites', weight: 1 });
  }

  // coupled via inverted index of references
  const refSets = new Map<string, Set<string>>();
  const inv = new Map<string, string[]>();
  for (const c of cards) {
    const s = new Set(c.paper!.referencedWorks ?? []);
    refSets.set(c.id, s);
    for (const r of s) { const l = inv.get(r); if (l) l.push(c.id); else inv.set(r, [c.id]); }
  }
  const shared = new Map<string, number>();
  for (const list of inv.values()) {
    if (list.length < 2 || list.length > 80) continue; // ubiquitous refs add noise
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const k = list[i] < list[j] ? `${list[i]}|${list[j]}` : `${list[j]}|${list[i]}`;
      shared.set(k, (shared.get(k) ?? 0) + 1);
    }
  }
  const soft: Relation[] = [];
  for (const [k, n] of shared) {
    const [a, b] = k.split('|');
    const w = jaccard(refSets.get(a)!, refSets.get(b)!, n);
    if (w > 0.1) soft.push({ id: uid(), topicId, from: a, to: b, type: 'coupled', weight: Math.round(w * 1000) / 1000 });
  }

  // similar via concept Jaccard
  const cs = cards.map(c => ({ id: c.id, set: new Set((c.paper!.concepts ?? []).map(x => x.toLowerCase())) })).filter(x => x.set.size >= 2);
  for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
    const w = jaccard(cs[i].set, cs[j].set);
    if (w > 0.3) soft.push({ id: uid(), topicId, from: cs[i].id, to: cs[j].id, type: 'similar', weight: Math.round(w * 1000) / 1000 });
  }
  soft.sort((a, b) => b.weight - a.weight);
  rels.push(...soft.slice(0, 500));

  await db.transaction('rw', db.relations, async () => {
    const old = await db.relations.where('topicId').equals(topicId).toArray();
    await db.relations.bulkDelete(old.filter(r => !r.manual && STRUCTURAL.has(r.type)).map(r => r.id));
    await db.relations.bulkAdd(rels);
  });
  return rels.length;
}

/** LLM-judge top candidate pairs → supports/contradicts relations with a short note. */
export async function judgeRelations(topicId: string, onProgress: Progress = noop): Promise<number> {
  if (!(await hasAIKey())) throw new LLMNotConfigured();
  const cards = new Map((await paperCards(topicId)).map(c => [c.id, c]));
  const rels = await db.relations.where('topicId').equals(topicId).toArray();
  const judged = new Set(rels.filter(r => r.type === 'supports' || r.type === 'contradicts').map(r => [r.from, r.to].sort().join('|')));
  const seen = new Set<string>();
  const cand = rels
    .filter(r => (r.type === 'coupled' || r.type === 'similar') && cards.has(r.from) && cards.has(r.to))
    .sort((a, b) => b.weight - a.weight)
    .filter(r => {
      const k = [r.from, r.to].sort().join('|');
      if (seen.has(k) || judged.has(k)) return false;
      seen.add(k); return true;
    })
    .slice(0, 15);
  if (!cand.length) throw new Error('沒有可判讀的候選配對，請先計算關聯');
  onProgress(`AI 判讀 ${cand.length} 組論文關係…`);
  const brief = (c: Card) => `「${c.title}」(${c.paper?.year ?? '?'})：${(c.paper?.abstract ?? c.body ?? '').slice(0, 450) || '（無摘要）'}`;
  const text = cand.map((r, i) => `配對 ${i + 1}\nA. ${brief(cards.get(r.from)!)}\nB. ${brief(cards.get(r.to)!)}`).join('\n\n');
  const out = await chatJSON<{ judgments?: { i: number; verdict: string; note?: string }[] }>([
    {
      role: 'system',
      content:
        '你是嚴謹的文獻分析助手。針對每個配對，僅依據所提供的標題與摘要，判斷兩篇研究的結論關係：' +
        '"supports"（結論互相支持或一致）、"contradicts"（結論互相矛盾或不一致）、"unrelated"（無明確結論關係或資訊不足）。' +
        '資訊不足時一律填 unrelated，不要臆測。note 用繁體中文一句話（40 字內）說明理由。' +
        '只輸出 JSON：{"judgments":[{"i":1,"verdict":"supports","note":"..."}]}',
    },
    { role: 'user', content: text },
  ]);
  const add: Relation[] = [];
  for (const j of out.judgments ?? []) {
    const r = cand[(j.i ?? 0) - 1];
    if (!r || (j.verdict !== 'supports' && j.verdict !== 'contradicts')) continue;
    add.push({ id: uid(), topicId, from: r.from, to: r.to, type: j.verdict, weight: 0.8, note: j.note?.slice(0, 200) });
  }
  if (add.length) await db.relations.bulkAdd(add);
  onProgress(`判讀完成：${add.length} 組有明確支持/矛盾關係`);
  return add.length;
}

// ───────────────────────── synthesis ─────────────────────────

export interface Signals {
  yearHistogram: { year: number; count: number }[];
  recentShare: number;           // share of papers from the last 5 years (of those with a year)
  medianYear?: number;
  silentConcepts: { concept: string; count: number }[]; // concepts covered by <2 papers
  coverage: { concept: string; count: number }[];
}

export function computeSignals(topic: Topic, cards: Card[]): Signals {
  const years = cards.map(c => c.paper?.year).filter((y): y is number => !!y);
  const hist = new Map<number, number>();
  for (const y of years) hist.set(y, (hist.get(y) ?? 0) + 1);
  const nowY = new Date().getFullYear();
  const sorted = [...years].sort((a, b) => a - b);
  const coverage = topic.concepts.map(g => {
    const count = cards.filter(c => {
      const t = (c.title + ' ' + (c.paper?.abstract ?? '') + ' ' + (c.paper?.concepts ?? []).join(' ')).toLowerCase();
      return groupMatches(g, t);
    }).length;
    return { concept: g.concept, count };
  });
  return {
    yearHistogram: [...hist.entries()].sort((a, b) => a[0] - b[0]).map(([year, count]) => ({ year, count })),
    recentShare: years.length ? years.filter(y => y >= nowY - 4).length / years.length : 0,
    medianYear: sorted.length ? sorted[Math.floor(sorted.length / 2)] : undefined,
    silentConcepts: coverage.filter(c => c.count < 2),
    coverage,
  };
}

export async function getSignals(topicId: string): Promise<Signals | null> {
  const topic = await db.topics.get(topicId);
  if (!topic) return null;
  return computeSignals(topic, await paperCards(topicId));
}

interface RawSynth {
  themes?: { name?: string; summary?: string; papers?: number[]; status?: string }[];
  gaps?: { type?: string; description?: string; evidence?: number[]; implication?: string; suggestion?: string }[];
  directions?: string[];
}

/** Optional AI synthesis (needs an AI key). The default, free path is synthesizeBibliometric. */
export async function synthesizeAI(topicId: string, onProgress: Progress = noop): Promise<Synthesis> {
  if (!(await hasAIKey())) throw new LLMNotConfigured();
  const topic = await db.topics.get(topicId);
  if (!topic) throw new Error('找不到主題');
  const all = await paperCards(topicId);
  if (all.length < 3) throw new Error('論文太少（至少 3 篇）才能做綜合分析，請先深入挖掘');
  const top = [...all].sort((a, b) => (b.paper?.relevance ?? 0) - (a.paper?.relevance ?? 0)).slice(0, 40);
  const signals = computeSignals(topic, all);
  const nowY = new Date().getFullYear();

  const list = top.map((c, i) =>
    `[${i + 1}] ${c.title} (${c.paper?.year ?? '年份不詳'}${c.paper?.venue ? '，' + c.paper.venue : ''})\n    摘要：${(c.paper?.abstract ?? '').slice(0, 600) || '（無摘要）'}`,
  ).join('\n');
  const sigText =
    `論文數 ${all.length}；年份分布：${signals.yearHistogram.map(h => `${h.year}:${h.count}`).join(' ') || '無'}；` +
    `近五年(${nowY - 4}–${nowY})占比 ${(signals.recentShare * 100).toFixed(0)}%；` +
    `覆蓋不足(<2篇)的概念：${signals.silentConcepts.map(c => c.concept).join('、') || '無'}`;

  onProgress('AI 綜合分析中（可能需要一分鐘）…');
  const raw = await chatJSON<RawSynth>([
    {
      role: 'system',
      content:
        '你是嚴謹的文獻回顧研究助理。根據使用者提供的編號論文清單（標題、年份、摘要）做主題綜合與研究缺口分析。\n' +
        '嚴格規則：\n' +
        '1. 只能使用清單中的論文，以方括號編號引用；嚴禁虛構論文、作者、數據或結論。摘要缺漏時不要推測其內容。\n' +
        '2. 輸出繁體中文，只輸出一個 JSON 物件，不含任何其他文字。\n' +
        '3. themes：3 到 7 個主題，每個含 name、summary（2 句內）、papers（編號陣列）、status：' +
        '"convergent"（3 篇以上結論一致）、"divergent"（來源之間結論不同或矛盾）、"silent"（少於 2 篇，潛在缺口）。\n' +
        '4. gaps：研究缺口，type 只能是 empirical（缺少特定族群/情境的實證資料）、methodological（只用單一類型研究方法）、' +
        'theoretical（沒有理論框架能解釋現象）、temporal（證據過時）、geographic（只涵蓋部分地區）。' +
        '每個缺口含 description、evidence（支持此判斷的論文編號陣列，至少 1 個）、implication（此缺口的意義）、suggestion（建議的研究方向）。' +
        '只列出清單證據確實支持的缺口，寧缺勿濫，最多 8 個。\n' +
        '5. directions：3 到 5 條可執行的未來研究方向（字串陣列）。\n' +
        '格式：{"themes":[{"name":"","summary":"","papers":[1],"status":"convergent"}],' +
        '"gaps":[{"type":"empirical","description":"","evidence":[1],"implication":"","suggestion":""}],"directions":[""]}',
    },
    { role: 'user', content: `研究主題：${topic.name}\n輔助統計：${sigText}\n\n論文清單：\n${list}` },
  ], { temperature: 0.2 });

  const toIds = (nums?: number[]) => uniq((nums ?? []).map(n => top[Number(n) - 1]?.id).filter((x): x is string => !!x));
  const themes: Theme[] = (raw.themes ?? []).filter(t => t?.name).map(t => {
    const cardIds = toIds(t.papers);
    let status: Theme['status'] = t.status === 'divergent' ? 'divergent' : 'convergent';
    if (cardIds.length < 2) status = 'silent';
    return { name: String(t.name), summary: String(t.summary ?? ''), cardIds, status };
  });
  for (const s of signals.silentConcepts) {
    if (!themes.some(t => t.name.includes(s.concept) || s.concept.includes(t.name))) {
      themes.push({
        name: s.concept, summary: `主題概念「${s.concept}」在已收集的論文中僅 ${s.count} 篇涉及，可能是研究缺口。`,
        cardIds: top.filter(c => (c.title + (c.paper?.abstract ?? '')).toLowerCase().includes(s.concept.toLowerCase())).map(c => c.id).slice(0, 2),
        status: 'silent',
      });
    }
  }
  const gaps: Gap[] = (raw.gaps ?? [])
    .filter(g => g && GAP_TYPES.includes(g.type as GapType) && g.description)
    .slice(0, 8)
    .map(g => ({
      type: g.type as GapType, description: String(g.description), evidence: toIds(g.evidence),
      implication: String(g.implication ?? ''), suggestion: String(g.suggestion ?? ''),
    }));
  if (signals.yearHistogram.length >= 3 && signals.recentShare < 0.2 && !gaps.some(g => g.type === 'temporal')) {
    const oldest = [...top].filter(c => c.paper?.year).sort((a, b) => a.paper!.year! - b.paper!.year!).slice(0, 3).map(c => c.id);
    gaps.push({
      type: 'temporal',
      description: `近五年的論文僅占 ${(signals.recentShare * 100).toFixed(0)}%（年份中位數 ${signals.medianYear}），證據可能已過時。`,
      evidence: oldest, implication: '既有結論可能無法反映最新情境或技術。', suggestion: '以近年資料重新檢驗主要結論。',
    });
  }
  const synthesis: Synthesis = {
    themes, gaps,
    directions: (raw.directions ?? []).map(String).filter(Boolean).slice(0, 6),
    generatedAt: Date.now(),
    source: 'ai',
  };
  await touchTopic(topicId, { synthesis });
  onProgress('綜合分析完成');
  return synthesis;
}

// ───────────────────────── bibliometric synthesis (free, no AI) ─────────────────────────

interface Pat { key: string; label: string; re: RegExp }
const METHODS: (Pat & { implication: string; suggestion: string })[] = [
  { key: 'qual', label: '質性／訪談', re: /\b(qualitative|interviews?|interviewed|focus groups?|ethnograph\w*|thematic analysis|grounded theory|phenomenolog\w*|narrative inquiry)\b|訪談|質性|焦點團體/i,
    implication: '缺少對情境與經驗的深度理解', suggestion: '以半結構式訪談或焦點團體探究當事人的經驗與脈絡' },
  { key: 'survey', label: '問卷／調查', re: /\b(surveys?|surveyed|questionnaires?|likert|self-report\w*)\b|問卷|調查/i,
    implication: '缺少大樣本、可推論的量化證據', suggestion: '設計大樣本問卷調查以檢驗關聯強度與族群差異' },
  { key: 'experiment', label: '實驗／準實驗', re: /\b(experiments?|experimental|randomi[sz]ed|RCT|quasi-experiment\w*|controlled trial)\b|實驗/i,
    implication: '缺少因果推論的證據', suggestion: '以隨機對照或準實驗設計檢驗介入效果' },
  { key: 'longitudinal', label: '縱貫追蹤', re: /\b(longitudinal|panel (data|study)|cohort|follow-up)\b|縱貫|追蹤研究/i,
    implication: '缺少長期變化與持續效果的證據', suggestion: '進行多波次縱貫追蹤，觀察長期效果' },
  { key: 'review', label: '系統回顧／統合分析', re: /\b(meta-analys\w*|systematic (literature )?review|scoping review|systematic mapping|bibliometric)\b|統合分析|系統性?回顧|後設分析/i,
    implication: '缺少對既有證據的系統性整合', suggestion: '進行系統性文獻回顧或統合分析' },
  { key: 'case', label: '個案研究', re: /\b(case stud(y|ies)|multiple-case|single-case)\b|個案|案例研究/i,
    implication: '缺少對特定組織／場域的深入個案', suggestion: '選擇代表性場域做深入個案研究' },
];
const THEORY_RE = /\b(theor(y|ies|etical)|conceptual (framework|model)|framework)\b|理論|框架/i;
const POPS: (Pat & { watch?: boolean })[] = [
  { key: 'students', label: '大專／一般學生', re: /\b(students?|undergraduates?|graduate students?|learners?)\b|學生|學習者/i },
  { key: 'teachers', label: '教師／教育者', re: /\b(teachers?|educators?|instructors?|faculty)\b|教師|老師|教師/i },
  { key: 'children', label: '兒童／K-12', re: /\b(children|k-12|primary school|elementary|preschool|kindergarten)\b|兒童|幼兒|國小/i, watch: true },
  { key: 'adolescents', label: '青少年', re: /\b(adolescen\w*|teenagers?|high school|secondary school)\b|青少年|國中|高中/i, watch: true },
  { key: 'older', label: '高齡者', re: /\b(older adults?|elderly|seniors?)\b|長者|高齡|老年/i, watch: true },
  { key: 'workers', label: '勞工／職場', re: /\b(workers?|employees?|nurses?|managers?|workplace)\b|員工|勞工|職場/i, watch: true },
  { key: 'women', label: '女性／性別', re: /\b(women|female|gender)\b|女性|性別/i, watch: true },
  { key: 'disadv', label: '弱勢／偏鄉族群', re: /\b(low-income|rural|disadvantaged|marginali[sz]ed|refugees?|migrants?|indigenous|disabilit\w+|special needs)\b|偏鄉|弱勢|原住民|身心障礙/i, watch: true },
];
const GLOBAL_SOUTH = new Set(['IN', 'BR', 'ZA', 'NG', 'KE', 'GH', 'ET', 'TZ', 'UG', 'EG', 'MX', 'AR', 'CO', 'CL', 'PE', 'PK', 'BD', 'LK', 'NP', 'ID', 'PH', 'VN', 'TH', 'MY']);

const pct = (x: number) => (x > 0 && x < 0.005 ? '不到 1%' : `${Math.round(x * 100)}%`);
const cardText = (c: Card) => (c.title + ' ' + (c.paper?.abstract ?? '')).toLowerCase();
const byRel = (a: Card, b: Card) => (b.paper?.relevance ?? 0) - (a.paper?.relevance ?? 0) || (b.paper?.citedByCount ?? 0) - (a.paper?.citedByCount ?? 0);
const pick = (cards: Card[], k = 3) => [...cards].sort(byRel).slice(0, k).map(c => c.id);
function countryName(code: string): string {
  try { return new Intl.DisplayNames(['zh-TW'], { type: 'region' }).of(code) ?? code; } catch { return code; }
}

async function fetchRemoteStats(topicId: string, topic: Topic): Promise<{ stats: SynthesisStats; warn?: string }> {
  const expr = lsGet(LS_FILTER(topicId)) || buildFilterExpr(topic.concepts);
  if (!expr) return { stats: {}, warn: '此主題沒有英文關鍵字，略過 OpenAlex 統計（可在「編輯關鍵字」補上英文詞）' };
  const f = filterOf(expr);
  try {
    // 3 search-class requests (group_by), all sharing the same filter as the deep dig
    const [years, countries, types]: GroupCount[][] = await Promise.all([
      groupBy(f, 'publication_year'), groupBy(f, 'authorships.institutions.country_code'), groupBy(f, 'type'),
    ]);
    const yr = years.map(g => ({ year: Number(g.key), count: g.count })).filter(g => g.year >= 1900 && g.year <= new Date().getFullYear() + 1).sort((a, b) => a.year - b.year);
    return {
      stats: {
        total: years.reduce((n, g) => n + g.count, 0), years: yr,
        countries: countries.map(g => ({ code: g.key, count: g.count })).sort((a, b) => b.count - a.count),
        types: types.map(g => ({ type: g.key, count: g.count })).sort((a, b) => b.count - a.count),
      },
    };
  } catch (e) {
    return { stats: {}, warn: (e as Error).message };
  }
}

/**
 * Free gap analysis from real counts: OpenAlex group_by aggregates (3 search-class requests) plus a local scan of the
 * collected papers' abstracts. Never claims "divergent" and never states anything without a number behind it.
 */
export async function synthesizeBibliometric(topicId: string, onProgress: Progress = noop): Promise<Synthesis> {
  const topic = await db.topics.get(topicId);
  if (!topic) throw new Error('找不到主題');
  const all = await paperCards(topicId);
  if (all.length < 3) throw new Error('論文太少（至少 3 篇）才能做缺口分析，請先深入挖掘');
  const nowY = new Date().getFullYear();

  onProgress('向 OpenAlex 取得年份／國家／類型統計…');
  const { stats: remote, warn } = await fetchRemoteStats(topicId, topic);
  const stats: SynthesisStats = { ...remote };
  const gaps: Gap[] = [];

  // ── temporal ──
  const yearRows = remote.years?.length ? remote.years : computeSignals(topic, all).yearHistogram;
  const yTotal = yearRows.reduce((n, y) => n + y.count, 0);
  if (yTotal >= 10) {
    const recent = yearRows.filter(y => y.year >= nowY - 4).reduce((n, y) => n + y.count, 0);
    const prior = yearRows.filter(y => y.year >= nowY - 9 && y.year < nowY - 4).reduce((n, y) => n + y.count, 0);
    const peak = [...yearRows].sort((a, b) => b.count - a.count)[0];
    const src = remote.years?.length ? `OpenAlex 上符合此主題的 ${yTotal} 篇` : `已收集的 ${yTotal} 篇`;
    const share = recent / yTotal;
    const withYear = all.filter(c => c.paper?.year);
    if (yTotal >= 30 && (share < 0.2 || (peak.year < nowY - 4 && recent < prior * 0.7))) {
      gaps.push({
        type: 'temporal',
        description: `${src}中，近五年（${nowY - 4}–${nowY}）僅占 ${pct(share)}（${recent} 篇），前五年為 ${prior} 篇，發表高峰在 ${peak.year} 年（${peak.count} 篇）。`,
        evidence: pick(withYear.filter(c => c.paper!.year! < nowY - 8), 3),
        implication: '近年的新情境、新技術或新資料尚少被檢驗，既有結論可能已過時。',
        suggestion: '以近五年的資料重新檢驗主要結論，並比較與早期研究的差異。',
      });
    } else if (yTotal >= 30 && share >= 0.65 && (prior === 0 || recent / prior >= 2.5)) {
      gaps.push({
        type: 'temporal',
        description: `${src}中，近五年占 ${pct(share)}（${recent} 篇），約為前五年（${prior} 篇）的 ${prior ? (recent / prior).toFixed(1) + ' 倍' : '全部'}；屬快速成長的新興領域。`,
        evidence: pick(withYear, 3),
        implication: '研究多為近年的初步探索，長期追蹤與成熟的共識結論尚不足。',
        suggestion: '進行縱貫研究與重複驗證，檢驗早期發現是否穩定。',
      });
    }
  }

  // ── geographic ──
  if (remote.countries?.length && (remote.total ?? 0) >= 50) {
    const total = remote.total!;
    const top = remote.countries.slice(0, 3);
    const topSum = top.reduce((n, c) => n + c.count, 0) / total;
    const topLine = top.map(c => `${countryName(c.code)} ${pct(c.count / total)}`).join('、');
    if (top[0].count / total >= 0.3 || topSum >= 0.6) {
      gaps.push({
        type: 'geographic',
        description: `含該國機構作者的論文比例：${topLine}（以 ${total} 篇計，一篇可同時屬於多國），研究集中在少數國家。`,
        evidence: [],
        implication: '結論可能受特定國家的制度與文化脈絡影響，對其他地區的適用性未知。',
        suggestion: '在其他地區與文化脈絡中複製研究，並做跨國比較。',
      });
    }
    const tw = remote.countries.find(c => c.code === 'TW')?.count ?? 0;
    const south = remote.countries.filter(c => GLOBAL_SOUTH.has(c.code)).reduce((n, c) => n + c.count, 0);
    const parts: string[] = [];
    if (tw / total < 0.03) parts.push(`臺灣機構作者的論文僅 ${tw} 篇（${pct(tw / total)}）`);
    if (south / total < 0.15) parts.push(`印度、巴西、南非等主要全球南方國家合計約 ${pct(Math.min(1, south / total))}`);
    if (parts.length) {
      const twCards = all.filter(c => /taiwan|taiwanese|臺灣|台灣/.test(cardText(c)) && topic.concepts.filter(g => groupMatches(g, cardText(c))).length >= Math.min(2, topic.concepts.length));
      gaps.push({
        type: 'geographic',
        description: `${parts.join('；')}（以 ${total} 篇計）。`,
        evidence: pick(twCards, 3),
        implication: '本地（臺灣）與全球南方情境的證據偏少，結論未必適用。',
        suggestion: '以臺灣或發展中地區的樣本做實證，檢驗既有發現是否成立。',
      });
    }
  }

  // ── methodological (local abstracts) ──
  const withAbs = all.filter(c => (c.paper?.abstract ?? '').length >= 80);
  stats.methodBase = withAbs.length;
  if (withAbs.length >= 8) {
    const n = withAbs.length;
    const hit = METHODS.map(m => ({ m, cards: withAbs.filter(c => m.re.test(cardText(c))) }));
    stats.methods = hit.map(h => ({ key: h.m.key, label: h.m.label, count: h.cards.length }));
    const line = hit.map(h => `${h.m.label} ${h.cards.length} 篇（${pct(h.cards.length / n)}）`).join('、');
    const dom = [...hit].sort((a, b) => b.cards.length - a.cards.length)[0];
    const typeKnown = !!remote.types?.length;
    const rare = hit.filter(h => h.cards.length / n < 0.08 && !(typeKnown && h.m.key === 'review'))
      .sort((a, b) => ['experiment', 'longitudinal', 'qual', 'survey', 'case', 'review'].indexOf(a.m.key) - ['experiment', 'longitudinal', 'qual', 'survey', 'case', 'review'].indexOf(b.m.key));
    if (rare.length) {
      const shown = rare.slice(0, 3);
      gaps.push({
        type: 'methodological',
        description: `在 ${n} 篇有摘要的論文中（依摘要用語判斷，可能低估）：${line}。較少見：${shown.map(h => `${h.m.label}（${h.cards.length} 篇）`).join('、')}。`,
        evidence: pick(dom.cards.length ? dom.cards : withAbs, 3),
        implication: shown.map(h => h.m.implication).join('；') + '。',
        suggestion: shown.map(h => h.m.suggestion).join('；') + '。',
      });
    }
  }

  // review share (OpenAlex type)
  if (remote.types?.length && (remote.total ?? 0) >= 30) {
    const reviews = remote.types.find(t => t.type === 'review')?.count ?? 0;
    const share = reviews / remote.total!;
    if (share < 0.03) {
      const reviewCards = all.filter(c => METHODS[4].re.test(cardText(c)));
      gaps.push({
        type: 'methodological',
        description: `OpenAlex 符合此主題的 ${remote.total} 篇中，標示為文獻回顧的僅 ${reviews} 篇（${pct(share)}）。`,
        evidence: pick(reviewCards, 3),
        implication: '尚少有對此主題證據的系統性整合，各研究的結論難以相互比較。',
        suggestion: '進行系統性文獻回顧（或 scoping review），整理方法、樣本與主要發現。',
      });
    }
  }

  // ── theoretical (local abstracts) ──
  if (withAbs.length >= 8) {
    const th = withAbs.filter(c => THEORY_RE.test(cardText(c)));
    const share = th.length / withAbs.length;
    stats.theoryShare = share;
    if (share < 0.3) {
      gaps.push({
        type: 'theoretical',
        description: `${withAbs.length} 篇有摘要的論文中，僅 ${th.length} 篇（${pct(share)}）的摘要提到理論或分析框架。`,
        evidence: pick(withAbs.filter(c => !THEORY_RE.test(cardText(c))), 3),
        implication: '多數研究偏重描述現象，缺乏理論解釋，結果難以累積與推論。',
        suggestion: '選用或發展理論框架來解釋觀察到的模式，並檢驗其適用範圍。',
      });
    }
  }

  // ── empirical (local concept pairs + populations) ──
  const cov = topic.concepts.map(g => ({ g, set: new Set(all.filter(c => groupMatches(g, cardText(c) + ' ' + (c.paper?.concepts ?? []).join(' ').toLowerCase())).map(c => c.id)) }));
  let pairs = 0;
  for (let i = 0; i < cov.length && pairs < 2; i++) for (let j = i + 1; j < cov.length && pairs < 2; j++) {
    const a = cov[i], b = cov[j];
    if (a.set.size < 3 || b.set.size < 3) continue;
    const both = [...a.set].filter(id => b.set.has(id)).length;
    if (both <= 1 || both / Math.min(a.set.size, b.set.size) < 0.12) {
      pairs++;
      const ca = all.filter(c => a.set.has(c.id) && !b.set.has(c.id)), cb = all.filter(c => b.set.has(c.id) && !a.set.has(c.id));
      gaps.push({
        type: 'empirical',
        description: `在已收集的 ${all.length} 篇中，「${a.g.concept}」有 ${a.set.size} 篇、「${b.g.concept}」有 ${b.set.size} 篇，但兩者同時討論的只有 ${both} 篇。`,
        evidence: uniq([...pick(ca, 2), ...pick(cb, 2)]),
        implication: '這兩個概念各有研究，但彼此的關係缺少直接的實證資料。',
        suggestion: `直接檢驗「${a.g.concept}」與「${b.g.concept}」的關聯，例如以兩者的量表或指標做相關／迴歸分析。`,
      });
    }
  }
  if (withAbs.length >= 8) {
    const pops = POPS.map(p => ({ p, cards: withAbs.filter(c => p.re.test(cardText(c))) }));
    stats.populations = pops.map(x => ({ label: x.p.label, count: x.cards.length }));
    const covered = pops.filter(x => x.cards.length >= 3).sort((a, b) => b.cards.length - a.cards.length);
    const missing = pops.filter(x => x.p.watch && x.cards.length <= 1).slice(0, 3);
    if (covered.length && missing.length) {
      gaps.push({
        type: 'empirical',
        description: `${withAbs.length} 篇有摘要的論文，常見研究對象為${covered.slice(0, 3).map(x => `${x.p.label} ${x.cards.length} 篇`).join('、')}；` +
          `幾乎未出現：${missing.map(x => `${x.p.label}（${x.cards.length} 篇）`).join('、')}。`,
        evidence: pick(covered[0].cards, 3),
        implication: '結論主要來自特定族群，對未被研究的族群是否成立並不清楚（是否構成缺口需視你的研究問題判斷）。',
        suggestion: `以${missing.map(x => x.p.label).join('、')}為對象檢驗既有發現。`,
      });
    }
  }

  // ── themes (OpenAlex keywords/topics across collected cards) ──
  const termCards = new Map<string, { term: string; ids: Set<string> }>();
  for (const c of all) for (const raw of new Set([...(c.paper?.concepts ?? [])])) {
    const term = raw.trim();
    const key = term.toLowerCase().replace(/s$/, '');
    if (!term || GENERIC_TERMS.has(key) || BROAD_FIELDS.has(key) || /\(.+\)$/.test(term) || topic.concepts.some(g => termsOf(g).includes(term.toLowerCase()))) continue;
    const e = termCards.get(key) ?? { term, ids: new Set<string>() };
    e.ids.add(c.id); termCards.set(key, e);
  }
  const byId = new Map(all.map(c => [c.id, c]));
  const themes: Theme[] = [...termCards.values()].filter(e => e.ids.size >= 3).sort((a, b) => b.ids.size - a.ids.size).slice(0, 8).map(e => ({
    name: e.term,
    summary: `「${e.term}」出現在 ${e.ids.size} 篇（${pct(e.ids.size / all.length)}）已收集論文的 OpenAlex 關鍵字／主題中，是此主題反覆出現的面向。`,
    cardIds: [...e.ids].map(id => byId.get(id)!).sort(byRel).slice(0, 10).map(c => c.id),
    status: 'convergent' as const,
  }));
  for (const sc of cov.filter(x => x.set.size < 2)) {
    themes.push({
      name: sc.g.concept,
      summary: `主題概念「${sc.g.concept}」在已收集的 ${all.length} 篇中只有 ${sc.set.size} 篇涉及，可能是尚待研究之處。`,
      cardIds: [...sc.set], status: 'silent',
    });
  }

  const directions = uniq(gaps.map(g => g.suggestion)).slice(0, 6);
  const synthesis: Synthesis = { themes, gaps, directions, generatedAt: Date.now(), source: 'bibliometric', stats };
  await touchTopic(topicId, { synthesis });
  onProgress(warn ? `分析完成，但 OpenAlex 統計暫缺：${warn}` : '分析完成');
  return synthesis;
}

/** Save each gap as a 'gap' card and each direction as an 'idea' card. Returns number of cards created. */
export async function saveGapsAsCards(topicId: string): Promise<number> {
  const topic = await db.topics.get(topicId);
  const syn = topic?.synthesis;
  if (!topic || !syn) throw new Error('尚未產生缺口分析');
  const existing = new Set((await db.cards.where('topicId').equals(topicId).toArray()).map(c => c.kind + '|' + c.title));
  const titleMap = new Map((await paperCards(topicId)).map(c => [c.id, c.title]));
  let n = 0;
  for (const g of syn.gaps) {
    const title = `【${GAP_LABEL[g.type]}】${g.description.slice(0, 40)}`;
    if (existing.has('gap|' + title)) continue;
    const ev = g.evidence.map(id => titleMap.get(id)).filter(Boolean).map(t => `- ${t}`).join('\n');
    await addCard({
      kind: 'gap', title, topicId, tags: ['gap', g.type], source: 'research',
      body: `${g.description}\n\n**意義**：${g.implication}\n\n**建議方向**：${g.suggestion}${ev ? `\n\n**證據論文**：\n${ev}` : ''}`,
    });
    n++;
  }
  for (const d of syn.directions) {
    const title = `【研究方向】${d.slice(0, 40)}`;
    if (existing.has('idea|' + title)) continue;
    await addCard({ kind: 'idea', title, topicId, tags: ['direction'], body: d, source: 'research' });
    n++;
  }
  return n;
}

/** Move never-edited openalex paper cards from 'inbox' to 'library' (once per topic; flag in localStorage). */
export async function migrateToLibrary(topicId: string): Promise<number> {
  const flag = `paperread:libMigrated:${topicId}`;
  try { if (localStorage.getItem(flag)) return 0; } catch { /* ignore */ }
  const ids = (await db.cards.where('topicId').equals(topicId).toArray())
    .filter(c => c.kind === 'paper' && c.source === 'openalex' && c.columnId === 'inbox' && c.updatedAt === c.createdAt)
    .map(c => c.id);
  if (ids.length) await db.cards.where('id').anyOf(ids).modify({ columnId: 'library' });
  try { localStorage.setItem(flag, '1'); } catch { /* ignore */ }
  return ids.length;
}
