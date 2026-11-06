import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ENV, Env } from '../config/env';
import { Db } from '../db/pool';
import { Actor, AuditService } from '../audit/audit.service';
import { STORAGE } from '../core/tokens';
import { StorageDriver } from '../storage/storage';
import { RequestsService } from '../requests/requests.service';
import { sanitizeOriginalName } from '../domain/text';
import {
  detectSlots,
  dominantMarking,
  FieldDef,
  fillTemplate,
  isEmptyValue,
  openDocx,
  SlotConfig,
  slugKey,
  suggestConfig,
  TemplateError,
} from '../domain/docx/template';
import { buildContext, resolveSource, STATIC_SOURCES } from '../domain/docx/sources';
import { FORMAT_LABELS } from '../domain/docx/format';
import { buildContent, buildInstructions, ExtractionDoc, parseExtraction } from '../domain/docx/extraction';
import sharp from 'sharp';
import { templateMetaSchema, templateUpdateSchema } from './contracts.schema';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** Contrato só é gerado depois que a documentação foi conferida. */
const GENERATE_STATUSES = ['APROVADO', 'FINALIZADO'];

interface TemplateRow {
  id: string;
  name: string;
  description: string | null;
  model_id: string | null;
  storage_key: string;
  original_name: string;
  size_bytes: number;
  sha256: string;
  marking: string | null;
  fields: FieldDef[];
  slots: SlotConfig[];
  remove_marking: boolean;
  output_pattern: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

interface ContractRow {
  id: string;
  request_id: string;
  template_id: string;
  template_name: string;
  values: Record<string, unknown>;
  status: 'RASCUNHO' | 'CONFIRMADO' | 'GERADO';
  confirmed_by: string | null;
  confirmed_at: Date | null;
  values_hash: string | null;
  generated_file_id: string | null;
  generated_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

function sha256(b: Buffer | string) {
  return createHash('sha256').update(b).digest('hex');
}

function hashValues(v: Record<string, unknown>) {
  const sorted = Object.keys(v)
    .sort()
    .map((k) => [k, v[k]]);
  return sha256(JSON.stringify(sorted));
}

function fileBase(pattern: string, name: string) {
  const n = name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return (pattern.includes('[NOME]') ? pattern.replace('[NOME]', n) : `${pattern}_${n}`).replace(/\s+/g, '_').slice(0, 150);
}

const MAX_AI_BYTES = 20 * 1024 * 1024; // total enviado à IA por leitura

@Injectable()
export class ContractsService {
  private readonly logger = new Logger(ContractsService.name);

  constructor(
    private readonly db: Db,
    @Inject(STORAGE) private readonly storage: StorageDriver,
    @Inject(ENV) private readonly env: Env,
    private readonly audit: AuditService,
    private readonly requests: RequestsService,
  ) {}

  // ========================================================================
  // Modelos de contrato
  // ========================================================================

  async listTemplates(onlyActive: boolean) {
    return this.db.many(
      `select t.id, t.name, t.description, t.model_id, m.name as model_name, t.original_name, t.size_bytes, t.marking,
              t.active, t.created_at, t.updated_at,
              jsonb_array_length(t.fields) as field_count,
              (select count(*) from jsonb_array_elements(t.slots) s where s->>'action' = 'FIELD') as mapped_slots,
              (select count(*) from request_contracts rc where rc.template_id = t.id) as usage_count
         from contract_templates t left join document_models m on m.id = t.model_id
        ${onlyActive ? 'where t.active' : ''}
        order by t.active desc, t.name`,
    );
  }

  private async getTemplateRow(id: string): Promise<TemplateRow> {
    const t = await this.db.maybe<TemplateRow>('select * from contract_templates where id = $1', [id]);
    if (!t) throw new NotFoundException('Modelo de contrato não encontrado');
    return t;
  }

