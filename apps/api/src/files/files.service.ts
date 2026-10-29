import { BadRequestException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ENV, Env } from '../config/env';
import { Db, Queryable } from '../db/pool';
import { Actor, AuditService } from '../audit/audit.service';
import { STORAGE } from '../core/tokens';
import { StorageDriver, signFileUrl } from '../storage/storage';
import { validateUpload, UploadValidationError, ValidatedFile } from '../domain/file-validation';
import { buildDocumentPdf } from '../domain/pdf-builder';
import { canApplicantUpload } from '../domain/status';
import { sanitizeOriginalName } from '../domain/text';
import { RequestDocRow, RequestsService } from '../requests/requests.service';
import { AnalysisService } from '../analysis/analysis.service';

export interface IncomingFile {
  buffer: Buffer;
  originalname: string;
  mimetype: string;
  size: number;
}

export interface FileRow {
  id: string;
  request_id: string;
  request_document_id: string | null;
  kind: 'ORIGINAL' | 'PROCESSED' | 'FINAL';
  storage_driver: string;
  storage_key: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  page_count: number | null;
  side: 'FRONT' | 'BACK' | null;
  is_current: boolean;
  purged_at: Date | null;
  created_at: Date;
}

const SIDE_ORDER = { FRONT: 0, BACK: 1 } as const;

@Injectable()
export class FilesService {
  private readonly logger = new Logger(FilesService.name);

  constructor(
    private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly requests: RequestsService,
    private readonly analysis: AnalysisService,
  ) {}

  get maxBytes() {
    return this.env.MAX_UPLOAD_MB * 1024 * 1024;
  }

  /**
   * Recebe arquivos para um documento (portal do solicitante ou upload interno pelo RH).
   * Arquivos anteriores nunca são apagados: ficam no histórico com is_current = false.
   */
  async uploadToDocument(
    requestId: string,
    docId: string,
    incoming: IncomingFile[],
    sides: Array<'FRONT' | 'BACK' | null>,
    actor: Actor,
    opts: { byApplicant: boolean; note?: string | null },
  ) {
    if (!incoming.length) throw new BadRequestException('Selecione ao menos um arquivo.');
    if (incoming.length > this.env.MAX_FILES_PER_UPLOAD) throw new BadRequestException(`Envie no máximo ${this.env.MAX_FILES_PER_UPLOAD} arquivos por vez.`);

    const doc = await this.db.maybe<RequestDocRow>('select * from request_documents where id = $1 and request_id = $2', [docId, requestId]);
    if (!doc) throw new NotFoundException('Documento não encontrado');
    if (doc.kind !== 'FILE') throw new BadRequestException('Este item é uma informação de texto, não um arquivo.');
    if (!doc.is_applicable) throw new BadRequestException('Este documento não é necessário nesta solicitação.');
    if (opts.byApplicant && !canApplicantUpload(doc.status)) {
      throw new BadRequestException(doc.status === 'APROVADO' ? 'Este documento já foi aprovado.' : 'Este documento está em análise.');
    }

    // validação completa antes de gravar qualquer coisa
    const validated: Array<{ f: IncomingFile; name: string; v: ValidatedFile }> = [];
    for (const f of incoming) {
      const name = sanitizeOriginalName(f.originalname);
      try {
        const v = await validateUpload(f.buffer, name, f.mimetype, this.maxBytes);
        if (doc.accept === 'PDF' && v.mime !== 'application/pdf') {
          throw new UploadValidationError('Este documento aceita somente arquivo PDF.', 'FORMAT_NOT_ALLOWED');
        }
        if (doc.accept === 'IMAGE' && v.mime === 'application/pdf') {
          throw new UploadValidationError('Este documento aceita somente foto (JPG ou PNG).', 'FORMAT_NOT_ALLOWED');
        }
        validated.push({ f, name, v });
      } catch (e) {
        if (e instanceof UploadValidationError) throw new BadRequestException(`${name}: ${e.message}`);
        throw e;
      }
    }

    const current = await this.db.many<{ id: string; side: 'FRONT' | 'BACK' | null }>(
      `select id, side from files where request_document_id = $1 and kind = 'ORIGINAL' and is_current`,
      [docId],
    );
    // frente/verso: um novo envio de "frente" substitui a frente anterior (idem verso)
    const sidesToReplace = doc.both_sides ? (validated.map((_, i) => sides[i]).filter(Boolean) as Array<'FRONT' | 'BACK'>) : [];
    // documento de arquivo único, ou reenvio após rejeição: o novo envio substitui o anterior
    const replaceAll = !doc.allow_multiple || doc.status === 'REJEITADO';
    const remaining = replaceAll ? 0 : current.filter((f) => !(f.side && sidesToReplace.includes(f.side))).length;
    if (remaining + validated.length > doc.max_files) {
      throw new BadRequestException(
        doc.max_files === 1 ? 'Envie apenas um arquivo para este documento.' : `Máximo de ${doc.max_files} arquivos para este documento.`,
      );
    }

    const storedKeys: string[] = [];
    try {
      await this.db.tx(async (c) => {
        const locked = await this.db.one<RequestDocRow>('select * from request_documents where id = $1 for update', [docId], c);
        if (opts.byApplicant && !canApplicantUpload(locked.status)) throw new BadRequestException('Este documento não aceita novos envios.');
        const submission = locked.submission_count + 1;
        if (replaceAll) {
          await this.db.exec(`update files set is_current = false where request_document_id = $1 and kind = 'ORIGINAL' and is_current`, [docId], c);
        } else if (sidesToReplace.length) {
          await this.db.exec(
            `update files set is_current = false where request_document_id = $1 and kind = 'ORIGINAL' and is_current and side = any($2::text[])`,
            [docId, sidesToReplace],
            c,
          );
        }
        for (const [i, { f, name, v }] of validated.entries()) {
          const id = randomUUID();
          const key = `requests/${requestId}/original/${id}.${v.extension === 'jpeg' ? 'jpg' : v.extension}`;
          await this.storage.put(key, f.buffer, v.mime);
          storedKeys.push(key);
          const side = doc.both_sides ? sides[i] ?? null : null;
          await this.db.exec(
            `insert into files (id, request_id, request_document_id, kind, storage_driver, storage_key, original_name, mime_type,
                                size_bytes, sha256, page_count, side, submission_number, security_flags, uploaded_by_applicant, uploaded_by, uploader_ip)
             values ($1,$2,$3,'ORIGINAL',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::inet)`,
            [
              id, requestId, docId, this.storage.name, key, name, v.mime, v.sizeBytes, v.sha256, v.pageCount, side, submission,
              v.securityFlags, opts.byApplicant, actor.type === 'USER' ? actor.userId : null,
              actor.type !== 'SYSTEM' && actor.ip && /^[\d.:a-f]+$/i.test(actor.ip) ? actor.ip : null,
            ],
            c,
          );
          await this.analysis.enqueue(id, c);
        }
        await this.db.exec(
          `update request_documents set status = 'RECEBIDO', submission_count = $2, submitted_at = now(),
                  na_requested = false, applicant_note = coalesce($3, applicant_note),
                  rejection_reason = null, rejection_note = null, reviewed_at = null, reviewed_by = null
            where id = $1`,
          [docId, submission, opts.note ?? null],
          c,
        );
        await this.audit.log(
          actor,
          locked.status === 'REJEITADO' ? 'DOCUMENT_RESUBMITTED' : 'DOCUMENT_UPLOADED',
          {
            requestId,
            entityType: 'request_document',
            entityId: docId,
            details: { name: doc.name, files: validated.map((x) => x.name), submission, flags: validated.flatMap((x) => x.v.securityFlags) },
          },
          c,
        );
        await this.invalidateProcessed(docId, c);
        await this.requests.recalc(requestId, actor, c);
      });
    } catch (e) {
      // desfaz gravações no storage se a transação falhar
      await Promise.all(storedKeys.map((k) => this.storage.remove(k).catch(() => undefined)));
      throw e;
    }
    return { ok: true };
  }

