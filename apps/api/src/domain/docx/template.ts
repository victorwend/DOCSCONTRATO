import { ZipArchive, ZipError } from './zip';
import { applyReplacements, charMarkings, Marking, parsePart, ParsedPart, Replacement } from './ooxml';
import { formatValue, FieldFormat } from './format';

/**
 * Modelo de contrato (.docx): detecção dos campos e preenchimento.
 *
 * Um "slot" é um trecho do documento que pode receber um dado: "XXXX", "xxx", "____", "(   )",
 * textos-guia como "(Nº DA OBRA)" ou um texto destacado. Cada slot é ligado a um campo
 * (field) pelo RH; o mesmo campo pode aparecer em vários slots (todas as ocorrências).
 */

export type SlotType = 'PLACEHOLDER' | 'CHECKBOX' | 'GUIDE' | 'MARKED_TEXT';
export type SlotAction = 'FIELD' | 'KEEP' | 'CLEAR';

export interface DetectedSlot {
  id: string;
  part: string;
  paragraph: number;
  start: number;
  end: number;
  text: string;
  type: SlotType;
  marked: boolean;
  marking: string | null;
  before: string;
  after: string;
  /** rótulo sugerido (ex.: "CPF", "Razão social") */
  label: string;
}

export interface SlotConfig {
  id: string;
  action: SlotAction;
  field?: string | null;
}

export type FieldType = 'TEXT' | 'LONGTEXT' | 'DATE' | 'MONEY' | 'NUMBER' | 'CHECK';

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  required: boolean;
  group?: string | null;
  help?: string | null;
  /** origem do pré-preenchimento (ex.: "applicant.name", "answers.valor_locacao") */
  source?: string | null;
  format?: FieldFormat | null;
}

export class TemplateError extends Error {}

const MAX_DOCX_BYTES = 15 * 1024 * 1024;

export function contentParts(zip: ZipArchive): string[] {
  const names = zip.names();
  const body = names.filter((n) => n === 'word/document.xml');
  const hf = names.filter((n) => /^word\/(header|footer)\d*\.xml$/.test(n)).sort();
  const notes = names.filter((n) => n === 'word/footnotes.xml' || n === 'word/endnotes.xml');
  return [...hf.filter((n) => n.includes('header')), ...body, ...notes, ...hf.filter((n) => n.includes('footer'))];
}

export function openDocx(buffer: Buffer): ZipArchive {
  if (buffer.length > MAX_DOCX_BYTES) throw new TemplateError('Arquivo maior que 15 MB.');
  if (buffer.length < 4 || buffer.readUInt32LE(0) !== 0x04034b50) {
    if (buffer.subarray(0, 8).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))) {
      throw new TemplateError('Este é um arquivo .doc (Word 97-2003). Abra no Word e use "Salvar como → Documento do Word (.docx)".');
    }
    throw new TemplateError('O arquivo não é um documento do Word (.docx).');
  }
  let zip: ZipArchive;
  try {
    zip = ZipArchive.read(buffer);
  } catch (e) {
    throw new TemplateError(e instanceof ZipError ? e.message : 'Arquivo .docx corrompido.');
  }
  if (!zip.has('word/document.xml')) throw new TemplateError('O arquivo não contém um documento do Word (word/document.xml).');
  if (zip.has('word/vbaProject.bin')) throw new TemplateError('Arquivos com macros não são aceitos.');
  return zip;
}

// ---------------------------------------------------------------------------
// Detecção
// ---------------------------------------------------------------------------

interface Token {
  start: number;
  end: number;
  type: SlotType;
}

const TOKEN_RE = new RegExp(
  [
    String.raw`\(\s*[xX]?\s*\)`, // (   ) ( x )
    String.raw`\[\s*[xX]?\s*\]`, // [ ] [x]
    String.raw`[Xx]{2,}`, // XXXX xxx Xxx
    String.raw`_{3,}`, // ______
    String.raw`\.{3,}|…+`, // ...... (linhas pontilhadas)
    String.raw`\bFULANO\b`,
  ].join('|'),
  'g',
);

