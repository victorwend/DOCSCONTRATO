import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import sharp from 'sharp';
import { evaluateItem, coerceAnswer, RuleDef } from '../src/domain/rules-engine';
import { computeRequestStatus, computeProgress, blockingReason, DocState } from '../src/domain/status';
import { isValidCpf, isValidCnpj, buildOutputFileName, renderPlaceholders, formatDocument } from '../src/domain/text';
import { validateUpload, UploadValidationError } from '../src/domain/file-validation';
import { buildDocumentPdf, buildFinalPdf } from '../src/domain/pdf-builder';

const MB = 1024 * 1024;

async function jpeg(w = 1200, h = 800, orientation?: number) {
  let img = sharp({ create: { width: w, height: h, channels: 3, background: '#3366aa' } }).jpeg();
  if (orientation) img = img.withMetadata({ orientation });
  return img.toBuffer();
}
async function png() {
  return sharp({ create: { width: 600, height: 900, channels: 4, background: '#ffcc00' } }).png().toBuffer();
}
async function pdf(pages: number) {
  const d = await PDFDocument.create();
  for (let i = 0; i < pages; i++) d.addPage([595, 842]).drawText(`Pagina ${i + 1}`, { x: 50, y: 700 });
  return Buffer.from(await d.save());
}

test('regras condicionais: veículo de terceiro', () => {
  const rules: RuleDef[] = [{ questionKey: 'veiculo_terceiro', operator: 'EQUALS', value: true, action: 'SHOW_ITEM', target: 'contrato' }];
  const qs = [{ key: 'veiculo_terceiro', label: 'O veículo está em nome de outra pessoa ou empresa?', type: 'BOOLEAN' as const }];
  assert.equal(evaluateItem('contrato', true, rules, {}, qs).awaitingAnswer, true);
  assert.equal(evaluateItem('contrato', true, rules, {}, qs).applicable, false);
  assert.equal(evaluateItem('contrato', true, rules, { veiculo_terceiro: true }, qs).applicable, true);
  const no = evaluateItem('contrato', true, rules, { veiculo_terceiro: false }, qs);
  assert.equal(no.applicable, false);
  assert.equal(no.awaitingAnswer, false);
  assert.match(no.reason!, /Não se aplica/);
  assert.equal(evaluateItem('outro', true, rules, {}, qs).applicable, true);
});

test('regras: PF/PJ, HIDE e REQUIRE', () => {
  const rules: RuleDef[] = [
    { questionKey: 'tipo_pessoa', operator: 'EQUALS', value: 'PJ', action: 'SHOW_ITEM', target: 'cnpj' },
    { questionKey: 'tipo_pessoa', operator: 'EQUALS', value: 'PJ', action: 'HIDE_ITEM', target: 'cpf' },
    { questionKey: 'tipo_pessoa', operator: 'IN', value: ['PJ'], action: 'REQUIRE_ITEM', target: 'contrato' },
  ];
  assert.equal(evaluateItem('cnpj', true, rules, { tipo_pessoa: 'PF' }).applicable, false);
  assert.equal(evaluateItem('cnpj', true, rules, { tipo_pessoa: 'pj' }).applicable, true);
  assert.equal(evaluateItem('cpf', true, rules, { tipo_pessoa: 'PJ' }).applicable, false);
  assert.equal(evaluateItem('cpf', true, rules, { tipo_pessoa: 'PF' }).applicable, true);
  assert.equal(evaluateItem('contrato', false, rules, { tipo_pessoa: 'PJ' }).required, true);
  assert.equal(evaluateItem('contrato', false, rules, { tipo_pessoa: 'PF' }).required, false);
});

