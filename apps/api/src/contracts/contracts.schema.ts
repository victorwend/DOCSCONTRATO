import { z } from 'zod';
import { FIELD_FORMATS } from '../domain/docx/format';

const key = z.string().regex(/^[a-z][a-z0-9_]{0,59}$/, 'chave do campo: letras minúsculas, números e _');

export const fieldSchema = z.object({
  key,
  label: z.string().trim().min(1).max(160),
  type: z.enum(['TEXT', 'LONGTEXT', 'DATE', 'MONEY', 'NUMBER', 'CHECK']).default('TEXT'),
  required: z.boolean().default(true),
  group: z.string().trim().max(80).nullish(),
  help: z.string().trim().max(400).nullish(),
  source: z.string().trim().max(160).nullish(),
  format: z.enum(FIELD_FORMATS).nullish(),
});

export const slotSchema = z.object({
  id: z.string().min(3).max(120),
  action: z.enum(['FIELD', 'KEEP', 'CLEAR']),
  field: key.nullish(),
});

export const templateMetaSchema = z.object({
  name: z.string().trim().min(2).max(160),
  description: z.string().trim().max(1000).nullish(),
  modelId: z.string().uuid().nullish(),
});

export const templateUpdateSchema = templateMetaSchema.extend({
  active: z.boolean().default(true),
  removeMarking: z.boolean().default(false),
  outputPattern: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_\-\[\] ]+$/, 'nome do arquivo: letras, números, _, - e [NOME]')
    .default('CONTRATO_[NOME]'),
  fields: z.array(fieldSchema).max(400),
  slots: z.array(slotSchema).max(2000),
});

export const createContractSchema = z.object({ templateId: z.string().uuid() });

export const valuesSchema = z.object({
  values: z.record(z.union([z.string().max(4000), z.boolean(), z.number(), z.null()])),
});
