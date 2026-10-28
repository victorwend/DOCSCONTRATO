import { ForbiddenException, GoneException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { Actor, AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { hashToken, isWellFormedToken } from '../domain/link-token';
import { computeProgress, LINK_OPEN_STATUSES, REJECTION_REASONS, RejectionReason } from '../domain/status';
import { RequestDocRow, RequestRow, RequestsService } from '../requests/requests.service';

/**
 * Portal público do solicitante. O token identifica UMA solicitação — nenhum dado de outra
 * solicitação é acessível. Não expõe CPF completo, dados internos, respostas internas nem arquivos.
 */
@Injectable()
export class PortalService {
  constructor(
    private readonly db: Db,
    private readonly requests: RequestsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Resolve o token. `forWrite` exige que a solicitação aceite envios. */
  async resolve(token: string, forWrite: boolean): Promise<RequestRow> {
    if (!isWellFormedToken(token)) throw new NotFoundException('Link inválido.');
    const r = await this.db.maybe<RequestRow>('select * from requests where token_hash = $1', [hashToken(token)]);
    if (!r) throw new NotFoundException('Link inválido ou substituído por um novo link.');
    if (r.status === 'CANCELADO') throw new GoneException('Esta solicitação foi cancelada.');
    if (!r.link_active && r.status !== 'FINALIZADO') throw new ForbiddenException('Este link está desativado. Fale com a Pavidez Engenharia.');
    if (r.link_expires_at && new Date(r.link_expires_at).getTime() < Date.now() && !['APROVADO', 'FINALIZADO'].includes(r.status)) {
      if (r.status !== 'EXPIRADO') await this.requests.recalc(r.id, { type: 'SYSTEM' });
      throw new GoneException('O prazo deste link expirou. Fale com a Pavidez Engenharia para receber um novo prazo.');
    }
    if (forWrite && !LINK_OPEN_STATUSES.includes(r.status)) {
      throw new ForbiddenException('Esta documentação já foi conferida e não aceita novos envios.');
    }
    return r;
  }

  async view(token: string, actor: Actor) {
    const r = await this.resolve(token, false);
    // registra acesso (no máximo um registro a cada 30 minutos)
    if (!r.last_accessed_at || Date.now() - new Date(r.last_accessed_at).getTime() > 30 * 60_000) {
      await this.db.exec('update requests set last_accessed_at = now() where id = $1', [r.id]);
      await this.audit.log(actor, 'LINK_ACCESSED', { requestId: r.id });
    }
    const docs = await this.db.many<RequestDocRow>(
      `select * from request_documents where request_id = $1 and (is_applicable or awaiting_answer) order by position, created_at`,
      [r.id],
    );
    const files = await this.db.many<{ id: string; request_document_id: string; original_name: string; size_bytes: number; side: string | null; created_at: Date }>(
      `select id, request_document_id, original_name, size_bytes, side, created_at from files
        where request_id = $1 and kind = 'ORIGINAL' and is_current order by created_at`,
      [r.id],
    );
    const answers = Object.fromEntries(
      (await this.db.many<{ key: string; value: unknown }>('select key, value from request_answers where request_id = $1', [r.id])).map((a) => [a.key, a.value]),
    );
    const applicantQuestions = r.questions.filter((q) => q.answeredBy === 'APPLICANT');
    const allDocs = await this.db.many<RequestDocRow>('select is_applicable, required, status from request_documents where request_id = $1', [r.id]);
    const accepting = LINK_OPEN_STATUSES.includes(r.status);

    return {
      company: this.env.COMPANY_NAME,
      title: r.portal_title,
      processType: r.model_name,
      applicantName: r.applicant_name,
      code: r.code,
      status: r.status,
      accepting,
      submittedAt: r.submitted_at,
      deadline: r.deadline,
      submissionMode: r.submission_mode,
      message: this.requests.renderMessage(r, answers, r.questions),
      maxUploadMb: this.env.MAX_UPLOAD_MB,
      progress: computeProgress(allDocs),
      questions: applicantQuestions.map((q) => ({
        key: q.key,
        label: q.label,
        helpText: q.helpText,
        type: q.type,
        options: q.options,
        required: q.required,
        section: q.section,
        value: answers[q.key] ?? null,
      })),
      documents: docs.map((d) => ({
        id: d.id,
        section: d.section,
        name: d.name,
        description: d.description,
        kind: d.kind,
        required: d.required,
        allowMultiple: d.allow_multiple,
        maxFiles: d.max_files,
        bothSides: d.both_sides,
        isCombined: d.is_combined,
        awaitingAnswer: d.awaiting_answer && !d.is_applicable,
        status: d.status,
        naRequested: d.na_requested,
        applicantNote: d.applicant_note,
        textValue: d.text_value,
        rejection:
          d.status === 'REJEITADO'
            ? { reason: REJECTION_REASONS[d.rejection_reason as RejectionReason] ?? d.rejection_reason, note: d.rejection_note }
            : null,
        files: files
          .filter((f) => f.request_document_id === d.id)
          .map((f) => ({ id: f.id, name: f.original_name, size: f.size_bytes, side: f.side, createdAt: f.created_at })),
      })),
    };
  }

  async submit(token: string, actor: Actor) {
    const r = await this.resolve(token, true);
    const docs = await this.db.many<RequestDocRow>('select * from request_documents where request_id = $1', [r.id]);
    const missing = docs.filter((d) => d.is_applicable && d.required && (d.status === 'PENDENTE' || d.status === 'REJEITADO'));
    const unanswered = (await this.requests.unansweredRequired(r.id)).filter((q) => q.answeredBy === 'APPLICANT');
    if (missing.length || unanswered.length) {
      return {
        ok: false,
        missing: missing.map((d) => d.name),
        unanswered: unanswered.map((q) => q.label),
      };
    }
    await this.db.exec('update requests set submitted_at = now() where id = $1', [r.id]);
    await this.audit.log(actor, 'APPLICANT_SUBMITTED', { requestId: r.id });

    // notifica o responsável interno
    const to =
      (r.responsible_user_id
        ? (await this.db.maybe<{ email: string }>('select email::text as email from users where id = $1 and active', [r.responsible_user_id]))?.email
        : null) ?? this.env.DEFAULT_NOTIFY_EMAIL;
    if (to) {
      const p = computeProgress(docs);
      const res = await this.email.send(
        'DOCUMENTATION_COMPLETE',
        to,
        { processType: r.model_name, applicantName: r.applicant_name, approved: p.received, total: p.total, panelUrl: `${this.env.APP_URL}/solicitacoes/${r.id}` },
        { requestId: r.id },
      );
      await this.audit.log({ type: 'SYSTEM' }, res.ok ? 'EMAIL_SENT' : 'EMAIL_FAILED', {
        requestId: r.id,
        details: { template: 'DOCUMENTATION_COMPLETE', to, error: res.error },
      });
    }
    return { ok: true };
  }
}
