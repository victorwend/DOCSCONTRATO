import { BadRequestException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { Actor, AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { REJECTION_REASONS, RejectionReason } from '../domain/status';
import { decryptToken } from '../domain/link-token';
import { RequestDocRow, RequestsService } from './requests.service';

/** Conferência dos documentos pelo RH/conferente. */
@Injectable()
export class ReviewService {
  constructor(
    private readonly db: Db,
    private readonly audit: AuditService,
    private readonly requests: RequestsService,
    private readonly email: EmailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async load(requestId: string, docId: string) {
    const r = await this.requests.getRow(requestId);
    if (['CANCELADO', 'FINALIZADO'].includes(r.status)) throw new BadRequestException('Solicitação encerrada.');
    const d = await this.db.maybe<RequestDocRow>('select * from request_documents where id = $1 and request_id = $2', [docId, requestId]);
    if (!d) throw new NotFoundException('Documento não encontrado');
    if (!d.is_applicable) throw new BadRequestException('Documento marcado como N/A.');
    return { r, d };
  }

  /** Marca EM_ANALISE quando o conferente abre o documento. */
  async startReview(requestId: string, docId: string, actor: Actor) {
    const { d } = await this.load(requestId, docId);
    if (d.status !== 'RECEBIDO') return { status: d.status };
    await this.db.tx(async (c) => {
      const n = await this.db.exec(`update request_documents set status = 'EM_ANALISE' where id = $1 and status = 'RECEBIDO'`, [docId], c);
      if (n) {
        await this.audit.log(actor, 'DOCUMENT_REVIEW_STARTED', { requestId, entityType: 'request_document', entityId: docId, details: { name: d.name } }, c);
        await this.requests.recalc(requestId, actor, c);
      }
    });
    return { status: 'EM_ANALISE' };
  }

  async approve(requestId: string, docId: string, note: string | null, actor: Actor & { type: 'USER' }) {
    const { d } = await this.load(requestId, docId);
    if (d.status === 'PENDENTE') throw new BadRequestException('O documento ainda não foi enviado.');
    if (d.status === 'APROVADO') return;
    await this.db.tx(async (c) => {
      await this.db.exec(
        `update request_documents set status = 'APROVADO', reviewed_at = now(), reviewed_by = $2, reviewer_note = $3,
                rejection_reason = null, rejection_note = null where id = $1`,
        [docId, actor.userId, note],
        c,
      );
      await this.audit.log(actor, 'DOCUMENT_APPROVED', { requestId, entityType: 'request_document', entityId: docId, details: { name: d.name, note, naRequested: d.na_requested } }, c);
      await this.requests.recalc(requestId, actor, c);
    });
  }

  async reject(requestId: string, docId: string, reason: RejectionReason, note: string | null, notify: boolean, actor: Actor & { type: 'USER' }) {
    const { r, d } = await this.load(requestId, docId);
    if (d.status === 'PENDENTE') throw new BadRequestException('O documento ainda não foi enviado.');
    await this.db.tx(async (c) => {
      // arquivos rejeitados saem do envio atual, mas permanecem no histórico
      await this.db.exec(`update files set is_current = false where request_document_id = $1 and kind = 'ORIGINAL' and is_current`, [docId], c);
      await this.db.exec(`delete from files where request_document_id = $1 and kind = 'PROCESSED'`, [docId], c);
      await this.db.exec(
        `update request_documents set status = 'REJEITADO', reviewed_at = now(), reviewed_by = $2, rejection_reason = $3,
                rejection_note = $4, na_requested = false where id = $1`,
        [docId, actor.userId, reason, note],
        c,
      );
      await this.audit.log(
        actor,
        'DOCUMENT_REJECTED',
        { requestId, entityType: 'request_document', entityId: docId, details: { name: d.name, reason: REJECTION_REASONS[reason], note } },
        c,
      );
      await this.requests.recalc(requestId, actor, c);
    });

    if (notify && this.env.NOTIFY_APPLICANT_EMAILS && r.applicant_email && r.token_encrypted && r.link_active) {
      const res = await this.email.send(
        'DOCUMENT_REJECTED',
        r.applicant_email,
        {
          processType: r.model_name,
          applicantName: r.applicant_name,
          documentName: d.name,
          rejectionReason: REJECTION_REASONS[reason],
          rejectionNote: note,
          link: this.requests.linkUrl(decryptToken(r.token_encrypted, this.env.TOKEN_ENCRYPTION_KEY)),
        },
        { requestId },
      );
      await this.audit.log({ type: 'SYSTEM' }, res.ok ? 'EMAIL_SENT' : 'EMAIL_FAILED', {
        requestId,
        details: { template: 'DOCUMENT_REJECTED', to: r.applicant_email, document: d.name, error: res.error },
      });
    }
  }

  /** Itens do tipo TEXTO (ex.: telefone) — enviados pelo solicitante ou preenchidos pelo RH. */
  async submitText(requestId: string, docId: string, value: string, actor: Actor, byApplicant: boolean) {
    const d = await this.db.maybe<RequestDocRow>('select * from request_documents where id = $1 and request_id = $2', [docId, requestId]);
    if (!d) throw new NotFoundException('Documento não encontrado');
    if (d.kind !== 'TEXT') throw new BadRequestException('Este item exige o envio de um arquivo.');
    if (!d.is_applicable) throw new BadRequestException('Este item não é necessário nesta solicitação.');
    if (byApplicant && !['PENDENTE', 'RECEBIDO', 'REJEITADO'].includes(d.status)) throw new BadRequestException('Este item já está em conferência.');
    const v = value.trim();
    if (!v) throw new BadRequestException('Preencha a informação.');
    if (v.length > 2000) throw new BadRequestException('Texto muito longo.');
    await this.db.tx(async (c) => {
      await this.db.exec(
        `update request_documents set text_value = $2, status = 'RECEBIDO', submitted_at = now(), submission_count = submission_count + 1,
                na_requested = false, rejection_reason = null, rejection_note = null where id = $1`,
        [docId, v],
        c,
      );
      await this.audit.log(actor, d.status === 'REJEITADO' ? 'DOCUMENT_RESUBMITTED' : 'DOCUMENT_TEXT_SUBMITTED', {
        requestId, entityType: 'request_document', entityId: docId, details: { name: d.name },
      }, c);
      await this.requests.recalc(requestId, actor, c);
    });
  }

  /** Solicitante informa que o documento não se aplica — vai para conferência do RH. */
  async requestNotApplicable(requestId: string, docId: string, justification: string, actor: Actor) {
    const d = await this.db.maybe<RequestDocRow>('select * from request_documents where id = $1 and request_id = $2', [docId, requestId]);
    if (!d) throw new NotFoundException('Documento não encontrado');
    if (!['PENDENTE', 'RECEBIDO', 'REJEITADO'].includes(d.status)) throw new BadRequestException('Este item já está em conferência.');
    const j = justification.trim();
    if (j.length < 3) throw new BadRequestException('Explique brevemente por que o documento não se aplica.');
    await this.db.tx(async (c) => {
      await this.db.exec(`update files set is_current = false where request_document_id = $1 and kind = 'ORIGINAL' and is_current`, [docId], c);
      await this.db.exec(
        `update request_documents set na_requested = true, applicant_note = $2, status = 'RECEBIDO', submitted_at = now(),
                submission_count = submission_count + 1, rejection_reason = null, rejection_note = null where id = $1`,
        [docId, j.slice(0, 1000)],
        c,
      );
      await this.audit.log(actor, 'DOCUMENT_NA_REQUESTED', { requestId, entityType: 'request_document', entityId: docId, details: { name: d.name, justification: j } }, c);
      await this.requests.recalc(requestId, actor, c);
    });
  }
}
