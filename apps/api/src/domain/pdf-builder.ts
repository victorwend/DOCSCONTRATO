import { PDFDocument, PDFFont, PDFPage, StandardFonts, rgb } from 'pdf-lib';
import sharp from 'sharp';

/**
 * Geração de PDFs:
 *  - buildDocumentPdf: junta os arquivos de UM documento (ex.: RG frente + verso) em um PDF.
 *    Imagens são corrigidas (rotação EXIF), reduzidas e convertidas; PDFs têm todas as páginas preservadas.
 *  - buildFinalPdf: capa + dados informados + documentos na ordem do modelo.
 */

const A4: [number, number] = [595.28, 841.89];
const MARGIN = 28;
const DARK = rgb(0.12, 0.12, 0.12);
const MUTED = rgb(0.42, 0.42, 0.42);
const YELLOW = rgb(0.988, 0.914, 0.31);

export interface SourceFile {
  buffer: Buffer;
  mime: string;
}

async function normalizeImage(buf: Buffer): Promise<{ jpg: Buffer; width: number; height: number }> {
  const { data, info } = await sharp(buf, { limitInputPixels: 120_000_000 })
    .rotate() // aplica orientação EXIF (fotos de celular)
    .flatten({ background: '#ffffff' })
    .resize({ width: 2480, height: 2480, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer({ resolveWithObject: true });
  return { jpg: data, width: info.width, height: info.height };
}

async function addImagePage(pdf: PDFDocument, buf: Buffer) {
  const { jpg, width, height } = await normalizeImage(buf);
  const img = await pdf.embedJpg(jpg);
  const landscape = width > height;
  const [pw, ph] = landscape ? [A4[1], A4[0]] : A4;
  const page = pdf.addPage([pw, ph]);
  const scale = Math.min((pw - MARGIN * 2) / width, (ph - MARGIN * 2) / height, 1.5);
  const w = width * scale;
  const h = height * scale;
  page.drawImage(img, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
}

export async function buildDocumentPdf(files: SourceFile[]): Promise<{ buffer: Buffer; pageCount: number }> {
  const out = await PDFDocument.create();
  for (const f of files) {
    if (f.mime === 'application/pdf') {
      const src = await PDFDocument.load(f.buffer, { updateMetadata: false });
      const pages = await out.copyPages(src, src.getPageIndices());
      pages.forEach((p) => out.addPage(p));
    } else {
      await addImagePage(out, f.buffer);
    }
  }
  out.setProducer('PAVIDEZ DOCS');
  const bytes = await out.save();
  return { buffer: Buffer.from(bytes), pageCount: out.getPageCount() };
}

// ---------------------------------------------------------------------------
// Texto seguro para fontes padrão (WinAnsi)
// ---------------------------------------------------------------------------
function safeText(font: PDFFont, text: string): string {
  const set = new Set(font.getCharacterSet());
  return Array.from(text.replace(/\r/g, ''))
    .map((ch) => {
      if (ch === '\n') return ch;
      if (set.has(ch.codePointAt(0)!)) return ch;
      const base = ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
      return base && set.has(base.codePointAt(0)!) ? base : '?';
    })
    .join('');
}

function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  for (const para of safeText(font, text).split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxWidth) {
        line = candidate;
      } else {
        if (line) lines.push(line);
        // palavra maior que a linha: quebra por caracteres
        let w = word;
        while (font.widthOfTextAtSize(w, size) > maxWidth && w.length > 1) {
          let cut = w.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxWidth) cut--;
          lines.push(w.slice(0, cut));
          w = w.slice(cut);
        }
        line = w;
      }
    }
    lines.push(line);
  }
  return lines;
}

class Writer {
  page!: PDFPage;
  y = 0;
  constructor(
    private pdf: PDFDocument,
    public font: PDFFont,
    public bold: PDFFont,
    private header: string,
  ) {
    this.newPage();
  }
  newPage() {
    this.page = this.pdf.addPage(A4);
    this.y = A4[1] - 56;
    this.page.drawRectangle({ x: 0, y: A4[1] - 8, width: A4[0], height: 8, color: YELLOW });
    this.page.drawText(safeText(this.font, this.header), { x: 48, y: 24, size: 8, font: this.font, color: MUTED });
  }
  ensure(h: number) {
    if (this.y - h < 56) this.newPage();
  }
  text(t: string, opts: { size?: number; bold?: boolean; color?: ReturnType<typeof rgb>; x?: number; width?: number; gap?: number } = {}) {
    const size = opts.size ?? 10;
    const font = opts.bold ? this.bold : this.font;
    const x = opts.x ?? 48;
    const lines = wrap(font, t, size, opts.width ?? A4[0] - x - 48);
    for (const l of lines) {
      this.ensure(size + 4);
      this.page.drawText(l, { x, y: this.y, size, font, color: opts.color ?? DARK });
      this.y -= size + 4;
    }
    this.y -= opts.gap ?? 0;
  }
  rule() {
    this.ensure(10);
    this.page.drawLine({ start: { x: 48, y: this.y + 4 }, end: { x: A4[0] - 48, y: this.y + 4 }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) });
    this.y -= 8;
  }
}

export interface FinalSection {
  index: number;
  name: string;
  section?: string | null;
  notApplicable?: boolean;
  naReason?: string | null;
  textValue?: string | null;
  pdf?: Buffer | null; // PDF já processado do documento
}

export interface FinalPdfInput {
  companyName: string;
  companyCnpj: string;
  processType: string;
  applicantName: string;
  applicantDocument: string;
  requestCode: string;
  date: Date;
  logoPng?: Buffer | null;
  info: Array<{ label: string; value: string; section?: string | null }>;
  sections: FinalSection[];
}