  async createTemplate(file: { buffer: Buffer; originalname: string } | undefined, meta: z.infer<typeof templateMetaSchema>, actor: Actor & { type: 'USER' }) {
    if (!file?.buffer?.length) throw new BadRequestException('Envie o arquivo do contrato em Word (.docx).');
    let detected;
    try {
      detected = detectSlots(openDocx(file.buffer));
    } catch (e) {
      if (e instanceof TemplateError) throw new BadRequestException(e.message);
      throw new BadRequestException('Não foi possível ler o arquivo. Verifique se é um .docx válido.');
    }
    if (meta.modelId) await this.assertModel(meta.modelId);
    const suggestion = suggestConfig(detected);
    const id = randomUUID();
    const key = `contract-templates/${id}/${randomUUID()}.docx`;
    await this.storage.put(key, file.buffer, DOCX_MIME);
    try {
      await this.db.exec(
        `insert into contract_templates (id, name, description, model_id, storage_key, original_name, size_bytes, sha256, marking, fields, slots, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          id,
          meta.name,
          meta.description ?? null,
          meta.modelId ?? null,
          key,
          sanitizeOriginalName(file.originalname || 'contrato.docx'),
          file.buffer.length,
          sha256(file.buffer),
          dominantMarking(detected),
          JSON.stringify(suggestion.fields),
          JSON.stringify(suggestion.slots),
          actor.userId,
        ],
      );
    } catch (e) {
      await this.storage.remove(key).catch(() => undefined);
      throw e;
    }
    await this.audit.log(actor, 'CONTRACT_TEMPLATE_CREATED', { entityType: 'contract_template', entityId: id, details: { name: meta.name } });
    return { id, detected: detected.length, fields: suggestion.fields.length };
  }

  private async assertModel(modelId: string) {
    const m = await this.db.maybe('select 1 from document_models where id = $1', [modelId]);
    if (!m) throw new BadRequestException('Modelo de documentação inexistente');
  }

  /** Modelo + todos os trechos detectados no arquivo, com a configuração de cada um. */
  async getTemplate(id: string) {
    const t = await this.getTemplateRow(id);
    const buffer = await this.storage.get(t.storage_key);
    const detected = detectSlots(openDocx(buffer));
    const cfg = new Map(t.slots.map((s) => [s.id, s]));
    const { storage_key, ...safe } = t;
    void storage_key;
    return {
      template: safe,
      slots: detected.map((s) => ({ ...s, action: cfg.get(s.id)?.action ?? 'KEEP', field: cfg.get(s.id)?.field ?? null })),
      sources: await this.sources(t.model_id),
      formats: Object.entries(FORMAT_LABELS).map(([value, label]) => ({ value, label })),
    };
  }

  /** Origens de pré-preenchimento: dados do solicitante/empresa/veículo + perguntas e informações do modelo. */
  async sources(modelId: string | null) {
    const out = [...STATIC_SOURCES];
    if (modelId) {
      const qs = await this.db.many<{ key: string; label: string; section: string | null }>(
        'select key, label, section from document_model_questions where model_id = $1 order by position',
        [modelId],
      );
      for (const q of qs) out.push({ path: `answers.${q.key}`, label: q.label, group: 'Perguntas do modelo' });
      const texts = await this.db.many<{ name: string }>(
        `select name from document_model_items where model_id = $1 and kind = 'TEXT' and active order by position`,
        [modelId],
      );
      for (const t of texts) out.push({ path: `texts.${slugKey(t.name)}`, label: t.name, group: 'Informações enviadas' });
    }
    return out;
  }

  async updateTemplate(id: string, dto: z.infer<typeof templateUpdateSchema>, actor: Actor & { type: 'USER' }) {
    const t = await this.getTemplateRow(id);
    if (dto.modelId) await this.assertModel(dto.modelId);
    const keys = new Set<string>();
    for (const f of dto.fields) {
      if (keys.has(f.key)) throw new BadRequestException(`Campo repetido: ${f.key}`);
      keys.add(f.key);
    }
    const detected = new Set(detectSlots(openDocx(await this.storage.get(t.storage_key))).map((s) => s.id));
    const slots: SlotConfig[] = [];
    for (const s of dto.slots) {
      if (!detected.has(s.id)) continue;
      if (s.action === 'FIELD') {
        if (!s.field || !keys.has(s.field)) throw new BadRequestException(`Trecho ${s.id}: escolha um campo existente.`);
        slots.push({ id: s.id, action: 'FIELD', field: s.field });
      } else slots.push({ id: s.id, action: s.action, field: null });
    }
    await this.db.exec(
      `update contract_templates set name=$2, description=$3, model_id=$4, active=$5, remove_marking=$6, output_pattern=$7, fields=$8, slots=$9 where id=$1`,
      [id, dto.name, dto.description ?? null, dto.modelId ?? null, dto.active, dto.removeMarking, dto.outputPattern, JSON.stringify(dto.fields), JSON.stringify(slots)],
    );
    await this.audit.log(actor, 'CONTRACT_TEMPLATE_UPDATED', {
      entityType: 'contract_template',
      entityId: id,
      details: { fields: dto.fields.length, mapped: slots.filter((s) => s.action === 'FIELD').length },
    });
  }

  async templateOriginal(id: string) {
    const t = await this.getTemplateRow(id);
    return { buffer: await this.storage.get(t.storage_key), name: t.original_name };
  }

  /** Arquivo de teste: cada campo recebe «nome do campo», para conferir o mapeamento no Word. */
  async templatePreview(id: string) {
    const t = await this.getTemplateRow(id);
    const values: Record<string, unknown> = {};
    for (const f of t.fields) values[f.key] = f.type === 'CHECK' ? true : `«${f.label}»`;
    const r = fillTemplate(await this.storage.get(t.storage_key), { fields: t.fields, slots: t.slots, removeMarking: t.remove_marking }, values, { allowMissing: true });
    return { buffer: r.buffer, name: `TESTE_${t.original_name.replace(/\.docx$/i, '')}.docx` };
  }

  // ========================================================================
  // Contratos de uma solicitação
  // ========================================================================

  async listForRequest(requestId: string) {
    const r = await this.requests.getRow(requestId);
    const contracts = await this.db.many(
      `select rc.*, u.name as confirmed_by_name, f.original_name as file_name, f.size_bytes as file_size
         from request_contracts rc
         left join users u on u.id = rc.confirmed_by
         left join files f on f.id = rc.generated_file_id
        where rc.request_id = $1 order by rc.created_at`,
      [requestId],
    );
    const templates = await this.db.many(
      `select id, name, description, model_id, (model_id = $1) as suggested from contract_templates where active order by (model_id = $1) desc nulls last, name`,
      [r.model_id],
    );
    const detailed = await Promise.all(
      contracts.map(async (c: ContractRow & Record<string, unknown>) => {
        const t = await this.db.maybe<Pick<TemplateRow, 'fields' | 'slots' | 'active'>>('select fields, slots, active from contract_templates where id = $1', [c.template_id]);
        const used = new Set((t?.slots ?? []).filter((s) => s.action === 'FIELD').map((s) => s.field));
        const fields = (t?.fields ?? []).filter((f) => used.has(f.key));
        return {
          ...c,
          fields,
          missing: fields.filter((f) => f.required && f.type !== 'CHECK' && isEmptyValue(c.values[f.key])).map((f) => f.label),
          stale: c.status !== 'RASCUNHO' && c.values_hash !== hashValues(c.values),
        };
      }),
    );
    return {
      contracts: detailed,
      templates,
      aiEnabled: this.aiEnabled,
      canGenerate: GENERATE_STATUSES.includes(r.status),
      generateBlockedReason: GENERATE_STATUSES.includes(r.status)
        ? null
        : 'O contrato só pode ser gerado depois que todos os documentos obrigatórios forem aprovados.',
    };
  }

  private async context(requestId: string) {
    const r = await this.requests.getRow(requestId);
    const company = r.company_id
      ? await this.db.maybe('select legal_name, cnpj, state_registration, address, phone, email::text as email from companies where id = $1', [r.company_id])
      : null;
    const vehicle = await this.db.maybe(
      'select plate, renavam, brand_model, year, color, body_type, axles, load_capacity, pbt from vehicles where request_id = $1',
      [requestId],
    );
    const driver = await this.db.maybe('select name, cpf, phone, email::text as email, address from drivers where request_id = $1', [requestId]);
    const answers = Object.fromEntries(
      (await this.db.many<{ key: string; value: unknown }>('select key, value from request_answers where request_id = $1', [requestId])).map((a) => [a.key, a.value]),
    );
    const texts = Object.fromEntries(
      (
        await this.db.many<{ name: string; text_value: string | null }>(
          `select name, text_value from request_documents where request_id = $1 and kind = 'TEXT' and is_applicable`,
          [requestId],
        )
      ).map((d) => [slugKey(d.name), d.text_value]),
    );
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
    return buildContext({
      request: r,
      company,
      vehicle,
      driver,
      answers,
      texts,
      pavidez: { name: this.env.COMPANY_NAME, cnpj: this.env.COMPANY_CNPJ },
      today,
    });
  }

  private prefill(fields: FieldDef[], ctx: Record<string, string | boolean | null>, current: Record<string, unknown>, onlyEmpty: boolean) {
    const values: Record<string, unknown> = { ...current };
    let changed = 0;
    for (const f of fields) {
      if (!f.source) continue;
      if (onlyEmpty && !isEmptyValue(values[f.key]) && values[f.key] !== false) continue;
      const v = resolveSource(ctx, f.source);
      if (v === null || v === undefined || v === '') continue;
      const next = f.type === 'CHECK' ? v === true || v === 'SIM' : typeof v === 'boolean' ? (v ? 'SIM' : 'NÃO') : v;
      if (values[f.key] !== next) {
        values[f.key] = next;
        changed++;
      }
    }
    return { values, changed };
  }

  private async getContract(requestId: string, contractId: string): Promise<ContractRow> {
    const c = await this.db.maybe<ContractRow>('select * from request_contracts where id = $1 and request_id = $2', [contractId, requestId]);
    if (!c) throw new NotFoundException('Contrato não encontrado');
    return c;
  }

  async createForRequest(requestId: string, templateId: string, actor: Actor & { type: 'USER' }) {
    const r = await this.requests.getRow(requestId);
    if (r.status === 'CANCELADO') throw new BadRequestException('Solicitação cancelada.');
    const t = await this.getTemplateRow(templateId);
    if (!t.active) throw new BadRequestException('Modelo de contrato inativo.');
    const { values } = this.prefill(t.fields, await this.context(requestId), {}, false);
    const row = await this.db.one<{ id: string }>(
      `insert into request_contracts (request_id, template_id, template_name, "values", created_by) values ($1,$2,$3,$4,$5) returning id`,
      [requestId, t.id, t.name, JSON.stringify(values), actor.userId],
    );
    await this.audit.log(actor, 'CONTRACT_CREATED', { requestId, entityType: 'request_contract', entityId: row.id, details: { template: t.name } });
    // lê automaticamente os documentos já aprovados (se a leitura estiver configurada)
    let extraction: { filled: number; found: number; notes: string[] } | { error: string } | null = null;
    if (this.aiEnabled && (await this.hasApprovedDocs(requestId))) {
      extraction = await this.extract(requestId, row.id, actor).catch((e) => ({ error: (e as Error).message }));
    }
    return { id: row.id, extraction };
  }

  async saveValues(requestId: string, contractId: string, incoming: Record<string, unknown>, actor: Actor & { type: 'USER' }) {
    const c = await this.getContract(requestId, contractId);
    const t = await this.getTemplateRow(c.template_id);
    const allowed = new Set(t.fields.map((f) => f.key));
    const values: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) if (allowed.has(k)) values[k] = typeof v === 'string' ? v.trim() : v;
    const changed = hashValues(values) !== hashValues(c.values);
    if (!changed) return { changed: false };
    // qualquer alteração exige nova confirmação
    await this.db.exec(
      `update request_contracts set "values" = $2, status = 'RASCUNHO', confirmed_by = null, confirmed_at = null, values_hash = null where id = $1`,
      [contractId, JSON.stringify(values)],
    );
    await this.audit.log(actor, 'CONTRACT_UPDATED', { requestId, entityType: 'request_contract', entityId: contractId, details: { template: c.template_name } });
    return { changed: true };
  }

  async refill(requestId: string, contractId: string, actor: Actor & { type: 'USER' }) {
    const c = await this.getContract(requestId, contractId);
    const t = await this.getTemplateRow(c.template_id);
    const { values, changed } = this.prefill(t.fields, await this.context(requestId), c.values, true);
    if (changed) await this.saveValues(requestId, contractId, values, actor);
    return { changed };
  }

  async confirm(requestId: string, contractId: string, actor: Actor & { type: 'USER' }) {
    const c = await this.getContract(requestId, contractId);
    const t = await this.getTemplateRow(c.template_id);
    const used = new Set(t.slots.filter((s) => s.action === 'FIELD').map((s) => s.field));
    const missing = t.fields.filter((f) => used.has(f.key) && f.required && f.type !== 'CHECK' && isEmptyValue(c.values[f.key]));
    if (missing.length) {
      throw new BadRequestException(`Preencha os campos obrigatórios: ${missing.map((f) => f.label).join(', ')}.`);
    }
    await this.db.exec(`update request_contracts set status = 'CONFIRMADO', confirmed_by = $2, confirmed_at = now(), values_hash = $3 where id = $1`, [
      contractId,
      actor.userId,
      hashValues(c.values),
    ]);
    await this.audit.log(actor, 'CONTRACT_CONFIRMED', { requestId, entityType: 'request_contract', entityId: contractId, details: { template: c.template_name } });
  }

  async generate(requestId: string, contractId: string, actor: Actor & { type: 'USER' }) {
    const r = await this.requests.getRow(requestId);
    if (!GENERATE_STATUSES.includes(r.status)) {
      throw new BadRequestException('O contrato só pode ser gerado depois que todos os documentos obrigatórios forem aprovados.');
    }
    const c = await this.getContract(requestId, contractId);
    if (c.status === 'RASCUNHO' || !c.values_hash) throw new BadRequestException('Confira e confirme os dados do contrato antes de gerar.');
    if (c.values_hash !== hashValues(c.values)) throw new ConflictException('Os dados mudaram depois da confirmação. Confirme novamente.');
    const t = await this.getTemplateRow(c.template_id);
    const result = fillTemplate(await this.storage.get(t.storage_key), { fields: t.fields, slots: t.slots, removeMarking: t.remove_marking }, c.values);
    if (result.missing.length) throw new BadRequestException(`Preencha os campos obrigatórios: ${result.missing.map((f) => f.label).join(', ')}.`);

    const fileId = randomUUID();
    const key = `requests/${requestId}/final/${fileId}.docx`;
    const name = `${fileBase(t.output_pattern, r.applicant_name)}.docx`;
    await this.storage.put(key, result.buffer, DOCX_MIME);
    await this.db.tx(async (tx) => {
      if (c.generated_file_id) await this.db.exec('update files set is_current = false where id = $1', [c.generated_file_id], tx);
      await this.db.exec(
        `insert into files (id, request_id, kind, storage_driver, storage_key, original_name, mime_type, size_bytes, sha256, uploaded_by)
         values ($1,$2,'CONTRACT',$3,$4,$5,$6,$7,$8,$9)`,
        [fileId, requestId, this.storage.name, key, name, DOCX_MIME, result.buffer.length, sha256(result.buffer), actor.userId],
        tx,
      );
      await this.db.exec(`update request_contracts set status = 'GERADO', generated_file_id = $2, generated_at = now() where id = $1`, [contractId, fileId], tx);
    });
    await this.audit.log(actor, 'CONTRACT_GENERATED', {
      requestId,
      entityType: 'file',
      entityId: fileId,
      details: { template: t.name, name, filled: result.filled, kept: result.keptSlots.length, stale: result.staleSlots.length },
    });
    return { fileId, name, filled: result.filled, kept: result.keptSlots.length };
  }

  // ========================================================================
  // Leitura dos documentos aprovados (IA assistiva)
  // ========================================================================

  get aiEnabled() {
    return !!this.env.ANTHROPIC_API_KEY;
  }

  private async hasApprovedDocs(requestId: string) {
    const r = await this.db.maybe(`select 1 from request_documents where request_id = $1 and status = 'APROVADO' and is_applicable limit 1`, [requestId]);
    return !!r;
  }

  /** Documentos aprovados com os arquivos atuais (fotos reduzidas para leitura). */
  private async approvedDocs(requestId: string): Promise<{ docs: ExtractionDoc[]; skipped: string[] }> {
    const rows = await this.db.many<{ id: string; name: string; kind: string; text_value: string | null }>(
      `select id, name, kind, text_value from request_documents
        where request_id = $1 and status = 'APROVADO' and is_applicable order by position, created_at`,
      [requestId],
    );
    const docs: ExtractionDoc[] = [];
    const skipped: string[] = [];
    let total = 0;
    for (const d of rows) {
      const doc: ExtractionDoc = { name: d.name, text: d.kind === 'TEXT' ? d.text_value : null, files: [] };
      const files = await this.db.many<{ storage_key: string; mime_type: string; original_name: string; size_bytes: number }>(
        `select storage_key, mime_type, original_name, size_bytes from files
          where request_document_id = $1 and kind = 'ORIGINAL' and is_current and purged_at is null
          order by side nulls first, created_at`,
        [d.id],
      );
      for (const f of files) {
        let data = await this.storage.get(f.storage_key);
        let mime = f.mime_type;
        if (mime.startsWith('image/')) {
          data = await sharp(data, { limitInputPixels: 120_000_000 })
            .rotate()
            .resize(2000, 2000, { fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 85 })
            .toBuffer();
          mime = 'image/jpeg';
        } else if (mime !== 'application/pdf') continue;
        if (total + data.length > MAX_AI_BYTES) {
          skipped.push(`${d.name} (${f.original_name})`);
          continue;
        }
        total += data.length;
        doc.files.push({ mime, data, name: f.original_name });
      }
      if (doc.files.length || doc.text) docs.push(doc);
    }
    return { docs, skipped };
  }

  private async callClaude(content: Array<Record<string, unknown>>): Promise<string> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.env.CONTRACT_AI_TIMEOUT_SECONDS * 1000);
    try {
      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.env.ANTHROPIC_API_KEY!, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.env.ANTHROPIC_MODEL, max_tokens: 8000, messages: [{ role: 'user', content }] }),
        signal: ctrl.signal,
      });
      const body = (await res.json().catch(() => null)) as { content?: Array<{ type: string; text?: string }>; error?: { message?: string } } | null;
      if (!res.ok) throw new Error(`Leitura dos documentos falhou (${res.status}): ${body?.error?.message ?? 'erro na API de IA'}`);
      return (body?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('A leitura dos documentos demorou demais. Tente novamente.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Lê os documentos aprovados e preenche os campos vazios do contrato (ou todos, com overwrite).
   * Os valores lidos ficam marcados com o documento de origem; o RH confere e confirma antes de gerar.
   */
  async extract(requestId: string, contractId: string, actor: Actor & { type: 'USER' }, opts: { overwrite?: boolean } = {}) {
    if (!this.aiEnabled) throw new BadRequestException('Leitura automática não configurada: defina ANTHROPIC_API_KEY nas variáveis de ambiente da API.');
    const c = await this.getContract(requestId, contractId);
    const t = await this.getTemplateRow(c.template_id);
    const used = new Set(t.slots.filter((s) => s.action === 'FIELD').map((s) => s.field));
    const fields = t.fields.filter((f) => used.has(f.key));
    if (!fields.length) throw new BadRequestException('O modelo de contrato não tem campos ligados ao arquivo.');
    const { docs, skipped } = await this.approvedDocs(requestId);
    if (!docs.length) throw new BadRequestException('Nenhum documento aprovado para ler. Aprove os documentos primeiro.');

    const r = await this.requests.getRow(requestId);
    const answers = await this.db.many<{ label: string; value: unknown }>('select label, value from request_answers where request_id = $1', [requestId]);
    const extras = Object.fromEntries(
      answers.filter((a) => a.value !== null && a.value !== '').map((a) => [a.label, typeof a.value === 'boolean' ? (a.value ? 'Sim' : 'Não') : String(a.value)]),
    );
    const instructions = buildInstructions(fields, {
      processo: r.model_name,
      solicitante: r.applicant_name,
      tipoPessoa: r.person_type === 'PJ' ? 'pessoa jurídica' : 'pessoa física',
      extras,
    });

    let result;
    try {
      result = parseExtraction(await this.callClaude(buildContent(docs, instructions)), fields);
    } catch (e) {
      const msg = (e as Error).message;
      this.logger.warn(`Leitura do contrato ${contractId} falhou: ${msg}`);
      await this.db.exec('update request_contracts set extraction_error = $2, extracted_at = now() where id = $1', [contractId, msg.slice(0, 500)]);
      throw new BadRequestException(msg);
    }

    const values: Record<string, unknown> = { ...c.values };
    let filled = 0;
    for (const [key, s] of Object.entries(result.suggestions)) {
      const cur = values[key];
      const empty = cur === undefined || cur === null || (typeof cur === 'string' && !cur.trim());
      if (opts.overwrite || empty) {
        if (cur !== s.value) filled++;
        values[key] = s.value;
      }
    }
    const notes = [...result.notes, ...skipped.map((x) => `Não enviado para leitura (limite de tamanho): ${x}`)];
    const changed = filled > 0;
    await this.db.exec(
      `update request_contracts set "values" = $2, suggestions = $3, extraction_notes = $4, extracted_at = now(), extraction_error = null
              ${changed ? `, status = 'RASCUNHO', confirmed_by = null, confirmed_at = null, values_hash = null` : ''}
        where id = $1`,
      [contractId, JSON.stringify(values), JSON.stringify(result.suggestions), JSON.stringify(notes)],
    );
    await this.audit.log(actor, 'CONTRACT_EXTRACTED', {
      requestId,
      entityType: 'request_contract',
      entityId: contractId,
      details: { template: c.template_name, documents: docs.length, found: Object.keys(result.suggestions).length, filled },
    });
    return { filled, found: Object.keys(result.suggestions).length, notes };
  }

  async remove(requestId: string, contractId: string, actor: Actor & { type: 'USER' }) {
    const c = await this.getContract(requestId, contractId);
    await this.db.exec('delete from request_contracts where id = $1', [contractId]);
    await this.audit.log(actor, 'CONTRACT_REMOVED', { requestId, entityType: 'request_contract', entityId: contractId, details: { template: c.template_name } });
  }
}
