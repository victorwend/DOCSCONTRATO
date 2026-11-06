import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ZipArchive } from '../src/domain/docx/zip';
import { parsePart } from '../src/domain/docx/ooxml';
import { checkboxText, detectSlots, documentText, fillTemplate, openDocx, suggestConfig, TemplateError } from '../src/domain/docx/template';
import { formatValue, moneyWords, numberWords } from '../src/domain/docx/format';
import { buildContext, resolveSource } from '../src/domain/docx/sources';

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const yellow = '<w:rPr><w:b/><w:highlight w:val="yellow"/></w:rPr>';
const blue = '<w:rPr><w:color w:val="0070C0"/></w:rPr>';
const r = (t: string, rPr = '') => `<w:r>${rPr}<w:t xml:space="preserve">${t}</w:t></w:r>`;
const p = (...runs: string[]) => `<w:p>${runs.join('')}</w:p>`;

function docx(body: string, header?: string) {
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'word/document.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${W}><w:body>${body}</w:body></w:document>` },
  ];
  if (header) files.push({ name: 'word/header1.xml', data: `<?xml version="1.0"?><w:hdr ${W}>${header}</w:hdr>` });
  return ZipArchive.create(files).toBuffer();
}

const SAMPLE = docx(
  [
    p(r('Nome: '), r('XXXX', yellow)),
    // marcador dividido em dois runs (o Word faz isso com frequência)
    p(r('CPF: '), r('XX', yellow), r('XX', yellow), r(' – fixo')),
    p(r('Categoria: '), r('(   )', yellow), r(' TAC Pessoa Física '), r('(   )', yellow), r(' ETC')),
    p(r('Ag: xxx; Conta: xxx', yellow)),
    p(r('Texto sem destaque XXXX que não deve mudar')),
    '<w:tbl><w:tr><w:tc><w:p>' + r('PLACA') + '</w:p></w:tc></w:tr><w:tr><w:tc><w:p>' + r('xxx', blue) + '</w:p></w:tc></w:tr></w:tbl>',
  ].join(''),
  p(r('Nº. '), r('XXX', blue), r(' (Nº DA OBRA)', blue)),
);

test('zip: entradas não alteradas são copiadas byte a byte', () => {
  const zip = ZipArchive.read(SAMPLE);
  zip.set('word/document.xml', zip.getText('word/document.xml')!.replace('Nome', 'Nome'));
  const again = ZipArchive.read(zip.toBuffer());
  assert.deepEqual(again.names(), zip.names());
  assert.equal(again.getText('word/header1.xml'), ZipArchive.read(SAMPLE).getText('word/header1.xml'));
});

test('rejeita .doc antigo e arquivos que não são Word', () => {
  assert.throws(() => openDocx(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0])), (e: Error) => e instanceof TemplateError && /\.doc/.test(e.message));
  assert.throws(() => openDocx(Buffer.from('não é zip')), TemplateError);
});

test('detecta campos destacados, caixas de seleção e cabeçalho; ignora marcadores sem destaque', () => {
  const slots = detectSlots(openDocx(SAMPLE));
  const cfg = suggestConfig(slots);
  const active = new Map(cfg.slots.filter((s) => s.action === 'FIELD').map((s) => [s.id, s.field]));
  const fieldOf = (text: string, label: string) => {
    const s = slots.find((x) => x.text === text && x.label === label);
    assert.ok(s, `slot ${text} / ${label}`);
    return active.get(s!.id);
  };
  assert.ok(fieldOf('XXXX', 'Nome'));
  assert.ok(fieldOf('XXXX', 'CPF'), 'marcador dividido em dois runs vira um único campo');
  assert.ok(fieldOf('(   )', 'TAC Pessoa Física'));
  assert.ok(fieldOf('(   )', 'ETC'));
  assert.ok(fieldOf('xxx', 'Ag'));
  assert.ok(fieldOf('xxx', 'Conta'));
  assert.ok(fieldOf('xxx', 'PLACA'), 'rótulo vem do cabeçalho da coluna');
  assert.ok(fieldOf('XXX', 'Nº da obra'), 'rótulo vem do texto-guia');
  const plain = slots.find((s) => s.text === 'XXXX' && !s.marked)!;
  assert.equal(active.has(plain.id), false, 'marcador sem destaque não é preenchido automaticamente');
});