test('coerção de respostas', () => {
  assert.equal(coerceAnswer({ key: 'a', label: 'A', type: 'BOOLEAN' }, 'sim'), true);
  assert.equal(coerceAnswer({ key: 'a', label: 'A', type: 'BOOLEAN' }, 'false'), false);
  assert.equal(coerceAnswer({ key: 'a', label: 'A', type: 'TEXT' }, '  '), null);
  assert.equal(coerceAnswer({ key: 'a', label: 'A', type: 'SELECT', options: [{ value: 'PF', label: 'PF' }] }, 'pf'), 'PF');
  assert.throws(() => coerceAnswer({ key: 'a', label: 'A', type: 'SELECT', options: [{ value: 'PF', label: 'PF' }] }, 'XX'));
});

test('status da solicitação', () => {
  const base = { linkGenerated: true, linkExpiresAt: null, cancelledAt: null, finalizedAt: null, unansweredRequiredQuestions: 0 };
  const d = (status: DocState['status'], required = true, is_applicable = true): DocState => ({ status, required, is_applicable });
  assert.equal(computeRequestStatus({ ...base, linkGenerated: false, docs: [d('PENDENTE')] }), 'RASCUNHO');
  assert.equal(computeRequestStatus({ ...base, docs: [d('PENDENTE'), d('RECEBIDO')] }), 'AGUARDANDO_DOCUMENTOS');
  assert.equal(computeRequestStatus({ ...base, docs: [d('RECEBIDO'), d('APROVADO'), d('PENDENTE', false)] }), 'EM_CONFERENCIA');
  assert.equal(computeRequestStatus({ ...base, docs: [d('REJEITADO'), d('APROVADO')] }), 'PENDENCIA');
  assert.equal(computeRequestStatus({ ...base, docs: [d('APROVADO'), d('PENDENTE', false), d('PENDENTE', true, false)] }), 'APROVADO');
  assert.equal(computeRequestStatus({ ...base, docs: [d('APROVADO'), d('RECEBIDO', false)] }), 'EM_CONFERENCIA');
  assert.equal(computeRequestStatus({ ...base, unansweredRequiredQuestions: 1, docs: [d('APROVADO')] }), 'AGUARDANDO_DOCUMENTOS');
  assert.equal(computeRequestStatus({ ...base, linkExpiresAt: new Date(Date.now() - 1000), docs: [d('PENDENTE')] }), 'EXPIRADO');
  assert.equal(computeRequestStatus({ ...base, cancelledAt: new Date(), docs: [d('APROVADO')] }), 'CANCELADO');
  const p = computeProgress([d('APROVADO'), d('REJEITADO'), d('PENDENTE'), d('RECEBIDO'), d('PENDENTE', true, false)]);
  assert.deepEqual([p.total, p.approved, p.rejected, p.pending, p.inReview, p.notApplicable, p.received], [4, 1, 1, 1, 1, 1, 3]);
  assert.match(blockingReason([{ ...d('PENDENTE'), name: 'RG' }], 0)!, /RG/);
  assert.equal(blockingReason([{ ...d('APROVADO'), name: 'RG' }], 0), null);
});

test('CPF/CNPJ e nomes de arquivo', () => {
  assert.equal(isValidCnpj('01.744.153/0001-06'), true);
  assert.equal(isValidCnpj('01.744.153/0001-07'), false);
  assert.equal(isValidCpf('529.982.247-25'), true);
  assert.equal(isValidCpf('111.111.111-11'), false);
  assert.equal(formatDocument('01744153000106'), '01.744.153/0001-06');
  assert.equal(buildOutputFileName('DOSSIE_ADMISSIONAL_[NOME]', { nome: 'João da Silva' }), 'DOSSIE_ADMISSIONAL_JOAO_DA_SILVA.pdf');
  assert.equal(buildOutputFileName('LOCACAO_[EQUIPAMENTO]_[NOME]', { nome: 'José', equipamento: 'Caminhão-pipa' }), 'LOCACAO_CAMINHAO_PIPA_JOSE.pdf');
  assert.equal(buildOutputFileName('LOCACAO_[EQUIPAMENTO]', {}), 'LOCACAO.pdf');
  assert.equal(renderPlaceholders('locação do [EQUIPAMENTO] — [NOME] [X]', { equipamento: 'CAMINHÃO-PIPA', nome: 'Ana' }), 'locação do CAMINHÃO-PIPA — Ana [X]');
});

