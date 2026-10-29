/**
 * Teste de integração da camada de serviços contra um PostgreSQL real (sem HTTP).
 * Requer banco migrado + seed:  DATABASE_URL=... npm run test:flow
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';

process.env.JWT_SECRET ??= 'x'.repeat(40);
process.env.TOKEN_ENCRYPTION_KEY ??= 'y'.repeat(40);
process.env.FILE_URL_SECRET ??= 'z'.repeat(40);
process.env.EMAIL_DRIVER = 'log';
process.env.NODE_ENV = 'test';
const storageDir = mkdtempSync(join(tmpdir(), 'pd-storage-'));
process.env.LOCAL_STORAGE_DIR = storageDir;
process.env.EMAIL_LOG_DIR = join(storageDir, 'emails');
process.env.DEFAULT_NOTIFY_EMAIL = 'rh@pavidez.test';

import { loadEnv } from '../src/config/env';
import { createPool, Db } from '../src/db/pool';
import { AuditService } from '../src/audit/audit.service';
import { EmailService } from '../src/email/email.service';
import { ModelsService } from '../src/models/models.service';
import { AnalysisService } from '../src/analysis/analysis.service';
import { RequestsService } from '../src/requests/requests.service';
import { ReviewService } from '../src/requests/review.service';
import { WhatsappService } from '../src/whatsapp/whatsapp.service';
import { FilesService } from '../src/files/files.service';
import { FinalPdfService } from '../src/pdf/final-pdf.service';
import { PortalService } from '../src/portal/portal.service';
import { JobsService } from '../src/jobs/jobs.service';
import { AuthService } from '../src/auth/auth.service';
import { LocalStorageDriver, verifyFileUrl } from '../src/storage/storage';
import { createRequestSchema } from '../src/requests/requests.schema';
import { modelSchema } from '../src/models/models.schema';

const env = loadEnv();
const db = new Db(createPool(env.DATABASE_URL, env.DATABASE_SSL));
const audit = new AuditService(db);
const email = new EmailService(env, db);
const models = new ModelsService(db);
const analysis = new AnalysisService(db);
const requests = new RequestsService(db, models, audit, email, env);
const storage = new LocalStorageDriver(storageDir);
const files = new FilesService(db, storage, env, audit, requests, analysis);
const review = new ReviewService(db, audit, requests, email, new WhatsappService(env), env);
const finalPdf = new FinalPdfService(db, files, requests, audit, email, env);
const portal = new PortalService(db, requests, audit, email, env);
const jobs = new JobsService(db, requests, audit, storage, env);
const auth = new AuthService(env, db);

let actor: { type: 'USER'; userId: string; name: string };
const applicant = { type: 'APPLICANT' as const, name: 'Solicitante', ip: '10.0.0.1', userAgent: 'test' };

const jpeg = (w = 900, h = 1200, color = '#336699') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).jpeg().toBuffer();
const png = () => sharp({ create: { width: 800, height: 600, channels: 4, background: '#ffcc00' } }).png().toBuffer();
async function pdf(pages: number) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`Pagina ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await d.save());
}
const file = (buffer: Buffer, originalname: string, mimetype: string) => ({ buffer, originalname, mimetype, size: buffer.length });
const tokenOf = (link: string) => link.split('/').pop()!;
const modelBySlug = async (slug: string) => models.get((await db.one<{ id: string }>('select id from document_models where slug = $1', [slug])).id);
async function itemsFor(modelId: string) {
  const p = await requests.preview(modelId, {});
  return p.items.map((i: any) => ({
    modelItemId: i.id, section: i.section, name: i.name, description: i.description, kind: i.kind, required: i.required,
    allowMultiple: i.allow_multiple, bothSides: i.both_sides, maxFiles: i.max_files,
  }));
}
const docsOf = async (id: string) => Object.fromEntries((await requests.detail(id)).documents.map((d: any) => [d.name, d]));

before(async () => {
  const admin = await db.one<{ id: string; name: string }>("select id, name from users where email = 'admin@pavidez.com.br'");
  actor = { type: 'USER', userId: admin.id, name: admin.name };
});
after(async () => {
  await db.pool.end();
  rmSync(storageDir, { recursive: true, force: true });
});

test('login local (bcrypt) e sessão', async () => {
  await assert.rejects(auth.validate('admin@pavidez.com.br', 'errada'));
  const u = await auth.validate('ADMIN@pavidez.com.br', process.env.ADMIN_PASSWORD ?? 'Pavidez2026');
  assert.equal(u.role, 'ADMIN');
  assert.ok(auth.sign(u).split('.').length === 3);
});

test('modelos iniciais do seed', async () => {
  const list = await models.list(false);
  const slugs = list.map((m: any) => m.slug);
  for (const s of ['admissao', 'contrato-carreteiro', 'transportador-pj', 'locacao-equipamentos']) assert.ok(slugs.includes(s), s);
  const adm = await modelBySlug('admissao');
  assert.equal(adm.items.length, 20);
  assert.equal(adm.items[0].name, 'Currículo');
  assert.equal(adm.items[19].kind, 'TEXT');
  const pj = await modelBySlug('transportador-pj');
  assert.equal(pj.rules.length, 8);
});

test('criar e editar modelo por configuração (sem código)', async () => {
  const input = modelSchema.parse({
    name: 'Contrato de aluguel de veículo (teste)',
    items: ['CRLV', 'CNH', 'CPF', 'CNPJ', 'Comprovante de endereço', 'Dados bancários', 'Proposta'].map((n, i) => ({ ref: `i${i}`, name: n })),
    questions: [{ ref: 'q', key: 'tipo_pessoa', label: 'Tipo', type: 'SELECT', options: [{ value: 'PF', label: 'PF' }, { value: 'PJ', label: 'PJ' }] }],
    rules: [{ questionRef: 'q', operator: 'EQUALS', value: 'PJ', action: 'SHOW_ITEM', targetRef: 'i3' }],
  });
  const id = await models.create(input, actor.userId);
  const m = await models.get(id);
  assert.equal(m.items.length, 7);
  assert.equal(m.rules[0].target_item_id, m.items[3].id);
  // edição: renomeia, reordena e remove um item, troca a chave da pergunta
  await models.update(
    id,
    modelSchema.parse({
      name: 'Contrato de aluguel de veículo (teste) v2',
      items: [m.items[1], m.items[0], m.items[3]].map((i) => ({ id: i.id, ref: i.id, name: i.name + '!', bothSides: i.name === 'CNH' })),
      questions: [{ id: m.questions[0].id, ref: m.questions[0].id, key: 'pessoa', label: 'Tipo', type: 'SELECT', options: m.questions[0].options }],
      rules: [{ questionRef: m.questions[0].id, operator: 'EQUALS', value: 'PJ', action: 'SHOW_ITEM', targetRef: m.items[3].id }],
    }),
  );
  const m2 = await models.get(id);
  assert.deepEqual(m2.items.map((i) => i.name), ['CNH!', 'CRLV!', 'CNPJ!']);
  assert.equal(m2.items[0].id, m.items[1].id, 'id preservado');
  assert.equal(m2.items[0].max_files, 2);
  assert.equal(m2.rules[0].question_key, 'pessoa');
  const dup = await models.duplicate(id, actor.userId);
  assert.equal((await models.get(dup)).items.length, 3);
});

test('fluxo completo: carreteiro (link, portal, upload, rejeição, reenvio, PDF, e-mail, histórico)', async () => {
  const model = await modelBySlug('contrato-carreteiro');
  const items = await itemsFor(model.id);
  items.push({ modelItemId: undefined as any, section: null, name: 'Foto do caminhão', description: null, kind: 'FILE', required: false, allowMultiple: true, bothSides: false, maxFiles: 5 });
  const dto = createRequestSchema.parse({
    modelId: model.id,
    applicant: { name: 'João da Silva', document: '529.982.247-25', phone: '(38) 99999-0000', email: 'joao@example.com' },
    items: items.filter((i) => i.name !== 'PIS/NIT'),
    generateLink: true,
    sendEmailToApplicant: true,
  });
  const created = await requests.create(dto, actor);
  assert.match(created.link!, /\/enviar\/[A-Za-z0-9_-]{32}$/);
  const token = tokenOf(created.link!);
  let det = await requests.detail(created.id);
  assert.equal(det.request.status, 'AGUARDANDO_DOCUMENTOS');
  assert.equal(det.documents.length, 8);
  assert.ok(!det.documents.some((d: any) => d.name === 'PIS/NIT'));
  assert.ok(det.emails.some((e: any) => e.template === 'REQUEST_CREATED' && e.status === 'SENT'));
  assert.ok(!('token_hash' in det.request));
  assert.equal(det.link, created.link);

  // portal
  const v = await portal.view(token, applicant);
  assert.equal(v.applicantName, 'João da Silva');
  assert.ok(!JSON.stringify(v).includes('52998224725'), 'portal não expõe CPF');
  assert.equal(v.questions.length, 11);
  await assert.rejects(portal.view('A'.repeat(32), applicant), /inválido/);

  const d = Object.fromEntries(v.documents.map((x: any) => [x.name, x]));
  await files.uploadToDocument(created.id, d['RG'].id, [file(await jpeg(), 'rg-frente.jpg', 'image/jpeg')], ['FRONT'], applicant, { byApplicant: true });
  await files.uploadToDocument(created.id, d['RG'].id, [file(await jpeg(1200, 900, '#aa3333'), 'rg-verso.jpg', 'image/jpeg')], ['BACK'], applicant, { byApplicant: true });
  // reenviar frente substitui só a frente
  await files.uploadToDocument(created.id, d['RG'].id, [file(await jpeg(), 'rg-frente2.jpg', 'image/jpeg')], ['FRONT'], applicant, { byApplicant: true });
  await assert.rejects(
    files.uploadToDocument(created.id, d['CPF'].id, [file(await png(), 'a.png', 'image/png'), file(await png(), 'b.png', 'image/png')], [], applicant, { byApplicant: true }),
    /apenas um arquivo/,
  );
  await assert.rejects(files.uploadToDocument(created.id, d['CPF'].id, [file(Buffer.from('%PDF-1.4 lixo'), 'x.pdf', 'application/pdf')], [], applicant, { byApplicant: true }), /corrompido/);
  for (const name of ['CPF', 'Comprovante de residência', 'CRLV', 'RNTRC/ANTT', 'Comprovante bancário']) {
    await files.uploadToDocument(created.id, d[name].id, [file(await pdf(name === 'CRLV' ? 2 : 1), `${name}.pdf`, 'application/pdf')], [], applicant, { byApplicant: true });
  }
  await files.uploadToDocument(created.id, d['CNH'].id, [file(await pdf(2), 'cnh.pdf', 'application/pdf')], [], applicant, { byApplicant: true });

  // perguntas obrigatórias pendentes impedem EM_CONFERENCIA
  det = await requests.detail(created.id);
  assert.equal(det.request.status, 'AGUARDANDO_DOCUMENTOS');
  let sub = await portal.submit(token, applicant);
  assert.equal(sub.ok, false);
  assert.ok(sub.unanswered!.includes('Placa'));
  await assert.rejects(requests.setAnswers(created.id, { numero_inexistente: 'x' }, 'APPLICANT', applicant));
  await requests.setAnswers(
    created.id,
    { nome_completo: 'João da Silva', cpf: '529.982.247-25', telefone: '38999990000', endereco: 'Rua A, 1', placa: 'abc-1d23', renavam: '123', marca_modelo: 'Volvo FH', ano: '2020', tipo_carroceria: 'Basculante', capacidade_carga: '30 t' },
    'APPLICANT',
    applicant,
  );
  const veh = await db.one("select plate, brand_model from vehicles where request_id = $1", [created.id]);
  assert.deepEqual(veh, { plate: 'ABC1D23', brand_model: 'Volvo FH' });
  const drv = await db.one('select cpf from drivers where request_id = $1', [created.id]);
  assert.equal(drv.cpf, '52998224725');
  sub = await portal.submit(token, applicant);
  assert.equal(sub.ok, true);
  det = await requests.detail(created.id);
  assert.equal(det.request.status, 'EM_CONFERENCIA');
  assert.ok(det.emails.some((e: any) => e.template === 'DOCUMENTATION_COMPLETE'));

  // conferência
  const docs = await docsOf(created.id);
  const rgFiles = docs['RG'].files;
  assert.equal(rgFiles.length, 3);
  assert.equal(rgFiles.filter((f: any) => f.is_current).length, 2);
  await review.startReview(created.id, docs['RG'].id, actor);
  assert.equal((await docsOf(created.id))['RG'].status, 'EM_ANALISE');
  for (const n of ['RG', 'CPF', 'CNH', 'CRLV', 'RNTRC/ANTT', 'Comprovante bancário']) await review.approve(created.id, docs[n].id, null, actor);
  const rej = await review.reject(created.id, docs['Comprovante de residência'].id, 'ILEGIVEL', 'Envie uma nova foto com melhor qualidade.', true, actor);
  assert.equal(rej.whatsapp, null, 'sem token Meta: não tenta envio automático');
  assert.match(rej.whatsappLink!, /^https:\/\/wa\.me\/5538999990000\?text=/);
  const waText = decodeURIComponent(rej.whatsappLink!.split('text=')[1]);
  assert.match(waText, /Comprovante de residência/);
  assert.match(waText, /Documento ilegível — Envie uma nova foto/);
  assert.match(waText, /\/enviar\//);
  det = await requests.detail(created.id);
  assert.equal(det.request.status, 'PENDENCIA');
  assert.ok(det.emails.some((e: any) => e.template === 'DOCUMENT_REJECTED' && e.recipient === 'joao@example.com'));
  await assert.rejects(finalPdf.generate(created.id, actor, { sendEmail: true }), /aprovados/);

  // URL temporária
  const f = await files.getFile(rgFiles[0].id);
  const url = await files.temporaryUrl(f, 'inline', actor.userId);
  const claims = verifyFileUrl(env.FILE_URL_SECRET, url.split('/').pop()!);
  assert.equal(claims?.fid, f.id);
  assert.equal(verifyFileUrl(env.FILE_URL_SECRET, url.split('/').pop()!.slice(0, -2) + 'xx'), null);

  // reenvio
  const v2 = await portal.view(token, applicant);
  const resid = v2.documents.find((x: any) => x.name === 'Comprovante de residência');
  assert.equal(resid.status, 'REJEITADO');
  assert.equal(resid.rejection.reason, 'Documento ilegível');
  assert.equal(resid.files.length, 0);
  await files.uploadToDocument(created.id, resid.id, [file(await png(), 'comprovante.png', 'image/png')], [], applicant, { byApplicant: true });
  const resDoc = (await docsOf(created.id))['Comprovante de residência'];
  assert.equal(resDoc.status, 'RECEBIDO');
  assert.equal(resDoc.files.length, 2, 'arquivo rejeitado no histórico');
  await review.approve(created.id, resDoc.id, null, actor);

  // opcional enviado precisa ser conferido; opcional não enviado não bloqueia
  det = await requests.detail(created.id);
  assert.equal(det.request.status, 'APROVADO');
  assert.equal(det.progress.approved, 7);
  assert.equal(det.progress.total, 8);
  assert.equal(det.canGeneratePdf, true);

  const out = await finalPdf.generate(created.id, actor, { sendEmail: true });
  assert.equal(out.fileName, 'DOCS_JOAO_DA_SILVA.pdf');
  // RG 2 + CPF 1 + CNH 2 + resid 1 + CRLV 2 + RNTRC 1 + banco 1 = 10 + capa/dados
  const final = await PDFDocument.load(await files.read(await files.getFile(out.fileId)));
  assert.ok(final.getPageCount() >= 11 && final.getPageCount() <= 13, `páginas: ${final.getPageCount()}`);
  assert.equal(out.email?.ok, true);
  det = await requests.detail(created.id);
  assert.equal(det.request.status, 'FINALIZADO');
  assert.ok(det.emails.some((e: any) => e.template === 'PDF_FINALIZED' && e.recipient === 'rh@pavidez.test' && e.attachments.length === 1));
  const actions = new Set(det.timeline.map((t: any) => t.action));
  for (const a of ['REQUEST_CREATED', 'LINK_GENERATED', 'LINK_ACCESSED', 'DOCUMENT_UPLOADED', 'DOCUMENT_REVIEW_STARTED', 'DOCUMENT_APPROVED', 'DOCUMENT_REJECTED', 'DOCUMENT_RESUBMITTED', 'APPLICANT_SUBMITTED', 'PDF_GENERATED', 'EMAIL_SENT', 'REQUEST_FINALIZED', 'STATUS_CHANGED']) {
    assert.ok(actions.has(a), a);
  }
  // processo finalizado: portal somente leitura
  const v3 = await portal.view(token, applicant);
  assert.equal(v3.accepting, false);
  await assert.rejects(files.uploadToDocument(created.id, resid.id, [file(await png(), 'x.png', 'image/png')], [], applicant, { byApplicant: true }));
  await assert.rejects(portal.resolve(token, true), /conferida/);

  // consulta posterior
  const list = await requests.list({ page: 1, pageSize: 20, q: 'João', status: 'FINALIZADO' });
  assert.ok(list.rows.some((r: any) => r.id === created.id && r.docs_approved === 7));
  const byDoc = await requests.list({ page: 1, pageSize: 20, document: '529.982' });
  assert.ok(byDoc.rows.some((r: any) => r.id === created.id));
  const stats = await requests.stats();
  assert.ok(stats.byStatus.FINALIZADO >= 1);
});

test('transportador PJ: perguntas condicionais alteram os documentos', async () => {
  const model = await modelBySlug('transportador-pj');
  const created = await requests.create(
    createRequestSchema.parse({
      modelId: model.id,
      applicant: { name: 'Transportes XYZ Ltda', document: '01.744.153/0001-06' },
      items: await itemsFor(model.id),
      answers: { motorista_socio: false },
    }),
    actor,
  );
  const token = tokenOf(created.link!);
  let docs = await docsOf(created.id);
  assert.equal(docs['Contrato de locação, arrendamento ou comodato do veículo'].awaiting_answer, true);
  assert.equal(docs['Documentação societária do motorista'].is_applicable, false);
  assert.match(docs['Documentação societária do motorista'].na_reason, /Não se aplica/);
  let v = await portal.view(token, applicant);
  assert.ok(v.documents.some((d: any) => d.name === 'Contrato de locação, arrendamento ou comodato do veículo' && d.awaitingAnswer));
  assert.ok(!v.documents.some((d: any) => d.name === 'Documentação societária do motorista'));
  await assert.rejects(requests.setAnswers(created.id, { numero_contrato_obra: '1' }, 'APPLICANT', applicant), /não pode ser respondida/);

  await requests.setAnswers(created.id, { veiculo_terceiro: true, motorista_empregado: 'sim', motorista_subcontratado: false, motorista_cooperado: false }, 'APPLICANT', applicant);
  docs = await docsOf(created.id);
  assert.equal(docs['Contrato de locação, arrendamento ou comodato do veículo'].is_applicable, true);
  for (const n of ['CTPS do motorista com o vínculo', 'Ficha de registro do motorista', 'Contrato de trabalho do motorista', 'ASO válido do motorista']) assert.equal(docs[n].is_applicable, true, n);
  assert.equal(docs['Declaração da cooperativa'].is_applicable, false);
  assert.equal(docs['Contrato de prestação de serviços entre a empresa e o motorista'].is_applicable, false);

  // mudou de ideia: veículo é da empresa
  await requests.setAnswers(created.id, { veiculo_terceiro: false }, 'APPLICANT', applicant);
  docs = await docsOf(created.id);
  assert.equal(docs['Contrato de locação, arrendamento ou comodato do veículo'].is_applicable, false);
  // RH força N/A manual e a regra não sobrescreve
  await requests.updateDocument(created.id, docs['TAG de pedágio'].id, { notApplicable: true, naReason: 'Rota sem pedágio' }, actor);
  await requests.setAnswers(created.id, { veiculo_terceiro: true }, 'INTERNAL', actor);
  docs = await docsOf(created.id);
  assert.equal(docs['TAG de pedágio'].is_applicable, false);
  assert.equal(docs['TAG de pedágio'].na_reason, 'Rota sem pedágio');
  // empresa cadastrada
  const comp = await db.one("select legal_name from companies where cnpj = '01744153000106'");
  assert.equal(comp.legal_name, 'Transportes XYZ Ltda');
  // "não se aplica" pelo solicitante
  await review.requestNotApplicable(created.id, docs['Inscrição estadual'].id, 'Não possui inscrição estadual', applicant);
  docs = await docsOf(created.id);
  assert.equal(docs['Inscrição estadual'].status, 'RECEBIDO');
  assert.equal(docs['Inscrição estadual'].na_requested, true);
  // texto
  await review.submitText(created.id, docs['Telefone'].id, '(38) 3333-4444', applicant, true);
  assert.equal((await docsOf(created.id))['Telefone'].text_value, '(38) 3333-4444');
  // checklist editável depois de criado
  const added = await requests.addDocument(created.id, { name: 'Alvará', section: null, description: null, kind: 'FILE', required: true, allowMultiple: false, maxFiles: 1, bothSides: false }, actor);
  await requests.removeDocument(created.id, added.id, actor);
  await assert.rejects(requests.removeDocument(created.id, docs['Inscrição estadual'].id, actor), /N\/A/);
  // cancelar / reabrir
  await requests.cancel(created.id, 'teste', actor);
  await assert.rejects(portal.view(token, applicant), /cancelada/);
  await requests.reopen(created.id, actor);
  assert.notEqual((await requests.getRow(created.id)).status, 'CANCELADO');
  // novo link invalida o anterior
  const { link } = await requests.generateLink(created.id, actor, true);
  assert.notEqual(link, created.link);
  await assert.rejects(portal.view(token, applicant), /inválido/);
  await portal.view(tokenOf(link), applicant);
});

test('locação: mensagem com [EQUIPAMENTO], PF sem Cartão CNPJ, nome do arquivo', async () => {
  const model = await modelBySlug('locacao-equipamentos');
  const created = await requests.create(
    createRequestSchema.parse({
      modelId: model.id,
      applicant: { name: 'José Locador', document: '529.982.247-25' },
      items: await itemsFor(model.id),
      answers: { tipo_pessoa: 'PF', equipamento: 'CAMINHÃO-PIPA', valor_locacao: 'R$ 10.000/mês' },
    }),
    actor,
  );
  const det = await requests.detail(created.id);
  assert.ok(det.renderedMessage.includes('sobre a locação do CAMINHÃO-PIPA.'));
  assert.equal(det.documents.find((d: any) => d.name === 'Cartão CNPJ').is_applicable, false);
  assert.equal(det.request.person_type, 'PF');
  // envia tudo e aprova
  const v = await portal.view(tokenOf(created.link!), applicant);
  for (const d of v.documents) {
    await files.uploadToDocument(created.id, d.id, [file(await jpeg(), `${d.name}.jpg`, 'image/jpeg')], d.bothSides ? ['FRONT'] : [], applicant, { byApplicant: true });
    await review.approve(created.id, d.id, null, actor);
  }
  assert.equal((await requests.getRow(created.id)).status, 'APROVADO');
  process.env.HARNESS_FAIL_EMAIL = '1';
  const out = await finalPdf.generate(created.id, actor, { sendEmail: true });
  delete process.env.HARNESS_FAIL_EMAIL;
  assert.equal(out.fileName, 'DOCS_JOSE_LOCADOR.pdf');
  if (out.email?.ok === false) {
    // e-mail falhou: continua APROVADO, com PDF salvo e erro registrado
    const r = await requests.detail(created.id);
    assert.equal(r.request.status, 'APROVADO');
    assert.ok(r.emails.some((e: any) => e.status === 'FAILED' && e.error));
    await finalPdf.finalize(created.id, actor);
  }
  assert.equal((await requests.getRow(created.id)).status, 'FINALIZADO');
});

test('admissão em modo PDF único', async () => {
  const model = await modelBySlug('admissao');
  const created = await requests.create(
    createRequestSchema.parse({ modelId: model.id, applicant: { name: 'Maria Souza' }, items: await itemsFor(model.id), generateLink: false }),
    actor,
  );
  let det = await requests.detail(created.id);
  assert.equal(det.request.status, 'RASCUNHO');
  assert.equal(created.link, null);
  assert.equal(det.documents.length, 2);
  assert.equal(det.documents[0].is_combined, true);
  assert.match(det.documents[0].description, /1\. Currículo/);
  assert.equal(det.documents[1].name, 'Telefone para contato');
  const { link } = await requests.generateLink(created.id, actor, false);
  det = await requests.detail(created.id);
  assert.equal(det.request.status, 'AGUARDANDO_DOCUMENTOS');
  assert.ok(det.renderedMessage.includes('CONVÊNIO: 070801756'));
  const v = await portal.view(tokenOf(link), applicant);
  assert.equal(v.title, 'DOCUMENTAÇÃO PARA CONTRATAÇÃO');
  await files.uploadToDocument(created.id, det.documents[0].id, [file(await pdf(20), 'todos.pdf', 'application/pdf')], [], applicant, { byApplicant: true });
  await review.submitText(created.id, det.documents[1].id, '(38) 99999-1111', applicant, true);
  assert.equal((await requests.getRow(created.id)).status, 'EM_CONFERENCIA');
  for (const d of det.documents) await review.approve(created.id, d.id, null, actor);
  const out = await finalPdf.generate(created.id, actor, { sendEmail: false });
  assert.equal(out.fileName, 'DOCS_MARIA_SOUZA.pdf');
  const final = await PDFDocument.load(await files.read(await files.getFile(out.fileId)));
  assert.ok(final.getPageCount() >= 21);
  assert.equal((await requests.getRow(created.id)).status, 'FINALIZADO');
});

test('formato aceito por documento (somente foto / somente PDF)', async () => {
  const model = await modelBySlug('contrato-carreteiro');
  const items = (await itemsFor(model.id)).map((i: any) => ({ ...i, accept: i.name === 'CPF' ? 'PDF' : i.name === 'CRLV' ? 'IMAGE' : 'ANY' }));
  const created = await requests.create(createRequestSchema.parse({ modelId: model.id, applicant: { name: 'Formato Teste' }, items }), actor);
  const v = await portal.view(tokenOf(created.link!), applicant);
  const d = Object.fromEntries(v.documents.map((x: any) => [x.name, x]));
  assert.equal(d['CPF'].accept, 'PDF');
  await assert.rejects(files.uploadToDocument(created.id, d['CPF'].id, [file(await jpeg(), 'cpf.jpg', 'image/jpeg')], [], applicant, { byApplicant: true }), /somente arquivo PDF/);
  await files.uploadToDocument(created.id, d['CPF'].id, [file(await pdf(1), 'cpf.pdf', 'application/pdf')], [], applicant, { byApplicant: true });
  await assert.rejects(files.uploadToDocument(created.id, d['CRLV'].id, [file(await pdf(1), 'crlv.pdf', 'application/pdf')], [], applicant, { byApplicant: true }), /somente foto/);
  await files.uploadToDocument(created.id, d['CRLV'].id, [file(await jpeg(), 'crlv.jpg', 'image/jpeg')], [], applicant, { byApplicant: true });
  await requests.updateDocument(created.id, d['CPF'].id, { accept: 'ANY' }, actor);
  assert.equal((await docsOf(created.id))['CPF'].accept, 'ANY');
});

test('expiração de link', async () => {
  const model = await modelBySlug('contrato-carreteiro');
  const created = await requests.create(createRequestSchema.parse({ modelId: model.id, applicant: { name: 'Expira Teste' }, items: await itemsFor(model.id) }), actor);
  await db.exec("update requests set link_expires_at = now() - interval '1 minute' where id = $1", [created.id]);
  await jobs.expireLinks();
  assert.equal((await requests.getRow(created.id)).status, 'EXPIRADO');
  await assert.rejects(portal.view(tokenOf(created.link!), applicant), /expirou/);
  await requests.update(created.id, { linkExpiresAt: new Date(Date.now() + 86400_000).toISOString() }, actor);
  assert.equal((await requests.getRow(created.id)).status, 'AGUARDANDO_DOCUMENTOS');
  await portal.view(tokenOf(created.link!), applicant);
});
