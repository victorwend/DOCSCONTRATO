import { z } from 'zod';
import { isValidCnpj, isValidCpf, onlyDigits } from '../domain/text';
import { REQUEST_STATUSES } from '../domain/status';

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .nullish()
    .transform((v) => (v && v.trim() ? v.trim() : null));

export const documentNumber = z
  .string()
  .nullish()
  .transform((v) => onlyDigits(v) || null)
  .refine((v) => v === null || (v.length === 11 ? isValidCpf(v) : v.length === 14 ? isValidCnpj(v) : false), 'CPF/CNPJ inválido');

const email = z
  .string()
  .trim()
  .toLowerCase()
  .email('E-mail inválido')
  .max(200)
  .nullish()
  .or(z.literal('').transform(() => null))
  .transform((v) => v || null);

const phone = z
  .string()
  .max(40)
  .nullish()
  .transform((v) => (v && v.trim() ? v.trim() : null))
  .refine((v) => v === null || onlyDigits(v).length >= 10, 'Telefone deve ter DDD + número');

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD)')
  .nullish()
  .or(z.literal('').transform(() => null))
  .transform((v) => v || null);

export const requestItemSchema = z.object({
  modelItemId: z.string().uuid().nullish(),
  section: optText(200),
  name: z.string().trim().min(1).max(200),
  description: optText(2000),
  kind: z.enum(['FILE', 'TEXT']).default('FILE'),
  required: z.boolean().default(true),
  allowMultiple: z.boolean().default(false),
  maxFiles: z.number().int().min(1).max(50).default(10),
  bothSides: z.boolean().default(false),
  accept: z.enum(['ANY', 'IMAGE', 'PDF']).default('ANY'),
});

export const createRequestSchema = z.object({
  modelId: z.string().uuid(),
  personType: z.enum(['PF', 'PJ']).nullish(),
  applicant: z.object({
    name: z.string().trim().min(2, 'Informe o nome/razão social').max(200),
    document: documentNumber,
    phone,
    email,
  }),
  notifyEmail: email,
  notes: optText(5000),
  responsibleUserId: z.string().uuid().nullish(),
  deadline: date,
  message: optText(10000),
  submissionMode: z.enum(['SEPARATE', 'SINGLE_FILE']).nullish(),
  answers: z.record(z.unknown()).default({}),
  items: z.array(requestItemSchema).min(1, 'O checklist precisa de ao menos um documento').max(200),
  generateLink: z.boolean().default(true),
  sendEmailToApplicant: z.boolean().default(false),
});
export type CreateRequestInput = z.infer<typeof createRequestSchema>;

export const previewSchema = z.object({
  modelId: z.string().uuid(),
  answers: z.record(z.unknown()).default({}),
});

export const updateRequestSchema = z.object({
  personType: z.enum(['PF', 'PJ']).optional(),
  applicant: z
    .object({ name: z.string().trim().min(2).max(200), document: documentNumber, phone, email })
    .partial()
    .optional(),
  notifyEmail: email.optional(),
  notes: optText(5000).optional(),
  responsibleUserId: z.string().uuid().nullish(),
  deadline: date.optional(),
  message: optText(10000).optional(),
  linkExpiresAt: z.string().datetime({ offset: true }).nullish(),
});

export const listQuerySchema = z.object({
  status: z.enum(REQUEST_STATUSES).optional(),
  modelId: z.string().uuid().optional(),
  responsibleUserId: z.string().uuid().optional(),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  q: z.string().trim().max(200).optional(),
  document: z.string().trim().max(30).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

export const addDocumentSchema = requestItemSchema.omit({ modelItemId: true });

export const updateDocumentSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: optText(2000).optional(),
  required: z.boolean().optional(),
  allowMultiple: z.boolean().optional(),
  bothSides: z.boolean().optional(),
  accept: z.enum(['ANY', 'IMAGE', 'PDF']).optional(),
  notApplicable: z.boolean().optional(),
  naReason: optText(500).optional(),
});

export const reorderSchema = z.object({ order: z.array(z.string().uuid()).min(1) });

export const rejectSchema = z.object({
  reason: z.enum(['ILEGIVEL', 'CORTADO', 'INCOMPLETO', 'INCORRETO', 'VENCIDO', 'OUTRO']),
  note: optText(1000),
  notifyApplicant: z.boolean().default(true),
}).refine((v) => v.reason !== 'OUTRO' || !!v.note, { message: 'Descreva o motivo na observação', path: ['note'] });

export const approveSchema = z.object({ note: optText(1000) });

export const answersSchema = z.object({ answers: z.record(z.unknown()) });

export const cancelSchema = z.object({ reason: optText(1000) });
