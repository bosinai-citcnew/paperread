import { db, getSettings, uid } from '../db';
import { chat, chatJSON } from './llm';
import { bodyLang, buildContext, citationIds, formatReference, renderCitations, sanitizeCitations, segMarkdown, segText, stripCitations, type CitationContext, type Lang } from './citation';
import type { Card, CitationStyle, FrontMatter, PaperDoc, PaperLanguage, PaperPattern, Section, Topic } from '../types';

export const docLang = (d: Pick<PaperDoc, 'language'>): PaperLanguage => d.language ?? 'zh-TW';
export const docStyle = (d: Pick<PaperDoc, 'citationStyle'>): CitationStyle => d.citationStyle ?? 'apa7';
export const LANG_LABELS: Record<PaperLanguage, string> = { 'zh-TW': '繁體中文', en: 'English', bilingual: '雙語（中文內文＋英文摘要）' };
export const STYLE_LABELS: Record<CitationStyle, string> = { apa7: 'APA 第 7 版', ieee: 'IEEE（數字）', 'chicago-ad': 'Chicago 作者-年份' };

/** Heading dictionary: [zh, en]. Used for templates and relabeling. */
const H: [string, string][] = [
  ['緒論', 'Introduction'], ['主題與研究動機', 'Topic and Rationale'], ['回顧範圍', 'Scope of the Review'],
  ['回顧方法', 'Review Method'], ['全文架構', 'Organization of the Paper'], ['跨主題綜合', 'Cross-Cutting Synthesis'],
  ['共識發現', 'Convergent Findings'], ['分歧與爭論', 'Divergent Findings'], ['方法學觀察', 'Methodological Observations'],
  ['研究缺口與未來方向', 'Research Gaps and Future Directions'], ['已辨識的研究缺口', 'Identified Research Gaps'],
  ['建議的研究議程', 'Proposed Research Agenda'], ['結論', 'Conclusion'], ['摘要', 'Abstract'], ['文獻回顧', 'Literature Review'],
  ['文獻探討', 'Literature Review'], ['研究方法', 'Method'], ['研究結果', 'Results'], ['討論', 'Discussion'],
  ['研究背景', 'Background'], ['問題陳述與研究缺口', 'Problem Statement and Research Gap'], ['研究問題', 'Research Questions'],
  ['預期貢獻', 'Expected Contributions'], ['時程規劃', 'Timeline'], ['參考文獻', 'References'],
];
const heading = (zh: string, lang: PaperLanguage) => (lang === 'en' ? (H.find(h => h[0] === zh)?.[1] ?? zh) : zh);

/** Re-label known headings to the target language (custom headings untouched). Mutates. */
export function relabelHeadings(sections: Section[], lang: PaperLanguage) {
  walk(sections, s => {
    const h = s.heading.trim();
    const hit = H.find(x => x[0] === h || x[1].toLowerCase() === h.toLowerCase());
    if (hit) s.heading = lang === 'en' ? hit[1] : hit[0];
  });
}


export const PATTERN_LABELS: Record<PaperPattern, string> = {
  'thematic-review': '主題式文獻回顧',
  imrad: 'IMRaD 研究論文',
  proposal: '研究計畫書',
};

function sec(heading: string, guidance: string, targetWords: number, children: Section[] = [], cardIds: string[] = []): Section {
  return { id: uid(), heading, guidance, targetWords, content: '', cardIds, children };
}

/** Skeleton sections for a pattern (without synthesis-specific data). */
export function templates(pattern: PaperPattern, lang: PaperLanguage = 'zh-TW'): Section[] {
  const out = rawTemplates(pattern);
  if (lang === 'en') relabelHeadings(out, 'en');
  return out;
}

function rawTemplates(pattern: PaperPattern): Section[] {
  if (pattern === 'imrad') {
    return [
      sec('摘要', '以 150–250 字概述研究目的、方法、主要發現與貢獻。', 250),
      sec('緒論', '說明研究背景、問題陳述、研究目的與研究問題。', 800),
      sec('文獻回顧', '整理相關理論與實證研究，指出缺口並導出研究問題。', 1500),
      sec('研究方法', '描述研究設計、樣本／資料來源、測量工具與分析方法。', 1000),
      sec('研究結果', '客觀呈現分析結果，不做過度詮釋。', 1000),
      sec('討論', '詮釋結果、對照文獻、說明理論與實務意涵、限制。', 1000),
      sec('結論', '總結主要發現、貢獻與未來研究方向。', 450),
    ];
  }
  if (pattern === 'proposal') {
    return [
      sec('研究背景', '說明研究主題的重要性與脈絡。', 600),
      sec('問題陳述與研究缺口', '指出現有研究的不足，說明本研究要解決的問題。', 600),
      sec('研究問題', '列出清楚、可回答的研究問題或假設。', 300),
      sec('文獻探討', '整理與研究問題相關的理論與實證文獻。', 1500),
      sec('研究方法', '說明研究設計、對象、資料蒐集與分析方式。', 1000),
      sec('預期貢獻', '說明學術與實務上的預期貢獻。', 400),
      sec('時程規劃', '以階段與時間點列出研究進度。', 300),
    ];
  }
  return [
    sec('緒論', '說明主題、回顧範圍與全文結構。', 1000, [
      sec('主題與研究動機', '說明為何此主題值得回顧。', 300),
      sec('回顧範圍', '界定納入的文獻類型、年代與議題範圍。', 250),
      sec('回顧方法', '說明檢索策略、納入與排除標準。', 250),
      sec('全文架構', '簡述各章節安排。', 200),
    ]),
    sec('跨主題綜合', '比較各主題之間的共識、分歧與方法特徵。', 1500, [
      sec('共識發現', '多數研究一致的結論。', 500),
      sec('分歧與爭論', '研究結果互相矛盾之處及可能原因。', 500),
      sec('方法學觀察', '現有研究在方法上的特徵與限制。', 500),
    ]),
    sec('研究缺口與未來方向', '整理現有證據揭示的缺口並提出研究議程。', 1200, [
      sec('已辨識的研究缺口', '逐一說明缺口及其證據。', 700),
      sec('建議的研究議程', '提出具體的未來研究方向。', 500),
    ]),
    sec('結論', '總結全文重點與貢獻。', 500),
  ];
}

// ---------- tree helpers ----------

export function walk(sections: Section[], fn: (s: Section, parent: Section | null, depth: number) => void, parent: Section | null = null, depth = 0) {
  for (const s of sections) { fn(s, parent, depth); walk(s.children, fn, s, depth + 1); }
}

export function findSection(sections: Section[], id: string): Section | undefined {
  let r: Section | undefined;
  walk(sections, s => { if (s.id === id) r = s; });
  return r;
}

export function leafSections(sections: Section[]): Section[] {
  const out: Section[] = [];
  walk(sections, s => { if (!s.children.length) out.push(s); });
  return out;
}

export function allCardIds(sections: Section[]): string[] {
  const set = new Set<string>();
  walk(sections, s => s.cardIds.forEach(i => set.add(i)));
  return [...set];
}

export function countWords(text: string): number {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) ?? []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿]/g, ' ').match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) ?? []).length;
  return cjk + latin;
}

// ---------- outline ----------

function mostCommonTag(c: Card, freq: Map<string, number>): string | undefined {
  let best: string | undefined; let bestN = 0;
  for (const t of c.tags) { const n = freq.get(t) ?? 0; if (n > bestN) { best = t; bestN = n; } }
  return best;
}

