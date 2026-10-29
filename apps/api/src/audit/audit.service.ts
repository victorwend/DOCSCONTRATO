import { Injectable } from '@nestjs/common';
import { Db, Queryable } from '../db/pool';

export type Actor =
  | { type: 'USER'; userId: string; name: string; ip?: string | null; userAgent?: string | null }
  | { type: 'APPLICANT'; name?: string; ip?: string | null; userAgent?: string | null }
  | { type: 'SYSTEM' };

/** Ações registradas na linha do tempo da solicitação. */
export const AUDIT_LABELS: Record<string, string> = {
  REQUEST_CREATED: 'Solicitação criada',
  REQUEST_UPDATED: 'Solicitação atualizada',
  LINK_GENERATED: 'Link gerado',
  LINK_REGENERATED: 'Novo link gerado (o anterior foi invalidado)',
  LINK_DEACTIVATED: 'Link desativado',
  LINK_REACTIVATED: 'Link reativado',
  LINK_SENT: 'Link enviado',
  LINK_ACCESSED: 'Link acessado pelo solicitante',
  DOCUMENT_UPLOADED: 'Documento enviado',
  DOCUMENT_RESUBMITTED: 'Documento reenviado',
  DOCUMENT_FILE_REMOVED: 'Arquivo removido pelo solicitante',
  DOCUMENT_TEXT_SUBMITTED: 'Informação enviada',
  DOCUMENT_NA_REQUESTED: 'Solicitante informou que o documento não se aplica',
  DOCUMENT_REVIEW_STARTED: 'Documento em análise',
  DOCUMENT_APPROVED: 'Documento aprovado',
  DOCUMENT_REJECTED: 'Documento rejeitado',
  DOCUMENT_ADDED: 'Documento adicionado ao checklist',
  DOCUMENT_REMOVED: 'Documento removido do checklist',
  DOCUMENT_UPDATED: 'Documento alterado',
  DOCUMENT_MARKED_NA: 'Documento marcado como N/A',
  DOCUMENT_UNMARKED_NA: 'Documento voltou a ser solicitado',
  ANSWERS_UPDATED: 'Respostas atualizadas',
  APPLICANT_SUBMITTED: 'Solicitante finalizou o envio',
  STATUS_CHANGED: 'Status alterado',
  FILE_VIEWED: 'Arquivo visualizado',
  FILE_DOWNLOADED: 'Arquivo baixado',
  PDF_GENERATED: 'PDF gerado',
  PDF_FAILED: 'Falha ao gerar PDF',
  EMAIL_SENT: 'E-mail enviado',
  EMAIL_FAILED: 'Falha no envio de e-mail',
  WHATSAPP_SENT: 'Aviso enviado pelo WhatsApp',
  WHATSAPP_FAILED: 'Falha no aviso pelo WhatsApp',
  WHATSAPP_MANUAL: 'Aviso pelo WhatsApp aberto pelo RH',
  REQUEST_FINALIZED: 'Processo finalizado',
  REQUEST_CANCELLED: 'Solicitação cancelada',
  REQUEST_REOPENED: 'Solicitação reaberta',
  FILES_PURGED: 'Arquivos removidos pela política de retenção',
};

@Injectable()
export class AuditService {
  constructor(private readonly db: Db) {}

  async log(
    actor: Actor,
    action: string,
    opts: { requestId?: string | null; entityType?: string; entityId?: string; details?: Record<string, unknown> } = {},
    client?: Queryable,
  ) {
    const userId = actor.type === 'USER' ? actor.userId : null;
    const name = actor.type === 'USER' ? actor.name : actor.type === 'APPLICANT' ? actor.name ?? 'Solicitante' : 'Sistema';
    const ip = actor.type === 'SYSTEM' ? null : actor.ip ?? null;
    const ua = actor.type === 'SYSTEM' ? null : actor.userAgent?.slice(0, 400) ?? null;
    await this.db.exec(
      `insert into audit_logs (request_id, actor_type, actor_user_id, actor_name, action, entity_type, entity_id, details, ip, user_agent)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9::inet,$10)`,
      [
        opts.requestId ?? null,
        actor.type,
        userId,
        name,
        action,
        opts.entityType ?? null,
        opts.entityId ?? null,
        JSON.stringify(opts.details ?? {}),
        isIp(ip) ? ip : null,
        ua,
      ],
      client,
    );
  }
}

function isIp(ip: string | null): ip is string {
  return !!ip && (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) || /^[0-9a-f:]+$/i.test(ip));
}
