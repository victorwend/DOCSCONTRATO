/**
 * Leitura e preenchimento de campos em partes WordprocessingML (document.xml, header*.xml, footer*.xml).
 *
 * Princípio: o XML é editado no lugar. Só o conteúdo dos elementos <w:t> que contêm um campo é
 * reescrito; parágrafos, runs, propriedades (fonte, cor, destaque), tabelas e seções ficam
 * exatamente como no arquivo original.
 */

export interface TextSegment {
  /** posição do conteúdo (entre <w:t ...> e </w:t>) no XML */
  start: number;
  end: number;
  /** posição da tag de abertura <w:t ...> (ou <w:t/>) */
  tagStart: number;
  tagEnd: number;
  selfClosing: boolean;
  text: string;
  runIndex: number;
  /** posição do texto deste segmento dentro do parágrafo */
  offset: number;
}

export interface RunInfo {
  index: number;
  rPrStart: number | null;
  rPrEnd: number | null;
  marking: Marking | null;
}

export interface Marking {
  kind: 'highlight' | 'shading' | 'color';
  value: string;
}

export interface CellRef {
  table: number;
  row: number;
  /** coluna na grade da tabela (considera células mescladas horizontalmente) */
  col: number;
}

export interface Paragraph {
  index: number;
  text: string;
  segments: TextSegment[];
  cell: CellRef | null;
}

export interface ParsedPart {
  xml: string;
  paragraphs: Paragraph[];
  runs: RunInfo[];
}

const ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

export function decodeXml(s: string): string {
  return s.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITY[e];
  });
}

export function encodeXml(s: string): string {
  // remove caracteres de controle inválidos em XML 1.0
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag) ?? new RegExp(`\\s${name}\\s*=\\s*'([^']*)'`).exec(tag);
  return m ? m[1] : null;
}

const NEUTRAL_COLORS = new Set(['auto', '000000', 'FFFFFF', 'none']);

export function markingOf(rPr: string): Marking | null {
  const hl = /<w:highlight\b[^>]*>/.exec(rPr);
  if (hl) {
    const v = attr(hl[0], 'w:val');
    if (v && v !== 'none') return { kind: 'highlight', value: v };
  }
  const shd = /<w:shd\b[^>]*>/.exec(rPr);
  if (shd) {
    const fill = (attr(shd[0], 'w:fill') ?? '').toUpperCase();
    if (fill && !NEUTRAL_COLORS.has(fill) && fill !== 'AUTO') return { kind: 'shading', value: fill };
  }
  const color = /<w:color\b[^>]*>/.exec(rPr);
  if (color) {
    const v = (attr(color[0], 'w:val') ?? '').toUpperCase();
    if (v && !NEUTRAL_COLORS.has(v) && v !== 'AUTO' && !isNearBlack(v)) return { kind: 'color', value: v };
  }
  return null;
}

function isNearBlack(hex: string) {
  if (!/^[0-9A-F]{6}$/.test(hex)) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return r < 60 && g < 60 && b < 60;
}

/**
 * Varre o XML com um tokenizador simples (sem DOM): suficiente para WordprocessingML,
 * que não usa DTD nem entidades externas.
 */
