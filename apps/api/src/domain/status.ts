/** Regras de status da solicitação e cálculo de progresso (puro). */

export const REQUEST_STATUSES = [
  'RASCUNHO',
  'AGUARDANDO_DOCUMENTOS',
  'EM_CONFERENCIA',
  'PENDENCIA',
  'APROVADO',
  'FINALIZADO',
  'CANCELADO',
  'EXPIRADO',
] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

export const DOCUMENT_STATUSES = ['PENDENTE', 'RECEBIDO', 'EM_ANALISE', 'APROVADO', 'REJEITADO'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const REJECTION_REASONS = {
  ILEGIVEL: 'Documento ilegível',
  CORTADO: 'Documento cortado',
  INCOMPLETO: 'Documento incompleto',
  INCORRETO: 'Documento incorreto',
  VENCIDO: 'Documento vencido',
  OUTRO: 'Outro',
} as const;
export type RejectionReason = keyof typeof REJECTION_REASONS;

export interface DocState {
  is_applicable: boolean;
  required: boolean;
  status: DocumentStatus;
}

export interface Progress {
  total: number; // documentos aplicáveis
  required: number;
  approved: number;
  received: number; // enviados (qualquer status diferente de PENDENTE)
  pending: number;
  inReview: number; // RECEBIDO + EM_ANALISE
  rejected: number;
  notApplicable: number;
  percent: number; // aprovados / aplicáveis
  sentPercent: number;
}

export function computeProgress(docs: DocState[]): Progress {
  const applicable = docs.filter((d) => d.is_applicable);
  const count = (s: DocumentStatus[]) => applicable.filter((d) => s.includes(d.status)).length;
  const total = applicable.length;
  const approved = count(['APROVADO']);
  const pending = count(['PENDENTE']);
  return {
    total,
    required: applicable.filter((d) => d.required).length,
    approved,
    received: total - pending,
    pending,
    inReview: count(['RECEBIDO', 'EM_ANALISE']),
    rejected: count(['REJEITADO']),
    notApplicable: docs.length - total,
    percent: total ? Math.round((approved / total) * 100) : 0,
    sentPercent: total ? Math.round(((total - pending) / total) * 100) : 0,
  };
}

export interface StatusInput {
  linkGenerated: boolean;
  linkExpiresAt: Date | null;
  cancelledAt: Date | null;
  finalizedAt: Date | null;
  docs: DocState[];
  unansweredRequiredQuestions: number;
  now?: Date;
}

/**
 * Status derivado do estado dos documentos — chamado após qualquer alteração.
 *   CANCELADO/FINALIZADO são terminais; RASCUNHO até gerar o link.
 */
export function computeRequestStatus(i: StatusInput): RequestStatus {
  if (i.cancelledAt) return 'CANCELADO';
  if (i.finalizedAt) return 'FINALIZADO';
  if (!i.linkGenerated) return 'RASCUNHO';

  const docs = i.docs.filter((d) => d.is_applicable);
  const required = docs.filter((d) => d.required);
  const optionalUploaded = docs.filter((d) => !d.required && d.status !== 'PENDENTE');

  if (docs.some((d) => d.status === 'REJEITADO')) return 'PENDENCIA';

  const allRequiredApproved = required.every((d) => d.status === 'APROVADO');
  const optionalReviewed = optionalUploaded.every((d) => d.status === 'APROVADO');
  if (docs.length > 0 && allRequiredApproved && optionalReviewed && i.unansweredRequiredQuestions === 0) {
    return 'APROVADO';
  }

  const now = i.now ?? new Date();
  if (i.linkExpiresAt && i.linkExpiresAt.getTime() < now.getTime()) return 'EXPIRADO';

  const allRequiredSent = required.every((d) => d.status !== 'PENDENTE');
  if (allRequiredSent && i.unansweredRequiredQuestions === 0 && docs.some((d) => d.status !== 'PENDENTE')) {
    return 'EM_CONFERENCIA';
  }
  return 'AGUARDANDO_DOCUMENTOS';
}

/** Motivo pelo qual o PDF final ainda não pode ser gerado (null = pode gerar). */
export function blockingReason(docs: Array<DocState & { name: string }>, unansweredRequiredQuestions: number): string | null {
  const app = docs.filter((d) => d.is_applicable);
  if (app.length === 0) return 'A solicitação não possui documentos.';
  const pend = app.filter((d) => d.required && d.status !== 'APROVADO');
  if (pend.length) return `Documentos obrigatórios não aprovados: ${pend.map((d) => d.name).join(', ')}`;
  const opt = app.filter((d) => !d.required && d.status !== 'PENDENTE' && d.status !== 'APROVADO');
  if (opt.length) return `Documentos opcionais enviados aguardando conferência: ${opt.map((d) => d.name).join(', ')}`;
  if (unansweredRequiredQuestions > 0) return `Há ${unansweredRequiredQuestions} pergunta(s) obrigatória(s) sem resposta.`;
  return null;
}

/** Status do documento que aceitam (re)envio pelo solicitante. */
export function canApplicantUpload(status: DocumentStatus): boolean {
  return status === 'PENDENTE' || status === 'REJEITADO' || status === 'RECEBIDO';
}

export const LINK_OPEN_STATUSES: RequestStatus[] = ['AGUARDANDO_DOCUMENTOS', 'EM_CONFERENCIA', 'PENDENCIA'];