  /** Remove (do envio atual) um arquivo ainda não conferido. O arquivo permanece no storage/histórico. */
  async detachFile(requestId: string, docId: string, fileId: string, actor: Actor, byApplicant: boolean) {
    await this.db.tx(async (c) => {
      const doc = await this.db.maybe<RequestDocRow>('select * from request_documents where id = $1 and request_id = $2 for update', [docId, requestId], c);
      if (!doc) throw new NotFoundException('Documento não encontrado');
      if (byApplicant && doc.status !== 'RECEBIDO') throw new BadRequestException('Só é possível remover arquivos ainda não conferidos.');
      const f = await this.db.maybe<FileRow>(`select * from files where id = $1 and request_document_id = $2 and is_current and kind = 'ORIGINAL'`, [fileId, docId], c);
      if (!f) throw new NotFoundException('Arquivo não encontrado');
      await this.db.exec('update files set is_current = false where id = $1', [fileId], c);
      const left = await this.db.one<{ n: number }>(`select count(*)::int as n from files where request_document_id = $1 and is_current and kind = 'ORIGINAL'`, [docId], c);
      if (left.n === 0 && !doc.text_value) {
        await this.db.exec(`update request_documents set status = 'PENDENTE', submitted_at = null where id = $1`, [docId], c);
      }
      await this.audit.log(actor, 'DOCUMENT_FILE_REMOVED', { requestId, entityType: 'file', entityId: fileId, details: { name: doc.name, file: f.original_name } }, c);
      await this.invalidateProcessed(docId, c);
      await this.requests.recalc(requestId, actor, c);
    });
  }