test('preenche só os campos, mantendo texto fixo, formatação e destaque', () => {
  const zip = openDocx(SAMPLE);
  const slots = detectSlots(zip);
  const cfg = suggestConfig(slots);
  const byLabel = (label: string) => cfg.fields.find((f) => f.label === label)!.key;
  const values = {
    [byLabel('Nome')]: 'João & Filhos <Ltda>',
    [byLabel('CPF')]: '12345678909',
    [byLabel('TAC Pessoa Física')]: true,
    [byLabel('ETC')]: false,
    [byLabel('Ag')]: '1234',
    [byLabel('Conta')]: '5678-9',
    [byLabel('PLACA')]: 'ABC1D23',
    [byLabel('Nº da obra')]: '015',
  };
  cfg.fields.find((f) => f.label === 'CPF')!.format = 'CPF_CNPJ';
  const out = fillTemplate(SAMPLE, cfg, values);
  assert.equal(out.missing.length, 0);
  const text = documentText(out.buffer);
  assert.match(text, /Nº\. 015 \(Nº DA OBRA\)/);
  assert.match(text, /Nome: João & Filhos <Ltda>/);
  assert.match(text, /CPF: 123\.456\.789-09 – fixo/);
  assert.match(text, /Categoria: \( X \) TAC Pessoa Física \( {3}\) ETC/);
  assert.match(text, /Ag: 1234; Conta: 5678-9/);
  assert.match(text, /Texto sem destaque XXXX que não deve mudar/);
  assert.match(text, /ABC1D23/);
  const xml = ZipArchive.read(out.buffer).getText('word/document.xml')!;
  assert.match(xml, /João &amp; Filhos &lt;Ltda&gt;/);
  assert.equal((xml.match(/w:highlight w:val="yellow"/g) ?? []).length, 6, 'destaque mantido');
  // o XML continua válido para o leitor
  assert.ok(parsePart(xml).paragraphs.length >= 6);
});

test('remove o destaque quando configurado e bloqueia obrigatório vazio', () => {
  const cfg = suggestConfig(detectSlots(openDocx(SAMPLE)));
  const blocked = fillTemplate(SAMPLE, cfg, {});
  assert.ok(blocked.missing.length > 0);
  const values = Object.fromEntries(cfg.fields.map((f) => [f.key, f.type === 'CHECK' ? true : 'ok']));
  const out = fillTemplate(SAMPLE, { ...cfg, removeMarking: true }, values);
  const xml = ZipArchive.read(out.buffer).getText('word/document.xml')!;
  assert.equal((xml.match(/w:highlight/g) ?? []).length, 0);
  assert.match(xml, /<w:b\/>/, 'demais propriedades do run ficam');
});

test('caixas de seleção mantêm o tamanho original', () => {
  assert.equal(checkboxText('(   )', true), '( X )');
  assert.equal(checkboxText('( x)', false), '(  )');
  assert.equal(checkboxText('[ ]', true), '[X]');
});

test('formatos: datas, valores e extenso', () => {
  assert.equal(formatValue('2026-11-06', 'DATE', null), '06/11/2026');
  assert.equal(formatValue('2026-11-06', 'DATE', 'DATE_LONG'), '6 de novembro de 2026');
  assert.equal(formatValue('1500', 'MONEY', 'MONEY_FULL'), 'R$ 1.500,00 (mil e quinhentos reais)');
  assert.equal(formatValue('2.350,75', 'MONEY', 'MONEY'), 'R$ 2.350,75');
  assert.equal(moneyWords(1234.56), 'mil duzentos e trinta e quatro reais e cinquenta e seis centavos');
  assert.equal(moneyWords(1_000_000), 'um milhão de reais');
  assert.equal(numberWords(12), 'doze');
  assert.equal(numberWords(100), 'cem');
  assert.equal(numberWords(101), 'cento e um');
  assert.equal(numberWords(2024), 'dois mil e vinte e quatro');
  assert.equal(formatValue('12', 'NUMBER', 'NUMBER_FULL'), '12 (doze)');
  assert.equal(formatValue('01744153000106', 'TEXT', 'CPF_CNPJ'), '01.744.153/0001-06');
});