/** Build an outline from a topic's synthesis (or tag grouping). Works without LLM. */
export async function buildOutline(topicId: string, pattern: PaperPattern, lang: PaperLanguage = 'zh-TW'): Promise<Section[]> {
  const topic: Topic | undefined = await db.topics.get(topicId);
  const cards = (await db.cards.where('topicId').equals(topicId).toArray()).filter(c => c.kind === 'paper');

  let themes: { name: string; summary: string; cardIds: string[] }[] = topic?.synthesis?.themes?.map(t => ({ name: t.name, summary: t.summary, cardIds: t.cardIds ?? [] })) ?? [];
  if (!themes.length) {
    const freq = new Map<string, number>();
    cards.forEach(c => c.tags.forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1)));
    const groups = new Map<string, string[]>();
    for (const c of cards) {
      const tag = mostCommonTag(c, freq) ?? '其他';
      groups.set(tag, [...(groups.get(tag) ?? []), c.id]);
    }
    themes = [...groups.entries()].sort((a, b) => b[1].length - a[1].length)
      .map(([name, cardIds]) => ({ name, summary: '', cardIds }));
  }
  const gaps = topic?.synthesis?.gaps ?? [];
  const gapCards = [...new Set(gaps.flatMap(g => g.evidence ?? []))];
  const allIds = cards.map(c => c.id);
  const tpl = templates(pattern, lang);

  if (pattern === 'thematic-review') {
    const [intro, cross, gapSec, concl] = tpl;
    intro.cardIds = allIds.slice(0, 12);
    const themeSecs = themes.map(t => sec(t.name, `${t.summary ? t.summary + '\n' : ''}整理此主題下的研究：主要發現、方法、共識與分歧。`, 1200, [], t.cardIds));
    cross.cardIds = [...new Set(themes.flatMap(t => t.cardIds))].slice(0, 20);
    if (gaps.length) {
      const gs = gapSec.children[0];
      gs.cardIds = gapCards;
      gs.guidance = '逐一說明缺口及其證據：\n' + gaps.map(g => `- [${g.type}] ${g.description}`).join('\n');
      gapSec.cardIds = gapCards;
    }
    const dirs = topic?.synthesis?.directions ?? [];
    if (dirs.length) {
      const ag = gapSec.children[1];
      ag.guidance = '提出具體研究議程：\n' + dirs.map(d => `- ${d}`).join('\n');
      ag.cardIds = gapCards;
    }
    return [intro, ...themeSecs, cross, gapSec, concl];
  }

  // imrad / proposal: attach evidence to literature sections, themes as sub-sections
  const litIdx = tpl.findIndex(s => /^(文獻回顧|文獻探討|Literature Review)$/.test(s.heading));
  if (litIdx >= 0) {
    tpl[litIdx].children = themes.map(t => sec(t.name, `${t.summary ? t.summary + '\n' : ''}回顧此主題相關研究。`, 400, [], t.cardIds));
    tpl[litIdx].cardIds = allIds.slice(0, 20);
  }
  const gapIdx = tpl.findIndex(s => /^(問題陳述與研究缺口|Problem Statement and Research Gap)$/.test(s.heading));
  if (gapIdx >= 0 && gaps.length) {
    tpl[gapIdx].cardIds = gapCards;
    tpl[gapIdx].guidance = (tpl[gapIdx].guidance ?? '') + '\n已辨識缺口：\n' + gaps.map(g => `- [${g.type}] ${g.description}`).join('\n');
  }
  const discIdx = tpl.findIndex(s => /^(討論|Discussion)$/.test(s.heading));
  if (discIdx >= 0) tpl[discIdx].cardIds = gapCards;
  return tpl;
}

// ---------- drafting ----------

const SYS_ZH = `你是嚴謹的學術寫作助理。請以「正式學術中文」撰寫指定章節的 Markdown 內文。
文體規範：
1. 使用書面語與第三人稱，採「本研究」「研究者」等稱謂；避免口語、第一人稱（如「我們覺得」）、誇飾與主觀評價。
2. 全程使用全形標點符號（，。；：、？！「」（））；英文專有名詞與縮寫維持半形。
3. 論述宜有保留（如「顯示」「可能」「尚待驗證」），不得過度推論或做因果誇大。
引用與證據規範：
4. 只能引用「提供的文獻」，且必須使用該文獻的引用標記，不要自行寫作者姓名與年份（系統會依引用格式轉換）。引用標記有四種寫法：
   - 括號引用（句末佐證）：[@id]，多筆為 [@id1; @id2]，例如「……成效顯著 [@id]。」
   - 敘述引用（作者作為句子主詞）：直接寫 @id，例如「@id 指出……」，會轉為「王小明等人（2019）指出……」
   - 帶前綴：[見 @id] 或 [參見 @id]，前綴與引用在同一個括號內，不要在標記外自行加括號。
   - 帶頁碼：[@id, 頁 12]
   標記前後不要再加括號，也不要在標記前留空白。
5. 嚴禁捏造任何文獻、作者、年份、數據或結論；只能依據文獻標題與摘要明示的內容陳述，沒有提到的不要推測。
6. 證據不足以支撐論點時，直接標註【待補證據】，不要編造。
7. 不要輸出本節標題，也不要輸出參考文獻列表。字數盡量接近目標字數。可使用「###」小標題與條列，但以連貫段落為主。`;

const SYS_EN = `You are a rigorous academic writing assistant. Write the requested section in Markdown in the most formal academic English.
Style rules:
1. Use formal academic register, third person, and no contractions, colloquialisms, rhetorical questions, or first-person pronouns (use "this study" or "the authors" where necessary).
2. Hedge claims appropriately (e.g., "suggests", "may", "remains to be examined"); avoid overstatement and unsupported causal language.
3. Follow APA 7 writing conventions: past tense for completed studies, present perfect for established literature, numbers and abbreviations per APA, unbiased language.
Citation and evidence rules:
4. Cite ONLY the provided sources using their citation tokens; never write author names or years yourself (the system formats them per the chosen citation style). Four forms:
   - Parenthetical (support at the end of a claim): [@id], multiple as [@id1; @id2], e.g., "...improved outcomes [@id]."
   - Narrative (the author is the grammatical subject): write @id bare, e.g., "@id reported that...", rendered as "Lee and Park (2020) reported that..."
   - With prefix: [see @id] or [e.g., @id], the prefix stays inside the same parentheses; never wrap a token in additional parentheses.
   - With locator: [@id, p. 12]
5. Never invent sources, authors, years, data, or findings. State only what a source's title and abstract explicitly support; do not speculate.
6. Where evidence is insufficient to support a claim, write [EVIDENCE NEEDED] instead of fabricating.
7. Do not output the section heading or a reference list. Aim for the target word count. Prefer coherent paragraphs; "###" subheadings and lists are allowed sparingly.`;

export const systemFor = (l: Lang) => (l === 'en' ? SYS_EN : SYS_ZH);

export function firstAuthorLabel(c: Card): string {
  const a = c.paper?.authors?.[0];
  const last = a ? (a.includes(',') ? a.split(',')[0] : a.trim().split(/\s+/).slice(-1)[0]) : c.title.slice(0, 12);
  const more = (c.paper?.authors?.length ?? 0) > 1 ? ' et al.' : '';
  return `${last}${more}, ${c.paper?.year ?? 'n.d.'}`;
}

function pointsBrief(c: Card): string {
  const kps = (c.reading?.keyPoints ?? []).filter(k => k.confirmed || k.ai).slice(0, 12);
  return kps.map(k => `  [@${c.id}#${k.id}] (${k.kind}) ${k.text}`).join('\n');
}

