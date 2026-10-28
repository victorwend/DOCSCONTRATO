#!/usr/bin/env node
/**
 * Teste ponta a ponta dos critérios de aceite (API).
 * Pré-requisitos: banco migrado + seed, API rodando (npm run dev) e .env com EMAIL_DRIVER=log.
 *
 *   node scripts/e2e.mjs [http://localhost:3000] [admin@pavidez.com.br] [senha]
 *
 * Usa o Next (porta 3000) por padrão, validando também o proxy /api.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

const BASE = process.argv[2] ?? 'http://localhost:3000';
const EMAIL = process.argv[3] ?? process.env.ADMIN_EMAIL ?? 'admin@pavidez.com.br';
const PASSWORD = process.argv[4] ?? process.env.ADMIN_PASSWORD ?? 'TroqueEstaSenha123';

let cookie = '';
let passed = 0;
const ok = (cond, msg) => {
  if (!cond) {
    console.error(`✗ ${msg}`);
    process.exit(1);
  }
  passed++;
  console.log(`✓ ${msg}`);
};

async function call(path, { method, body, form, auth = true, raw } = {}) {
  const headers = {};
  if (auth && cookie) headers.cookie = cookie;
  if (body !== undefined) headers['content-type'] = 'application/json';
  headers.origin = BASE;
  const res = await fetch(`${BASE}/api${path}`, {
    method: method ?? (body !== undefined || form ? 'POST' : 'GET'),
    headers,
    body: form ?? (body !== undefined ? JSON.stringify(body) : undefined),
    redirect: 'manual',
  });
  const set = res.headers.get('set-cookie');
  if (set && set.includes('pd_session=')) cookie = set.split(';')[0];
  if (raw) return res;
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }
  return { status: res.status, data };
}

// --- arquivos de teste gerados em memória ---------------------------------
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function png(w = 400, h = 300, rgb = [30, 90, 200]) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => rgb[i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
function pdf(pages = 2) {
  // PDF mínimo válido com N páginas
  const objs = [];
  const kids = [];
  for (let i = 0; i < pages; i++) kids.push(`${3 + i * 2} 0 R`);
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages} >>`);
  for (let i = 0; i < pages; i++) {
    const stream = `BT /F1 24 Tf 72 720 Td (Pagina ${i + 1}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents ${4 + i * 2} 0 R /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> >>`);
    objs.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = '%PDF-1.4\n';
  const offsets = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
function form(files, extra = {}) {
  const fd = new FormData();
  for (const f of files) fd.append('files', new Blob([f.data], { type: f.type }), f.name);
  for (const [k, v] of Object.entries(extra)) fd.append(k, v);
  return fd;
}

// ---------------------------------------------------------------------------
console.log(`PAVIDEZ DOCS — teste ponta a ponta em ${BASE}\n`);

// 1. login
let r = await call('/auth/login', { body: { email: EMAIL, password: 'errada' }, auth: false });
ok(r.status === 401, 'login com senha errada é recusado');
r = await call('/auth/login', { body: { email: EMAIL, password: PASSWORD }, auth: false });
ok(r.status === 200 && cookie, '1. login no painel');
r = await call('/requests', { auth: false });
ok(r.status === 401, 'API exige autenticação');

// 2. criar modelo (configuração, sem alterar código)
r = await call('/models', {
  body: {
    name: `Contrato de aluguel de veículo E2E ${Date.now()}`,
    category: 'LOCACAO',
    defaultMessage: 'Olá, [NOME]. Envie os documentos do [VEICULO].',
    outputFilePattern: 'ALUGUEL_[VEICULO]_[NOME]',
    items: [
      { ref: 'crlv', name: 'CRLV' },
      { ref: 'cnh', name: 'CNH', bothSides: true },
      { ref: 'cpf', name: 'CPF' },
      { ref: 'cnpj', name: 'Cartão CNPJ' },
      { ref: 'end', name: 'Comprovante de endereço', required: false },
      { ref: 'banco', name: 'Dados bancários', kind: 'TEXT' },
      { ref: 'prop', name: 'Proposta' },
    ],
    questions: [
      { ref: 'q1', key: 'tipo_pessoa', label: 'Tipo de pessoa', type: 'SELECT', options: [{ value: 'PF', label: 'PF' }, { value: 'PJ', label: 'PJ' }], answeredBy: 'APPLICANT', required: true, mapsTo: 'request.person_type' },
      { ref: 'q2', key: 'veiculo', label: 'Veículo', type: 'TEXT', answeredBy: 'INTERNAL', required: true },
    ],
    rules: [{ questionRef: 'q1', operator: 'EQUALS', value: 'PJ', action: 'SHOW_ITEM', targetRef: 'cnpj' }],
  },
});
ok(r.status === 201 || r.status === 200, '2. criar modelo');
const modelId = r.data.id;
r = await call(`/models/${modelId}`);
ok(r.data.items.length === 7 && r.data.rules.length === 1, 'modelo salvo com itens e regras');

// editar modelo
const m = r.data;
r = await call(`/models/${modelId}`, {
  method: 'PUT',
  body: {
    name: m.name, category: m.category, portalTitle: m.portal_title, defaultMessage: m.default_message, defaultDeadlineDays: 5,
    submissionMode: 'SEPARATE', singleFileLabel: m.single_file_label, outputFilePattern: m.output_file_pattern, active: true,
    items: m.items.map((i) => ({ id: i.id, ref: i.id, section: i.section, name: i.name, description: i.description, kind: i.kind, required: i.required, allowMultiple: i.allow_multiple, maxFiles: i.max_files, bothSides: i.both_sides })),
    questions: m.questions.map((q) => ({ id: q.id, ref: q.id, key: q.key, label: q.label, helpText: q.help_text, type: q.type, options: q.options, required: q.required, answeredBy: q.answered_by, section: q.section, mapsTo: q.maps_to })),
    rules: m.rules.map((x) => ({ questionRef: x.question_id, operator: x.operator, value: x.value, action: x.action, targetRef: x.target_item_id })),
  },
});
ok(r.status === 200, 'editar modelo');

// 3/4. solicitação a partir do modelo, com checklist personalizado
r = await call('/requests/preview', { body: { modelId, answers: {} } });
const cnpjItem = r.data.items.find((i) => i.name === 'Cartão CNPJ');
ok(cnpjItem.evaluation.awaitingAnswer === true, 'item condicional aguarda resposta');
const items = r.data.items
  .filter((i) => i.name !== 'Proposta') // remove um documento
  .map((i) => ({ modelItemId: i.id, section: i.section, name: i.name, description: i.description, kind: i.kind, required: i.required, allowMultiple: i.allow_multiple, bothSides: i.both_sides, maxFiles: i.max_files }));
items.push({ name: 'Foto do veículo', kind: 'FILE', required: true, allowMultiple: true, maxFiles: 5 }); // adiciona
r = await call('/requests', {
  body: {
    modelId,
    applicant: { name: 'João da Silva', document: '529.982.247-25', phone: '(38) 99999-0000', email: 'joao@example.com' },
    notifyEmail: 'rh@example.com',
    answers: { veiculo: 'Caminhão-pipa' },
    items,
    generateLink: true,
  },
});
ok(r.status === 201 || r.status === 200, '3. criar solicitação a partir do modelo');
const reqId = r.data.id;
const link = r.data.link;
ok(/\/enviar\/[A-Za-z0-9_-]{32}$/.test(link), '5. link único gerado');
const token = link.split('/').pop();
r = await call(`/requests/${reqId}`);
ok(r.data.documents.length === 7 && r.data.documents.some((d) => d.name === 'Foto do veículo') && !r.data.documents.some((d) => d.name === 'Proposta'), '4. checklist personalizado');
ok(r.data.request.status === 'AGUARDANDO_DOCUMENTOS', 'status AGUARDANDO_DOCUMENTOS');
ok(r.data.renderedMessage.includes('Caminhão-pipa') && r.data.renderedMessage.includes('João da Silva'), 'mensagem com variáveis');

// 6. abrir o link sem login
const saved = cookie;
cookie = '';
r = await call(`/portal/${token}`, { auth: false });
ok(r.status === 200 && r.data.applicantName === 'João da Silva', '6. link abre sem login');
ok(!JSON.stringify(r.data).includes('52998224725'), 'portal não expõe CPF');
r = await call(`/portal/${'x'.repeat(32)}`, { auth: false });
ok(r.status === 404, 'token inválido é recusado');
r = await call(`/requests/${reqId}`, { auth: false });
ok(r.status === 401, 'portal não dá acesso ao painel');

// regra condicional respondida pelo solicitante
r = await call(`/portal/${token}/answers`, { method: 'PUT', body: { answers: { tipo_pessoa: 'PF' } }, auth: false });
ok(r.status === 200, 'solicitante responde pergunta');
r = await call(`/portal/${token}`, { auth: false });
const docs = Object.fromEntries(r.data.documents.map((d) => [d.name, d]));
ok(!docs['Cartão CNPJ'], 'PF: Cartão CNPJ não é solicitado');

// 7. envio de documentos
const up = (name, files, extra) => call(`/portal/${token}/documents/${docs[name].id}/files`, { form: form(files, extra), auth: false });
r = await up('CRLV', [{ name: 'crlv.pdf', type: 'application/pdf', data: pdf(2) }]);
ok(r.status === 201 || r.status === 200, '7. upload de PDF');
r = await up('CNH', [{ name: 'frente.png', type: 'image/png', data: png() }], { sides: JSON.stringify(['FRONT']) });
ok(r.status < 300, 'upload frente');
r = await up('CNH', [{ name: 'verso.png', type: 'image/png', data: png(300, 400, [200, 60, 60]) }], { sides: JSON.stringify(['BACK']) });
ok(r.status < 300, 'upload verso');
r = await up('CPF', [{ name: 'cpf.jpg', type: 'image/jpeg', data: png() }]);
ok(r.status === 400, 'extensão que não corresponde ao conteúdo é recusada');
r = await up('CPF', [{ name: 'vazio.pdf', type: 'application/pdf', data: Buffer.alloc(0) }]);
ok(r.status === 400, 'arquivo vazio é recusado');
r = await up('CPF', [{ name: 'virus.exe', type: 'application/octet-stream', data: Buffer.from('MZ....') }]);
ok(r.status === 400, 'formato não aceito é recusado');
r = await up('CPF', [{ name: 'corrompido.pdf', type: 'application/pdf', data: Buffer.from('%PDF-1.4 lixo') }]);
ok(r.status === 400, 'PDF corrompido é recusado');
r = await up('CPF', [{ name: 'cpf.png', type: 'image/png', data: png() }]);
ok(r.status < 300, 'upload de imagem');
r = await up('Foto do veículo', [
  { name: 'f1.png', type: 'image/png', data: png() },
  { name: 'f2.png', type: 'image/png', data: png() },
]);
ok(r.status < 300, 'upload de múltiplos arquivos');
r = await call(`/portal/${token}/documents/${docs['Dados bancários'].id}/text`, { body: { value: 'Banco 237, ag 1234, cc 5678-9' }, auth: false });
ok(r.status === 200, 'item de texto enviado');
r = await call(`/portal/${token}/submit`, { method: 'POST', auth: false });
ok(r.data.ok === true, 'finalizar envio');

cookie = saved;
// 8. visualizar documentos no painel
r = await call(`/requests/${reqId}`);
ok(r.data.request.status === 'EM_CONFERENCIA', 'status EM_CONFERENCIA');
const d = Object.fromEntries(r.data.documents.map((x) => [x.name, x]));
const fileId = d['CRLV'].files[0].id;
r = await call(`/files/${fileId}/url`);
ok(r.status === 200 && r.data.url, '8. URL temporária para visualizar');
const fileRes = await call(r.data.url.replace(/^\/api/, ''), { raw: true, auth: false });
ok(fileRes.status === 200 && (await fileRes.arrayBuffer()).byteLength > 100, 'arquivo servido pela URL assinada');
const bad = await call(r.data.url.replace(/^\/api/, '').slice(0, -3) + 'abc', { raw: true, auth: false });
ok(bad.status === 403, 'URL adulterada é recusada');
r = await call(`/requests/${reqId}/documents/${d['CNH'].id}/pdf`);
ok(r.status === 200, 'PDF do documento (frente + verso)');

// 9/10/11. aprovar / rejeitar com motivo
const approve = (name) => call(`/requests/${reqId}/documents/${d[name].id}/approve`, { body: {} });
for (const n of ['CRLV', 'CNH', 'Dados bancários', 'Foto do veículo']) {
  r = await approve(n);
  ok(r.status === 200, `9. aprovar ${n}`);
}
r = await call(`/requests/${reqId}/documents/${d['CPF'].id}/reject`, { body: { reason: 'ILEGIVEL', note: 'Envie uma nova foto com melhor qualidade.' } });
ok(r.status === 200, '10/11. rejeitar com motivo');
r = await call(`/requests/${reqId}`);
ok(r.data.request.status === 'PENDENCIA', 'status PENDENCIA');
r = await call(`/requests/${reqId}/final-pdf`, { body: {} });
ok(r.status === 400, '14. PDF bloqueado com documento rejeitado');

// 12. reenvio
r = await call(`/portal/${token}`, { auth: false });
const cpf = r.data.documents.find((x) => x.name === 'CPF');
ok(cpf.status === 'REJEITADO' && cpf.rejection.reason === 'Documento ilegível', 'solicitante vê motivo da rejeição');
r = await call(`/portal/${token}/documents/${cpf.id}/files`, { form: form([{ name: 'cpf2.pdf', type: 'application/pdf', data: pdf(1) }]), auth: false });
ok(r.status < 300, '12. reenviar documento');
r = await call(`/requests/${reqId}`);
const cpfDoc = r.data.documents.find((x) => x.name === 'CPF');
ok(cpfDoc.files.length === 2 && cpfDoc.files.filter((f) => f.is_current).length === 1, 'arquivo anterior mantido no histórico');
r = await call(`/requests/${reqId}/documents/${cpfDoc.id}/approve`, { body: {} });
ok(r.status === 200, 'aprovar reenviado');

// 13. progresso
r = await call(`/requests/${reqId}`);
ok(r.data.progress.approved === 5 && r.data.progress.total === 6, `13. progresso ${r.data.progress.approved}/${r.data.progress.total}`);
ok(r.data.request.status === 'APROVADO', 'status APROVADO (opcional não enviado não bloqueia)');

// 15-18. PDF consolidado, armazenamento, e-mail
r = await call(`/requests/${reqId}/final-pdf`, { body: { sendEmail: true } });
ok(r.status === 200 && r.data.fileName === 'ALUGUEL_CAMINHAO_PIPA_JOAO_DA_SILVA.pdf', `15. PDF consolidado ${r.data.fileName} (${r.data.pages} págs.)`);
// capa(+info) + CRLV 2 + CNH 2 + CPF 1 + fotos 2
ok(r.data.pages >= 8, '16. todas as páginas na ordem do modelo');
ok(r.data.email?.ok === true, '18. e-mail enviado');
r = await call(`/requests/${reqId}`);
ok(r.data.finalFile && r.data.request.status === 'FINALIZADO', '17. PDF armazenado e processo FINALIZADO');
ok(r.data.emails.some((e) => e.template === 'PDF_FINALIZED' && e.status === 'SENT' && e.attachments.length === 1), 'e-mail registrado com anexo');

// 19. histórico
const actions = r.data.timeline.map((t) => t.action);
for (const a of ['REQUEST_CREATED', 'LINK_GENERATED', 'DOCUMENT_UPLOADED', 'DOCUMENT_APPROVED', 'DOCUMENT_REJECTED', 'DOCUMENT_RESUBMITTED', 'PDF_GENERATED', 'EMAIL_SENT', 'REQUEST_FINALIZED']) {
  ok(actions.includes(a), `19. histórico: ${a}`);
}

// 20. consulta posterior
r = await call(`/requests?q=Jo%C3%A3o&status=FINALIZADO`);
ok(r.data.rows.some((x) => x.id === reqId), '20. consultar processo finalizado');
r = await call(`/requests?document=52998224725`);
ok(r.data.rows.some((x) => x.id === reqId), 'filtro por CPF');
r = await call(`/portal/${token}/documents/${cpfDoc.id}/files`, { form: form([{ name: 'x.pdf', type: 'application/pdf', data: pdf(1) }]), auth: false });
ok(r.status === 403, 'processo finalizado não aceita novos envios');

// e-mail gravado (driver log)
try {
  const dir = new URL('../storage/emails/', import.meta.url);
  const emls = readdirSync(dir).filter((f) => f.endsWith('.eml'));
  const last = readFileSync(new URL(emls.sort().at(-1), dir), 'utf8');
  ok(last.includes('Documenta') && last.includes('application/pdf'), 'arquivo .eml com PDF anexado');
} catch {
  console.log('(pulando verificação do .eml — EMAIL_DRIVER não é "log" ou pasta diferente)');
}

console.log(`\n${passed} verificações OK.`);
