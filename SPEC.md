# PaperRead — 研究筆記 PWA 規格

Local-first PWA (React 19 + Vite + TypeScript + Dexie/IndexedDB). Works offline on phone and desktop.
UI language: 繁體中文. Mobile-first: everything must work at 375px width with touch.

## Shared contracts (DO NOT modify these files unless told to)
- `src/types.ts` — data model (Card, Topic, Relation, Gap, Synthesis, PaperDoc, Section, Settings).
- `src/db.ts` — Dexie db, `uid()`, `addCard()`, `updateCard()`, `getSettings()`.
- `src/lib/llm.ts` — `chat()`, `chatJSON<T>()` against OpenAI-compatible endpoint; throws `LLMNotConfigured`.
- `src/App.tsx` — shell; views are default exports from `src/views/{Board,Research,PaperEditor,Settings}.tsx`;
  global `src/components/QuickCapture.tsx`. Call `navigate(tab)` from `src/App.tsx` to switch tabs.
- `src/index.css` — design tokens + primitives (`.page .page-title .btn .btn-primary .btn-sm .input .textarea
  .select .panel .row .muted .tag .error .modal-backdrop .modal`). Use CSS variables only; put module CSS in
  its own file imported by the module, with class names prefixed by the module (e.g. `.board-`, `.rs-`, `.pe-`).
- Reactive reads: `useLiveQuery` from `dexie-react-hooks`.
- Every AI feature must degrade gracefully: if `LLMNotConfigured` is thrown, show a friendly message with a
  button `navigate('settings')`; non-AI parts keep working.

## Research methodology (adapted from academic research practice)
1. **Topic → keywords**: decompose the topic into 2–4 core concepts, each with synonyms incl. English and
   Chinese equivalents; build Boolean query `("A" OR "A1") AND ("B" OR "B1")`. Without LLM, fall back to
   splitting the query and using OpenAlex concepts of top results.
2. **Search layers**: (a) keyword search, (b) backward chaining — references cited by several core papers,
   (c) forward tracking — papers citing the core papers, (d) related works. Hit-count heuristic:
   <20 results → relax (drop a concept / use OR), >500 → tighten.
3. **Relations between papers**: `cites` (direct reference), `coupled` (bibliographic coupling = share
   references, weight = Jaccard of reference sets), `co-cited`, `similar` (concept/title-term Jaccard), and
   LLM-judged `supports`/`contradicts` with an explanation for candidate pairs (pairs sharing a sub-topic or
   construct). Coupling is a signal for inclusion, never exclusion.
4. **Synthesis**: build a source × theme matrix; mark each theme `convergent` (3+ sources agree),
   `divergent` (sources disagree), `silent` (<2 sources → potential gap).
5. **Gaps** — five types, each with evidence card ids, implication, and a suggested direction:
   empirical (no data on population/context), methodological (only one method type),
   theoretical (no framework explains the pattern), temporal (evidence outdated), geographic (only some regions).
   Also compute cheap non-LLM signals: year histogram (temporal), concept coverage (silent themes).

## Paper patterns (structure editor templates)
- `thematic-review`: 1 Introduction (Topic & Rationale, Scope, Review Method, Organization) / 2..N Themes
  (from synthesis) / Cross-cutting Synthesis (Convergent, Divergent, Methodological) / Research Gaps &
  Future Directions (Identified Gaps, Proposed Agenda) / Conclusion. ~8000 words.
- `imrad`: Abstract / Introduction / Literature Review / Method / Results / Discussion / Conclusion. ~6000 words.
- `proposal`: Background / Problem & Gap / Research Questions / Literature / Method / Expected Contribution / Timeline.
Each section: guidance text, targetWords, linked evidence cards, markdown content. Never fabricate citations:
generated text may only cite cards linked to the section, formatted (Author, Year).

## External APIs (all CORS-enabled, no key)
- OpenAlex `https://api.openalex.org/works?search=...&per-page=50` (add `mailto=` from settings if set).
  Abstracts come as `abstract_inverted_index` → reconstruct. Filters: `cites:Wxxx`, `cited_by:Wxxx`,
  `ids.openalex`, `related_to:Wxxx`. Batch fetch: `filter=openalex:W1|W2|...` (≤50).
- arXiv is optional; OpenAlex covers it.

## Capture & sync
- QuickCapture floating button (always visible above mobile tab bar): text + voice (Web Speech API,
  `webkitSpeechRecognition`, lang from settings, interim results, continuous). Saves to inbox.
- Google Keep: (1) import Google Takeout zip / folder of Keep `.json` → cards kind 'keep' (title, textContent,
  listContent → checklist markdown, labels → tags, timestamps). Dedupe by title+created time.
  (2) Web Share Target (GET, params title/text/url) so on Android, Keep "Send" → PaperRead creates a card.
  (3) Card → "copy for Keep" (plain text to clipboard) and `navigator.share` on mobile.
- Backup: export all tables to JSON file; import (merge by id, newer updatedAt wins). Optional: share the
  backup file via `navigator.share({files})` so users can save to Google Drive from phone.