function cardBrief(c: Card, i: number, l: Lang): string {
  const p = c.paper;
  const kp = pointsBrief(c);
  const abs = (p?.abstract || c.body || '').slice(0, 1200) || (l === 'en' ? '(no abstract)' : '（無摘要）');
  return l === 'en'
    ? `[${i + 1}] Citation token: [@${c.id}]\nTitle: ${c.title}\nAuthors: ${p?.authors?.join('; ') || 'unknown'}\nYear: ${p?.year ?? 'unknown'}\nAbstract: ${abs}${kp ? `\nKey points (you may cite a specific point with its token, e.g. [@id#kpId]; it renders as a citation of this source):\n${kp}` : ''}`
    : `[${i + 1}] 引用標記：[@${c.id}]\n標題：${c.title}\n作者：${p?.authors?.join('; ') || '未知'}\n年份：${p?.year ?? '未知'}\n摘要：${abs}${kp ? `\n重點（可用其標記引用特定重點，如 [@id#kpId]，會顯示為此文獻的引用）：\n${kp}` : ''}`;
}

// ---------- template (no-AI) drafting: structured draft built only from real data ----------

/** True when an AI key is configured. Without it every generator uses the template path. */
export async function aiEnabled(): Promise<boolean> {
  try { return !!(await getSettings()).llmApiKey?.trim(); } catch { return false; }
}

/** Placeholders the user must fill in: 【待補：…】 (zh) / [TODO: …] (en). */
export const PLACEHOLDER_RE = /【待補[^】]*】|\[TODO[^\]]*\]/g;
const ph = (l: Lang, zh: string, en: string) => (l === 'en' ? `[TODO: ${en}]` : `【待補：${zh}】`);
const joinL = (xs: string[], l: Lang) => (l === 'en'
  ? (xs.length <= 2 ? xs.join(' and ') : `${xs.slice(0, -1).join(', ')}, and ${xs[xs.length - 1]}`)
  : xs.join('、'));
const tr = (l: Lang, zh: string, en: string) => (l === 'en' ? en : zh);

function yearsOf(cs: Card[]): [number, number] | null {
  const ys = cs.map(c => c.paper?.year).filter((y): y is number => typeof y === 'number');
  return ys.length ? [Math.min(...ys), Math.max(...ys)] : null;
}
/** "，發表於 2019 至 2023 年" / ", published between 2019 and 2023" ('' when no years). */
function yearPhrase(cs: Card[], l: Lang): string {
  const r = yearsOf(cs);
  if (!r) return '';
  if (l === 'en') return r[0] === r[1] ? `, published in ${r[0]}` : `, published between ${r[0]} and ${r[1]}`;
  return r[0] === r[1] ? `，發表於 ${r[0]} 年` : `，發表於 ${r[0]} 至 ${r[1]} 年`;
}

/** Split into sentences without breaking on abbreviations, decimals or "et al.". */
export function splitSentences(text: string): string[] {
  const t = text.replace(/\s+/g, ' ').trim();
  const raw = t.match(/(?:[^。！？.!?]|[.!?](?!\s|$))*(?:[。！？]+|[.!?]+(?=\s|$)|$)/g)?.map(x => x.trim()).filter(Boolean) ?? [];
  const out: string[] = [];
  for (const s of raw) {
    const prev = out[out.length - 1];
    if (prev && (/\b(?:e\.g|i\.e|et al|vs|Fig|No|Dr|Mr|Ms|Prof|approx|U\.S)\.$/.test(prev) || (/[.!?]$/.test(prev) && /^[a-z]/.test(s)))) out[out.length - 1] = `${prev} ${s}`;
    else out.push(s);
  }
  return out;
}
const hasMark = (s: string) => { PLACEHOLDER_RE.lastIndex = 0; return PLACEHOLDER_RE.test(s) || /\[@|(?:^|\s)@[\w-]+/.test(s); };
const cap = (s: string, n = 320) => (s.length > n ? s.slice(0, n).replace(/[\s,;，；、]+$/, '') + '…' : s);

interface Ev { text: string; kpId?: string; kind: 'finding' | 'method' | 'abstract' }
/** Evidence for one paper: confirmed (else any) finding/method key points, else first abstract sentence. Verbatim. */
function evidenceFor(c: Card, max = 2): Ev[] {
  const pool = (c.reading?.keyPoints ?? []).filter(k => k.kind === 'finding' || k.kind === 'method');
  const confirmed = pool.filter(k => k.confirmed);
  const use = (confirmed.length ? confirmed : pool).sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'finding' ? -1 : 1)).slice(0, max);
  const evs: Ev[] = use.map(k => ({ text: (k.quote?.trim() || k.text.trim()), kpId: k.id, kind: k.kind as 'finding' | 'method' })).filter(e => e.text);
  if (evs.length) return evs;
  const first = splitSentences(c.paper?.abstract || c.body || '')[0];
  return first ? [{ text: first, kind: 'abstract' }] : [];
}

const quote = (t: string, l: Lang) => {
  const x = cap(t.replace(/[.。]+$/, ''));
  return l === 'en' ? `“${x}”` : `「${x.replace(/「/g, '『').replace(/」/g, '』')}」`;
};

/** One citable sentence for a paper, using narrative [@id] / parenthetical / key-point syntax. */
function paperSentence(c: Card, i: number, l: Lang): string {
  const evs = evidenceFor(c);
  if (!evs.length) {
    return l === 'en'
      ? `@${c.id} authored “${c.title}”, but no abstract or key points are recorded ${ph(l, '', 'summarize this study’s main content')}.`
      : `@${c.id} 發表〈${c.title}〉，但尚無摘要或重點紀錄${ph(l, '此研究的主要內容', '')}。`;
  }
  const tok = (e: Ev) => `@${c.id}${e.kpId ? '#' + e.kpId : ''}`;
  const parts = evs.map((e, k) => {
    const q = quote(e.text, l);
    if (k === 0 && i % 2 === 0) {
      const v = l === 'en' ? (e.kind === 'method' ? 'described the method as' : e.kind === 'abstract' ? 'wrote in the abstract that' : 'reported that') : (e.kind === 'method' ? '說明其方法為' : e.kind === 'abstract' ? '在摘要中提到' : '指出');
      return `${tok(e)} ${v}${l === 'en' ? ' ' : ''}${q}`;
    }
    if (k === 0) return l === 'en' ? `${q} [${tok(e)}]` : `此外，${q}[${tok(e)}]`;
    const v = l === 'en' ? (e.kind === 'method' ? 'The same study described its method as' : 'The same study also reported that') : (e.kind === 'method' ? '同一研究亦說明其方法為' : '同一研究亦指出');
    return `${v}${l === 'en' ? ' ' : ''}${q}${l === 'en' ? ' ' : ''}[${tok(e)}]`;
  });
  return parts.join(l === 'en' ? '. ' : '。') + (l === 'en' ? '.' : '。');
}

const METHODS: { zh: string; en: string; re: RegExp }[] = [
  { zh: '問卷調查', en: 'a survey or questionnaire', re: /問卷|survey|questionnaire/i },
  { zh: '訪談', en: 'interviews', re: /訪談|interview/i },
  { zh: '實驗', en: 'an experiment', re: /實驗|experiment|randomi[sz]ed|\bRCT\b/i },
  { zh: '個案研究', en: 'a case study', re: /個案|案例研究|case stud/i },
  { zh: '質性研究', en: 'qualitative methods', re: /質性|qualitative|grounded theory|thematic analysis/i },
  { zh: '量化分析', en: 'quantitative analysis', re: /量化|quantitative|regression|迴歸/i },
  { zh: '系統性回顧或統合分析', en: 'a systematic review or meta-analysis', re: /系統性回顧|統合分析|meta-analy|systematic review|systematic literature/i },
  { zh: '縱貫設計', en: 'a longitudinal design', re: /縱貫|longitudinal/i },
  { zh: '模擬', en: 'simulation', re: /模擬|simulation/i },
];
/** Count papers whose method key points / abstract / title mention each method. Computed from data only. */
function methodCounts(cards: Card[]): { m: typeof METHODS[number]; ids: string[] }[] {
  const res = METHODS.map(m => ({ m, ids: [] as string[] }));
  for (const c of cards) {
    const text = [c.title, c.paper?.abstract ?? '', ...(c.reading?.keyPoints ?? []).filter(k => k.kind === 'method' || k.kind === 'sample').map(k => `${k.text} ${k.quote ?? ''}`)].join(' ');
    res.forEach(r => { if (r.m.re.test(text)) r.ids.push(c.id); });
  }
  return res.filter(r => r.ids.length).sort((a, b) => b.ids.length - a.ids.length);
}
const citeList = (ids: string[], max = 4) => `[${ids.slice(0, max).map(i => '@' + i).join('; ')}]`;

/** Closing sentence that only restates counts computed from the data. */
function closingSentence(cards: Card[], l: Lang): string {
  const n = cards.length;
  const mc = methodCounts(cards).slice(0, 3);
  if (mc.length) {
    const bits = mc.map(r => (l === 'en'
      ? `${r.ids.length} mentioned ${r.m.en} ${citeList(r.ids)}`
      : `有 ${r.ids.length} 篇${citeList(r.ids)}提及${r.m.zh}`));
    return l === 'en' ? `Of the ${n} ${n === 1 ? 'study' : 'studies'} above, ${joinL(bits, l)}.` : `上述 ${n} 篇研究中，${bits.join('，')}。`;
  }
  const withKp = cards.filter(c => (c.reading?.keyPoints ?? []).length).length;
  const yp = yearPhrase(cards, l);
  return l === 'en'
    ? `The ${n} studies above${yp} include ${withKp} with recorded key points.`
    : `上述 ${n} 篇研究${yp}，其中 ${withKp} 篇已有精讀重點可供引用。`;
}

function topKeywords(cards: Card[], topic: Topic | undefined, n = 5): string[] {
  const freq = new Map<string, { label: string; n: number }>();
  const add = (k: string) => { const key = k.trim().toLowerCase(); if (!key || key.length > 40) return; const e = freq.get(key); if (e) e.n++; else freq.set(key, { label: k.trim(), n: 1 }); };
  cards.forEach(c => { (c.paper?.concepts ?? []).forEach(add); c.tags.forEach(add); });
  const ranked = [...freq.values()].sort((a, b) => b.n - a.n).map(x => x.label);
  const fromTopic = (topic?.concepts ?? []).map(g => g.concept);
  return [...new Set([...fromTopic, ...ranked])].slice(0, n);
}

const GAP_LABEL: Record<string, [string, string]> = {
  empirical: ['實證', 'empirical'], methodological: ['方法', 'methodological'], theoretical: ['理論', 'theoretical'],
  temporal: ['時間', 'temporal'], geographic: ['地理', 'geographic'],
};
const gapLabel = (t: string, l: Lang) => (GAP_LABEL[t] ?? [t, t])[l === 'en' ? 1 : 0];

function gapLines(topic: Topic | undefined, cards: Card[], l: Lang, withSuggest = false): string[] {
  const known = new Set(cards.map(c => c.id));
  return (topic?.synthesis?.gaps ?? []).map((g, i) => {
    const ev = (g.evidence ?? []);
    const cited = ev.filter(id => known.has(id));
    const evs = !ev.length ? '' : l === 'en'
      ? ` (evidence from ${ev.length} stud${ev.length === 1 ? 'y' : 'ies'}${cited.length ? ' ' + citeList(cited) : ''})`
      : `（共 ${ev.length} 篇文獻顯示此缺口${cited.length ? ' ' + citeList(cited) : ''}）`;
    const endp = (x: string) => (/[.。!?！？]$/.test(x.trim()) ? x.trim() : x.trim() + (l === 'en' ? '.' : '。'));
    const imp = g.implication ? (l === 'en' ? ` Implication: ${endp(g.implication)}` : `意涵：${endp(g.implication)}`) : '';
    const sug = withSuggest && g.suggestion ? (l === 'en' ? ` Suggested direction: ${endp(g.suggestion)}` : `建議方向：${endp(g.suggestion)}`) : '';
    return l === 'en'
      ? `${i + 1}. (${gapLabel(g.type, l)} gap) ${g.description}${evs}.${imp}${sug}`
      : `${i + 1}. （${gapLabel(g.type, l)}缺口）${g.description}${evs}。${imp}${sug}`;
  });
}

type Kind = 'abstract' | 'intro' | 'scope' | 'reviewMethod' | 'organization' | 'gapProblem' | 'gaps' | 'agenda' | 'gapsParent' | 'rq'
  | 'method' | 'results' | 'discussion' | 'conclusion' | 'contribution' | 'timeline' | 'cross' | 'convergent' | 'divergent' | 'methodObs' | 'lit' | 'theme';
const KIND_RES: [Kind, RegExp][] = [
  ['abstract', /^(摘要|abstract)$/i], ['intro', /^(緒論|主題與研究動機|研究背景|introduction|topic and rationale|background)$/i],
  ['scope', /^(回顧範圍|scope of the review)$/i], ['reviewMethod', /^(回顧方法|review method)$/i],
  ['organization', /^(全文架構|organization of the paper)$/i], ['gapProblem', /^(問題陳述與研究缺口|problem statement and research gap)$/i],
  ['gaps', /^(已辨識的研究缺口|identified research gaps)$/i], ['agenda', /^(建議的研究議程|proposed research agenda)$/i],
  ['gapsParent', /^(研究缺口與未來方向|research gaps and future directions)$/i], ['rq', /^(研究問題|research questions)$/i],
  ['method', /^(研究方法|methods?)$/i], ['results', /^(研究結果|results)$/i], ['discussion', /^(討論|discussion)$/i],
  ['conclusion', /^(結論|conclusions?)$/i], ['contribution', /^(預期貢獻|expected contributions)$/i], ['timeline', /^(時程規劃|timeline)$/i],
  ['cross', /^(跨主題綜合|cross-cutting synthesis)$/i], ['convergent', /^(共識發現|convergent findings)$/i],
  ['divergent', /^(分歧與爭論|divergent findings)$/i], ['methodObs', /^(方法學觀察|methodological observations)$/i],
  ['lit', /^(文獻回顧|文獻探討|literature review)$/i],
];
export function sectionKind(heading: string): Kind {
  const h = heading.trim();
  return KIND_RES.find(([, re]) => re.test(h))?.[0] ?? 'theme';
}

export interface TemplateInput {
  lang: Lang; pattern: PaperPattern; docTitle: string; heading: string; guidance?: string;
  outline: string[];        // top-level headings of the doc
  cards: Card[];            // the section's evidence cards (already resolved)
  topic?: Topic;
}

function litBody(inp: TemplateInput, kind: Kind): string {
  const { lang: l, cards, topic, heading } = inp;
  if (!cards.length) {
    return l === 'en'
      ? `No sources are linked to this section. ${ph(l, '', 'link evidence cards, then summarize the studies on “' + heading + '”')}`
      : `本節尚未連結任何文獻。${ph(l, `連結證據文獻後，整理「${heading}」相關研究`, '')}`;
  }
  const sorted = [...cards].sort((a, b) => (a.paper?.year ?? 9999) - (b.paper?.year ?? 9999));
  const theme = topic?.synthesis?.themes?.find(t => t.name === heading);
  const out: string[] = [];
  const yp = yearPhrase(sorted, l);
  const statusZh = { convergent: '多數文獻結論一致', divergent: '文獻之間存在分歧', silent: '目前證據不足（少於 2 篇）' };
  const statusEn = { convergent: 'the sources largely agree', divergent: 'the sources disagree', silent: 'evidence is still thin (fewer than two sources)' };
  const status = theme ? (l === 'en' ? ` For this theme, ${statusEn[theme.status]}.` : `就此主題而言，${statusZh[theme.status]}。`) : '';
  const topicName = kind === 'theme' ? heading : (topic?.name ?? inp.docTitle);
  out.push(l === 'en'
    ? `The literature on “${topicName}” comprises ${sorted.length} stud${sorted.length === 1 ? 'y' : 'ies'}${yp}.${status}${theme?.summary ? ' ' + theme.summary : ''}`
    : `「${topicName}」相關文獻共 ${sorted.length} 篇${yp}。${status}${theme?.summary ? theme.summary : ''}`);

  // group by most common tag (generic literature-review sections); a theme section is already one group
  const groups = new Map<string, Card[]>();
  if (kind === 'lit') {
    const freq = new Map<string, number>();
    sorted.forEach(c => c.tags.forEach(t => freq.set(t, (freq.get(t) ?? 0) + 1)));
    for (const c of sorted) {
      const tag = mostCommonTag(c, freq) ?? tr(l, '其他', 'Other studies');
      groups.set(tag, [...(groups.get(tag) ?? []), c]);
    }
  } else groups.set('', sorted);
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);
  let idx = 0;
  for (const [tag, cs] of ordered) {
    const intro = tag
      ? (l === 'en' ? `Under “${tag}”, ${cs.length} stud${cs.length === 1 ? 'y is' : 'ies are'} included${yearPhrase(cs, l)}:` : `在「${tag}」面向下，共有 ${cs.length} 篇研究${yearPhrase(cs, l)}：`)
      : '';
    out.push([intro, ...cs.map(c => paperSentence(c, idx++, l))].filter(Boolean).join(l === 'en' ? ' ' : ''));
  }
  out.push(closingSentence(sorted, l) + ' ' + ph(l, '綜合比較這些研究的共同點、差異與其對本研究的意涵', 'compare these studies’ commonalities and differences and their implications for this paper'));
  return out.join('\n\n');
}

