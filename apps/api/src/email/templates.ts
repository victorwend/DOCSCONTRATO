/** Templates de e-mail (texto + HTML). Mantidos simples para boa entregabilidade. */

export type TemplateName =
  | 'REQUEST_CREATED'
  | 'DOCUMENT_REJECTED'
  | 'DOCUMENTATION_COMPLETE'
  | 'PDF_FINALIZED'
  | 'PROCESSING_ERROR';

export interface Rendered {
  subject: string;
  text: string;
  html: string;
}

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function layout(title: string, bodyHtml: string, companyName: string) {
  return `<!doctype html><html lang="pt-BR"><body style="margin:0;background:#f4f4f2;font-family:Arial,Helvetica,sans-serif;color:#1f1f1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px;overflow:hidden">
<tr><td style="background:#1f1f1f;padding:16px 24px;border-bottom:4px solid #fce94f"><span style="color:#fce94f;font-weight:bold;letter-spacing:1px">${esc(companyName)}</span><span style="color:#ffffff"> · PAVIDEZ DOCS</span></td></tr>
<tr><td style="padding:24px"><h1 style="font-size:18px;margin:0 0 16px">${esc(title)}</h1>${bodyHtml}</td></tr>
<tr><td style="padding:16px 24px;background:#fafaf8;color:#777;font-size:12px">Mensagem automática do PAVIDEZ DOCS. Não responda este e-mail.</td></tr>
</table></td></tr></table></body></html>`;
}

const p = (t: string) => `<p style="margin:0 0 12px;line-height:1.5">${esc(t).replace(/\n/g, '<br>')}</p>`;
const btn = (url: string, label: string) =>
  `<p style="margin:20px 0"><a href="${esc(url)}" style="background:#fce94f;color:#1f1f1f;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px;display:inline-block">${esc(label)}</a></p>`;

export interface TemplateVars {
  companyName: string;
  processType: string;
  applicantName: string;
  link?: string;
  message?: string;
  documentName?: string;
  rejectionReason?: string;
  rejectionNote?: string | null;
  approved?: number;
  total?: number;
  panelUrl?: string;
  fileName?: string;
  error?: string;
  deadline?: string | null;
}

export function renderTemplate(name: TemplateName, v: TemplateVars): Rendered {
  switch (name) {
    case 'REQUEST_CREATED': {
      const subject = `[PAVIDEZ DOCS] Envio de documentos - ${v.processType}`;
      const text = `${v.message ?? `Olá, ${v.applicantName}.`}\n\nEnvie seus documentos pelo link:\n${v.link}\n${v.deadline ? `\nPrazo: ${v.deadline}\n` : ''}\nAtenciosamente,\n${v.companyName}`;
      const html = layout(
        'Envio de documentos',
        `${p(v.message ?? `Olá, ${v.applicantName}.`)}${btn(v.link!, 'ENVIAR DOCUMENTOS')}${v.deadline ? p(`Prazo: ${v.deadline}`) : ''}${p(`Se o botão não funcionar, copie o endereço: ${v.link}`)}`,
        v.companyName,
      );
      return { subject, text, html };
    }
    case 'DOCUMENT_REJECTED': {
      const subject = `[PAVIDEZ DOCS] Documento precisa ser reenviado - ${v.documentName}`;
      const lines = [
        `Olá, ${v.applicantName}.`,
        '',
        `Documento: ${v.documentName}`,
        'Status: Rejeitado',
        `Motivo: ${v.rejectionReason}`,
        ...(v.rejectionNote ? [`Observação: ${v.rejectionNote}`] : []),
        '',
        'Reenvie o documento pelo link:',
        v.link ?? '',
        '',
        `Atenciosamente,\n${v.companyName}`,
      ];
      const html = layout(
        'Documento precisa ser reenviado',
        `${p(`Olá, ${v.applicantName}.`)}
        <table role="presentation" cellpadding="6" style="border-collapse:collapse;margin:0 0 12px;font-size:14px">
          <tr><td style="color:#777">Documento</td><td><b>${esc(v.documentName ?? '')}</b></td></tr>
          <tr><td style="color:#777">Status</td><td style="color:#b42318"><b>Rejeitado</b></td></tr>
          <tr><td style="color:#777">Motivo</td><td>${esc(v.rejectionReason ?? '')}</td></tr>
          ${v.rejectionNote ? `<tr><td style="color:#777">Observação</td><td>${esc(v.rejectionNote)}</td></tr>` : ''}
        </table>${v.link ? btn(v.link, 'REENVIAR DOCUMENTO') : ''}`,
        v.companyName,
      );
      return { subject, text: lines.join('\n'), html };
    }
    case 'DOCUMENTATION_COMPLETE': {
      const subject = `[PAVIDEZ DOCS] Documentos enviados para conferência - ${v.applicantName}`;
      const text = `Olá,\n\n${v.applicantName} concluiu o envio dos documentos do processo ${v.processType}.\nEnviados: ${v.approved}/${v.total}.\n\nAbra o processo para conferir:\n${v.panelUrl}\n\nPAVIDEZ DOCS`;
      const html = layout(
        'Documentos enviados para conferência',
        `${p(`${v.applicantName} concluiu o envio dos documentos do processo ${v.processType}.`)}${p(`Enviados: ${v.approved}/${v.total}.`)}${btn(v.panelUrl!, 'ABRIR PROCESSO')}`,
        v.companyName,
      );
      return { subject, text, html };
    }
    case 'PDF_FINALIZED': {
      const subject = `[PAVIDEZ DOCS] Documentação concluída - ${v.applicantName}`;
      const text = `Olá,\n\nA documentação referente ao processo ${v.processType} de ${v.applicantName} foi recebida e conferida.\n\nDocumentos:\n${v.approved}/${v.total} aprovados.\n\nO PDF consolidado está anexado.\n\nAtenciosamente,\nPAVIDEZ DOCS`;
      const html = layout(
        'Documentação concluída',
        `${p('Olá,')}${p(`A documentação referente ao processo ${v.processType} de ${v.applicantName} foi recebida e conferida.`)}${p(`Documentos:\n${v.approved}/${v.total} aprovados.`)}${p(`O PDF consolidado está anexado (${v.fileName}).`)}${p('Atenciosamente,\nPAVIDEZ DOCS')}`,
        v.companyName,
      );
      return { subject, text, html };
    }
    case 'PROCESSING_ERROR': {
      const subject = `[PAVIDEZ DOCS] Erro no processamento - ${v.applicantName}`;
      const text = `Ocorreu um erro ao processar a documentação de ${v.applicantName} (${v.processType}).\n\nErro: ${v.error}\n\n${v.panelUrl ?? ''}`;
      const html = layout(
        'Erro no processamento',
        `${p(`Ocorreu um erro ao processar a documentação de ${v.applicantName} (${v.processType}).`)}${p(`Erro: ${v.error}`)}${v.panelUrl ? btn(v.panelUrl, 'ABRIR PROCESSO') : ''}`,
        v.companyName,
      );
      return { subject, text, html };
    }
  }
}