test('pré-preenchimento a partir da solicitação', () => {
  const ctx = buildContext({
    request: { code: 'PD-1', model_name: 'Locação', person_type: 'PJ', applicant_name: 'Locadora X', applicant_document: '01744153000106', applicant_email: null, applicant_phone: null, deadline: null },
    vehicle: { plate: 'ABC1D23' },
    answers: { tipo_pessoa: 'PJ', equipamento: 'Caminhão-pipa', possui_seguro: true },
    texts: {},
    pavidez: { name: 'PAVIDEZ', cnpj: '01.744.153/0001-06' },
    today: '2026-11-06',
  });
  assert.equal(resolveSource(ctx, 'vehicle.plate'), 'ABC1D23');
  assert.equal(resolveSource(ctx, 'answers.equipamento'), 'Caminhão-pipa');
  assert.equal(resolveSource(ctx, 'answers.tipo_pessoa=PJ'), true);
  assert.equal(resolveSource(ctx, 'answers.tipo_pessoa=PF'), false);
  assert.equal(resolveSource(ctx, 'answers.possui_seguro=sim'), true);
  assert.equal(resolveSource(ctx, 'applicant.is_pj'), true);
});

test('leitura dos documentos: aceita só campos conhecidos e tipos válidos', async () => {
  const { parseExtraction, buildContent, buildInstructions } = await import('../src/domain/docx/extraction');
  const fields = [
    { key: 'placa', label: 'Placa', type: 'TEXT' as const, required: true },
    { key: 'inicio', label: 'Início', type: 'DATE' as const, required: true },
    { key: 'valor', label: 'Valor', type: 'MONEY' as const, required: true },
    { key: 'pj', label: 'PESSOA JURÍDICA', type: 'CHECK' as const, required: false },
  ];
  const answer = 'Aqui está:\n```json\n' + JSON.stringify({
    campos: {
      placa: { valor: 'ABC1D23', documento: 'CRLV', trecho: 'PLACA ABC1D23', confianca: 'alta' },
      inicio: { valor: '05/11/2026', documento: 'Proposta', confianca: 'média' },
      valor: { valor: 1500, documento: 'Proposta', confianca: 'baixa' },
      pj: { valor: 'sim', documento: 'Cartão CNPJ' },
      inventado: { valor: 'x' },
      vazio: null,
    },
    observacoes: ['CNH vence em 2027'],
  }) + '\n```';
  const r = parseExtraction(answer, fields);
  assert.deepEqual(Object.keys(r.suggestions).sort(), ['inicio', 'pj', 'placa', 'valor']);
  assert.equal(r.suggestions.inicio.value, '2026-11-05');
  assert.equal(r.suggestions.valor.value, '1500');
  assert.equal(r.suggestions.valor.confidence, 'baixa');
  assert.equal(r.suggestions.pj.value, true);
  assert.deepEqual(r.notes, ['CNH vence em 2027']);
  assert.throws(() => parseExtraction('sem json', fields));
  const content = buildContent(
    [{ name: 'CRLV', files: [{ mime: 'application/pdf', data: Buffer.from('%PDF'), name: 'crlv.pdf' }] }],
    buildInstructions(fields, { processo: 'Locação', solicitante: 'X', tipoPessoa: 'pessoa jurídica', extras: {} }),
  );
  assert.equal(content[1].type, 'document');
  assert.match(String(content[content.length - 1].text), /Não invente/);
});