/** Build prose for one section from real data only; anything the author must supply is a marked placeholder. */
export function templateSection(inp: TemplateInput): string {
  const { lang: l, cards, topic, heading } = inp;
  const kind = sectionKind(heading);
  const n = cards.length;
  const topicName = topic?.name ?? inp.docTitle;
  const yp = yearPhrase(cards, l);
  const kws = topKeywords(cards, topic);
  const gaps = topic?.synthesis?.gaps ?? [];
  const dirs = topic?.synthesis?.directions ?? [];
  const P = (zh: string, en: string) => ph(l, zh, en);
  const para = (...xs: string[]) => xs.filter(Boolean).join('\n\n');
  const cardsLine = (): string => n
    ? (l === 'en'
      ? `This paper draws on ${n} stud${n === 1 ? 'y' : 'ies'}${yp}${kws.length ? `; the most frequent keywords are ${joinL(kws.slice(0, 4), l)}` : ''}.`
      : `目前納入 ${n} 篇文獻${yp}${kws.length ? `；出現頻率最高的關鍵詞為${joinL(kws.slice(0, 4), l)}` : ''}。`)
    : (l === 'en' ? `No studies are linked yet ${P('', 'link evidence cards')}.` : `尚未連結文獻${P('連結證據文獻', '')}。`);

  switch (kind) {
    case 'intro': {
      const concepts = (topic?.concepts ?? []).map(g => g.concept);
      const p1 = l === 'en'
        ? `This paper concerns “${topicName}”. ${cardsLine().replace(/^This paper draws on/, 'It draws on')}${concepts.length ? ` The topic is decomposed into ${concepts.length} core concept${concepts.length === 1 ? '' : 's'}: ${joinL(concepts, l)}.` : ''}`
        : `本文以「${topicName}」為主題。${cardsLine()}${concepts.length ? `主題拆解為 ${concepts.length} 個核心概念：${joinL(concepts, l)}。` : ''}`;
      const p2 = gaps.length
        ? (l === 'en' ? `The existing literature leaves ${gaps.length} gap${gaps.length === 1 ? '' : 's'} open:` : `既有文獻在以下 ${gaps.length} 項仍有缺口：`) + '\n\n' + gapLines(topic, cards, l).join('\n')
        : P('研究缺口與問題陳述（尚未執行缺口分析）', 'research gap and problem statement (no gap analysis has been run)');
      const p3 = l === 'en'
        ? `The purpose of this paper is to ${P('', 'state the research purpose')}, and it asks ${P('', 'research questions')}.`
        : `本研究旨在${P('研究目的', '')}，並回答${P('研究問題', '')}。`;
      return para(p1, p2, p3);
    }
    case 'scope':
      return para(
        l === 'en' ? `The review covers ${n} stud${n === 1 ? 'y' : 'ies'}${yp}.` : `本回顧涵蓋 ${n} 篇文獻${yp}。`,
        l === 'en' ? `Inclusion and exclusion criteria: ${P('', 'document types, years, languages, and topic boundaries')}.` : `納入與排除標準：${P('文獻類型、年代、語言與議題範圍', '')}。`);
    case 'reviewMethod': {
      const oa = cards.filter(c => c.paper?.openalexId).length;
      return para(
        topic?.booleanQuery
          ? (l === 'en' ? `The search query was \`${topic.booleanQuery}\`.` : `檢索式為 \`${topic.booleanQuery}\`。`)
          : (l === 'en' ? `Search query: ${P('', 'Boolean query')}.` : `檢索式：${P('布林檢索式', '')}。`),
        oa ? (l === 'en' ? `${oa} of the ${n} records were retrieved through OpenAlex.` : `${n} 篇文獻中有 ${oa} 篇經由 OpenAlex 取得。`) : '',
        l === 'en' ? `Databases, search date, and screening procedure: ${P('', 'databases, search date, screening steps')}.` : `資料庫、檢索日期與篩選流程：${P('資料庫、檢索日期、篩選步驟', '')}。`);
    }
    case 'organization': {
      const names = inp.outline.filter(h => !/^(參考文獻|references)$/i.test(h));
      return names.length
        ? (l === 'en' ? `The paper proceeds as follows: ${joinL(names, l)}.` : `本文依序為：${joinL(names, l)}。`)
        : P('全文架構說明', 'organization of the paper');
    }
    case 'gapProblem':
    case 'gaps':
    case 'gapsParent': {
      const lines = gapLines(topic, cards, l, kind !== 'gapProblem');
      return para(
        gaps.length ? (l === 'en' ? `The analysis identified ${gaps.length} research gap${gaps.length === 1 ? '' : 's'}${n ? ` across ${n} studies` : ''}:` : `分析${n ? ` ${n} 篇文獻` : ''}後共辨識 ${gaps.length} 項研究缺口：`) : P('研究缺口（尚未執行缺口分析）', 'research gaps (no gap analysis has been run)'),
        lines.join('\n'),
        kind === 'gapsParent' && dirs.length ? dirs.map((d, i) => `${i + 1}. ${d}`).join('\n') : '',
        kind === 'gapProblem' ? (l === 'en' ? `Problem statement: ${P('', 'the problem this study addresses')}.` : `本研究欲解決的問題：${P('問題陳述', '')}。`) : '');
    }
    case 'agenda': {
      const sugg = gaps.map(g => g.suggestion).filter(Boolean);
      const all = [...new Set([...dirs, ...sugg])];
      return para(
        all.length ? (l === 'en' ? `Based on the identified gaps, the following directions are proposed:` : `依據已辨識的缺口，建議的研究方向如下：`) + '\n\n' + all.map((d, i) => `${i + 1}. ${d}`).join('\n') : P('未來研究方向（尚無缺口或方向資料）', 'future research directions (no gap or direction data yet)'),
        l === 'en' ? `Priorities and feasibility: ${P('', 'order these directions and explain feasibility')}.` : `優先順序與可行性：${P('排序並說明可行性', '')}。`);
    }
    case 'rq': {
      const list = gaps.length
        ? gaps.map((g, i) => (l === 'en' ? `RQ${i + 1}. Addressing the ${gapLabel(g.type, l)} gap (“${g.description}”): ${P('', 'state the research question')}` : `RQ${i + 1}. 針對${gapLabel(g.type, l)}缺口（「${g.description}」）：${P('研究問題', '')}`)).join('\n')
        : [1, 2].map(i => `RQ${i}. ${P('研究問題', 'research question')}`).join('\n');
      return para(l === 'en' ? 'The study poses the following research questions:' : '本研究提出以下研究問題：', list);
    }
    case 'method':
    case 'results': {
      const mc = methodCounts(cards).slice(0, 3);
      if (kind === 'method') {
        const ref = mc.length
          ? (l === 'en' ? `For reference, of the ${n} reviewed studies, ${joinL(mc.map(r => `${r.ids.length} mentioned ${r.m.en}`), l)}.` : `作為參考，已回顧的 ${n} 篇研究中，${mc.map(r => `有 ${r.ids.length} 篇提及${r.m.zh}`).join('，')}。`)
          : '';
        return para(
          l === 'en' ? `**Research design.** This study adopts ${P('', 'research design, e.g., survey, interviews, experiment')}. ${ref}` : `**研究設計。** 本研究採${P('研究設計，如問卷調查、訪談、實驗', '')}。${ref}`,
          l === 'en' ? `**Participants and sampling.** ${P('', 'population, sampling method, sample size, inclusion criteria')}.` : `**研究對象與抽樣。** ${P('研究對象與抽樣方式、樣本數、納入條件', '')}。`,
          l === 'en' ? `**Instruments.** ${P('', 'instruments or materials, with reliability and validity')}.` : `**研究工具。** ${P('研究工具或材料，及其信度與效度', '')}。`,
          l === 'en' ? `**Procedure.** ${P('', 'data collection procedure and time frame')}.` : `**資料蒐集程序。** ${P('資料蒐集流程與時間', '')}。`,
          l === 'en' ? `**Data analysis.** ${P('', 'analysis methods and software')}.` : `**資料分析。** ${P('分析方法與使用的軟體', '')}。`,
          l === 'en' ? `**Ethical considerations.** ${P('', 'ethics approval and informed consent')}.` : `**研究倫理。** ${P('倫理審查與知情同意', '')}。`);
      }
      return para(
        l === 'en' ? `**Overview of the data.** ${P('', 'sample size and basic characteristics')}.` : `**資料概述。** ${P('樣本數與基本特徵', '')}。`,
        (gaps.length ? gaps.map((_, i) => i) : [0, 1]).map(i => (l === 'en' ? `**Finding ${i + 1}.** ${P('', 'result for research question ' + (i + 1) + ', with statistics')}.` : `**發現${i + 1}。** ${P(`針對研究問題 ${i + 1} 的結果與統計數據`, '')}。`)).join('\n\n'),
        l === 'en' ? `**Tables and figures.** ${P('', 'tables or figures summarizing the results')}.` : `**表格與圖。** ${P('彙整結果的表格或圖', '')}。`);
    }
    case 'discussion': {
      const known = cards.slice(0, 6).map(c => c.id);
      return para(
        l === 'en' ? `**Summary of findings.** ${P('', 'summarize the main findings')}.` : `**主要發現摘要。** ${P('主要發現', '')}。`,
        n ? (l === 'en' ? `**Comparison with the literature.** The findings can be compared with ${n} linked stud${n === 1 ? 'y' : 'ies'} ${citeList(known, 6)}: ${P('', 'where results agree or differ')}.` : `**與文獻對照。** 本研究結果可與已連結的 ${n} 篇文獻 ${citeList(known, 6)} 對照：${P('一致或相異之處', '')}。`) : '',
        gaps.length ? (l === 'en' ? `**Research gaps.** ${gaps.length} gap${gaps.length === 1 ? ' was' : 's were'} identified in the literature (${joinL(gaps.map(g => gapLabel(g.type, l)), l)}); ${P('', 'state whether and how this study addresses them')}.` : `**研究缺口。** 文獻中辨識出 ${gaps.length} 項缺口（${joinL(gaps.map(g => gapLabel(g.type, l) + '缺口'), l)}）；${P('本研究是否及如何回應這些缺口', '')}。`) : '',
        l === 'en' ? `**Implications.** ${P('', 'theoretical and practical implications')}.` : `**理論與實務意涵。** ${P('理論與實務意涵', '')}。`,
        l === 'en' ? `**Limitations.** ${P('', 'limitations of this study')}.` : `**研究限制。** ${P('研究限制', '')}。`,
        dirs.length ? (l === 'en' ? `**Future directions.**\n\n` : `**未來研究方向。**\n\n`) + dirs.map((d, i) => `${i + 1}. ${d}`).join('\n') : '');
    }
    case 'conclusion':
      return para(
        n ? (l === 'en' ? `This paper reviewed ${n} stud${n === 1 ? 'y' : 'ies'}${yp}.${gaps.length ? ` It identified ${gaps.length} research gap${gaps.length === 1 ? '' : 's'} (${joinL(gaps.map(g => gapLabel(g.type, l)), l)}).` : ''}` : `本文整理 ${n} 篇文獻${yp}${gaps.length ? `，並辨識出 ${gaps.length} 項研究缺口（${joinL(gaps.map(g => gapLabel(g.type, l) + '缺口'), l)}）` : ''}。`) : cardsLine(),
        l === 'en' ? `Main conclusions: ${P('', 'state the main conclusions supported by this study')}.` : `主要結論：${P('依本研究實際結果撰寫主要結論', '')}。`,
        dirs.length ? (l === 'en' ? 'Future research may pursue the following directions:\n\n' : '未來研究可朝以下方向發展：\n\n') + dirs.map((d, i) => `${i + 1}. ${d}`).join('\n') : '',
        l === 'en' ? `Contributions: ${P('', 'contributions of this study')}.` : `貢獻：${P('本研究的學術與實務貢獻', '')}。`);
    case 'contribution':
      return para(
        gaps.length ? (l === 'en' ? `The study is expected to address ${gaps.length} identified gap${gaps.length === 1 ? '' : 's'}: ${joinL(gaps.map(g => gapLabel(g.type, l)), l)}.` : `預期回應文獻中已辨識的 ${gaps.length} 項缺口：${joinL(gaps.map(g => gapLabel(g.type, l) + '缺口'), l)}。`) : '',
        l === 'en' ? `**Academic contribution.** ${P('', 'academic contribution')}.` : `**學術貢獻。** ${P('學術貢獻', '')}。`,
        l === 'en' ? `**Practical contribution.** ${P('', 'practical contribution')}.` : `**實務貢獻。** ${P('實務貢獻', '')}。`);
    case 'timeline':
      return l === 'en'
        ? `| Stage | Work | Period |\n| --- | --- | --- |\n| 1 | Literature review and research design | ${P('', 'dates')} |\n| 2 | Data collection | ${P('', 'dates')} |\n| 3 | Data analysis | ${P('', 'dates')} |\n| 4 | Writing and revision | ${P('', 'dates')} |`
        : `| 階段 | 工作項目 | 預計時間 |\n| --- | --- | --- |\n| 1 | 文獻回顧與研究設計 | ${P('起訖時間', '')} |\n| 2 | 資料蒐集 | ${P('起訖時間', '')} |\n| 3 | 資料分析 | ${P('起訖時間', '')} |\n| 4 | 撰寫與修訂 | ${P('起訖時間', '')} |`;
    case 'cross': {
      const th = topic?.synthesis?.themes ?? [];
      const c = (s: string) => th.filter(t => t.status === s).length;
      return th.length
        ? para(l === 'en' ? `Across ${th.length} themes, ${c('convergent')} show convergent evidence (three or more agreeing sources), ${c('divergent')} show divergent evidence, and ${c('silent')} are thinly evidenced (fewer than two sources).` : `在 ${th.length} 個主題中，${c('convergent')} 個呈現共識（3 篇以上一致）、${c('divergent')} 個存在分歧、${c('silent')} 個證據不足（少於 2 篇）。`,
          P('跨主題的整體比較與詮釋', 'overall cross-theme comparison and interpretation'))
        : P('跨主題綜合（尚未執行主題綜合分析）', 'cross-theme synthesis (no theme synthesis has been run)');
    }
    case 'convergent':
    case 'divergent': {
      const want = kind === 'convergent' ? 'convergent' : 'divergent';
      const known = new Set(cards.map(x => x.id));
      const th = (topic?.synthesis?.themes ?? []).filter(t => t.status === want);
      if (!th.length) return l === 'en' ? `No ${want} themes were detected in the synthesis. ${P('', 'describe where sources agree or disagree')}` : `綜合分析中沒有${kind === 'convergent' ? '共識' : '分歧'}主題。${P('說明文獻一致或分歧之處', '')}`;
      const lines = th.map(t => {
        const ids = (t.cardIds ?? []).filter(id => known.has(id));
        return l === 'en' ? `- **${t.name}** (${(t.cardIds ?? []).length} sources)${t.summary ? ': ' + t.summary : ''}${ids.length ? ' ' + citeList(ids, 3) : ''}` : `- **${t.name}**（${(t.cardIds ?? []).length} 篇）${t.summary ? '：' + t.summary : ''}${ids.length ? ' ' + citeList(ids, 3) : ''}`;
      }).join('\n');
      return para(l === 'en' ? `${th.length} theme${th.length === 1 ? ' is' : 's are'} ${want}:` : `${th.length} 個主題${kind === 'convergent' ? '呈現共識' : '存在分歧'}：`, lines,
        kind === 'divergent' ? P('分歧的可能原因（樣本、方法、情境差異）', 'possible reasons for the divergence (sample, method, context)') : '');
    }
    case 'methodObs': {
      const mc = methodCounts(cards);
      const yc = new Map<number, number>();
      cards.forEach(x => { const y = x.paper?.year; if (y) yc.set(y, (yc.get(y) ?? 0) + 1); });
      return para(
        mc.length ? (l === 'en' ? `Of ${n} studies, ${joinL(mc.map(r => `${r.ids.length} mentioned ${r.m.en} ${citeList(r.ids, 3)}`), l)}.` : `${n} 篇研究中，${mc.map(r => `有 ${r.ids.length} 篇${citeList(r.ids, 3)}提及${r.m.zh}`).join('，')}。`) : (l === 'en' ? `No common method terms were detected in the ${n} linked records.` : `已連結的 ${n} 篇紀錄中未偵測到常見的研究方法用語。`),
        yc.size ? (l === 'en' ? `Publication years: ${[...yc.entries()].sort((a, b) => a[0] - b[0]).map(([y, k]) => `${y} (${k})`).join(', ')}.` : `發表年份分布：${[...yc.entries()].sort((a, b) => a[0] - b[0]).map(([y, k]) => `${y} 年 ${k} 篇`).join('、')}。`) : '',
        P('方法學上的限制與其對結論的影響', 'methodological limitations and their effect on conclusions'));
    }
    case 'abstract':
      return P('摘要將由「產生摘要」自動彙整', 'the abstract is assembled by “Generate abstract”');
    case 'lit':
    case 'theme':
    default:
      if (!n && kind === 'theme') {
        const g = inp.guidance?.split('\n')[0]?.trim();
        return l === 'en' ? `${P('', `write “${heading}”${g ? ' following the guidance: ' + g : ''}`)}` : P(`撰寫「${heading}」${g ? '，依本節指引：' + g : ''}`, '');
      }
      return litBody(inp, kind);
  }
}

