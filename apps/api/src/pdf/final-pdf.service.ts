import { BadRequestException, Inject, Injectable, Logger } from '@nestjs/common';
import { readFile } from 'node:fs/promises';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { Actor, AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { FilesService } from '../files/files.service';
import { buildFinalPdf, FinalSection } from '../domain/pdf-builder';
import { blockingReason, computeProgress } from '../domain/status';
import { answerLabel, isAnswered } from '../domain/rules-engine';
import { buildOutputFileName, formatDocument } from '../domain/text';
import { RequestDocRow, RequestsService } from '../requests/requests.service';

/** Gera o PDF consolidado, armazena, envia por e-mail e finaliza o processo. */
@Injectable()
export class FinalPdfService {
  private readonly logger = new Logger(FinalPdfService.name);
  private logo: Buffer | null | undefined;

  constructor(
    private readonly db: Db,
    private readonly files: FilesService,
    private readonly requests: RequestsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  private async getLogo() {
    if (this.logo === undefined) this.logo = await readFile(this.env.COMPANY_LOGO_PATH).catch(() => null);
    return this.logo;
  }

  async generate(requestId: string, actor: Actor & { type: 'USER' }, opts: { sendEmail: boolean }) {
    const r = await this.requests.getRow(requestId);
    if (!['APROVADO', 'FINALIZADO'].includes(r.status)) {
      throw new BadRequestException('O PDF final só pode ser gerado quando todos os documentos obrigatórios estiverem aprovados.');
    }
    const docs = await this.db.many<RequestDocRow>('select * from request_documents where request_id = $1 order by position, created_at', [requestId]);
    const unanswered = await this.requests.unansweredRequired(requestId);
    const block = blockingReason(docs, unanswered.length);
    if (block) throw new BadRequestException(block);

    const answers = await this.db.many<{ key: string; value: unknown }>('select key, value from request_answers where request_id = $1', [requestId]);
    const aMap = Object.fromEntries(answers.map((a) => [a.key, a.value]));

    let fileName = '';
    let fileId = '';
    try {
      const sections: FinalSection[] = [];
      let index = 1;
      for (const d of docs) {
        const s: FinalSection = { index: index++, name: d.name, section: d.section };
        if (!d.is_applicable) {
          s.notApplicable = true;
          s.naReason = d.na_reason;
        } else if (d.na_requested) {
          s.notApplicable = true;
          s.naReason = d.applicant_note ? `Informado pelo solicitante: ${d.applicant_note}` : 'Informado pelo solicitante';
        } else if (d.kind === 'TEXT') {
          s.textValue = d.text_value;
        } else if (d.status === 'APROVADO') {
          const pdf = await this.files.processedPdf(requestId, d.id);
          s.pdf = pdf?.buffer ?? null;
        } else {
          // opcional não enviado
          s.notApplicable = true;
          s.naReason = 'Não enviado (opcional)';
        }
        sections.push(s);
      }

      const info = r.questions
        .filter((q) => isAnswered(aMap[q.key]))
        .map((q) => ({ label: q.label, value: answerLabel(q, aMap[q.key]), section: q.section }));
      info.unshift(
        ...[
          { label: 'Telefone', value: r.applicant_phone ?? '', section: 'Solicitante' },
          { label: 'E-mail', value: r.applicant_email ?? '', section: 'Solicitante' },
        ].filter((x) => x.value),
      );

      const built = await buildFinalPdf({
        companyName: this.env.COMPANY_NAME,
        companyCnpj: this.env.COMPANY_CNPJ,
        processType: r.model_name,
        applicantName: r.applicant_name,
        applicantDocument: formatDocument(r.applicant_document) || '—',
        requestCode: r.code,
        date: new Date(),
        logoPng: await this.getLogo(),
        info,
        sections,
      });

      const vars: Record<string, string> = { nome: r.applicant_name, tipo: r.model_name, codigo: r.code };
      for (const q of r.questions) if (isAnswered(aMap[q.key])) vars[q.key] = answerLabel(q, aMap[q.key]);
      fileName = buildOutputFileName(r.output_file_pattern, vars);
      fileId = await this.files.storeFinal(requestId, fileName, built.buffer, built.pageCount, actor.userId);
      await this.db.exec('update requests set final_file_id = $2 where id = $1', [requestId, fileId]);
      await this.audit.log(actor, 'PDF_GENERATED', { requestId, entityType: 'file', entityId: fileId, details: { fileName, pages: built.pageCount, bytes: built.buffer.length } });

      let emailResult: { ok: boolean; error?: string } | null = null;
      if (opts.sendEmail) emailResult = await this.sendFinalEmail(requestId, actor, built.buffer, fileName);
      if (!opts.sendEmail || emailResult?.ok) await this.finalize(requestId, actor);
      return { fileId, fileName, pages: built.pageCount, email: emailResult };
    } catch (e) {
      if (e instanceof BadRequestException) throw e;
      const msg = e instanceof Error ? e.message : String(e);
      this.logger.error(`Falha ao gerar PDF de ${r.code}: ${msg}`);
      await this.audit.log(actor, 'PDF_FAILED', { requestId, details: { error: msg } });
      const to = await this.internalRecipient(r.responsible_user_id);
      if (to) {
        await this.email.send(
          'PROCESSING_ERROR',
          to,
          { processType: r.model_name, applicantName: r.applicant_name, error: msg, panelUrl: `${this.env.APP_URL}/solicitacoes/${requestId}` },
          { requestId },
        );
      }
      throw new BadRequestException(`Não foi possível gerar o PDF: ${msg}`);
    }
  }

  async sendFinalEmail(requestId: string, actor: Actor, buffer?: Buffer, fileName?: string) {
    const r = await this.requests.getRow(requestId);
    const to = r.notify_email ?? this.env.DEFAULT_NOTIFY_EMAIL;
    if (!to) throw new BadRequestException('Informe o e-mail de destino do PDF na solicitação.');
    if (!buffer) {
      if (!r.final_file_id) throw new BadRequestException('Gere o PDF final antes de enviar.');
      const f = await this.files.getFile(r.final_file_id);
      buffer = await this.files.read(f);
      fileName = f.original_name;
    }
    if (!buffer) throw new BadRequestException('Não foi possível ler o PDF final.');
    const docs = await this.db.many<RequestDocRow>('select is_applicable, required, status from request_documents where request_id = $1', [requestId]);
    const p = computeProgress(docs);
    const res = await this.email.send(
      'PDF_FINALIZED',
      to,
      { processType: r.model_name, applicantName: r.applicant_name, approved: p.approved, total: p.total, fileName },
      { requestId, attachments: [{ filename: fileName!, content: buffer, contentType: 'application/pdf' }] },
    );
    await this.audit.log(actor, res.ok ? 'EMAIL_SENT' : 'EMAIL_FAILED', {
      requestId,
      details: { template: 'PDF_FINALIZED', to, file: fileName, error: res.error },
    });
    return res;
  }

  async finalize(requestId: string, actor: Actor) {
    const r = await this.requests.getRow(requestId);
    if (r.status === 'FINALIZADO') return;
    if (r.status !== 'APROVADO') throw new BadRequestException('Somente processos aprovados podem ser finalizados.');
    if (!r.final_file_id) throw new BadRequestException('Gere o PDF final antes de finalizar.');
    await this.db.tx(async (c) => {
      await this.db.exec('update requests set finalized_at = now(), link_active = false where id = $1', [requestId], c);
      await this.audit.log(actor, 'REQUEST_FINALIZED', { requestId }, c);
      await this.requests.recalc(requestId, actor, c);
    });
  }

  private async internalRecipient(userId: string | null) {
    if (userId) {
      const u = await this.db.maybe<{ email: string }>('select email::text as email from users where id = $1 and active', [userId]);
      if (u) return u.email;
    }
    return this.env.DEFAULT_NOTIFY_EMAIL ?? null;
  }
}
