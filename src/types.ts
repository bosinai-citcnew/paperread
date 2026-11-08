// Shared data model. All modules import from here. Do not change shapes without updating SPEC.md.

export type CardKind = 'note' | 'paper' | 'gap' | 'idea' | 'quote' | 'keep' | 'voice';

/** A knowledge card — the atomic unit. Papers are cards with kind 'paper' + paper meta. */
export interface Card {
  id: string;
  kind: CardKind;
  title: string;
  body: string;            // markdown
  tags: string[];
  topicId?: string;        // research topic this card belongs to
  columnId: string;        // board column (see Column); 'inbox' by default
  order: number;           // sort order inside column (float, use midpoint insertion)
  paper?: PaperMeta;
  source?: string;         // 'keep' | 'voice' | 'share' | 'openalex' | ...
  pinned?: boolean;
  reading?: ReadingNotes;  // close-reading (精讀) notes for paper cards
  createdAt: number;
  updatedAt: number;
}

export interface PaperMeta {
  openalexId?: string;     // e.g. 'W2741809807'
  doi?: string;
  arxivId?: string;
  authors: string[];
  year?: number;
  venue?: string;
  abstract?: string;
  citedByCount?: number;
  referencedWorks?: string[]; // OpenAlex ids of references
  concepts?: string[];        // keywords / concepts
  url?: string;
  pdfUrl?: string;
  relevance?: number;         // 0..1 score vs topic
}

export type KeyPointKind =
  | 'question' | 'method' | 'sample' | 'finding' | 'limitation' | 'contribution' | 'quote' | 'note';

/** One key point (重點) extracted from a paper; addressable as `cardId#kpId`. */
export interface KeyPoint {
  id: string;              // short id, e.g. 'kp3f9a'
  kind: KeyPointKind;
  text: string;            // the point in the user's language
  quote?: string;          // verbatim source sentence it is based on
  page?: number;
  ai?: boolean;            // extracted by AI (unverified until user confirms)
  confirmed?: boolean;
  createdAt: number;
}

export interface ReadingNotes {
  status: 'unread' | 'reading' | 'done';
  summary?: string;        // one-paragraph summary
  keyPoints: KeyPoint[];
  progress?: number;       // 0..1 scroll position in full text
  updatedAt: number;
}

/** Full text stored separately (can be large). */
export interface FullText {
  cardId: string;
  source: 'pdf-upload' | 'oa-pdf' | 'paste' | 'abstract';
  paragraphs: { text: string; page?: number; heading?: boolean }[];
  fetchedAt: number;
}

export interface Column {
  id: string;
  name: string;
  order: number;
}

/** A research topic: user query -> expanded keywords -> papers -> relations -> gaps. */
export interface Topic {
  id: string;
  name: string;            // user's original query
  concepts: ConceptGroup[];// expanded keywords (2-4 core concepts with synonyms)
  booleanQuery?: string;
  createdAt: number;
  updatedAt: number;
  synthesis?: Synthesis;
}

export interface ConceptGroup {
  concept: string;
  synonyms: string[];      // include English + Chinese equivalents
}

export type RelationType =
  | 'cites'            // A references B
  | 'co-cited'         // both cited by same papers
  | 'coupled'          // share references (bibliographic coupling)
  | 'similar'          // keyword/text similarity
  | 'supports'
  | 'contradicts';

export interface Relation {
  id: string;
  topicId?: string;
  from: string;            // card id
  to: string;              // card id
  type: RelationType;
  weight: number;          // 0..1
  note?: string;           // explanation (esp. supports/contradicts from LLM)
  fromPoint?: string;      // key point id on `from` card this relation is about
  toPoint?: string;        // key point id on `to` card
  manual?: boolean;        // user-created link
}

export type GapType = 'empirical' | 'methodological' | 'theoretical' | 'temporal' | 'geographic';

export interface Gap {
  type: GapType;
  description: string;
  evidence: string[];      // card ids that reveal the gap
  implication: string;
  suggestion: string;      // proposed research direction
}

export interface Theme {
  name: string;
  summary: string;
  cardIds: string[];
  status: 'convergent' | 'divergent' | 'silent'; // 3+ agree / disagree / <2 sources
}

/** Real counts behind a bibliometric (non-AI) gap analysis. */
export interface SynthesisStats {
  total?: number;                                   // works matching the topic query in OpenAlex
  years?: { year: number; count: number }[];        // OpenAlex group_by publication_year
  countries?: { code: string; count: number }[];    // OpenAlex group_by country_code (papers with ≥1 institution there)
  types?: { type: string; count: number }[];        // OpenAlex group_by type
  methods?: { key: string; label: string; count: number }[]; // local abstract scan
  methodBase?: number;                              // number of collected papers with abstracts
  theoryShare?: number;                             // 0..1 of those mentioning theory/framework
  populations?: { label: string; count: number }[]; // local abstract scan
}

export interface Synthesis {
  themes: Theme[];
  gaps: Gap[];
  directions: string[];
  generatedAt: number;
  /** 'bibliometric' = computed from real counts, no AI; 'ai' = LLM synthesis. */
  source?: 'bibliometric' | 'ai';
  stats?: SynthesisStats;
}

/** Structured paper document: a tree of sections. */
export interface PaperDoc {
  id: string;
  topicId?: string;
  title: string;
  pattern: PaperPattern;
  language?: PaperLanguage;        // default 'zh-TW'
  citationStyle?: CitationStyle;   // default 'apa7'
  front?: FrontMatter;
  sections: Section[];
  createdAt: number;
  updatedAt: number;
}

export type PaperPattern = 'thematic-review' | 'imrad' | 'proposal';

export type PaperLanguage = 'zh-TW' | 'en' | 'bilingual'; // bilingual = Chinese body + English title/abstract/keywords
export type CitationStyle = 'apa7' | 'ieee' | 'chicago-ad';

/** Title page + abstract metadata (APA 7 student/professional paper elements). */
export interface FrontMatter {
  titleZh?: string;
  titleEn?: string;
  authors: string[];
  affiliation?: string;
  course?: string;          // student paper: course / instructor / due date
  instructor?: string;
  date?: string;
  runningHead?: string;     // professional paper running head (≤50 chars, EN uppercase)
  abstractZh?: string;
  abstractEn?: string;
  keywordsZh?: string[];
  keywordsEn?: string[];
  authorNote?: string;
  pageSize?: 'A4' | 'Letter';
  professional?: boolean;   // professional-paper running head
}

export interface Section {
  id: string;
  heading: string;
  guidance?: string;       // what this section should do
  targetWords?: number;
  content: string;         // markdown
  cardIds: string[];       // evidence cards linked to this section
  children: Section[];
}

export interface Settings {
  id: 'settings';
  llmBaseUrl: string;      // OpenAI-compatible, e.g. https://api.deepseek.com/v1
  llmApiKey: string;
  llmModel: string;
  openalexEmail?: string;  // polite pool (optional, legacy)
  openalexApiKey?: string; // free key from openalex.org/settings/api ($1/day budget vs $0.10 shared without)
  language: 'zh-TW' | 'en';
  voiceLang: string;       // e.g. 'zh-TW'
}