async function loadTemplateInput(doc: PaperDoc, s: Section): Promise<{ inp: TemplateInput; allowed: Set<string> }> {
  const l = bodyLang(doc.language);
  const topic = doc.topicId ? await db.topics.get(doc.topicId) : undefined;
  let cards = (await db.cards.bulkGet(s.cardIds)).filter((c): c is Card => !!c);
  if (!cards.length && doc.topicId) {
    const kind = sectionKind(s.heading);
    if (!['abstract', 'organization', 'timeline', 'method', 'results', 'rq', 'contribution'].includes(kind)) {
      cards = (await db.cards.where('topicId').equals(doc.topicId).toArray()).filter(c => c.kind === 'paper');
    }
  }
  const title = l === 'en' ? (doc.front?.titleEn || doc.title) : (doc.front?.titleZh || doc.title);
  return {
    inp: { lang: l, pattern: doc.pattern, docTitle: title, heading: s.heading, guidance: s.guidance, outline: doc.sections.map(x => x.heading), cards, topic },
    allowed: new Set(cards.map(c => c.id)),
  };
}

export async function draftSection(doc: PaperDoc, sectionId: string, opts: { signal?: AbortSignal } = {}): Promise<string> {
  const s = findSection(doc.sections, sectionId);
  if (!s) throw new Error('找不到章節');
  const l = bodyLang(doc.language);
  if (!(await aiEnabled())) {
    if (sectionKind(s.heading) === 'abstract') return (await templateAbstract(doc, l)).abstract;
    const { inp, allowed } = await loadTemplateInput(doc, s);
    return sanitizeCitations(templateSection(inp), allowed, l);
  }
  const cards = (await db.cards.bulkGet(s.cardIds)).filter((c): c is Card => !!c);
  const outline = flatOutline(doc.sections);
  const title = l === 'en' ? (doc.front?.titleEn || doc.title) : (doc.front?.titleZh || doc.title);
  const evidence = cards.length ? cards.map((c, i) => cardBrief(c, i, l)).join('\n\n')
    : (l === 'en' ? '(No sources are linked to this section. Write only structural/framing prose and mark every claim needing evidence with [EVIDENCE NEEDED].)'
      : '（本節沒有連結任何文獻。請只寫架構性說明，並在需要證據處標註【待補證據】。）');
  const user = l === 'en'
    ? `Paper title: ${title}\nPaper type: ${doc.pattern}\nOutline:\n${outline}\n\nSection to write: ${s.heading}\nSection purpose: ${s.guidance ?? '(none)'}\nTarget length: about ${s.targetWords ?? 400} words\n\nProvided sources (the ONLY citable sources):\n${evidence}\n\nWrite the section body.`
    : `論文題目：${title}\n論文類型：${PATTERN_LABELS[doc.pattern]}\n全文大綱：\n${outline}\n\n要撰寫的章節：${s.heading}\n本節任務：${s.guidance ?? '（無）'}\n目標字數：約 ${s.targetWords ?? 400} 字\n\n提供的文獻（唯一可引用來源）：\n${evidence}\n\n請撰寫本節內文。`;
  const out = await chat([{ role: 'system', content: systemFor(l) }, { role: 'user', content: user }], { temperature: 0.4, signal: opts.signal });
  return sanitizeCitations(out.trim(), new Set(s.cardIds), l);
}