export function parsePart(xml: string): ParsedPart {
  const paragraphs: Paragraph[] = [];
  const runs: RunInfo[] = [];
  const pStack: Paragraph[] = [];
  const rStack: RunInfo[] = [];
  // pilha de nomes de elementos, para saber se <w:rPr> e <w:t> são filhos diretos de <w:r>
  const stack: string[] = [];
  const tables: Array<{ id: number; row: number; col: number; cell: CellRef | null }> = [];
  let tableCount = 0;

  let i = 0;
  const n = xml.length;
  while (i < n) {
    const lt = xml.indexOf('<', i);
    if (lt < 0) break;
    if (xml.startsWith('<!--', lt)) {
      const e = xml.indexOf('-->', lt + 4);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml.startsWith('<![CDATA[', lt)) {
      const e = xml.indexOf(']]>', lt + 9);
      i = e < 0 ? n : e + 3;
      continue;
    }
    if (xml[lt + 1] === '?' || xml[lt + 1] === '!') {
      const e = xml.indexOf('>', lt + 1);
      i = e < 0 ? n : e + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt);
    const tag = xml.slice(lt, gt + 1);
    i = gt + 1;

    if (tag[1] === '/') {
      const name = tag.slice(2, -1).trim();
      // fecha até o elemento correspondente (tolerante a XML levemente malformado)
      const idx = stack.lastIndexOf(name);
      if (idx >= 0) stack.length = idx;
      if (name === 'w:p') pStack.pop();
      else if (name === 'w:r') rStack.pop();
      else if (name === 'w:tbl') tables.pop();
      else if (name === 'w:tc' && tables.length) tables[tables.length - 1].cell = null;
      continue;
    }

    const selfClosing = tag.endsWith('/>');
    const name = /^<([^\s/>]+)/.exec(tag)![1];
    const parent = stack[stack.length - 1];

    if (name === 'w:tbl' && !selfClosing) {
      tables.push({ id: tableCount++, row: -1, col: 0, cell: null });
    } else if (name === 'w:tr' && !selfClosing && tables.length) {
      const t = tables[tables.length - 1];
      t.row++;
      t.col = 0;
    } else if (name === 'w:tc' && !selfClosing && tables.length) {
      const t = tables[tables.length - 1];
      t.cell = { table: t.id, row: t.row, col: t.col };
      t.col += 1;
    } else if (name === 'w:gridSpan' && tables.length && parent === 'w:tcPr') {
      const span = Number(attr(tag, 'w:val') ?? 1);
      if (span > 1) tables[tables.length - 1].col += span - 1;
    }
    if (name === 'w:p' && !selfClosing) {
      const t = tables[tables.length - 1];
      const p: Paragraph = { index: paragraphs.length, text: '', segments: [], cell: t?.cell ? { ...t.cell } : null };
      paragraphs.push(p);
      pStack.push(p);
    } else if (name === 'w:r' && !selfClosing) {
      const r: RunInfo = { index: runs.length, rPrStart: null, rPrEnd: null, marking: null };
      runs.push(r);
      rStack.push(r);
    } else if (name === 'w:rPr' && parent === 'w:r' && rStack.length) {
      const r = rStack[rStack.length - 1];
      if (selfClosing) {
        r.rPrStart = lt;
        r.rPrEnd = gt + 1;
      } else {
        const close = xml.indexOf('</w:rPr>', gt);
        r.rPrStart = lt;
        r.rPrEnd = close < 0 ? gt + 1 : close + '</w:rPr>'.length;
        r.marking = markingOf(xml.slice(r.rPrStart, r.rPrEnd));
      }
    } else if (name === 'w:t' && parent === 'w:r' && rStack.length && pStack.length) {
      const p = pStack[pStack.length - 1];
      const r = rStack[rStack.length - 1];
      if (selfClosing) {
        p.segments.push({ start: gt + 1, end: gt + 1, tagStart: lt, tagEnd: gt + 1, selfClosing: true, text: '', runIndex: r.index, offset: p.text.length });
      } else {
        const close = xml.indexOf('</w:t>', gt);
        if (close < 0) throw new Error('XML do documento corrompido (<w:t> sem fechamento)');
        const text = decodeXml(xml.slice(gt + 1, close));
        p.segments.push({ start: gt + 1, end: close, tagStart: lt, tagEnd: gt + 1, selfClosing: false, text, runIndex: r.index, offset: p.text.length });
        p.text += text;
        i = close + '</w:t>'.length;
        continue; // o </w:t> já foi consumido
      }
    }
    if (!selfClosing) stack.push(name);
  }
  return { xml, paragraphs, runs };
}

function findTagEnd(xml: string, lt: number): number {
  let q: string | null = null;
  for (let j = lt + 1; j < xml.length; j++) {
    const c = xml[j];
    if (q) {
      if (c === q) q = null;
    } else if (c === '"' || c === "'") q = c;
    else if (c === '>') return j;
  }
  throw new Error('XML do documento corrompido (tag sem fechamento)');
}

// ---------------------------------------------------------------------------
// Edição
// ---------------------------------------------------------------------------

export interface Replacement {
  paragraph: number;
  /** intervalo [start, end) no texto do parágrafo */
  start: number;
  end: number;
  value: string;
}

