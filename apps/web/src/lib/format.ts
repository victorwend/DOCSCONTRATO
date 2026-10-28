export const REQUEST_STATUS: Record<string, { label: string; className: string }> = {
  RASCUNHO: { label: 'Rascunho', className: 'bg-neutral-100 text-neutral-700 ring-neutral-300' },
  AGUARDANDO_DOCUMENTOS: { label: 'Aguardando documentos', className: 'bg-amber-50 text-amber-800 ring-amber-300' },
  EM_CONFERENCIA: { label: 'Em conferência', className: 'bg-sky-50 text-sky-800 ring-sky-300' },
  PENDENCIA: { label: 'Com pendência', className: 'bg-red-50 text-red-800 ring-red-300' },
  APROVADO: { label: 'Aprovado', className: 'bg-emerald-50 text-emerald-800 ring-emerald-300' },
  FINALIZADO: { label: 'Finalizado', className: 'bg-ink text-brand ring-ink' },
  CANCELADO: { label: 'Cancelado', className: 'bg-neutral-100 text-neutral-500 ring-neutral-300 line-through' },
  EXPIRADO: { label: 'Expirado', className: 'bg-orange-50 text-orange-800 ring-orange-300' },
};

export const DOC_STATUS: Record<string, { label: string; className: string; dot: string }> = {
  PENDENTE: { label: 'Pendente', className: 'bg-amber-50 text-amber-800 ring-amber-300', dot: 'bg-amber-400' },
  RECEBIDO: { label: 'Recebido', className: 'bg-sky-50 text-sky-800 ring-sky-300', dot: 'bg-sky-500' },
  EM_ANALISE: { label: 'Em análise', className: 'bg-indigo-50 text-indigo-800 ring-indigo-300', dot: 'bg-indigo-500' },
  APROVADO: { label: 'Aprovado', className: 'bg-emerald-50 text-emerald-800 ring-emerald-300', dot: 'bg-emerald-500' },
  REJEITADO: { label: 'Rejeitado', className: 'bg-red-50 text-red-800 ring-red-300', dot: 'bg-red-500' },
};

export const REJECTION_REASONS: Array<{ value: string; label: string }> = [
  { value: 'ILEGIVEL', label: 'Documento ilegível' },
  { value: 'CORTADO', label: 'Documento cortado' },
  { value: 'INCOMPLETO', label: 'Documento incompleto' },
  { value: 'INCORRETO', label: 'Documento incorreto' },
  { value: 'VENCIDO', label: 'Documento vencido' },
  { value: 'OUTRO', label: 'Outro' },
];

export const AUDIT_LABELS: Record<string, string> = {
  REQUEST_CREATED: 'Solicitação criada',
  REQUEST_UPDATED: 'Solicitação atualizada',
  LINK_GENERATED: 'Link gerado',
  LINK_REGENERATED: 'Novo link gerado (anterior invalidado)',
  LINK_DEACTIVATED: 'Link desativado',
  LINK_REACTIVATED: 'Link reativado',
  LINK_SENT: 'Link enviado',
  LINK_ACCESSED: 'Link acessado pelo solicitante',
  DOCUMENT_UPLOADED: 'Documento enviado',
  DOCUMENT_RESUBMITTED: 'Documento reenviado',
  DOCUMENT_FILE_REMOVED: 'Arquivo removido pelo solicitante',
  DOCUMENT_TEXT_SUBMITTED: 'Informação enviada',
  DOCUMENT_NA_REQUESTED: 'Solicitante informou "não se aplica"',
  DOCUMENT_REVIEW_STARTED: 'Documento em análise',
  DOCUMENT_APPROVED: 'Documento aprovado',
  DOCUMENT_REJECTED: 'Documento rejeitado',
  DOCUMENT_ADDED: 'Documento adicionado',
  DOCUMENT_REMOVED: 'Documento removido',
  DOCUMENT_UPDATED: 'Checklist alterado',
  DOCUMENT_MARKED_NA: 'Documento marcado como N/A',
  DOCUMENT_UNMARKED_NA: 'Documento voltou a ser solicitado',
  ANSWERS_UPDATED: 'Respostas atualizadas',
  APPLICANT_SUBMITTED: 'Solicitante finalizou o envio',
  STATUS_CHANGED: 'Status alterado',
  FILE_DOWNLOADED: 'Arquivo baixado',
  PDF_GENERATED: 'PDF gerado',
  PDF_FAILED: 'Falha ao gerar PDF',
  EMAIL_SENT: 'E-mail enviado',
  EMAIL_FAILED: 'Falha no envio de e-mail',
  REQUEST_FINALIZED: 'Processo finalizado',
  REQUEST_CANCELLED: 'Solicitação cancelada',
  REQUEST_REOPENED: 'Solicitação reaberta',
  FILES_PURGED: 'Arquivos removidos (retenção)',
};

export function fmtDate(v?: string | Date | null) {
  if (!v) return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) {
    const [y, m, d] = v.split('-');
    return `${d}/${m}/${y}`;
  }
  return new Date(v).toLocaleDateString('pt-BR');
}

export function fmtDateTime(v?: string | Date | null) {
  if (!v) return '—';
  return new Date(v).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

export function fmtDoc(v?: string | null) {
  const d = (v ?? '').replace(/\D/g, '');
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return v ?? '';
}

export function maskDocInput(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 14);
  if (d.length <= 11) {
    return d.replace(/(\d{3})(\d)/, '$1.$2').replace(/(\d{3})\.(\d{3})(\d)/, '$1.$2.$3').replace(/(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
  }
  return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{0,2})/, '$1.$2.$3/$4-$5');
}

export function maskPhone(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 11);
  if (d.length <= 2) return d;
  if (d.length <= 6) return `(${d.slice(0, 2)}) ${d.slice(2)}`;
  if (d.length <= 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
}

export function fmtBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function answerText(q: { type: string; options?: any[] }, v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  const opt = (q.options ?? []).find((o: any) => typeof o === 'object' && String(o.value) === String(v));
  if (opt) return opt.label;
  if (typeof v === 'boolean') return v ? 'Sim' : 'Não';
  return String(v);
}

export function todayPlus(days: number) {
  const d = new Date(Date.now() + days * 86400000);
  return d.toLocaleDateString('sv-SE');
}
