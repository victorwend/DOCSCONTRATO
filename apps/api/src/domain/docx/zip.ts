import { deflateRawSync, inflateRawSync } from 'node:zlib';

/**
 * Leitura/gravação mínima de ZIP (formato do .docx), sem dependências externas.
 *
 * Objetivo: preservar o arquivo original. Entradas que não foram alteradas são copiadas
 * byte a byte (mesmos dados comprimidos, mesmas datas, mesma ordem); só as partes XML
 * modificadas são recomprimidas. ZIP64, criptografia e "multi-disk" não são suportados
 * (um .docx de contrato nunca chega perto desses limites).
 */

export interface ZipEntry {
  name: string;
  /** método de compressão original (0 = stored, 8 = deflate) */
  method: number;
  flags: number;
  modTime: number;
  modDate: number;
  crc32: number;
  compressedSize: number;
  uncompressedSize: number;
  /** dados como estão no arquivo (comprimidos) */
  raw: Buffer;
  extra: Buffer;
  comment: Buffer;
  externalAttrs: number;
  internalAttrs: number;
  versionMadeBy: number;
  versionNeeded: number;
  /** conteúdo novo (descomprimido) quando a entrada foi alterada */
  replaced?: Buffer;
}

export class ZipError extends Error {}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

let CRC_TABLE: Uint32Array | null = null;
export function crc32(buf: Buffer): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export class ZipArchive {
  private constructor(
    public readonly entries: ZipEntry[],
    private readonly archiveComment: Buffer,
  ) {}

  static read(data: Buffer): ZipArchive {
    if (data.length < 22) throw new ZipError('Arquivo vazio ou corrompido');
    // procura o End Of Central Directory a partir do fim (comentário máx. 64 KiB)
    let eocd = -1;
    for (let i = data.length - 22; i >= Math.max(0, data.length - 22 - 0xffff); i--) {
      if (data.readUInt32LE(i) === SIG_EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new ZipError('Arquivo não é um .docx válido (estrutura ZIP não encontrada)');
    const total = data.readUInt16LE(eocd + 10);
    const cdSize = data.readUInt32LE(eocd + 12);
    const cdOffset = data.readUInt32LE(eocd + 16);
    const commentLen = data.readUInt16LE(eocd + 20);
    if (cdOffset === 0xffffffff || total === 0xffff) throw new ZipError('ZIP64 não suportado');
    if (cdOffset + cdSize > data.length) throw new ZipError('Arquivo corrompido (diretório central)');

    const entries: ZipEntry[] = [];
    let p = cdOffset;
    for (let i = 0; i < total; i++) {
      if (data.readUInt32LE(p) !== SIG_CENTRAL) throw new ZipError('Arquivo corrompido (entrada do diretório)');
      const versionMadeBy = data.readUInt16LE(p + 4);
      const versionNeeded = data.readUInt16LE(p + 6);
      const flags = data.readUInt16LE(p + 8);
      const method = data.readUInt16LE(p + 10);
      const modTime = data.readUInt16LE(p + 12);
      const modDate = data.readUInt16LE(p + 14);
      const crc = data.readUInt32LE(p + 16);
      const compressedSize = data.readUInt32LE(p + 20);
      const uncompressedSize = data.readUInt32LE(p + 24);
      const nameLen = data.readUInt16LE(p + 28);
      const extraLen = data.readUInt16LE(p + 30);
      const cLen = data.readUInt16LE(p + 32);
      const internalAttrs = data.readUInt16LE(p + 36);
      const externalAttrs = data.readUInt32LE(p + 38);
      const localOffset = data.readUInt32LE(p + 42);
      const name = data.subarray(p + 46, p + 46 + nameLen).toString(flags & 0x800 ? 'utf8' : 'latin1');
      const extra = Buffer.from(data.subarray(p + 46 + nameLen, p + 46 + nameLen + extraLen));
      const comment = Buffer.from(data.subarray(p + 46 + nameLen + extraLen, p + 46 + nameLen + extraLen + cLen));
      if (flags & 0x1) throw new ZipError('Arquivo protegido por senha não é suportado');
      if (data.readUInt32LE(localOffset) !== SIG_LOCAL) throw new ZipError('Arquivo corrompido (cabeçalho local)');
      const lNameLen = data.readUInt16LE(localOffset + 26);
      const lExtraLen = data.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + lNameLen + lExtraLen;
      const raw = Buffer.from(data.subarray(start, start + compressedSize));
      entries.push({
        name,
        method,
        flags,
        modTime,
        modDate,
        crc32: crc,
        compressedSize,
        uncompressedSize,
        raw,
        extra,
        comment,
        externalAttrs,
        internalAttrs,
        versionMadeBy,
        versionNeeded,
      });
      p += 46 + nameLen + extraLen + cLen;
    }
    return new ZipArchive(entries, Buffer.from(data.subarray(eocd + 22, eocd + 22 + commentLen)));
  }

  /** Cria um ZIP novo (usado em testes e para arquivos gerados do zero). */
  static create(files: Array<{ name: string; data: Buffer | string }>): ZipArchive {
    const entries: ZipEntry[] = files.map((f) => {
      const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
      return {
        name: f.name,
        method: 8,
        flags: 0x800,
        modTime: 0,
        modDate: (2026 - 1980) << 9 | (1 << 5) | 1,
        crc32: crc32(data),
        compressedSize: 0,
        uncompressedSize: data.length,
        raw: Buffer.alloc(0),
        extra: Buffer.alloc(0),
        comment: Buffer.alloc(0),
        externalAttrs: 0,
        internalAttrs: 0,
        versionMadeBy: 20,
        versionNeeded: 20,
        replaced: data,
      };
    });
    return new ZipArchive(entries, Buffer.alloc(0));
  }

  has(name: string) {
    return this.entries.some((e) => e.name === name);
  }

  names() {
    return this.entries.map((e) => e.name);
  }

  get(name: string): Buffer | null {
    const e = this.entries.find((x) => x.name === name);
    if (!e) return null;
    if (e.replaced) return e.replaced;
    if (e.method === 0) return e.raw;
    if (e.method === 8) return inflateRawSync(e.raw);
    throw new ZipError(`Compressão não suportada (${e.method}) em ${name}`);
  }

  getText(name: string): string | null {
    const b = this.get(name);
    return b ? b.toString('utf8') : null;
  }

  set(name: string, content: Buffer | string) {
    const e = this.entries.find((x) => x.name === name);
    if (!e) throw new ZipError(`Entrada inexistente: ${name}`);
    e.replaced = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  }

  /** Gera o ZIP. Entradas não alteradas mantêm os bytes comprimidos originais. */
  toBuffer(): Buffer {
    const locals: Buffer[] = [];
    const centrals: Buffer[] = [];
    let offset = 0;
    for (const e of this.entries) {
      let raw = e.raw;
      let method = e.method;
      let crc = e.crc32;
      let usize = e.uncompressedSize;
      // bit 3 (data descriptor) é descartado: tamanhos e CRC vão no cabeçalho local
      let flags = e.flags & ~0x8;
      if (e.replaced) {
        method = 8;
        raw = deflateRawSync(e.replaced, { level: 6 });
        crc = crc32(e.replaced);
        usize = e.replaced.length;
        flags = flags & ~0x6; // opções de nível de compressão do deflate
      }
      const nameBuf = Buffer.from(e.name, flags & 0x800 ? 'utf8' : 'latin1');
      const local = Buffer.alloc(30);
      local.writeUInt32LE(SIG_LOCAL, 0);
      local.writeUInt16LE(e.versionNeeded || 20, 4);
      local.writeUInt16LE(flags, 6);
      local.writeUInt16LE(method, 8);
      local.writeUInt16LE(e.modTime, 10);
      local.writeUInt16LE(e.modDate, 12);
      local.writeUInt32LE(crc, 14);
      local.writeUInt32LE(raw.length, 18);
      local.writeUInt32LE(usize, 22);
      local.writeUInt16LE(nameBuf.length, 26);
      local.writeUInt16LE(0, 28);
      locals.push(local, nameBuf, raw);

      const central = Buffer.alloc(46);
      central.writeUInt32LE(SIG_CENTRAL, 0);
      central.writeUInt16LE(e.versionMadeBy || 20, 4);
      central.writeUInt16LE(e.versionNeeded || 20, 6);
      central.writeUInt16LE(flags, 8);
      central.writeUInt16LE(method, 10);
      central.writeUInt16LE(e.modTime, 12);
      central.writeUInt16LE(e.modDate, 14);
      central.writeUInt32LE(crc, 16);
      central.writeUInt32LE(raw.length, 20);
      central.writeUInt32LE(usize, 24);
      central.writeUInt16LE(nameBuf.length, 28);
      central.writeUInt16LE(e.extra.length, 30);
      central.writeUInt16LE(e.comment.length, 32);
      central.writeUInt16LE(0, 34);
      central.writeUInt16LE(e.internalAttrs, 36);
      central.writeUInt32LE(e.externalAttrs, 38);
      central.writeUInt32LE(offset, 42);
      centrals.push(central, nameBuf, e.extra, e.comment);
      offset += 30 + nameBuf.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(SIG_EOCD, 0);
    eocd.writeUInt16LE(this.entries.length, 8);
    eocd.writeUInt16LE(this.entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(offset, 16);
    eocd.writeUInt16LE(this.archiveComment.length, 20);
    return Buffer.concat([...locals, cd, eocd, this.archiveComment]);
  }
}
