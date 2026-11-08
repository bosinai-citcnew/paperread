import {
  AlignmentType, Document, Footer, Header, HeadingLevel, Packer, PageNumber, Paragraph, TabStopType, TextRun,
} from 'docx';
import { saveAs } from 'file-saver';
import type { Card, PaperDoc, Section } from '../types';
import { bodyLang, formatReference, renderCitations } from './citation';
import { ctxFor, docLang, exportView, refHeading } from './paperGen';

export interface DocxOptions { paper?: 'A4' | 'Letter'; professional?: boolean }

const FONT = { ascii: 'Times New Roman', hAnsi: 'Times New Roman', cs: 'Times New Roman', eastAsia: 'PMingLiU' };
const SIZE = 24; // 12pt
const INDENT = 720; // 0.5in
const DOUBLE = { line: 480, lineRule: 'auto' as const, before: 0, after: 0 };

interface RunOpts { bold?: boolean; italics?: boolean }
const run = (text: string, o: RunOpts = {}) => new TextRun({ text, font: FONT, size: SIZE, color: '000000', bold: o.bold, italics: o.italics });

/** Inline markdown (**bold**, *italic*, `code`) -> runs. */
function inlineRuns(text: string, base: RunOpts = {}): TextRun[] {
  const out: TextRun[] = [];
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|_[^_\n]+_|`[^`]+`)/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(run(text.slice(last, m.index), base));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(run(tok.slice(2, -2), { ...base, bold: true }));
    else if (tok.startsWith('`')) out.push(run(tok.slice(1, -1), base));
    else out.push(run(tok.slice(1, -1), { ...base, italics: true }));
    last = m.index! + tok.length;
  }
  if (last < text.length) out.push(run(text.slice(last), base));
  return out;
}

const body = (children: TextRun[], extra: Record<string, unknown> = {}) =>
  new Paragraph({ children, spacing: DOUBLE, indent: { firstLine: INDENT }, ...extra });

/** APA heading by level 1..5. */
function apaHeading(text: string, level: number): Paragraph {
  const l = Math.min(Math.max(level, 1), 5);
  const hl = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5][l - 1];
  const o: RunOpts = { bold: true, italics: l === 3 || l === 5 };
  return new Paragraph({
    heading: hl, spacing: DOUBLE, keepNext: true,
    alignment: l === 1 ? AlignmentType.CENTER : AlignmentType.LEFT,
    indent: l >= 4 ? { left: INDENT } : undefined,
    children: [run(l >= 4 && !/[.。]$/.test(text) ? text + '.' : text, o)],
  });
}

