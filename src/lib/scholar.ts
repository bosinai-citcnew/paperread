import { getSettings } from '../db';
import type { PaperMeta } from '../types';

/** A work mapped from OpenAlex: title + PaperMeta. */
export interface ScholarWork {
  title: string;
  meta: PaperMeta;
  /** 0..1 position in the keyword-search result list (1 = OpenAlex's top hit). Set by callers. */
  rank?: number;
}

const BASE = 'https://api.openalex.org';
const SELECT = [
  'id', 'display_name', 'title', 'publication_year', 'doi', 'authorships', 'primary_location',
  'best_oa_location', 'cited_by_count', 'referenced_works', 'abstract_inverted_index',
  'concepts', 'topics', 'keywords', 'related_works',
].join(',');

export const shortId = (id: string) => id.replace(/^https?:\/\/openalex\.org\//, '').replace(/^works\//, '');

export function rebuildAbstract(inv?: Record<string, number[]> | null): string {
  if (!inv) return '';
  const words: string[] = [];
  for (const [w, pos] of Object.entries(inv)) for (const p of pos) words[p] = w;
  return words.filter(Boolean).join(' ');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function mapWork(w: any): ScholarWork {
  const names = (arr: unknown, min = 0) =>
    (Array.isArray(arr) ? arr : [])
      .filter((x: { score?: number }) => (x.score ?? 1) >= min)
      .map((x: { display_name?: string }) => x.display_name)
      .filter((x): x is string => !!x);
  const concepts = Array.from(new Set([
    ...names(w.keywords, 0.3), ...names(w.topics), ...names(w.concepts, 0.4),
  ])).slice(0, 12);
  const doi: string | undefined = w.doi ? String(w.doi).replace(/^https?:\/\/doi\.org\//, '') : undefined;
  const landing = w.primary_location?.landing_page_url as string | undefined;
  const meta: PaperMeta = {
    openalexId: shortId(w.id),
    doi,
    authors: (w.authorships ?? []).map((a: { author?: { display_name?: string } }) => a.author?.display_name).filter(Boolean),
    year: w.publication_year ?? undefined,
    venue: w.primary_location?.source?.display_name ?? undefined,
    abstract: rebuildAbstract(w.abstract_inverted_index) || undefined,
    citedByCount: w.cited_by_count ?? 0,
    referencedWorks: (w.referenced_works ?? []).map(shortId),
    concepts,
    url: doi ? `https://doi.org/${doi}` : landing || w.id,
    pdfUrl: w.best_oa_location?.pdf_url ?? undefined,
  };
  return { title: w.display_name || w.title || '(無標題)', meta };
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ───────────── budget + cache ─────────────

export const BUDGET_MESSAGE = '今日 OpenAlex 免費額度已用完，可到「設定」填入免費 API Key，或明天再試';
export class OpenAlexBudgetError extends Error {
  constructor(msg = BUDGET_MESSAGE) { super(msg); this.name = 'OpenAlexBudgetError'; }
}

export interface Budget { remainingUsd?: number; resetAt?: number; lastCostUsd?: number }
let budget: Budget = {};
const budgetListeners = new Set<(b: Budget) => void>();
/** Last remaining OpenAlex budget seen in response headers (USD). */
export const getBudget = (): Budget => budget;
export function onBudgetChange(cb: (b: Budget) => void): () => void {
  budgetListeners.add(cb);
  return () => { budgetListeners.delete(cb); };
}
function readBudget(res: Response) {
  const rem = res.headers.get('X-RateLimit-Remaining-USD');
  if (rem === null) return;
  const reset = Number(res.headers.get('X-RateLimit-Reset'));
  budget = {
    remainingUsd: Number(rem),
    resetAt: reset > 0 ? Date.now() + reset * 1000 : budget.resetAt,
    lastCostUsd: Number(res.headers.get('X-RateLimit-Cost-USD')) || undefined,
  };
  budgetListeners.forEach(cb => cb(budget));
}

/** In-memory response cache keyed by full URL (cleared on reload). */
const cache = new Map<string, unknown>();
const CACHE_MAX = 300;
let requestCount = 0;
/** Number of real (non-cached) network requests made so far; handy for cost accounting. */
export const getRequestCount = () => requestCount;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function api(path: string, params: Record<string, string | number | undefined>): Promise<any> {
  const s = await getSettings();
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v));
  if (s.openalexEmail) qs.set('mailto', s.openalexEmail);
  if (s.openalexApiKey?.trim()) qs.set('api_key', s.openalexApiKey.trim());
  const url = `${BASE}${path}?${qs.toString()}`;
  if (cache.has(url)) return cache.get(url);
  if (budget.remainingUsd !== undefined && budget.remainingUsd <= 0 && budget.resetAt && Date.now() < budget.resetAt) throw new OpenAlexBudgetError();
  let delay = 800;
  for (let attempt = 0; attempt < 4; attempt++) {
    requestCount++;
    const res = await fetch(url);
    readBudget(res);
    if (res.status === 429 || res.status >= 500) {
      if (res.status === 429) {
        const body = await res.clone().text().catch(() => '');
        const rem = res.headers.get('X-RateLimit-Remaining-USD');
        if ((rem !== null && Number(rem) <= 0) || /budget|insufficient|daily|quota/i.test(body)) throw new OpenAlexBudgetError();
      }
      const ra = Number(res.headers.get('Retry-After'));
      await sleep(ra > 0 ? Math.min(ra * 1000, 8000) : delay);
      delay *= 2;
      continue;
    }
    if (res.status === 403 || res.status === 402) throw new OpenAlexBudgetError();
    if (!res.ok) throw new Error(`OpenAlex 錯誤 ${res.status}`);
    const data = await res.json();
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value as string);
    cache.set(url, data);
    return data;
  }
  throw new Error('OpenAlex 請求過於頻繁，請稍後再試');
}

export interface SearchOpts { perPage?: number; filter?: string; sort?: string; page?: number }
export interface SearchResult { works: ScholarWork[]; count: number }

export async function searchWorksWithCount(query: string, opts: SearchOpts = {}): Promise<SearchResult> {
  const data = await api('/works', {
    search: query || undefined,
    'per-page': opts.perPage ?? 50,
    page: opts.page,
    filter: opts.filter,
    sort: opts.sort,
    select: SELECT,
  });
  return { works: (data.results ?? []).map(mapWork), count: data.meta?.count ?? 0 };
}

export async function searchWorks(query: string, opts: SearchOpts = {}): Promise<ScholarWork[]> {
  return (await searchWorksWithCount(query, opts)).works;
}

/** Batch fetch by OpenAlex ids ('W123'), ≤50 per request. */
export async function getWorks(ids: string[]): Promise<ScholarWork[]> {
  const uniq = Array.from(new Set(ids.map(shortId).filter(Boolean)));
  const out: ScholarWork[] = [];
  for (let i = 0; i < uniq.length; i += 50) {
    const chunk = uniq.slice(i, i + 50);
    const data = await api('/works', { filter: `openalex:${chunk.join('|')}`, 'per-page': 50, select: SELECT });
    out.push(...(data.results ?? []).map(mapWork));
  }
  return out;
}

/** Works that cite the given work (forward tracking). */
export async function citingWorks(id: string, perPage = 25): Promise<ScholarWork[]> {
  return searchWorks('', { filter: `cites:${shortId(id)}`, perPage, sort: 'cited_by_count:desc' });
}

/** Works referenced by the given work (backward chaining). Accepts a mapped work or id. */
export async function referencesOf(work: ScholarWork | PaperMeta | string, limit = 50): Promise<ScholarWork[]> {
  let refs: string[];
  if (typeof work === 'string') {
    const [w] = await getWorks([work]);
    refs = w?.meta.referencedWorks ?? [];
  } else {
    refs = ('meta' in work ? work.meta.referencedWorks : work.referencedWorks) ?? [];
  }
  return getWorks(refs.slice(0, limit));
}

/** OpenAlex's own related works. */
export async function relatedTo(id: string): Promise<ScholarWork[]> {
  const data = await api(`/works/${shortId(id)}`, { select: 'id,related_works' });
  const rel: string[] = (data.related_works ?? []).map(shortId);
  return getWorks(rel.slice(0, 20));
}

/** Works citing ANY of the given works, in one cheap id-filter request (forward tracking). */
export async function citingWorksOfMany(ids: string[], perPage = 40): Promise<ScholarWork[]> {
  const list = Array.from(new Set(ids.map(shortId).filter(Boolean))).slice(0, 50);
  if (!list.length) return [];
  return searchWorks('', { filter: `cites:${list.join('|')}`, perPage, sort: 'cited_by_count:desc' });
}

export interface GroupCount { key: string; label: string; count: number }

/** group_by aggregation over a works filter (search-class cost). Keys are normalised to short ids / codes. */
export async function groupBy(filter: string, field: string): Promise<GroupCount[]> {
  const data = await api('/works', { filter, group_by: field });
  return (data.group_by ?? []).map((g: { key: string; key_display_name?: string; count: number }) => ({
    key: String(g.key).replace(/^https?:\/\/openalex\.org\/((countries|types)\/)?/, ''),
    label: g.key_display_name ?? String(g.key),
    count: g.count,
  }));
}