  async currentFiles(docId: string, c: Queryable = this.db.pool): Promise<FileRow[]> {
    const rows = await this.db.many<FileRow>(
      `select * from files where request_document_id = $1 and kind = 'ORIGINAL' and is_current and purged_at is null order by created_at`,
      [docId],
      c,
    );
    // frente antes do verso; demais pela ordem de envio
    return rows.sort((a, b) => {
      const sa = a.side ? SIDE_ORDER[a.side] : 0.5;
      const sb = b.side ? SIDE_ORDER[b.side] : 0.5;
      return sa - sb || new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
  }

  private async invalidateProcessed(docId: string, c: Queryable) {
    const rows = await this.db.many<{ id: string; storage_key: string }>(`select id, storage_key from files where request_document_id = $1 and kind = 'PROCESSED'`, [docId], c);
    for (const r of rows) {
      await this.db.exec('delete from files where id = $1', [r.id], c);
      await this.storage.remove(r.storage_key).catch(() => undefined);
    }
  }

  /**
   * PDF processado de um documento (imagens convertidas + PDFs preservados, frente/verso em ordem).
   * Fica armazenado em requests/{id}/processed/ e é regenerado quando o documento muda.
   */
  async processedFile(requestId: string, docId: string): Promise<FileRow | null> {
    const built = await this.processedPdf(requestId, docId);
    if (!built) return null;
    return this.db.maybe<FileRow>(`select * from files where request_document_id = $1 and kind = 'PROCESSED'`, [docId]);
  }

  async processedPdf(requestId: string, docId: string): Promise<{ buffer: Buffer; pageCount: number } | null> {
    const existing = await this.db.maybe<FileRow>(`select * from files where request_document_id = $1 and kind = 'PROCESSED'`, [docId]);
    if (existing) {
      try {
        return { buffer: await this.storage.get(existing.storage_key), pageCount: existing.page_count ?? 0 };
      } catch {
        await this.db.exec('delete from files where id = $1', [existing.id]);
      }
    }
    const files = await this.currentFiles(docId);
    if (!files.length) return null;
    const sources = await Promise.all(files.map(async (f) => ({ buffer: await this.storage.get(f.storage_key), mime: f.mime_type })));
    const built = await buildDocumentPdf(sources);
    const key = `requests/${requestId}/processed/${docId}.pdf`;
    await this.storage.put(key, built.buffer, 'application/pdf');
    await this.db.exec(
      `insert into files (request_id, request_document_id, kind, storage_driver, storage_key, original_name, mime_type, size_bytes, sha256, page_count)
       values ($1,$2,'PROCESSED',$3,$4,$5,'application/pdf',$6,$7,$8)
       on conflict (storage_key) do update set size_bytes = excluded.size_bytes, sha256 = excluded.sha256, page_count = excluded.page_count, created_at = now()`,
      [requestId, docId, this.storage.name, key, `${docId}.pdf`, built.buffer.length, createHash('sha256').update(built.buffer).digest('hex'), built.pageCount],
    );
    return built;
  }

  async storeFinal(requestId: string, fileName: string, buffer: Buffer, pageCount: number, userId: string | null): Promise<string> {
    const id = randomUUID();
    const key = `requests/${requestId}/final/${id}.pdf`;
    await this.storage.put(key, buffer, 'application/pdf');
    await this.db.exec(`update files set is_current = false where request_id = $1 and kind = 'FINAL'`, [requestId]);
    await this.db.exec(
      `insert into files (id, request_id, kind, storage_driver, storage_key, original_name, mime_type, size_bytes, sha256, page_count, uploaded_by)
       values ($1,$2,'FINAL',$3,$4,$5,'application/pdf',$6,$7,$8,$9)`,
      [id, requestId, this.storage.name, key, fileName, buffer.length, createHash('sha256').update(buffer).digest('hex'), pageCount, userId],
    );
    return id;
  }

  async getFile(fileId: string): Promise<FileRow> {
    const f = await this.db.maybe<FileRow>('select * from files where id = $1', [fileId]);
    if (!f) throw new NotFoundException('Arquivo não encontrado');
    if (f.purged_at) throw new NotFoundException('Arquivo removido pela política de retenção');
    return f;
  }

  read(f: FileRow) {
    return this.storage.get(f.storage_key);
  }

  /** URL temporária para visualizar/baixar um arquivo (nunca pública). */
  async temporaryUrl(f: FileRow, disposition: 'inline' | 'attachment', userId: string, downloadName?: string) {
    const ttl = this.env.SIGNED_URL_TTL_SECONDS;
    if (this.storage.name === 'supabase' && disposition === 'attachment') {
      const url = await this.storage.signedUrl(f.storage_key, ttl, downloadName ?? f.original_name);
      if (url) return url;
    }
    const token = signFileUrl(this.env.FILE_URL_SECRET, {
      fid: f.id,
      exp: Math.floor(Date.now() / 1000) + ttl,
      disp: disposition,
      uid: userId,
      n: downloadName,
    });
    return `/api/files/signed/${token}`;
  }
}