test('validação de upload', async () => {
  const j = await jpeg();
  const ok = await validateUpload(j, 'rg.JPG', 'image/jpeg', 20 * MB);
  assert.equal(ok.mime, 'image/jpeg');
  assert.equal((await validateUpload(await png(), 'cpf.png', 'image/png', 20 * MB)).mime, 'image/png');
  assert.equal((await validateUpload(await pdf(3), 'ctps.pdf', 'application/pdf', 20 * MB)).pageCount, 3);

  const fail = async (p: Promise<unknown>, code: string) => {
    await assert.rejects(p, (e: unknown) => e instanceof UploadValidationError && e.code === code);
  };
  await fail(validateUpload(Buffer.alloc(0), 'a.pdf', 'application/pdf', 20 * MB), 'EMPTY');
  await fail(validateUpload(j, 'a.jpg', 'image/jpeg', 100), 'TOO_LARGE');
  await fail(validateUpload(j, 'a.exe', 'image/jpeg', 20 * MB), 'EXTENSION');
  await fail(validateUpload(j, 'a.pdf', 'application/pdf', 20 * MB), 'MISMATCH');
  await fail(validateUpload(Buffer.from('MZ\x90\x00 not an image'), 'a.jpg', 'image/jpeg', 20 * MB), 'SIGNATURE');
  await fail(validateUpload(j, 'a.jpg', 'text/html', 20 * MB), 'MIME');
  await fail(validateUpload(j.subarray(0, 400), 'a.jpg', 'image/jpeg', 20 * MB), 'CORRUPTED');
  await fail(validateUpload(Buffer.from('%PDF-1.7\n garbage'), 'a.pdf', 'application/pdf', 20 * MB), 'CORRUPTED');
});

test('PDF: frente e verso + PDF multipágina + consolidado', async () => {
  const rg = await buildDocumentPdf([
    { buffer: await jpeg(1200, 800, 6), mime: 'image/jpeg' }, // orientação EXIF 6 => retrato
    { buffer: await png(), mime: 'image/png' },
  ]);
  assert.equal(rg.pageCount, 2);
  const first = (await PDFDocument.load(rg.buffer)).getPage(0).getSize();
  assert.ok(first.height > first.width, 'foto rotacionada pelo EXIF deve ficar em retrato');

  const ctps = await buildDocumentPdf([{ buffer: await pdf(4), mime: 'application/pdf' }]);
  assert.equal(ctps.pageCount, 4);

  const logo = await png();
  const final = await buildFinalPdf({
    companyName: 'PAVIDEZ ENGENHARIA',
    companyCnpj: '01.744.153/0001-06',
    processType: 'Contrato de carreteiro',
    applicantName: 'João da Silva',
    applicantDocument: '529.982.247-25',
    requestCode: 'PD-2026-000001',
    date: new Date(),
    logoPng: logo,
    info: [{ label: 'Placa', value: 'ABC1D23 – ✓ ok', section: 'Dados do veículo' }],
    sections: [
      { index: 1, name: 'RG', pdf: rg.buffer },
      { index: 2, name: 'CTPS', pdf: ctps.buffer },
      { index: 3, name: 'Telefone para contato', textValue: '(38) 99999-0000' },
      { index: 4, name: 'Certificado do MOPP', notApplicable: true, naReason: 'Não possui' },
    ],
  });
  require('node:fs').writeFileSync('/tmp/final-test.pdf', final.buffer);
  const finalDoc = await PDFDocument.load(final.buffer);
  // capa/índice + 2 (RG) + 4 (CTPS)
  assert.ok(final.pageCount >= 7 && final.pageCount <= 8);
  assert.equal(finalDoc.getTitle(), 'Contrato de carreteiro - João da Silva');
});
