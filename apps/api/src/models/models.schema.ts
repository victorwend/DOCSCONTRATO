import { z } from 'zod';

export const MAPS_TO_VALUES = [
  'request.person_type',
  'vehicle.plate',
  'vehicle.renavam',
  'vehicle.brand_model',
  'vehicle.year',
  'vehicle.color',
  'vehicle.body_type',
  'vehicle.axles',
  'vehicle.load_capacity',
  'vehicle.pbt',
  'driver.name',
  'driver.cpf',
  'driver.phone',
  'driver.email',
  'driver.address',
  'driver.relationship',
] as const;

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim() : null));

const option = z.union([
  z.string().max(200),
  z.object({ value: z.union([z.string().max(200), z.boolean(), z.number()]), label: z.string().min(1).max(200) }),
]);

export const itemSchema = z.object({
  id: z.string().uuid().optional(),
  ref: z.string().min(1).max(64),
  section: optText(200),
  name: z.string().trim().min(1, 'Nome do documento é obrigatório').max(200),
  description: optText(2000),
  kind: z.enum(['FILE', 'TEXT']).default('FILE'),
  required: z.boolean().default(true),
  allowMultiple: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(50).default(10),
  bothSides: z.boolean().default(false),
  accept: z.enum(['ANY', 'IMAGE', 'PDF']).default('ANY'),
});

export const questionSchema = z.object({
  id: z.string().uuid().optional(),
  ref: z.string().min(1).max(64),
  key: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_]*$/, 'A chave deve conter apenas letras minúsculas, números e _ (ex.: veiculo_terceiro)')
    .max(60),
  label: z.string().trim().min(1).max(300),
  helpText: optText(1000),
  type: z.enum(['BOOLEAN', 'SELECT', 'TEXT', 'NUMBER', 'DATE']),
  options: z.array(option).max(100).default([]),
  required: z.boolean().default(false),
  answeredBy: z.enum(['INTERNAL', 'APPLICANT']).default('INTERNAL'),
  section: optText(200),
  mapsTo: z.enum(MAPS_TO_VALUES).nullish().transform((v) => v ?? null),
});

export const ruleSchema = z.object({
  questionRef: z.string().min(1),
  operator: z.enum(['EQUALS', 'NOT_EQUALS', 'IN', 'NOT_IN', 'ANSWERED']).default('EQUALS'),
  value: z.union([z.string(), z.boolean(), z.number(), z.array(z.union([z.string(), z.boolean(), z.number()]))]).nullish(),
  action: z.enum(['SHOW_ITEM', 'HIDE_ITEM', 'REQUIRE_ITEM']).default('SHOW_ITEM'),
  targetRef: z.string().min(1),
});

export const modelSchema = z
  .object({
    name: z.string().trim().min(2, 'Informe o nome do modelo').max(200),
    description: optText(2000),
    category: z.string().trim().min(1).max(60).default('OUTRO'),
    portalTitle: z.string().trim().min(1).max(120).default('DOCUMENTAÇÃO PARA CONTRATAÇÃO'),
    defaultMessage: optText(10000),
    defaultDeadlineDays: z.number().int().min(1).max(365).nullish().transform((v) => v ?? null),
    submissionMode: z.enum(['SEPARATE', 'SINGLE_FILE']).default('SEPARATE'),
    singleFileLabel: z.string().trim().min(1).max(200).default('Documentação completa (PDF único)'),
    outputFilePattern: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9_\-\[\] ]+$/, 'Use apenas letras, números, _ e variáveis como [NOME]')
      .default('DOCS_[NOME]'),
    active: z.boolean().default(true),
    items: z.array(itemSchema).max(200).default([]),
    questions: z.array(questionSchema).max(200).default([]),
    rules: z.array(ruleSchema).max(500).default([]),
  })
  .superRefine((m, ctx) => {
    const keys = new Set<string>();
    m.questions.forEach((q, i) => {
      if (keys.has(q.key)) ctx.addIssue({ code: 'custom', path: ['questions', i, 'key'], message: `Chave duplicada: ${q.key}` });
      keys.add(q.key);
      if (q.type === 'SELECT' && q.options.length === 0) {
        ctx.addIssue({ code: 'custom', path: ['questions', i, 'options'], message: 'Perguntas de seleção precisam de opções' });
      }
    });
    const itemRefs = new Set(m.items.map((i) => i.ref));
    const qRefs = new Set(m.questions.map((q) => q.ref));
    m.rules.forEach((r, i) => {
      if (!itemRefs.has(r.targetRef)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'targetRef'], message: 'Regra aponta para documento inexistente' });
      if (!qRefs.has(r.questionRef)) ctx.addIssue({ code: 'custom', path: ['rules', i, 'questionRef'], message: 'Regra aponta para pergunta inexistente' });
      if (r.operator !== 'ANSWERED' && (r.value === null || r.value === undefined || r.value === '')) {
        ctx.addIssue({ code: 'custom', path: ['rules', i, 'value'], message: 'Informe o valor da condição' });
      }
    });
  });

export type ModelInput = z.infer<typeof modelSchema>;