// texto-guia entre parênteses: (Nº DA OBRA), (NOME DO REPRESENTANTE LEGAL (OU PREPOSTO)), (descrição do imóvel)
const GUIDE_RE = /\((?:[^()]|\([^()]*\))+\)/g;
const GUIDE_HINT = /\b(NOME|DIA|M[ÊE]S|ANO|N[ºo°]|CNPJ|CPF|DATA|OBRA|CONTRATO|REPRESENTANTE|descri[çc][ãa]o|locador|locat[áa]rio)\b/i;

function findTokens(text: string, marks: Array<Marking | null>): Token[] {
  const tokens: Token[] = [];
  const taken = new Array<boolean>(text.length).fill(false);
  const add = (start: number, end: number, type: SlotType) => {
    for (let k = start; k < end; k++) if (taken[k]) return;
    for (let k = start; k < end; k++) taken[k] = true;
    tokens.push({ start, end, type });
  };
  for (const m of text.matchAll(TOKEN_RE)) {
    const s = m.index!;
    const t = m[0];
    const type: SlotType = /^[([]/.test(t) ? 'CHECKBOX' : 'PLACEHOLDER';
    add(s, s + t.length, type);
  }
  for (const m of text.matchAll(GUIDE_RE)) {
    const s = m.index!;
    const e = s + m[0].length;
    const inner = m[0].slice(1, -1).trim();
    if (!inner || /^[xX\s]*$/.test(inner)) continue;
    const marked = marks.slice(s, e).some(Boolean);
    const upperish = inner === inner.toUpperCase() || GUIDE_HINT.test(inner);
    if ((marked && upperish) || (!marked && GUIDE_HINT.test(inner) && inner === inner.toUpperCase())) {
      // não engole marcadores que estão dentro do parênteses (ex.: "(XXXX)" já é PLACEHOLDER)
      if (taken.slice(s, e).some(Boolean)) continue;
      add(s, e, 'GUIDE');
    }
  }
  // parágrafo cujo único conteúdo destacado é "-" (campo vazio de PF/PJ não aplicável)
  const trimmed = text.trim();
  if (trimmed === '-' && marks.some(Boolean)) {
    const s = text.indexOf('-');
    add(s, s + 1, 'PLACEHOLDER');
  }
  // textos destacados restantes
  let k = 0;
  while (k < text.length) {
    if (marks[k] && !taken[k]) {
      let e = k;
      while (e < text.length && marks[e] && !taken[e]) e++;
      let s0 = k;
      let e0 = e;
      while (s0 < e0 && /\s/.test(text[s0])) s0++;
      while (e0 > s0 && /\s/.test(text[e0 - 1])) e0--;
      const piece = text.slice(s0, e0);
      if (/[0-9A-Za-zÀ-ÿ]/.test(piece)) add(s0, e0, 'MARKED_TEXT');
      k = e;
    } else k++;
  }
  return tokens.sort((a, b) => a.start - b.start);
}

function compact(s: string) {
  return s.replace(/\s+/g, ' ');
}

function suggestLabel(before: string, afterFull: string, afterCut: string, type: SlotType, fallback: string): string {
  if (type === 'CHECKBOX') {
    const opt = afterCut.split(/\s{2,}|[([]/)[0].replace(/\s+/g, ' ').trim().replace(/^[:\-–\s]+/, '');
    const words = opt.split(/\s+/).slice(0, 6).join(' ');
    return words.replace(/[:;,.)]+$/, '') || 'Opção';
  }
  // "XXX (Nº DA OBRA)": o texto-guia logo depois do marcador é o melhor rótulo
  const guide = /^\s*\(([^()]{2,60})\)/.exec(afterFull);
  if (guide && !/^[xX\s]*$/.test(guide[1])) return capitalize(guide[1].trim());
  let b = compact(before).replace(/[\s:–\-/(]+$/, '').trim();
  if (b.replace(/R\$/g, '').replace(/[^A-Za-zÀ-ÿ]/g, '').length < 2) return fallback;
  if (b.includes(':')) {
    const tail = b.slice(b.lastIndexOf(':') + 1).trim();
    const head = b.slice(0, b.lastIndexOf(':')).trim();
    b = /[A-Za-zÀ-ÿ]{2,}/.test(tail.replace(/R\$/g, '')) ? tail : head;
  }
  const parts = b.split(/[;|•]|(?<=[a-zà-ú)])\.\s/);
  let label = (parts[parts.length - 1] ?? '').trim();
  const words = label.split(/\s+/);
  if (words.length > 5) label = words.slice(-5).join(' ');
  label = label.replace(/^[,.;:)\s]+/, '').slice(0, 60);
  return label.length >= 2 ? label : fallback;
}

function capitalize(s: string) {
  const l = s.toLocaleLowerCase('pt-BR');
  return l.charAt(0).toLocaleUpperCase('pt-BR') + l.slice(1);
}

export function detectSlots(zip: ZipArchive): DetectedSlot[] {
  const slots: DetectedSlot[] = [];
  for (const partName of contentParts(zip)) {
    const xml = zip.getText(partName);
    if (!xml) continue;
    const part = parsePart(xml);
    // texto de cada célula de tabela (para usar o cabeçalho da coluna como rótulo)
    const cellText = new Map<string, string>();
    for (const p of part.paragraphs) {
      if (!p.cell) continue;
      const k = `${p.cell.table}:${p.cell.row}:${p.cell.col}`;
      cellText.set(k, [cellText.get(k), p.text].filter(Boolean).join(' '));
    }
    const headerAbove = (p: (typeof part.paragraphs)[number]) => {
      if (!p.cell) return null;
      for (let r = p.cell.row - 1; r >= 0 && r >= p.cell.row - 3; r--) {
        const t = cellText.get(`${p.cell.table}:${r}:${p.cell.col}`);
        if (t && /[A-Za-zÀ-ÿ]{2,}/.test(t.replace(/[Xx]{2,}/g, ''))) return t;
      }
      return null;
    };
    let prevText = '';
    for (const p of part.paragraphs) {
      if (!p.text) continue;
      const marks = charMarkings(part, p);
      const tokens = findTokens(p.text, marks);
      // rótulos: só marcadores e caixas de seleção delimitam (textos destacados podem ser o próprio rótulo)
      const bounds = tokens.filter((t) => t.type === 'PLACEHOLDER' || t.type === 'CHECKBOX');
      const cellStart = p.cell ? cellText.get(`${p.cell.table}:${p.cell.row}:${p.cell.col}`) ?? '' : '';
      const ownCellHasLabel = /[A-Za-zÀ-ÿ]{2,}/.test(cellStart.replace(/[Xx]{2,}|\(\s*[xX]?\s*\)/g, ''));
      const above = !ownCellHasLabel ? headerAbove(p) : null;
      let lastLabel = (above ? compact(above).trim() : '') || compact(prevText).replace(/[\s:–\-]+$/, '').trim().split(/\s+/).slice(-5).join(' ') || 'Campo';
      for (const t of tokens) {
        const m = marks.slice(t.start, t.end).find(Boolean) ?? null;
        const bi = bounds.indexOf(t);
        const prevEnd = bi > 0 ? bounds[bi - 1].end : 0;
        const nextStart = bi >= 0 && bi < bounds.length - 1 ? bounds[bi + 1].start : p.text.length;
        const afterFull = p.text.slice(t.end, t.end + 60);
        let label: string;
        if (t.type === 'MARKED_TEXT' || t.type === 'GUIDE') label = compact(p.text.slice(t.start, t.end)).slice(0, 60);
        else {
          const fb = bi > 0 ? `${lastLabel} (2)` : lastLabel;
          label = suggestLabel(p.text.slice(prevEnd, t.start), afterFull, p.text.slice(t.end, nextStart), t.type, fb);
          lastLabel = label;
        }
        slots.push({
          id: `${partName.replace(/^word\//, '').replace(/\.xml$/, '')}:${p.index}:${t.start}`,
          part: partName,
          paragraph: p.index,
          start: t.start,
          end: t.end,
          text: p.text.slice(t.start, t.end),
          type: t.type,
          marked: !!m,
          marking: m ? `${m.kind}:${m.value}` : null,
          before: p.text.slice(Math.max(0, t.start - 90), t.start),
          after: afterFull,
          label,
        });
      }
      if (p.text.trim()) prevText = p.text.slice(-120);
    }
  }
  return slots;
}

/** Marcação predominante entre os slots marcados (ex.: "highlight:yellow"). */
export function dominantMarking(slots: DetectedSlot[]): string | null {
  const count = new Map<string, number>();
  for (const s of slots) if (s.marking && s.type !== 'MARKED_TEXT') count.set(s.marking, (count.get(s.marking) ?? 0) + 1);
  let best: string | null = null;
  let max = 0;
  for (const [k, v] of count) if (v > max) [best, max] = [k, v];
  return best;
}

// ---------------------------------------------------------------------------
// Configuração inicial sugerida
// ---------------------------------------------------------------------------

export function slugKey(label: string): string {
  const s = label
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\bn[o]?\s*[º°]|\bn\.(?=\s)/g, 'numero')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
  return /^[a-z]/.test(s) ? s : `campo_${s || 'x'}`;
}

function guessType(label: string, slot: DetectedSlot): FieldType {
  if (slot.type === 'CHECKBOX') return 'CHECK';
  const l = label.toLowerCase();
  if (/\b(data|in[íi]cio|t[ée]rmino|nascimento|validade)\b/.test(l)) return 'DATE';
  if (/\b(valor|pre[çc]o|r\$)\b/.test(l)) return 'MONEY';
  return 'TEXT';
}

/**
 * Sugere campos e ações para os slots detectados:
 * - marcadores destacados → um campo cada (o RH junta os que são o mesmo dado);
 * - marcadores sem destaque → ignorados (KEEP), listados para o RH decidir;
 * - textos destacados e textos-guia → mantidos (KEEP).
 * Slots idênticos (mesmo texto e mesmo contexto, ex.: cabeçalho repetido) recebem o mesmo campo.
 */
export function suggestConfig(slots: DetectedSlot[]): { fields: FieldDef[]; slots: SlotConfig[] } {
  const fields: FieldDef[] = [];
  const used = new Set<string>();
  const byContext = new Map<string, string>();
  const configs: SlotConfig[] = [];
  // o corpo do documento sem nenhum marcador destacado (ex.: só o nº do contrato no cabeçalho está em cor):
  // todos os marcadores do corpo viram candidatos
  const isFillable = (s: DetectedSlot) => s.type === 'PLACEHOLDER' || s.type === 'CHECKBOX';
  const bodyMarked = slots.some((s) => s.part === 'word/document.xml' && s.marked && isFillable(s));
  const otherMarked = slots.some((s) => s.part !== 'word/document.xml' && s.marked && isFillable(s));

  for (const s of slots) {
    const anyMarked = s.part === 'word/document.xml' ? bodyMarked : otherMarked || bodyMarked;
    const active = isFillable(s) && (s.marked || !anyMarked) && !/^_+$/.test(s.text) && !/^(\.{3,}|…+)$/.test(s.text);
    if (!active) {
      configs.push({ id: s.id, action: 'KEEP', field: null });
      continue;
    }
    // cópias do mesmo cabeçalho/rodapé (primeira página, páginas pares...) recebem o mesmo campo
    const ctx = s.part === 'word/document.xml' ? null : `${s.type}|${compact(s.before)}|${s.text}|${compact(s.after)}`;
    let key = ctx ? byContext.get(ctx) : undefined;
    if (!key) {
      const base = slugKey(s.label);
      key = base;
      let n = 2;
      while (used.has(key)) key = `${base}_${n++}`;
      used.add(key);
      if (ctx) byContext.set(ctx, key);
      fields.push({ key, label: s.label, type: guessType(s.label, s), required: s.type !== 'CHECKBOX', group: null, source: null, format: null });
    }
    configs.push({ id: s.id, action: 'FIELD', field: key });
  }
  return { fields, slots: configs };
}

// ---------------------------------------------------------------------------
// Preenchimento
// ---------------------------------------------------------------------------

export interface FillResult {
  buffer: Buffer;
  filled: number;
  /** campos obrigatórios sem valor */
  missing: FieldDef[];
  /** slots ligados a um campo que ficou sem valor (marcador mantido) */
  keptSlots: string[];
  /** slots configurados que não existem mais no arquivo */
  staleSlots: string[];
}

export function checkboxText(original: string, checked: boolean): string {
  const open = original[0];
  const close = original[original.length - 1];
  const inner = Math.max(1, original.length - 2);
  if (!checked) return open + ' '.repeat(inner) + close;
  const left = Math.floor((inner - 1) / 2);
  return open + ' '.repeat(left) + 'X' + ' '.repeat(inner - 1 - left) + close;
}

export function isTruthy(v: unknown) {
  return v === true || v === 'true' || v === 'X' || v === 'x' || v === 'SIM' || v === 'sim' || v === 1 || v === '1';
}

export function isEmptyValue(v: unknown) {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

export function fillTemplate(
  buffer: Buffer,
  config: { fields: FieldDef[]; slots: SlotConfig[]; removeMarking?: boolean },
  values: Record<string, unknown>,
  opts: { allowMissing?: boolean } = {},
): FillResult {
  const zip = openDocx(buffer);
  const detected = detectSlots(zip);
  const byId = new Map(detected.map((s) => [s.id, s]));
  const fields = new Map(config.fields.map((f) => [f.key, f]));

  const missing = config.fields.filter(
    (f) => f.required && f.type !== 'CHECK' && config.slots.some((s) => s.action === 'FIELD' && s.field === f.key) && isEmptyValue(values[f.key]),
  );
  if (missing.length && !opts.allowMissing) {
    return { buffer, filled: 0, missing, keptSlots: [], staleSlots: [] };
  }

  const perPart = new Map<string, Replacement[]>();
  const keptSlots: string[] = [];
  const staleSlots: string[] = [];
  let filled = 0;
  for (const sc of config.slots) {
    if (sc.action === 'KEEP') continue;
    const slot = byId.get(sc.id);
    if (!slot) {
      staleSlots.push(sc.id);
      continue;
    }
    let value: string | null = null;
    if (sc.action === 'CLEAR') value = '';
    else {
      const f = sc.field ? fields.get(sc.field) : undefined;
      if (!f) continue;
      const raw = values[f.key];
      if (slot.type === 'CHECKBOX' || f.type === 'CHECK') {
        if (slot.type === 'CHECKBOX') value = checkboxText(slot.text, isTruthy(raw));
        else value = isTruthy(raw) ? 'X' : null;
      } else if (isEmptyValue(raw)) {
        keptSlots.push(sc.id);
        continue;
      } else value = formatValue(raw, f.type, f.format ?? null);
    }
    if (value === null) continue;
    if (value === slot.text) continue;
    if (!perPart.has(slot.part)) perPart.set(slot.part, []);
    perPart.get(slot.part)!.push({ paragraph: slot.paragraph, start: slot.start, end: slot.end, value });
    filled++;
  }

  for (const [partName, reps] of perPart) {
    const part: ParsedPart = parsePart(zip.getText(partName)!);
    zip.set(partName, applyReplacements(part, reps, { removeMarking: !!config.removeMarking }));
  }
  return { buffer: zip.toBuffer(), filled, missing, keptSlots, staleSlots };
}

/** Texto corrido de todas as partes (para conferência/testes). */
export function documentText(buffer: Buffer): string {
  const zip = openDocx(buffer);
  return contentParts(zip)
    .map((name) => parsePart(zip.getText(name) ?? '').paragraphs.map((p) => p.text).join('\n'))
    .join('\n');
}