function flatOutline(sections: Section[]): string {
  const lines: string[] = [];
  walk(sections, (s, _p, d) => lines.push(`${'  '.repeat(d)}- ${s.heading}`));
  return lines.join('\n');
}

/** Draft every leaf section sequentially, persisting after each. Returns the updated doc. */
export async function generateAll(
  doc: PaperDoc,
  onProgress: (done: number, total: number, heading: string) => void,
  signal?: AbortSignal,
  opts: { overwrite?: boolean } = {},
): Promise<PaperDoc> {
  const leaves = leafSections(doc.sections).filter(l => opts.overwrite || !l.content.trim());
  let cur = doc;
  for (let i = 0; i < leaves.length; i++) {
    if (signal?.aborted) break;
    onProgress(i, leaves.length, leaves[i].heading);
    const text = await draftSection(cur, leaves[i].id, { signal });
    const latest = (await db.papers.get(doc.id)) ?? cur; // keep user edits made meanwhile
    const target = findSection(latest.sections, leaves[i].id);
    if (target) target.content = text;
    cur = { ...latest, updatedAt: Date.now() };
    await db.papers.put(cur);
  }
  if (!signal?.aborted) onProgress(leaves.length, leaves.length, '');
  return cur;
}

// ---------- abstract / keywords / translation ----------