export async function buildFinalPdf(input: FinalPdfInput): Promise<{ buffer: Buffer; pageCount: number }> {
  const out = await PDFDocument.create();
  out.setTitle(`${input.processType} - ${input.applicantName}`);
  out.setAuthor(input.companyName);
  out.setProducer('PAVIDEZ DOCS');
  out.setCreationDate(input.date);
  const font = await out.embedFont(StandardFonts.Helvetica);
  const bold = await out.embedFont(StandardFonts.HelveticaBold);

  const dateStr = input.date.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const header = `${input.companyName} | ${input.processType} | ${input.applicantName} | ${input.requestCode}`;

  // páginas de cada documento (para calcular o índice antes de juntar)
  const loaded: Array<{ s: FinalSection; doc: PDFDocument | null; pages: number }> = [];
  for (const s of input.sections) {
    if (s.pdf && !s.notApplicable) {
      const doc = await PDFDocument.load(s.pdf);
      loaded.push({ s, doc, pages: doc.getPageCount() });
    } else {
      loaded.push({ s, doc: null, pages: 0 });
    }
  }

  // ---- capa ----
  const w = new Writer(out, font, bold, header);
  if (input.logoPng) {
    try {
      const logo = await out.embedPng(input.logoPng);
      const lw = 220;
      const lh = (logo.height / logo.width) * lw;
      w.page.drawImage(logo, { x: (A4[0] - lw) / 2, y: w.y - lh + 10, width: lw, height: lh });
      w.y -= lh + 24;
    } catch {
      /* logo opcional */
    }
  }
  w.text(input.companyName, { size: 22, bold: true, gap: 2 });
  w.text(`CNPJ ${input.companyCnpj}`, { size: 9, color: MUTED, gap: 18 });

  const field = (label: string, value: string) => {
    w.text(label.toUpperCase(), { size: 8, color: MUTED, gap: 3 });
    w.text(value || '—', { size: 13, bold: true, gap: 8 });
  };
  field('Tipo de processo', input.processType.toUpperCase());
  field('Nome / Razão social', input.applicantName.toUpperCase());
  field('CPF/CNPJ', input.applicantDocument);
  field('Data', dateStr);
  field('Protocolo', input.requestCode);

  // ---- informações / dados informados ----
  const writeInfo = (wr: Writer) => {
    if (!input.info.length) return;
    wr.ensure(60);
    wr.y -= 6;
    wr.text('DADOS INFORMADOS', { size: 11, bold: true, gap: 4 });
    wr.rule();
    let lastSection: string | null | undefined;
    for (const it of input.info) {
      if (it.section && it.section !== lastSection) {
        wr.text(it.section, { size: 9, bold: true, color: MUTED, gap: 2 });
        lastSection = it.section;
      }
      wr.text(`${it.label}: ${it.value || '—'}`, { size: 9, gap: 1 });
    }
  };

  // Índice: precisamos dos números de página. Estratégia: desenhar índice + informações,
  // contar páginas geradas, e então calcular o deslocamento.
  const indexEntries: Array<{ label: string; detail: string }> = [];
  const drawIndex = (startPage: number) => {
    let page = startPage;
    indexEntries.length = 0;
    for (const { s, pages } of loaded) {
      const num = String(s.index).padStart(2, '0');
      let detail: string;
      if (s.notApplicable) detail = s.naReason ? `N/A — ${s.naReason}` : 'N/A';
      else if (pages > 0) {
        detail = pages === 1 ? `pág. ${page}` : `págs. ${page}–${page + pages - 1}`;
        page += pages;
      } else if (s.textValue) detail = s.textValue;
      else detail = '—';
      indexEntries.push({ label: `${num} - ${s.name.toUpperCase()}`, detail });
    }
  };

  // primeira passada para medir quantas páginas de pré-documento serão necessárias
  const measure = await PDFDocument.create();
  const mf = await measure.embedFont(StandardFonts.Helvetica);
  const mb = await measure.embedFont(StandardFonts.HelveticaBold);
  const mw = new Writer(measure, mf, mb, header);
  mw.y = w.y;
  drawIndex(1);
  const writeIndex = (wr: Writer) => {
    wr.y -= 6;
    wr.text('DOCUMENTOS', { size: 11, bold: true, gap: 4 });
    wr.rule();
    for (const e of indexEntries) {
      wr.ensure(14);
      const yBefore = wr.y;
      const pageBefore = wr.page;
      wr.text(e.label, { size: 9, bold: true, width: 330 });
      const yAfterLabel = wr.y;
      const pageAfter = wr.page;
      if (pageAfter === pageBefore) {
        wr.y = yBefore;
        wr.text(e.detail, { size: 9, x: 390, width: A4[0] - 390 - 48, color: MUTED });
        wr.y = Math.min(wr.y, yAfterLabel);
      } else {
        wr.text(e.detail, { size: 9, x: 390, width: A4[0] - 390 - 48, color: MUTED });
      }
      wr.y -= 2;
    }
  };
  writeIndex(mw);
  writeInfo(mw);
  const prePages = measure.getPageCount();

  drawIndex(prePages + 1);
  writeIndex(w);
  writeInfo(w);

  // ---- documentos ----
  for (const { doc } of loaded) {
    if (!doc) continue;
    const pages = await out.copyPages(doc, doc.getPageIndices());
    pages.forEach((p) => out.addPage(p));
  }

  const bytes = await out.save();
  return { buffer: Buffer.from(bytes), pageCount: out.getPageCount() };
}
