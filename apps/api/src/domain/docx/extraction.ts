/**
 * Leitura dos documentos aprovados para preencher o contrato (IA assistiva).
 *
 * Regras: a IA só devolve o que está escrito nos documentos; nada é inventado ou deduzido.
 * O resultado entra como sugestão nos campos vazios, com o documento de origem e o trecho lido,
 * e o RH continua obrigado a conferir e confirmar antes de gerar o contrato.
 */
import type { FieldDef } from './template';

export interface ExtractionDoc {
  name: string;
  /** texto informado (documentos do tipo "informação") */
  text?: string | null;
  files: Array<{ mime: string; data: Buffer; name: string }>;
}

export interface Suggestion {
  value: string | boolean;
  document: string | null;
  evidence: string | null;
  confidence: 'alta' | 'media' | 'baixa';
}

export interface ExtractionResult {
  suggestions: Record<string, Suggestion>;
  notes: string[];
}

export function buildInstructions(fields: FieldDef[], context: { processo: string; solicitante: string; tipoPessoa: string; extras: Record<string, string> }) {
  const list = fields.map((f) => ({
    chave: f.key,
    rotulo: f.label,
    grupo: f.group || null,
    tipo: f.type,
    ajuda: f.help || null,
  }));
  return `Você está ajudando o RH da PAVIDEZ ENGENHARIA LTDA (CNPJ 01.744.153/0001-06) a preencher um contrato.
Acima estão os documentos já APROVADOS pelo RH, enviados pelo contratado/locador.

Processo: ${context.processo}
Solicitante (como cadastrado pelo RH): ${context.solicitante} — ${context.tipoPessoa}
${Object.entries(context.extras)
  .map(([k, v]) => `${k}: ${v}`)
  .join('\n')}

Campos do contrato a preencher (JSON):
${JSON.stringify(list, null, 1)}

Para cada campo, procure o valor NOS DOCUMENTOS e devolva-o.

REGRAS OBRIGATÓRIAS:
1. Use somente o que está escrito nos documentos. Não invente, não deduza, não complete dados faltantes. Se não encontrar ou estiver ilegível, devolva null.
2. Confira a quem pertence cada dado (empresa, representante legal, motorista, proprietário do veículo, titular da conta) e use o "grupo"/"rótulo" do campo para escolher a pessoa certa. Não misture pessoas.
3. A PAVIDEZ ENGENHARIA é a contratante/locatária: os dados dela NÃO são dados do locador/contratado.
4. Condições comerciais (valor, prazo, datas de início/fim, quantidade) só se estiverem escritas num documento (ex.: proposta). Não calcule valores que não estejam determinados, exceto multiplicação simples de quantidade × valor unitário escritos.
5. Formatos: datas em AAAA-MM-DD; valores em reais como número com ponto decimal (ex.: 1500.00); CPF/CNPJ/placa/Renavam exatamente como impressos; nomes completos, sem abreviar, como no documento.
6. Campos do tipo CHECK (caixa de marcação): true se os documentos confirmam claramente a opção do rótulo, false se confirmam claramente que não, null se não dá para saber.
7. Se dois documentos trouxerem valores diferentes para o mesmo campo, devolva null e explique em "observacoes".

Responda APENAS com um JSON válido, sem texto antes ou depois, no formato:
{"campos": {"<chave>": {"valor": "...", "documento": "<nome do documento de onde leu>", "trecho": "<trecho curto lido>", "confianca": "alta|media|baixa"} | null}, "observacoes": ["..."]}`;
}

function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end < start) throw new Error('A resposta da IA não trouxe JSON.');
  return JSON.parse(raw.slice(start, end + 1));
}

/** Valida a resposta e descarta tudo que não for um campo conhecido ou não tiver o tipo esperado. */
export function parseExtraction(text: string, fields: FieldDef[]): ExtractionResult {
  const data = extractJson(text) as { campos?: Record<string, unknown>; observacoes?: unknown };
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const suggestions: Record<string, Suggestion> = {};
  for (const [key, item] of Object.entries(data.campos ?? {})) {
    const f = byKey.get(key);
    if (!f || !item || typeof item !== 'object') continue;
    const it = item as Record<string, unknown>;
    let value = it.valor;
    if (value === null || value === undefined) continue;
    if (f.type === 'CHECK') {
      if (typeof value === 'string') value = /^(true|sim|x)$/i.test(value.trim()) ? true : /^(false|n[ãa]o)$/i.test(value.trim()) ? false : null;
      if (typeof value !== 'boolean') continue;
    } else {
      if (typeof value === 'number') value = String(value);
      if (typeof value !== 'string' || !value.trim()) continue;
      value = value.trim().slice(0, 2000);
      if (f.type === 'DATE' && !/^\d{4}-\d{2}-\d{2}$/.test(value as string)) {
        const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(value as string);
        if (!m) continue;
        value = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
      }
    }
    const conf = String(it.confianca ?? '').toLowerCase();
    suggestions[key] = {
      value: value as string | boolean,
      document: typeof it.documento === 'string' ? it.documento.slice(0, 160) : null,
      evidence: typeof it.trecho === 'string' ? it.trecho.slice(0, 300) : null,
      confidence: conf.startsWith('a') ? 'alta' : conf.startsWith('b') ? 'baixa' : 'media',
    };
  }
  const notes = Array.isArray(data.observacoes) ? data.observacoes.filter((n): n is string => typeof n === 'string').map((n) => n.slice(0, 400)).slice(0, 20) : [];
  return { suggestions, notes };
}

/** Monta o conteúdo da mensagem (documentos + instruções) no formato da API de mensagens. */
export function buildContent(docs: ExtractionDoc[], instructions: string) {
  const content: Array<Record<string, unknown>> = [];
  docs.forEach((d, i) => {
    content.push({ type: 'text', text: `Documento ${i + 1}: ${d.name}${d.text ? `\nInformação digitada: ${d.text}` : ''}` });
    for (const f of d.files) {
      if (f.mime === 'application/pdf') {
        content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.data.toString('base64') }, title: `${d.name} – ${f.name}`.slice(0, 200) });
      } else {
        content.push({ type: 'image', source: { type: 'base64', media_type: f.mime, data: f.data.toString('base64') } });
      }
    }
  });
  content.push({ type: 'text', text: instructions });
  return content;
}