function bodyText(doc: PaperDoc): string {
  const parts: string[] = [];
  walk(doc.sections, (s, _p, d) => { if (s.content.trim()) parts.push(`${'#'.repeat(d + 2)} ${s.heading}\n${stripCitations(s.content).replace(/【待補證據】|\[EVIDENCE NEEDED\]/g, '').replace(PLACEHOLDER_RE, '')}`); });
  return parts.join('\n\n').slice(0, 14000);
}

function truncateSentences(text: string, max: number): string {
  const sents = text.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [text];
  let out = '';
  for (const x of sents) { if (countWords(out + x) > max) break; out += x; }
  if (out.trim()) return out.trim();
  return text.split(/\s+/).slice(0, max).join(' ').replace(/[,;:]$/, '') + '.';
}

const isLatinKw = (k: string) => /[A-Za-z]/.test(k) && !/[㐀-鿿]/.test(k);
const hasCjk = (k: string) => /[㐀-鿿]/.test(k);

/** Keywords from topic concepts (+ synonyms in the target script) then card tags / concepts. 3-5 items when data allows. */
export function templateKeywords(lang: Lang, topic: Topic | undefined, cards: Card[]): string[] {
  const ok = (k: string) => (lang === 'en' ? isLatinKw(k) : true);
  const pref = (k: string) => (lang === 'en' ? isLatinKw(k) : hasCjk(k));
  const cand: string[] = [];
  for (const g of topic?.concepts ?? []) {
    const opts = [g.concept, ...g.synonyms].filter(Boolean);
    const hit = opts.find(pref) ?? opts.find(ok);
    if (hit) cand.push(hit);
  }
  const freq = new Map<string, { label: string; n: number }>();
  cards.forEach(c => [...(c.paper?.concepts ?? []), ...c.tags].forEach(k => {
    const key = k.trim().toLowerCase(); if (!key || key.length > 40 || !ok(k)) return;
    const e = freq.get(key); if (e) e.n++; else freq.set(key, { label: k.trim(), n: 1 });
  }));
  cand.push(...[...freq.values()].sort((a, b) => b.n - a.n).map(x => x.label));
  const seen = new Set<string>();
  return cand.filter(k => { const key = k.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true; }).slice(0, 5);
}

