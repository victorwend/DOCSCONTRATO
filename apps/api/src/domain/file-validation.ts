import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { createHash } from 'node:crypto';

/** Validação de uploads: extensão, MIME declarado, assinatura binária, tamanho, vazio e integridade. */

export type AcceptedMime = 'application/pdf' | 'image/jpeg' | 'image/png';

const EXT_TO_MIME: Record<string, AcceptedMime> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

export class UploadValidationError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
  }
}

export interface ValidatedFile {
  mime: AcceptedMime;
  extension: string;
  sizeBytes: number;
  sha256: string;
  pageCount: number;
  securityFlags: string[];
  width?: number;
  height?: number;
}

export function sniffMime(buf: Buffer): AcceptedMime | null {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  // alguns geradores colocam bytes antes do cabeçalho (permitido pela especificação até 1024 bytes)
  if (buf.subarray(0, 1024).toString('latin1').includes('%PDF-')) return 'application/pdf';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  return null;
}

export async function validateUpload(
  buf: Buffer,
  originalName: string,
  declaredMime: string | undefined,
  maxBytes: number,
): Promise<ValidatedFile> {
  if (!buf || buf.length === 0) throw new UploadValidationError('O arquivo está vazio.', 'EMPTY');
  if (buf.length > maxBytes) {
    throw new UploadValidationError(`O arquivo excede o limite de ${Math.round(maxBytes / 1024 / 1024)} MB.`, 'TOO_LARGE');
  }
  const ext = (originalName.split('.').pop() ?? '').toLowerCase();
  const extMime = EXT_TO_MIME[ext];
  if (!extMime) throw new UploadValidationError('Formato não aceito. Envie PDF, JPG, JPEG ou PNG.', 'EXTENSION');

  const sniffed = sniffMime(buf);
  if (!sniffed) throw new UploadValidationError('O conteúdo do arquivo não corresponde a PDF, JPG ou PNG.', 'SIGNATURE');
  if (sniffed !== extMime) {
    throw new UploadValidationError('A extensão do arquivo não corresponde ao seu conteúdo.', 'MISMATCH');
  }
  const declared = (declaredMime ?? '').toLowerCase();
  const declaredOk =
    !declared ||
    declared === 'application/octet-stream' ||
    declared === sniffed ||
    (sniffed === 'image/jpeg' && declared === 'image/jpg');
  if (!declaredOk) throw new UploadValidationError('Tipo de arquivo (MIME) inválido.', 'MIME');

  const sha256 = createHash('sha256').update(buf).digest('hex');
  const securityFlags: string[] = [];

  if (sniffed === 'application/pdf') {
    let pageCount = 0;
    try {
      const pdf = await PDFDocument.load(buf, { updateMetadata: false });
      pageCount = pdf.getPageCount();
      if (pageCount > 0) pdf.getPage(0).getSize();
    } catch (e) {
      const msg = String((e as Error)?.message ?? '');
      if (/encrypt/i.test(msg)) {
        throw new UploadValidationError('O PDF está protegido por senha. Envie uma versão sem senha.', 'ENCRYPTED');
      }
      throw new UploadValidationError('O PDF está corrompido ou não pôde ser lido.', 'CORRUPTED');
    }
    if (pageCount < 1) throw new UploadValidationError('O PDF não possui páginas.', 'CORRUPTED');
    const raw = buf.toString('latin1');
    if (/\/JavaScript|\/JS\s*[(<]/.test(raw)) securityFlags.push('PDF_JAVASCRIPT');
    if (/\/Launch/.test(raw)) securityFlags.push('PDF_LAUNCH_ACTION');
    if (/\/EmbeddedFile/.test(raw)) securityFlags.push('PDF_EMBEDDED_FILE');
    return { mime: sniffed, extension: ext, sizeBytes: buf.length, sha256, pageCount, securityFlags };
  }

  try {
    const img = sharp(buf, { failOn: 'error', limitInputPixels: 120_000_000 });
    const meta = await img.metadata();
    if (!meta.width || !meta.height) throw new Error('sem dimensões');
    // força a decodificação completa — detecta arquivos truncados/corrompidos
    await img.stats();
    if (meta.width < 200 || meta.height < 200) securityFlags.push('LOW_RESOLUTION');
    return {
      mime: sniffed,
      extension: ext,
      sizeBytes: buf.length,
      sha256,
      pageCount: 1,
      securityFlags,
      width: meta.width,
      height: meta.height,
    };
  } catch {
    throw new UploadValidationError('A imagem está corrompida ou não pôde ser lida.', 'CORRUPTED');
  }
}