export interface ApplyOptions {
  /** remove destaque/sombreamento/cor de marcação dos runs que receberam dados */
  removeMarking?: boolean;
}

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Aplica substituições no XML preservando todo o restante. */
export function applyReplacements(part: ParsedPart, replacements: Replacement[], opts: ApplyOptions = {}): string {
  const byParagraph = new Map<number, Replacement[]>();
  for (const r of replacements) {
    if (!byParagraph.has(r.paragraph)) byParagraph.set(r.paragraph, []);
    byParagraph.get(r.paragraph)!.push(r);
  }
  const edits: Edit[] = [];
  const touchedRuns = new Set<number>();

  for (const [pIndex, reps] of byParagraph) {
    const p = part.paragraphs[pIndex];
    if (!p) throw new Error(`Parágrafo ${pIndex} inexistente`);
    const segTexts = p.segments.map((s) => s.text);
    const changed = new Set<number>();
    // da direita para a esquerda: as posições à esquerda continuam válidas
    const sorted = [...reps].sort((a, b) => b.start - a.start);
    let lastStart = Infinity;
    for (const r of sorted) {
      if (r.end > lastStart) throw new Error('Campos sobrepostos no mesmo parágrafo');
      lastStart = r.start;
      const overlapping = p.segments
        .map((s, k) => ({ s, k }))
        .filter(({ s }) => s.offset < r.end && s.offset + s.text.length > r.start);
      if (!overlapping.length) continue;
      overlapping.forEach(({ s, k }, idx) => {
        const a = Math.max(r.start, s.offset) - s.offset;
        const b = Math.min(r.end, s.offset + s.text.length) - s.offset;
        const cur = segTexts[k];
        segTexts[k] = cur.slice(0, a) + (idx === 0 ? r.value : '') + cur.slice(b);
        changed.add(k);
        if (r.value) touchedRuns.add(s.runIndex);
      });
    }
    for (const k of changed) {
      const s = p.segments[k];
      const text = segTexts[k];
      const needsPreserve = /^\s|\s$|\s\s/.test(text);
      const tag = part.xml.slice(s.tagStart, s.tagEnd);
      if (s.selfClosing) {
        edits.push({ start: s.tagStart, end: s.tagEnd, text: `<w:t${needsPreserve ? ' xml:space="preserve"' : ''}>${encodeXml(text)}</w:t>` });
      } else {
        if (needsPreserve && !/xml:space\s*=/.test(tag)) {
          edits.push({ start: s.tagStart, end: s.tagEnd, text: tag.replace(/^<w:t\b/, '<w:t xml:space="preserve"') });
        }
        edits.push({ start: s.start, end: s.end, text: encodeXml(text) });
      }
    }
  }

  if (opts.removeMarking) {
    for (const ri of touchedRuns) {
      const r = part.runs[ri];
      if (!r?.marking || r.rPrStart === null || r.rPrEnd === null) continue;
      const rPr = part.xml.slice(r.rPrStart, r.rPrEnd);
      let out = rPr.replace(/<w:highlight\b[^>]*\/>/g, '');
      if (r.marking.kind === 'shading') out = out.replace(/<w:shd\b[^>]*\/>/g, '');
      if (r.marking.kind === 'color') out = out.replace(/<w:color\b[^>]*\/>/g, '');
      if (out !== rPr) edits.push({ start: r.rPrStart, end: r.rPrEnd, text: out });
    }
  }

  edits.sort((a, b) => b.start - a.start);
  let xml = part.xml;
  let guard = Infinity;
  for (const e of edits) {
    if (e.end > guard) throw new Error('Edições sobrepostas no XML');
    guard = e.start;
    xml = xml.slice(0, e.start) + e.text + xml.slice(e.end);
  }
  return xml;
}

/** Marcação predominante de um intervalo do parágrafo (null se nenhum caractere estiver marcado). */
export function markingInRange(part: ParsedPart, p: Paragraph, start: number, end: number): Marking | null {
  for (const s of p.segments) {
    if (s.offset < end && s.offset + s.text.length > start) {
      const m = part.runs[s.runIndex]?.marking;
      if (m) return m;
    }
  }
  return null;
}

/** Para cada caractere do parágrafo, a marcação do run (ou null). */
export function charMarkings(part: ParsedPart, p: Paragraph): Array<Marking | null> {
  const out: Array<Marking | null> = new Array(p.text.length).fill(null);
  for (const s of p.segments) {
    const m = part.runs[s.runIndex]?.marking ?? null;
    for (let k = 0; k < s.text.length; k++) out[s.offset + k] = m;
  }
  return out;
}