/** First citation-free, placeholder-free sentence of a section's content. */
function firstCleanSentence(text: string): string {
  for (const line of text.split(/\n+/).map(x => x.trim()).filter(Boolean)) {
    if (/^[*|\-`#>]|^\d+[.)]/.test(line)) continue;
    const f = splitSentences(line).find(s => !hasMark(s) && s.length >= 12 && /[.。!?！？]$/.test(s));
    if (f) return f;
  }
  return '';
}

export interface AbstractInput { doc: PaperDoc; lang: Lang; cards: Card[]; topic?: Topic }

/** Template abstract (no AI): front matter + first sentences of drafted sections; English built from English metadata when the body is Chinese. */
export function buildTemplateAbstract({ doc, lang, cards, topic }: AbstractInput): { abstract: string; keywords: string[] } {
  const papers = cards.filter(c => c.paper);
  const n = papers.length;
  const yp = yearPhrase(papers, lang);
  const gaps = topic?.synthesis?.gaps ?? [];
  const keywords = templateKeywords(lang, topic, papers);
  const body = bodyLang(doc.language);
  const out: string[] = [];
  if (lang === body) {
    const title = lang === 'en' ? (doc.front?.titleEn || doc.title) : (doc.front?.titleZh || doc.title);
    out.push(lang === 'en' ? `This paper, “${title}”, draws on ${n} stud${n === 1 ? 'y' : 'ies'}${yp}.` : `本文以「${title}」為題，納入 ${n} 篇文獻${yp}。`);
    const sents: string[] = [];
    walk(doc.sections, (s, _p, _d) => {
      if (['abstract', 'intro', 'scope', 'reviewMethod', 'organization', 'convergent', 'divergent', 'methodObs', 'rq', 'contribution', 'timeline', 'agenda', 'gaps', 'gapProblem', 'gapsParent', 'conclusion'].includes(sectionKind(s.heading)) || /^(參考文獻|references)$/i.test(s.heading.trim())) return;
      const f = firstCleanSentence(s.content);
      if (f && !out.includes(f) && !sents.includes(f)) sents.push(f);
    });
    out.push(...sents.slice(0, 4).map(x => cap(x, 260)));
    if (gaps.length) out.push(lang === 'en' ? `The analysis identified ${gaps.length} research gap${gaps.length === 1 ? '' : 's'} (${joinL(gaps.map(g => gapLabel(g.type, lang)), lang)}).` : `分析辨識出 ${gaps.length} 項研究缺口（${joinL(gaps.map(g => gapLabel(g.type, lang) + '缺口'), lang)}）。`);
    out.push(lang === 'en' ? ph(lang, '', 'research purpose, method, and main findings') + '.' : ph(lang, '研究目的、方法與主要發現，請依實際研究補寫', ''));
    return { abstract: lang === 'en' ? truncateSentences(out.join(' '), 250) : out.join(''), keywords };
  }
  // English abstract for a Chinese-bodied document: English metadata only
  const enTitle = doc.front?.titleEn?.trim();
  out.push(`This paper addresses ${enTitle ? `“${enTitle}”` : ph(lang, '', 'English title')}.`);
  if (n) out.push(`It draws on ${n} stud${n === 1 ? 'y' : 'ies'}${yp}.`);
  if (keywords.length) out.push(`Frequent keywords in the reviewed literature include ${joinL(keywords.slice(0, 4), 'en')}.`);
  if (gaps.length) out.push(`The analysis identified ${gaps.length} research gap${gaps.length === 1 ? '' : 's'} (${joinL(gaps.map(g => gapLabel(g.type, 'en')), 'en')}).`);
  out.push(ph(lang, '', 'research purpose and method, translated from the Chinese abstract') + '.');
  out.push(ph(lang, '', 'main findings, translated from the Chinese abstract') + '.');
  return { abstract: truncateSentences(out.join(' '), 250), keywords };
}

async function templateAbstract(doc: PaperDoc, lang: Lang): Promise<{ abstract: string; keywords: string[] }> {
  const topic = doc.topicId ? await db.topics.get(doc.topicId) : undefined;
  let cards = await loadCards(doc);
  if (!cards.length && doc.topicId) cards = (await db.cards.where('topicId').equals(doc.topicId).toArray()).filter(c => c.kind === 'paper');
  return buildTemplateAbstract({ doc, lang, cards, topic });
}

/** Generate an abstract + 3-5 keywords from the drafted sections (AI when a key is set, else template). */
export async function generateAbstract(doc: PaperDoc, lang: Lang, opts: { signal?: AbortSignal } = {}): Promise<{ abstract: string; keywords: string[] }> {
  if (!(await aiEnabled())) return templateAbstract(doc, lang);
  const body = bodyText(doc);
  if (!body.trim()) throw new Error('請先撰寫內文章節，再產生摘要');
  const sys = lang === 'en'
    ? 'You write formal academic abstracts. Use only content present in the provided text; never add facts, numbers, or citations. Return JSON: {"abstract": string, "keywords": string[]}. The abstract is a single paragraph of at most 250 words in formal academic English, third person, no citations, no contractions, covering purpose, method (if any), main findings or arguments, and implications. Provide 3 to 5 keywords in lowercase except proper nouns.'
    : '你負責撰寫正式學術摘要。只能使用提供內容中已有的資訊，不得新增事實、數據或引用。回傳 JSON：{"abstract": string, "keywords": string[]}。摘要為單一段落，約 300 至 500 字，使用正式學術中文（書面語、第三人稱、全形標點、不含引用），涵蓋研究目的、方法（如有）、主要發現或論點與意涵。關鍵詞 3 至 5 個。';
  const r = await chatJSON<{ abstract: string; keywords: string[] }>([
    { role: 'system', content: sys },
    { role: 'user', content: `${lang === 'en' ? 'Title' : '題目'}：${lang === 'en' ? (doc.front?.titleEn || doc.title) : (doc.front?.titleZh || doc.title)}\n\n${body}` },
  ], { temperature: 0.2, signal: opts.signal });
  let abstract = String(r.abstract ?? '').trim();
  if (lang === 'en' && countWords(abstract) > 250) {
    try {
      const c = await chat([
        { role: 'system', content: 'Condense the abstract to at most 230 words, keeping formal academic English, third person, a single paragraph, and adding nothing new. Output only the abstract.' },
        { role: 'user', content: abstract },
      ], { temperature: 0.1, signal: opts.signal });
      if (c.trim()) abstract = c.trim();
    } catch (e) { if ((e as Error)?.name === 'AbortError') throw e; }
    if (countWords(abstract) > 250) abstract = truncateSentences(abstract, 250);
  }
  return { abstract, keywords: (r.keywords ?? []).map(k => String(k).trim()).filter(Boolean).slice(0, 5) };
}

/** Translate markdown zh<->en preserving [@id] tokens, headings and Markdown structure. */
export async function translateText(text: string, to: Lang, opts: { signal?: AbortSignal } = {}): Promise<string> {
  if (!text.trim()) return text;
  const sys = to === 'en'
    ? 'Translate the Chinese academic text into the most formal academic English (third person, no contractions, hedged claims). Preserve Markdown structure and every citation token EXACTLY (ids unchanged): [@abc123], [@id1; @id2], bare @abc123, and [see @abc123] (the prefix word may be translated, e.g., 見 <-> see); translate 【待補證據】 as [EVIDENCE NEEDED]. Do not add or remove content. Output only the translation.'
    : '將下列英文學術文字翻譯為正式學術中文（書面語、第三人稱、全形標點）。完整保留 Markdown 結構與所有引用標記（如 [@abc123]、[@id1; @id2]、獨立的 @abc123、[見 @abc123]），id 一字不改（前綴詞可互譯，如 見 <-> see）；[EVIDENCE NEEDED] 譯為【待補證據】。不得增刪內容。只輸出譯文。';
  const out = await chat([{ role: 'system', content: sys }, { role: 'user', content: text }], { temperature: 0.1, signal: opts.signal });
  const want = new Set(citationIds(text)); const got = new Set(citationIds(out));
  if ([...want].some(w => !got.has(w))) throw new Error('翻譯後引用標記遺失，已放棄套用以避免錯誤引用；請重試');
  return out.trim();
}

// ---------- export ----------

/** Export view: moves a body 摘要/Abstract section into front matter (if missing) and drops it from the body. */
export function exportView(doc: PaperDoc): PaperDoc {
  const front: FrontMatter = { ...(doc.front ?? { authors: [] }) };
  const sections = doc.sections.filter(sc => {
    const h = sc.heading.trim();
    const zh = h === '摘要'; const en = /^abstract$/i.test(h);
    if (!zh && !en) return true;
    const txt = stripCitations(sc.content).replace(/【待補證據】|\[EVIDENCE NEEDED\]/g, '').trim();
    if (zh && !front.abstractZh?.trim() && txt) front.abstractZh = txt;
    if (en && !front.abstractEn?.trim() && txt) front.abstractEn = txt;
    return false;
  });
  return { ...doc, front, sections };
}

export function ctxFor(doc: PaperDoc, cards: Card[], lang?: Lang): CitationContext {
  return buildContext(doc.sections, cards, docStyle(doc), lang ?? bodyLang(doc.language));
}

export function refHeading(doc: PaperDoc): string {
  return heading('參考文獻', docLang(doc) === 'en' ? 'en' : 'zh-TW');
}

function frontMarkdown(doc: PaperDoc, out: string[]) {
  const f: FrontMatter | undefined = doc.front;
  const l = docLang(doc);
  const zhTitle = f?.titleZh || doc.title; const enTitle = f?.titleEn || doc.title;
  out.push(`# ${l === 'en' ? enTitle : zhTitle}`, '');
  if (f?.authors?.length) out.push(f.authors.join(l === 'en' ? ', ' : '、'), '');
  if (f?.affiliation) out.push(f.affiliation, '');
  const kw = (k?: string[], zh?: boolean) => (k?.length ? `**${zh ? '關鍵詞' : 'Keywords'}**${zh ? '：' : ': '}${k.join(zh ? '、' : ', ')}` : '');
  if (l !== 'en' && f?.abstractZh) out.push('## 摘要', '', f.abstractZh, '', kw(f.keywordsZh, true), '');
  if (l !== 'zh-TW' && f?.abstractEn) {
    if (l === 'bilingual') out.push(`# ${enTitle}`, '');
    out.push('## Abstract', '', f.abstractEn, '', kw(f.keywordsEn), '');
  }
}

export function toMarkdown(rawDoc: PaperDoc, cards: Card[] = []): string {
  const doc = exportView(rawDoc);
  const l = bodyLang(doc.language);
  const ctx = ctxFor(doc, cards, l);
  const out: string[] = [];
  frontMarkdown(doc, out);
  const render = (list: Section[], prefix: number[]) => {
    list.forEach((s, i) => {
      const num = [...prefix, i + 1];
      out.push(`${'#'.repeat(Math.min(num.length + 1, 6))} ${num.join('.')} ${s.heading}`, '');
      if (s.content.trim()) out.push(renderCitations(s.content.trim(), ctx), '');
      render(s.children, num);
    });
  };
  render(doc.sections, []);
  if (ctx.refs.length) out.push(`## ${refHeading(doc)}`, '', ...ctx.refs.map(c => `- ${segMarkdown(formatReference(c, ctx.style, l, ctx.numbering.get(c.id)))}`), '');
  return out.join('\n');
}

/** Load cards for a doc and render markdown. */
export async function loadCards(doc: PaperDoc): Promise<Card[]> {
  return (await db.cards.bulkGet(allCardIds(doc.sections))).filter((c): c is Card => !!c);
}
export async function docToMarkdown(doc: PaperDoc): Promise<string> {
  return toMarkdown(doc, await loadCards(doc));
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** Print-ready HTML following APA-style rules (TNR / PMingLiU, double spacing, hanging-indent references). */
export function toPrintHtml(rawDoc: PaperDoc, cards: Card[], renderMd: (md: string) => string, paper: 'A4' | 'Letter' = 'A4'): string {
  const doc = exportView(rawDoc);
  const lang = docLang(doc); const l = bodyLang(lang);
  const ctx = ctxFor(doc, cards, l); const f = doc.front;
  const zhTitle = f?.titleZh || doc.title; const enTitle = f?.titleEn || doc.title;
  const kwLine = (k: string[] | undefined, zh: boolean) => (k?.length ? `<p class="kw"><i>${zh ? '關鍵詞' : 'Keywords'}</i>${zh ? '：' : ': '}${esc(k.join(zh ? '、' : ', '))}</p>` : '');
  const titlePage = (t: string, zh: boolean) => `<div class="titlepage"><p class="ttl">${esc(t)}</p>${f?.authors?.length ? `<p class="c">${esc(f.authors.join(zh ? '、' : ', '))}</p>` : ''}${[f?.affiliation, f?.course, f?.instructor, f?.date].filter(Boolean).map(x => `<p class="c">${esc(x!)}</p>`).join('')}</div>`;
  let h = '';
  h += titlePage(lang === 'en' ? enTitle : zhTitle, lang !== 'en');
  if (lang !== 'en' && f?.abstractZh) h += `<div class="pb"><p class="h1">摘要</p><p class="noind">${esc(f.abstractZh)}</p>${kwLine(f.keywordsZh, true)}</div>`;
  if (lang !== 'zh-TW' && f?.abstractEn) h += `<div class="pb">${lang === 'bilingual' ? `<p class="ttl">${esc(enTitle)}</p>` : ''}<p class="h1">Abstract</p><p class="noind">${esc(f.abstractEn)}</p>${kwLine(f.keywordsEn, false)}</div>`;
  h += `<div class="pb"><p class="ttl">${esc(l === 'en' ? enTitle : zhTitle)}</p>`;
  const body = (list: Section[], depth: number) => list.forEach(s => {
    const lvl = Math.min(depth + 1, 5);
    h += `<p class="h${lvl}">${esc(s.heading)}${lvl >= 4 ? '.' : ''}</p>`;
    if (s.content.trim()) h += `<div class="md">${renderMd(renderCitations(s.content.trim(), ctx))}</div>`;
    body(s.children, depth + 1);
  });
  body(doc.sections, 0);
  h += '</div>';
  if (ctx.refs.length) h += `<div class="pb"><p class="h1">${esc(refHeading(doc))}</p>${ctx.refs.map(c => `<p class="ref">${formatReference(c, ctx.style, l, ctx.numbering.get(c.id)).map(sg => (sg.i ? `<i>${esc(sg.t)}</i>` : esc(sg.t))).join('')}</p>`).join('')}</div>`;
  const css = `@page{size:${paper};margin:2.54cm}
body{font-family:"Times New Roman","PMingLiU","新細明體",serif;font-size:12pt;line-height:2;color:#000;max-width:16cm;margin:0 auto;padding:0 12px}
p{margin:0}.c{text-align:center}.ttl{text-align:center;font-weight:bold}.titlepage{padding-top:30vh}.titlepage .ttl{margin-bottom:2em}
.h1{text-align:center;font-weight:bold}.h2{font-weight:bold}.h3{font-weight:bold;font-style:italic}.h4{font-weight:bold;margin-left:1.27cm}.h5{font-weight:bold;font-style:italic;margin-left:1.27cm}
.md p{text-indent:1.27cm;margin:0}.md li{margin:0}.noind{text-indent:0}.kw{text-indent:1.27cm}
.ref{padding-left:1.27cm;text-indent:-1.27cm}.pb{break-before:page}.titlepage{break-after:auto}
.md table{border-collapse:collapse;line-height:1.5}.md td,.md th{border:1px solid #000;padding:2px 6px}`;
  return `<!doctype html><html lang="${l === 'en' ? 'en' : 'zh-TW'}"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>${css}</style></head><body>${h}</body></html>`;
}

export function newDoc(title: string, pattern: PaperPattern, sections: Section[], topicId?: string, language: PaperLanguage = 'zh-TW', citationStyle: CitationStyle = 'apa7'): PaperDoc {
  const now = Date.now();
  return { id: uid(), topicId, title, pattern, language, citationStyle, front: { authors: [] }, sections, createdAt: now, updatedAt: now };
}

export { formatReference, segText };
