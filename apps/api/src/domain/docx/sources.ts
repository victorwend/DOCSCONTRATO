/**
 * Origens de pré-preenchimento dos campos do contrato.
 * O RH liga cada campo a uma origem (ex.: "applicant.name"); ao criar o contrato da solicitação,
 * o valor é copiado como sugestão. Nada é gerado sem a conferência e a confirmação do RH.
 */

export interface SourceDef {
  path: string;
  label: string;
  group: string;
}

export const STATIC_SOURCES: SourceDef[] = [
  { path: 'applicant.name', label: 'Nome / razão social do solicitante', group: 'Solicitante' },
  { path: 'applicant.document', label: 'CPF/CNPJ do solicitante', group: 'Solicitante' },
  { path: 'applicant.email', label: 'E-mail do solicitante', group: 'Solicitante' },
  { path: 'applicant.phone', label: 'Telefone do solicitante', group: 'Solicitante' },
  { path: 'applicant.is_pf', label: 'É pessoa física (marcação)', group: 'Solicitante' },
  { path: 'applicant.is_pj', label: 'É pessoa jurídica (marcação)', group: 'Solicitante' },
  { path: 'company.legal_name', label: 'Empresa – razão social', group: 'Empresa' },
  { path: 'company.cnpj', label: 'Empresa – CNPJ', group: 'Empresa' },
  { path: 'company.state_registration', label: 'Empresa – inscrição estadual', group: 'Empresa' },
  { path: 'company.address', label: 'Empresa – endereço', group: 'Empresa' },
  { path: 'company.phone', label: 'Empresa – telefone', group: 'Empresa' },
  { path: 'company.email', label: 'Empresa – e-mail', group: 'Empresa' },
  { path: 'vehicle.plate', label: 'Veículo – placa', group: 'Veículo' },
  { path: 'vehicle.renavam', label: 'Veículo – Renavam', group: 'Veículo' },
  { path: 'vehicle.brand_model', label: 'Veículo – marca/modelo', group: 'Veículo' },
  { path: 'vehicle.year', label: 'Veículo – ano', group: 'Veículo' },
  { path: 'vehicle.color', label: 'Veículo – cor', group: 'Veículo' },
  { path: 'vehicle.body_type', label: 'Veículo – carroceria', group: 'Veículo' },
  { path: 'vehicle.axles', label: 'Veículo – eixos', group: 'Veículo' },
  { path: 'vehicle.load_capacity', label: 'Veículo – capacidade de carga', group: 'Veículo' },
  { path: 'vehicle.pbt', label: 'Veículo – PBT/PBTC', group: 'Veículo' },
  { path: 'driver.name', label: 'Motorista – nome', group: 'Motorista' },
  { path: 'driver.cpf', label: 'Motorista – CPF', group: 'Motorista' },
  { path: 'driver.phone', label: 'Motorista – telefone', group: 'Motorista' },
  { path: 'driver.email', label: 'Motorista – e-mail', group: 'Motorista' },
  { path: 'driver.address', label: 'Motorista – endereço', group: 'Motorista' },
  { path: 'request.code', label: 'Código da solicitação', group: 'Processo' },
  { path: 'request.model_name', label: 'Tipo de processo', group: 'Processo' },
  { path: 'request.deadline', label: 'Prazo da solicitação', group: 'Processo' },
  { path: 'today', label: 'Data de hoje', group: 'Processo' },
  { path: 'pavidez.name', label: 'Pavidez – nome', group: 'Pavidez' },
  { path: 'pavidez.cnpj', label: 'Pavidez – CNPJ', group: 'Pavidez' },
];

export interface ContextInput {
  request: {
    code: string;
    model_name: string;
    person_type: 'PF' | 'PJ';
    applicant_name: string;
    applicant_document: string | null;
    applicant_email: string | null;
    applicant_phone: string | null;
    deadline: string | null;
  };
  company?: Record<string, unknown> | null;
  vehicle?: Record<string, unknown> | null;
  driver?: Record<string, unknown> | null;
  answers: Record<string, unknown>;
  /** documentos do tipo "informação" (texto) enviados pelo solicitante, por chave */
  texts: Record<string, string | null>;
  pavidez: { name: string; cnpj: string };
  today: string; // YYYY-MM-DD
}

function str(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === 'boolean') return v ? 'SIM' : 'NÃO';
  if (Array.isArray(v)) return v.map(String).join(', ');
  const s = String(v).trim();
  return s ? s : null;
}

/** Valores disponíveis para pré-preenchimento, por caminho. */
export function buildContext(i: ContextInput): Record<string, string | boolean | null> {
  const ctx: Record<string, string | boolean | null> = {
    'applicant.name': i.request.applicant_name,
    'applicant.document': i.request.applicant_document,
    'applicant.email': i.request.applicant_email,
    'applicant.phone': i.request.applicant_phone,
    'applicant.is_pf': i.request.person_type === 'PF',
    'applicant.is_pj': i.request.person_type === 'PJ',
    'request.code': i.request.code,
    'request.model_name': i.request.model_name,
    'request.deadline': i.request.deadline,
    today: i.today,
    'pavidez.name': i.pavidez.name,
    'pavidez.cnpj': i.pavidez.cnpj,
  };
  for (const [prefix, obj] of [
    ['company', i.company],
    ['vehicle', i.vehicle],
    ['driver', i.driver],
  ] as const) {
    if (!obj) continue;
    for (const [k, v] of Object.entries(obj)) ctx[`${prefix}.${k}`] = str(v);
  }
  for (const [k, v] of Object.entries(i.answers)) ctx[`answers.${k}`] = typeof v === 'boolean' ? v : str(v);
  for (const [k, v] of Object.entries(i.texts)) ctx[`texts.${k}`] = str(v);
  return ctx;
}

/**
 * Valor sugerido para um campo a partir da origem.
 * - "answers.x=VALOR": marca (true) quando a resposta x é igual a VALOR — útil para caixas "( )".
 */
export function resolveSource(ctx: Record<string, string | boolean | null>, source: string | null | undefined): string | boolean | null {
  if (!source) return null;
  const eq = /^([^=]+)=(.*)$/.exec(source);
  if (eq) {
    const v = ctx[eq[1].trim()];
    if (v === null || v === undefined) return null;
    const want = eq[2].trim().toLowerCase();
    if (typeof v === 'boolean') return String(v) === want || (v ? 'sim' : 'não') === want || (v ? 'sim' : 'nao') === want;
    return String(v).trim().toLowerCase() === want;
  }
  const v = ctx[source];
  return v === undefined ? null : v;
}