/** Markdown section content -> paragraphs. Sub-headings (###) continue the APA level below `baseLevel`. */
function mdParagraphs(md: string, baseLevel: number): Paragraph[] {
  const out: Paragraph[] = [];
  const blocks = md.replace(/\r/g, '').split(/\n{2,}/);
  for (const raw of blocks) {
    const lines = raw.split('\n').filter(l => l.trim());
    if (!lines.length) continue;
    let buf: string[] = [];
    const flush = () => { if (buf.length) { out.push(body(inlineRuns(buf.join(' ').trim()))); buf = []; } };
    for (const line of lines) {
      const h = /^(#{1,6})\s+(.*)$/.exec(line);
      const li = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
      if (h) { flush(); out.push(apaHeading(h[2].replace(/[*_`]/g, ''), Math.min(baseLevel + Math.max(h[1].length - 2, 1) , 5))); }
      else if (li) {
        flush();
        const num = /^\s*(\d+)[.)]/.exec(line);
        out.push(new Paragraph({ spacing: DOUBLE, indent: { left: INDENT * 2, hanging: 360 }, children: [run((num ? num[1] + '.' : '•') + '\t'), ...inlineRuns(li[1])], tabStops: [{ type: TabStopType.LEFT, position: INDENT * 2 }] }));
      } else if (/^>\s?/.test(line)) { flush(); out.push(new Paragraph({ spacing: DOUBLE, indent: { left: INDENT }, children: inlineRuns(line.replace(/^>\s?/, '')) })); }
      else buf.push(line.trim());
    }
    flush();
  }
  return out;
}

const centered = (text: string, o: RunOpts = {}, extra: Record<string, unknown> = {}) =>
  new Paragraph({ alignment: AlignmentType.CENTER, spacing: DOUBLE, children: [run(text, o)], ...extra });

export function buildDocx(rawDoc: PaperDoc, cards: Card[], opts: DocxOptions = {}): Document {
  const doc = exportView(rawDoc);
  const paper = opts.paper ?? doc.front?.pageSize ?? 'A4';
  const lang = docLang(doc); const bl = bodyLang(lang);
  const ctx = ctxFor(doc, cards, bl);
  const f = doc.front;
  const zhTitle = f?.titleZh || doc.title; const enTitle = f?.titleEn || doc.title;
  const page = paper === 'A4' ? { width: 11906, height: 16838 } : { width: 12240, height: 15840 };
  const textWidth = page.width - 2880;

  const kids: Paragraph[] = [];
  const titlePage = (title: string, zh: boolean) => {
    kids.push(new Paragraph({ spacing: { ...DOUBLE, before: 0 }, children: [] }));
    for (let i = 0; i < 3; i++) kids.push(new Paragraph({ spacing: DOUBLE, children: [] }));
    kids.push(centered(title, { bold: true }));
    kids.push(new Paragraph({ spacing: DOUBLE, children: [] }));
    if (f?.authors?.length) kids.push(centered(f.authors.join(zh ? '、' : ', ')));
    for (const x of [f?.affiliation, f?.course, f?.instructor, f?.date]) if (x) kids.push(centered(x));
    if (f?.authorNote) { kids.push(new Paragraph({ spacing: DOUBLE, children: [] })); kids.push(centered('Author Note', { bold: true })); kids.push(body(inlineRuns(f.authorNote))); }
  };
  const abstractPage = (title: string | null, label: string, text: string, kwLabel: string, kws: string[] | undefined, zh: boolean) => {
    kids.push(centered(label, { bold: true }, { pageBreakBefore: true }));
    if (title) { /* title shown above label for the English abstract page in bilingual docs */ }
    kids.push(new Paragraph({ spacing: DOUBLE, children: inlineRuns(text.replace(/\n+/g, ' ')) }));
    if (kws?.length) kids.push(new Paragraph({ spacing: DOUBLE, indent: { firstLine: INDENT }, children: [run(kwLabel, { italics: true }), run(kws.join(zh ? '、' : ', '))] }));
  };

  titlePage(lang === 'en' ? enTitle : zhTitle, lang !== 'en');
  if (lang !== 'en' && f?.abstractZh) abstractPage(null, '摘要', f.abstractZh, '關鍵詞：', f.keywordsZh, true);
  if (lang !== 'zh-TW' && f?.abstractEn) {
    if (lang === 'bilingual') {
      kids.push(centered(enTitle, { bold: true }, { pageBreakBefore: true }));
      kids.push(centered('Abstract', { bold: true }));
      kids.push(new Paragraph({ spacing: DOUBLE, children: inlineRuns(f.abstractEn.replace(/\n+/g, ' ')) }));
      if (f.keywordsEn?.length) kids.push(new Paragraph({ spacing: DOUBLE, indent: { firstLine: INDENT }, children: [run('Keywords: ', { italics: true }), run(f.keywordsEn.join(', '))] }));
    } else abstractPage(null, 'Abstract', f.abstractEn, 'Keywords: ', f.keywordsEn, false);
  }

  // body
  kids.push(centered(bl === 'en' ? enTitle : zhTitle, { bold: true }, { pageBreakBefore: true }));
  const walkSecs = (list: Section[], depth: number) => list.forEach(s => {
    kids.push(apaHeading(s.heading, depth + 1));
    if (s.content.trim()) kids.push(...mdParagraphs(renderCitations(s.content.trim(), ctx), depth + 1));
    walkSecs(s.children, depth + 1);
  });
  walkSecs(doc.sections, 0);

  // references
  if (ctx.refs.length) {
    kids.push(centered(refHeading(doc), { bold: true }, { pageBreakBefore: true, heading: HeadingLevel.HEADING_1 }));
    for (const c of ctx.refs) {
      kids.push(new Paragraph({
        spacing: DOUBLE, indent: { left: INDENT, hanging: INDENT }, alignment: AlignmentType.LEFT,
        children: formatReference(c, ctx.style, bl, ctx.numbering.get(c.id)).map(sg => run(sg.t, { italics: sg.i })),
      }));
    }
  }

  const rh = (f?.runningHead || (f?.titleEn || doc.title)).slice(0, 50).toUpperCase();
  const headerKids = (opts.professional ?? doc.front?.professional)
    ? [new Paragraph({ tabStops: [{ type: TabStopType.RIGHT, position: textWidth }], children: [run(rh), run('\t'), new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE })] })]
    : [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ children: [PageNumber.CURRENT], font: FONT, size: SIZE })] })];

  const hStyle = (id: string, name: string, o: { bold: boolean; italics: boolean }) => ({
    id, name, basedOn: 'Normal', next: 'Normal', quickFormat: true,
    run: { font: FONT, size: SIZE, color: '000000', bold: o.bold, italics: o.italics },
    paragraph: { spacing: DOUBLE },
  });

  return new Document({
    creator: f?.authors?.[0] ?? 'PaperRead', title: doc.title,
    styles: {
      default: { document: { run: { font: FONT, size: SIZE }, paragraph: { spacing: DOUBLE } } },
      paragraphStyles: [
        hStyle('Heading1', 'heading 1', { bold: true, italics: false }), hStyle('Heading2', 'heading 2', { bold: true, italics: false }),
        hStyle('Heading3', 'heading 3', { bold: true, italics: true }), hStyle('Heading4', 'heading 4', { bold: true, italics: false }),
        hStyle('Heading5', 'heading 5', { bold: true, italics: true }),
      ],
    },
    sections: [{
      properties: { page: { size: page, margin: { top: 1440, bottom: 1440, left: 1440, right: 1440 } } },
      headers: { default: new Header({ children: headerKids }) },
      footers: { default: new Footer({ children: [new Paragraph({ children: [] })] }) },
      children: kids,
    }],
  });
}

export const docxFileName = (doc: PaperDoc) => `${(doc.title || 'paper').replace(/[\\/:*?"<>|]/g, '_')}.docx`;

export async function exportDocx(doc: PaperDoc, cards: Card[], opts: DocxOptions = {}) {
  const blob = await Packer.toBlob(buildDocx(doc, cards, opts));
  saveAs(blob, docxFileName(doc));
}
