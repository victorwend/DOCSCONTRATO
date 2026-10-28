import { BadRequestException, ConflictException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { ENV, Env } from '../config/env';
import { Db, Queryable } from '../db/pool';
import { Actor, AuditService } from '../audit/audit.service';
import { EmailService } from '../email/email.service';
import { ModelsService, FullModel } from '../models/models.service';
import { coerceAnswer, evaluateItem, isAnswered, QuestionDef, RuleDef, answerLabel } from '../domain/rules-engine';
import { blockingReason, computeProgress, computeRequestStatus, DocState, RequestStatus } from '../domain/status';
import { decryptToken, encryptToken, generateLinkToken, hashToken } from '../domain/link-token';
import { formatDocument, onlyDigits, renderPlaceholders } from '../domain/text';
import {
  addDocumentSchema,
  CreateRequestInput,
  listQuerySchema,
  updateDocumentSchema,
  updateRequestSchema,
} from './requests.schema';

/** Pergunta "congelada" na solicitação. */
export interface RequestQuestion extends QuestionDef {
  questionId: string | null;
  helpText: string | null;
  section: string | null;
  mapsTo: string | null;
  answeredBy: 'INTERNAL' | 'APPLICANT';
  required: boolean;
}

export interface RequestRow {
  id: string;
  code: string;
  model_id: string;
  model_name: string;
  portal_title: string;
  output_file_pattern: string;
  applicant_id: string;
  company_id: string | null;
  person_type: 'PF' | 'PJ';
  applicant_name: string;
  applicant_document: string | null;
  applicant_phone: string | null;
  applicant_email: string | null;
  notify_email: string | null;
  notes: string | null;
  message: string | null;
  submission_mode: 'SEPARATE' | 'SINGLE_FILE';
  questions: RequestQuestion[];
  rules: RuleDef[];
  status: RequestStatus;
  responsible_user_id: string | null;
  created_by: string | null;
  deadline: string | null;
  token_hash: string | null;
  token_encrypted: string | null;
  link_active: boolean;
  link_expires_at: Date | null;
  link_generated_at: Date | null;
  link_sent_at: Date | null;
  last_accessed_at: Date | null;
  submitted_at: Date | null;
  approved_at: Date | null;
  finalized_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: string | null;
  final_file_id: string | null;
  purged_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface RequestDocRow extends DocState {
  id: string;
  request_id: string;
  model_item_id: string | null;
  section: string | null;
  name: string;
  description: string | null;
  kind: 'FILE' | 'TEXT';
  base_required: boolean;
  position: number;
  allow_multiple: boolean;
  max_files: number;
  both_sides: boolean;
  is_custom: boolean;
  is_combined: boolean;
  applicability_source: 'DEFAULT' | 'RULE' | 'MANUAL';
  awaiting_answer: boolean;
  na_reason: string | null;
  na_requested: boolean;
  text_value: string | null;
  applicant_note: string | null;
  rejection_reason: string | null;
  rejection_note: string | null;
  reviewer_note: string | null;
  submission_count: number;
  submitted_at: Date | null;
  reviewed_at: Date | null;
  reviewed_by: string | null;
}

const OPEN_FOR_EDIT: RequestStatus[] = ['RASCUNHO', 'AGUARDANDO_DOCUMENTOS', 'EM_CONFERENCIA', 'PENDENCIA', 'APROVADO', 'EXPIRADO'];

@Injectable()
export class RequestsService {
  private readonly logger = new Logger(RequestsService.name);

  constructor(
    private readonly db: Db,
    private readonly models: ModelsService,
    private readonly audit: AuditService,
    private readonly email: EmailService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ========================================================================
  // Checklist / regras
  // ========================================================================
  static questionsFromModel(model: FullModel): RequestQuestion[] {
    return model.questions.map((q) => ({
      questionId: q.id,
      key: q.key,
      label: q.label,
      helpText: q.help_text,
      type: q.type,
      options: q.options,
      required: q.required,
      answeredBy: q.answered_by,
      section: q.section,
      mapsTo: q.maps_to,
    }));
  }

  static coerceAnswers(questions: RequestQuestion[], raw: Record<string, unknown>, allowed?: (q: RequestQuestion) => boolean) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
      const q = questions.find((x) => x.key === key);
      if (!q) throw new BadRequestException(`Pergunta desconhecida: ${key}`);
      if (allowed && !allowed(q)) throw new BadRequestException(`Pergunta não pode ser respondida aqui: ${q.label}`);
      try {
        out[key] = coerceAnswer(q, value);
      } catch (e) {
        throw new BadRequestException((e as Error).message);
      }
    }
    return out;
  }

  /** Pré-visualização do checklist (tela "Nova solicitação"), avaliada no servidor. */
  async preview(modelId: string, rawAnswers: Record<string, unknown>) {
    const model = await this.models.get(modelId);
    const questions = RequestsService.questionsFromModel(model);
    const answers = RequestsService.coerceAnswers(questions, rawAnswers);
    const rules: RuleDef[] = model.rules.map((r) => ({
      questionKey: r.question_key,
      operator: r.operator,
      value: r.value,
      action: r.action,
      target: r.target_item_id,
    }));
    return {
      model,
      items: model.items.map((it) => {
        const ev = evaluateItem(it.id, it.required, rules, answers, questions);
        const conditions = rules
          .filter((r) => r.target === it.id)
          .map((r) => {
            const q = questions.find((x) => x.key === r.questionKey);
            const verb = r.action === 'SHOW_ITEM' ? 'Solicitar se' : r.action === 'HIDE_ITEM' ? 'Não solicitar se' : 'Obrigatório se';
            return `${verb}: ${q?.label ?? r.questionKey} = ${answerLabel(q, r.value)}`;
          });
        return { ...it, evaluation: ev, conditions };
      }),
    };
  }

  private async loadAnswers(requestId: string, c: Queryable = this.db.pool) {
    const rows = await this.db.many<{ key: string; value: unknown }>('select key, value from request_answers where request_id = $1', [requestId], c);
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  /** Reaplica as regras condicionais nos documentos da solicitação. */
  async applyRules(c: Queryable, requestId: string) {
    const r = await this.db.one<{ questions: RequestQuestion[]; rules: RuleDef[] }>(
      'select questions, rules from requests where id = $1',
      [requestId],
      c,
    );
    const answers = await this.loadAnswers(requestId, c);
    const docs = await this.db.many<RequestDocRow>('select * from request_documents where request_id = $1', [requestId], c);
    for (const d of docs) {
      if (d.is_combined) continue;
      const ev = evaluateItem(d.id, d.base_required, r.rules, answers, r.questions);
      if (d.applicability_source === 'MANUAL') {
        if (ev.required !== d.required) await this.db.exec('update request_documents set required = $2 where id = $1', [d.id, ev.required], c);
        continue;
      }
      const source = ev.conditional ? 'RULE' : 'DEFAULT';
      const naReason = ev.applicable ? null : ev.reason;
      if (
        d.is_applicable !== ev.applicable ||
        d.awaiting_answer !== ev.awaitingAnswer ||
        d.required !== ev.required ||
        d.applicability_source !== source ||
        (d.na_reason ?? null) !== naReason
      ) {
        await this.db.exec(
          `update request_documents set is_applicable=$2, awaiting_answer=$3, required=$4, applicability_source=$5, na_reason=$6 where id=$1`,
          [d.id, ev.applicable, ev.awaitingAnswer, ev.required, source, naReason],
          c,
        );
      }
    }
  }

  async unansweredRequired(requestId: string, c: Queryable = this.db.pool): Promise<RequestQuestion[]> {
    const r = await this.db.one<{ questions: RequestQuestion[] }>('select questions from requests where id = $1', [requestId], c);
    const answers = await this.loadAnswers(requestId, c);
    return r.questions.filter((q) => q.required && !isAnswered(answers[q.key]));
  }

  /** Recalcula o status da solicitação a partir dos documentos. */
  async recalc(requestId: string, actor: Actor, c: Queryable = this.db.pool): Promise<RequestStatus> {
    const r = await this.db.one<RequestRow>('select * from requests where id = $1 for update', [requestId], c);
    const docs = await this.db.many<RequestDocRow>('select is_applicable, required, status from request_documents where request_id = $1', [requestId], c);
    const unanswered = (await this.unansweredRequired(requestId, c)).length;
    const next = computeRequestStatus({
      linkGenerated: !!r.link_generated_at,
      linkExpiresAt: r.link_expires_at,
      cancelledAt: r.cancelled_at,
      finalizedAt: r.finalized_at,
      docs,
      unansweredRequiredQuestions: unanswered,
    });
    if (next !== r.status) {
      await this.db.exec(
        `update requests set status = $2,
                approved_at = case when $2 = 'APROVADO' then coalesce(approved_at, now()) when $2 in ('FINALIZADO') then approved_at else null end
          where id = $1`,
        [requestId, next],
        c,
      );
      await this.audit.log(actor, 'STATUS_CHANGED', { requestId, details: { from: r.status, to: next } }, c);
    }
    return next;
  }

  // ========================================================================
  // Criação
  // ========================================================================
  async create(dto: CreateRequestInput, actor: Actor & { type: 'USER' }) {
    const model = await this.models.get(dto.modelId);
    if (!model.active) throw new BadRequestException('Este modelo está inativo.');
    const questions = RequestsService.questionsFromModel(model);
    const answers = RequestsService.coerceAnswers(questions, dto.answers);
    const mode = dto.submissionMode ?? model.submission_mode;
    const personQ = questions.find((q) => q.mapsTo === 'request.person_type');
    const personType =
      (personQ && typeof answers[personQ.key] === 'string' ? (answers[personQ.key] as 'PF' | 'PJ') : null) ??
      dto.personType ??
      (dto.applicant.document?.length === 14 ? 'PJ' : 'PF');

    if (dto.responsibleUserId) {
      const ok = await this.db.maybe('select 1 from users where id = $1 and active', [dto.responsibleUserId]);
      if (!ok) throw new BadRequestException('Responsável inválido');
    }

    const result = await this.db.tx(async (c) => {
      const applicantId = await this.upsertApplicant(c, personType, dto.applicant);
      const companyId = await this.upsertCompany(c, applicantId, dto.applicant);
      const seq = await this.db.one<{ n: number }>("select nextval('request_code_seq')::int as n", [], c);
      const code = `PD-${new Date().getFullYear()}-${String(seq.n).padStart(6, '0')}`;
      const deadline = dto.deadline ?? (model.default_deadline_days ? addDays(new Date(), model.default_deadline_days) : null);

      const req = await this.db.one<{ id: string }>(
        `insert into requests (code, model_id, model_name, portal_title, output_file_pattern, applicant_id, company_id, person_type,
                               applicant_name, applicant_document, applicant_phone, applicant_email, notify_email, notes, message,
                               submission_mode, questions, rules, responsible_user_id, created_by, deadline)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'[]',$18,$19,$20) returning id`,
        [
          code, model.id, model.name, model.portal_title, model.output_file_pattern, applicantId, companyId, personType,
          dto.applicant.name, dto.applicant.document, dto.applicant.phone, dto.applicant.email,
          dto.notifyEmail ?? this.env.DEFAULT_NOTIFY_EMAIL ?? null, dto.notes, dto.message ?? model.default_message, mode,
          JSON.stringify(questions), dto.responsibleUserId ?? actor.userId, actor.userId, deadline,
        ],
        c,
      );

      // documentos
      const itemToDoc = new Map<string, string>();
      let pos = 1;
      const fileItems = dto.items.filter((i) => i.kind === 'FILE');
      if (mode === 'SINGLE_FILE' && fileItems.length) {
        const list = fileItems.map((i, n) => `${n + 1}. ${i.name}${i.required ? '' : ' (se houver)'}${i.description ? ` — ${i.description}` : ''}`).join('\n');
        await this.db.exec(
          `insert into request_documents (request_id, name, description, kind, base_required, required, position, allow_multiple, max_files, is_combined)
           values ($1,$2,$3,'FILE',true,true,$4,true,10,true)`,
          [req.id, model.single_file_label, `O PDF deve conter, nesta ordem:\n${list}`, pos++],
          c,
        );
      }
      for (const it of dto.items) {
        if (mode === 'SINGLE_FILE' && it.kind === 'FILE') continue;
        const isModelItem = !!it.modelItemId && model.items.some((m) => m.id === it.modelItemId);
        const d = await this.db.one<{ id: string }>(
          `insert into request_documents (request_id, model_item_id, section, name, description, kind, base_required, required, position,
                                          allow_multiple, max_files, both_sides, is_custom)
           values ($1,$2,$3,$4,$5,$6,$7,$7,$8,$9,$10,$11,$12) returning id`,
          [
            req.id, isModelItem ? it.modelItemId : null, it.section, it.name, it.description, it.kind, it.required, pos++,
            it.allowMultiple || it.bothSides, it.bothSides ? 2 : it.allowMultiple ? it.maxFiles : 1,
            it.bothSides, !isModelItem,
          ],
          c,
        );
        if (isModelItem) itemToDoc.set(it.modelItemId!, d.id);
      }

      // regras "congeladas" apontando para os documentos desta solicitação
      const rules: RuleDef[] = model.rules
        .filter((r) => itemToDoc.has(r.target_item_id))
        .map((r) => ({ questionKey: r.question_key, operator: r.operator, value: r.value, action: r.action, target: itemToDoc.get(r.target_item_id)! }));
      await this.db.exec('update requests set rules = $2 where id = $1', [req.id, JSON.stringify(rules)], c);

      await this.saveAnswers(c, req.id, questions, answers, 'INTERNAL', actor.userId);
      await this.applyRules(c, req.id);
      await this.syncEntities(c, req.id);
      await this.audit.log(actor, 'REQUEST_CREATED', { requestId: req.id, details: { code, model: model.name } }, c);

      let token: string | null = null;
      if (dto.generateLink) token = await this.issueLink(c, req.id, actor, false);
      await this.recalc(req.id, actor, c);
      return { id: req.id, code, token };
    });

    if (result.token && dto.sendEmailToApplicant && dto.applicant.email) {
      await this.sendLinkEmail(result.id, result.token, actor);
    }
    return { id: result.id, code: result.code, link: result.token ? this.linkUrl(result.token) : null };
  }

  private async upsertApplicant(c: PoolClient, personType: 'PF' | 'PJ', a: CreateRequestInput['applicant']): Promise<string> {
    if (a.document) {
      const existing = await this.db.maybe<{ id: string }>('select id from applicants where document = $1 order by created_at limit 1', [a.document], c);
      if (existing) {
        await this.db.exec(
          'update applicants set name=$2, email=coalesce($3, email), phone=coalesce($4, phone), person_type=$5 where id=$1',
          [existing.id, a.name, a.email, a.phone, personType],
          c,
        );
        return existing.id;
      }
    }
    return (
      await this.db.one<{ id: string }>(
        'insert into applicants (person_type, name, document, email, phone) values ($1,$2,$3,$4,$5) returning id',
        [personType, a.name, a.document, a.email, a.phone],
        c,
      )
    ).id;
  }

  private async upsertCompany(c: PoolClient, applicantId: string, a: Partial<CreateRequestInput['applicant']>): Promise<string | null> {
    if (!a.document || a.document.length !== 14 || !a.name) return null;
    const row = await this.db.one<{ id: string }>(
      `insert into companies (applicant_id, legal_name, cnpj, phone, email) values ($1,$2,$3,$4,$5)
       on conflict (cnpj) do update set legal_name = excluded.legal_name,
            phone = coalesce(excluded.phone, companies.phone), email = coalesce(excluded.email, companies.email)
       returning id`,
      [applicantId, a.name, a.document, a.phone ?? null, a.email ?? null],
      c,
    );
    return row.id;
  }

  async saveAnswers(
    c: Queryable,
    requestId: string,
    questions: RequestQuestion[],
    answers: Record<string, unknown>,
    by: 'INTERNAL' | 'APPLICANT',
    userId: string | null,
  ) {
    for (const [key, value] of Object.entries(answers)) {
      const q = questions.find((x) => x.key === key)!;
      if (value === null) {
        await this.db.exec('delete from request_answers where request_id = $1 and key = $2', [requestId, key], c);
        continue;
      }
      await this.db.exec(
        `insert into request_answers (request_id, question_id, key, label, value, answered_by, answered_by_user)
         values ($1,$2,$3,$4,$5,$6,$7)
         on conflict (request_id, key) do update set value = excluded.value, answered_by = excluded.answered_by,
              answered_by_user = excluded.answered_by_user, answered_at = now(), label = excluded.label`,
        [requestId, q.questionId, key, q.label, JSON.stringify(value), by, userId],
        c,
      );
    }
    const personQ = questions.find((q) => q.mapsTo === 'request.person_type');
    if (personQ && (answers[personQ.key] === 'PF' || answers[personQ.key] === 'PJ')) {
      await this.db.exec('update requests set person_type = $2 where id = $1', [requestId, answers[personQ.key]], c);
    }
  }

  /** Atualiza vehicles/drivers a partir das respostas mapeadas (maps_to). */
  async syncEntities(c: Queryable, requestId: string) {
    const r = await this.db.one<{ questions: RequestQuestion[]; company_id: string | null; applicant_id: string }>(
      'select questions, company_id, applicant_id from requests where id = $1',
      [requestId],
      c,
    );
    const answers = await this.loadAnswers(requestId, c);
    const pick = (prefix: string) => {
      const out: Record<string, string | null> = {};
      for (const q of r.questions) {
        if (q.mapsTo?.startsWith(prefix)) {
          const v = answers[q.key];
          out[q.mapsTo.slice(prefix.length)] = isAnswered(v) ? String(v) : null;
        }
      }
      return out;
    };
    const vehicle = pick('vehicle.');
    if (Object.values(vehicle).some(Boolean)) {
      const cols = ['plate', 'renavam', 'brand_model', 'year', 'color', 'body_type', 'axles', 'load_capacity', 'pbt'];
      const vals = cols.map((k) => (k === 'plate' ? vehicle[k]?.toUpperCase().replace(/[^A-Z0-9]/g, '') ?? null : vehicle[k] ?? null));
      await this.db.exec(
        `insert into vehicles (request_id, company_id, applicant_id, ${cols.join(',')})
         values ($1,$2,$3,${cols.map((_, i) => `$${i + 4}`).join(',')})
         on conflict (request_id) do update set ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}`,
        [requestId, r.company_id, r.applicant_id, ...vals],
        c,
      );
    }
    const driver = pick('driver.');
    if (Object.values(driver).some(Boolean)) {
      const cols = ['name', 'cpf', 'phone', 'email', 'address', 'relationship'];
      const vals = cols.map((k) => (k === 'cpf' ? onlyDigits(driver[k]) || null : driver[k] ?? null));
      await this.db.exec(
        `insert into drivers (request_id, company_id, ${cols.join(',')})
         values ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(',')})
         on conflict (request_id) do update set ${cols.map((k) => `${k} = excluded.${k}`).join(', ')}`,
        [requestId, r.company_id, ...vals],
        c,
      );
    }
  }

  // ========================================================================
  // Link exclusivo
  // ========================================================================
  linkUrl(token: string) {
    return `${this.env.APP_URL.replace(/\/$/, '')}/enviar/${token}`;
  }

  private async issueLink(c: Queryable, requestId: string, actor: Actor, regenerate: boolean): Promise<string> {
    const token = generateLinkToken();
    const r = await this.db.one<{ deadline: string | null }>('select deadline from requests where id = $1', [requestId], c);
    const expires = defaultExpiry(r.deadline, this.env.LINK_DEFAULT_EXPIRATION_DAYS);
    await this.db.exec(
      `update requests set token_hash=$2, token_encrypted=$3, link_active=true, link_generated_at=now(),
              link_expires_at = coalesce(case when $5 then link_expires_at end, $4)
        where id=$1`,
      [requestId, hashToken(token), encryptToken(token, this.env.TOKEN_ENCRYPTION_KEY), expires, regenerate],
      c,
    );
    await this.audit.log(actor, regenerate ? 'LINK_REGENERATED' : 'LINK_GENERATED', { requestId, details: { expiresAt: expires } }, c);
    return token;
  }

  async generateLink(requestId: string, actor: Actor, regenerate: boolean) {
    const r = await this.getRow(requestId);
    if (['CANCELADO', 'FINALIZADO'].includes(r.status)) throw new BadRequestException('Solicitação encerrada.');
    if (r.token_hash && !regenerate) {
      return { link: this.linkUrl(decryptToken(r.token_encrypted!, this.env.TOKEN_ENCRYPTION_KEY)) };
    }
    const token = await this.db.tx(async (c) => {
      const t = await this.issueLink(c, requestId, actor, !!r.token_hash);
      await this.recalc(requestId, actor, c);
      return t;
    });
    return { link: this.linkUrl(token) };
  }

  async setLinkActive(requestId: string, active: boolean, actor: Actor) {
    const r = await this.getRow(requestId);
    if (!r.token_hash) throw new BadRequestException('O link ainda não foi gerado.');
    await this.db.exec('update requests set link_active = $2 where id = $1', [requestId, active]);
    await this.audit.log(actor, active ? 'LINK_REACTIVATED' : 'LINK_DEACTIVATED', { requestId });
  }

  async markLinkSent(requestId: string, channel: string, actor: Actor) {
    await this.getRow(requestId);
    await this.db.exec('update requests set link_sent_at = now() where id = $1', [requestId]);
    await this.audit.log(actor, 'LINK_SENT', { requestId, details: { channel } });
  }

  renderMessage(r: Pick<RequestRow, 'message' | 'applicant_name' | 'model_name' | 'deadline'>, answers: Record<string, unknown>, questions: RequestQuestion[]) {
    const vars: Record<string, string> = {
      nome: r.applicant_name,
      tipo: r.model_name,
      prazo: r.deadline ? formatDate(r.deadline) : '',
    };
    for (const q of questions) {
      const v = answers[q.key];
      if (isAnswered(v)) vars[q.key] = answerLabel(q, v);
    }
    return renderPlaceholders(r.message ?? '', vars);
  }

  async sendLinkEmail(requestId: string, token: string | null, actor: Actor) {
    const r = await this.getRow(requestId);
    if (!r.applicant_email) throw new BadRequestException('A solicitação não possui e-mail do solicitante.');
    const t = token ?? (r.token_encrypted ? decryptToken(r.token_encrypted, this.env.TOKEN_ENCRYPTION_KEY) : null);
    if (!t) throw new BadRequestException('Gere o link antes de enviar.');
    const answers = await this.loadAnswers(requestId);
    const res = await this.email.send(
      'REQUEST_CREATED',
      r.applicant_email,
      {
        processType: r.model_name,
        applicantName: r.applicant_name,
        link: this.linkUrl(t),
        message: this.renderMessage(r, answers, r.questions),
        deadline: r.deadline ? formatDate(r.deadline) : null,
      },
      { requestId },
    );
    await this.audit.log(actor, res.ok ? 'EMAIL_SENT' : 'EMAIL_FAILED', {
      requestId,
      details: { template: 'REQUEST_CREATED', to: r.applicant_email, error: res.error },
    });
    if (res.ok) await this.markLinkSent(requestId, 'email', actor);
    return res;
  }

  // ========================================================================
  // Consulta
  // ========================================================================
  async getRow(id: string, c: Queryable = this.db.pool): Promise<RequestRow> {
    const r = await this.db.maybe<RequestRow>('select * from requests where id = $1', [id], c);
    if (!r) throw new NotFoundException('Solicitação não encontrada');
    return r;
  }

  async list(q: z.infer<typeof listQuerySchema>) {
    const where: string[] = [];
    const params: unknown[] = [];
    const add = (sql: string, v: unknown) => {
      params.push(v);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (q.status) add('r.status = ?', q.status);
    if (q.modelId) add('r.model_id = ?', q.modelId);
    if (q.responsibleUserId) add('r.responsible_user_id = ?', q.responsibleUserId);
    if (q.from) add("r.created_at >= (?::date)::timestamp at time zone 'America/Sao_Paulo'", q.from);
    if (q.to) add("r.created_at < ((?::date) + 1)::timestamp at time zone 'America/Sao_Paulo'", q.to);
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
      where.push(`(r.applicant_name ilike $${params.length} or r.code ilike $${params.length})`);
    }
    if (q.document) {
      const d = onlyDigits(q.document);
      if (d) add('r.applicant_document like ?', `%${d}%`);
    }
    const whereSql = where.length ? `where ${where.join(' and ')}` : '';
    const total = await this.db.one<{ n: number }>(`select count(*)::int as n from requests r ${whereSql}`, params);
    params.push(q.pageSize, (q.page - 1) * q.pageSize);
    const rows = await this.db.many(
      `select r.id, r.code, r.applicant_name, r.applicant_document, r.person_type, r.model_id, r.model_name, r.status,
              r.created_at, r.deadline, r.link_active, r.final_file_id, r.responsible_user_id, u.name as responsible_name,
              (r.token_encrypted is not null) as has_link,
              count(d.id) filter (where d.is_applicable)::int as docs_total,
              count(d.id) filter (where d.is_applicable and d.status = 'APROVADO')::int as docs_approved,
              count(d.id) filter (where d.is_applicable and d.status <> 'PENDENTE')::int as docs_received,
              count(d.id) filter (where d.is_applicable and d.status = 'REJEITADO')::int as docs_rejected,
              count(d.id) filter (where d.is_applicable and d.status = 'PENDENTE')::int as docs_pending
         from requests r
         left join users u on u.id = r.responsible_user_id
         left join request_documents d on d.request_id = r.id
         ${whereSql}
        group by r.id, u.name
        order by r.created_at desc
        limit $${params.length - 1} offset $${params.length}`,
      params,
    );
    return { total: total.n, page: q.page, pageSize: q.pageSize, rows };
  }

  async stats() {
    const rows = await this.db.many<{ status: string; n: number }>('select status, count(*)::int as n from requests group by status');
    const by = Object.fromEntries(rows.map((r) => [r.status, r.n]));
    return {
      total: rows.reduce((s, r) => s + r.n, 0),
      byStatus: by,
    };
  }

  async detail(id: string) {
    const r = await this.getRow(id);
    const docs = await this.db.many<RequestDocRow & { reviewed_by_name: string | null }>(
      `select d.*, u.name as reviewed_by_name from request_documents d left join users u on u.id = d.reviewed_by
        where d.request_id = $1 order by d.position, d.created_at`,
      [id],
    );
    const files = await this.db.many(
      `select id, request_document_id, kind, original_name, mime_type, size_bytes, page_count, side, submission_number,
              is_current, security_flags, uploaded_by_applicant, created_at, purged_at
         from files where request_id = $1 order by created_at`,
      [id],
    );
    const answersRows = await this.db.many('select key, label, value, answered_by, answered_at from request_answers where request_id = $1', [id]);
    const answers = Object.fromEntries(answersRows.map((a: any) => [a.key, a.value]));
    const timeline = await this.db.many(
      `select id, actor_type, actor_name, action, entity_type, entity_id, details, created_at
         from audit_logs where request_id = $1 and action not in ('FILE_VIEWED') order by created_at desc, id desc limit 500`,
      [id],
    );
    const emails = await this.db.many(
      'select id, template, recipient, subject, status, error, attachments, sent_at, created_at from email_logs where request_id = $1 order by created_at desc',
      [id],
    );
    const responsible = r.responsible_user_id ? await this.db.maybe('select id, name from users where id = $1', [r.responsible_user_id]) : null;
    const unanswered = await this.unansweredRequired(id);
    const link = r.token_encrypted ? this.linkUrl(decryptToken(r.token_encrypted, this.env.TOKEN_ENCRYPTION_KEY)) : null;
    const finalFile = r.final_file_id ? files.find((f: any) => f.id === r.final_file_id) ?? null : null;
    const { token_hash, token_encrypted, ...safe } = r;
    void token_hash;
    void token_encrypted;
    return {
      request: { ...safe, applicant_document_formatted: formatDocument(r.applicant_document), responsible },
      link,
      renderedMessage: this.renderMessage(r, answers, r.questions),
      progress: computeProgress(docs),
      canGeneratePdf: blockingReason(docs, unanswered.length) === null && ['APROVADO', 'FINALIZADO'].includes(r.status),
      blockingReason: blockingReason(docs, unanswered.length),
      unansweredQuestions: unanswered.map((q) => q.label),
      documents: docs.map((d) => ({ ...d, files: files.filter((f: any) => f.request_document_id === d.id && f.kind === 'ORIGINAL') })),
      questions: r.questions,
      answers: answersRows,
      finalFile,
      finalFiles: files.filter((f: any) => f.kind === 'FINAL'),
      timeline,
      emails,
    };
  }

  // ========================================================================
  // Alterações
  // ========================================================================
  async update(id: string, dto: z.infer<typeof updateRequestSchema>, actor: Actor) {
    const r = await this.getRow(id);
    if (!OPEN_FOR_EDIT.includes(r.status)) throw new BadRequestException('Solicitação encerrada não pode ser alterada.');
    if (dto.responsibleUserId) {
      const ok = await this.db.maybe('select 1 from users where id = $1 and active', [dto.responsibleUserId]);
      if (!ok) throw new BadRequestException('Responsável inválido');
    }
    await this.db.tx(async (c) => {
      const a = dto.applicant ?? {};
      await this.db.exec(
        `update requests set
           applicant_name = coalesce($2, applicant_name),
           applicant_document = case when $3::boolean then $4 else applicant_document end,
           applicant_phone = case when $5::boolean then $6 else applicant_phone end,
           applicant_email = case when $7::boolean then $8 else applicant_email end,
           notify_email = case when $9::boolean then $10 else notify_email end,
           notes = case when $11::boolean then $12 else notes end,
           responsible_user_id = case when $13::boolean then $14::uuid else responsible_user_id end,
           deadline = case when $15::boolean then $16::date else deadline end,
           message = case when $17::boolean then $18 else message end,
           link_expires_at = case when $19::boolean then $20::timestamptz else link_expires_at end,
           person_type = coalesce($21, person_type)
         where id = $1`,
        [
          id, a.name ?? null,
          a.document !== undefined, a.document ?? null,
          a.phone !== undefined, a.phone ?? null,
          a.email !== undefined, a.email ?? null,
          dto.notifyEmail !== undefined, dto.notifyEmail ?? null,
          dto.notes !== undefined, dto.notes ?? null,
          dto.responsibleUserId !== undefined, dto.responsibleUserId ?? null,
          dto.deadline !== undefined, dto.deadline ?? null,
          dto.message !== undefined, dto.message ?? null,
          dto.linkExpiresAt !== undefined, dto.linkExpiresAt ?? null,
          dto.personType ?? null,
        ],
        c,
      );
      await this.audit.log(actor, 'REQUEST_UPDATED', { requestId: id, details: { fields: Object.keys(dto) } }, c);
      await this.recalc(id, actor, c);
    });
  }

  async setAnswers(id: string, raw: Record<string, unknown>, by: 'INTERNAL' | 'APPLICANT', actor: Actor) {
    const r = await this.getRow(id);
    if (!OPEN_FOR_EDIT.includes(r.status)) throw new BadRequestException('Solicitação encerrada não pode ser alterada.');
    const answers = RequestsService.coerceAnswers(r.questions, raw, by === 'APPLICANT' ? (q) => q.answeredBy === 'APPLICANT' : undefined);
    if (!Object.keys(answers).length) return;
    await this.db.tx(async (c) => {
      await this.saveAnswers(c, id, r.questions, answers, by, actor.type === 'USER' ? actor.userId : null);
      await this.applyRules(c, id);
      await this.syncEntities(c, id);
      await this.audit.log(actor, 'ANSWERS_UPDATED', { requestId: id, details: { keys: Object.keys(answers) } }, c);
      await this.recalc(id, actor, c);
    });
  }

  async cancel(id: string, reason: string | null, actor: Actor) {
    const r = await this.getRow(id);
    if (r.status === 'FINALIZADO') throw new BadRequestException('Processo finalizado não pode ser cancelado.');
    if (r.status === 'CANCELADO') return;
    await this.db.tx(async (c) => {
      await this.db.exec('update requests set cancelled_at = now(), cancel_reason = $2, link_active = false where id = $1', [id, reason], c);
      await this.audit.log(actor, 'REQUEST_CANCELLED', { requestId: id, details: { reason } }, c);
      await this.recalc(id, actor, c);
    });
  }

  async reopen(id: string, actor: Actor) {
    const r = await this.getRow(id);
    if (r.status !== 'CANCELADO') throw new BadRequestException('Apenas solicitações canceladas podem ser reabertas.');
    await this.db.tx(async (c) => {
      await this.db.exec('update requests set cancelled_at = null, cancel_reason = null, link_active = (token_hash is not null) where id = $1', [id], c);
      await this.audit.log(actor, 'REQUEST_REOPENED', { requestId: id }, c);
      await this.recalc(id, actor, c);
    });
  }

  // ---- checklist da solicitação ------------------------------------------
  private async getDoc(requestId: string, docId: string, c: Queryable = this.db.pool): Promise<RequestDocRow> {
    const d = await this.db.maybe<RequestDocRow>('select * from request_documents where id = $1 and request_id = $2', [docId, requestId], c);
    if (!d) throw new NotFoundException('Documento não encontrado nesta solicitação');
    return d;
  }

  async addDocument(id: string, dto: z.infer<typeof addDocumentSchema>, actor: Actor) {
    const r = await this.getRow(id);
    if (!OPEN_FOR_EDIT.includes(r.status)) throw new BadRequestException('Solicitação encerrada não pode ser alterada.');
    return this.db.tx(async (c) => {
      const pos = await this.db.one<{ p: number }>('select coalesce(max(position), 0) + 1 as p from request_documents where request_id = $1', [id], c);
      const d = await this.db.one<{ id: string }>(
        `insert into request_documents (request_id, section, name, description, kind, base_required, required, position, allow_multiple, max_files, both_sides, is_custom)
         values ($1,$2,$3,$4,$5,$6,$6,$7,$8,$9,$10,true) returning id`,
        [id, dto.section, dto.name, dto.description, dto.kind, dto.required, pos.p, dto.allowMultiple || dto.bothSides,
          dto.bothSides ? 2 : dto.allowMultiple ? dto.maxFiles : 1, dto.bothSides],
        c,
      );
      await this.audit.log(actor, 'DOCUMENT_ADDED', { requestId: id, entityType: 'request_document', entityId: d.id, details: { name: dto.name } }, c);
      await this.recalc(id, actor, c);
      return { id: d.id };
    });
  }

  async updateDocument(id: string, docId: string, dto: z.infer<typeof updateDocumentSchema>, actor: Actor) {
    const r = await this.getRow(id);
    if (!OPEN_FOR_EDIT.includes(r.status)) throw new BadRequestException('Solicitação encerrada não pode ser alterada.');
    await this.db.tx(async (c) => {
      const d = await this.getDoc(id, docId, c);
      await this.db.exec(
        `update request_documents set name = coalesce($2, name), description = case when $3::boolean then $4 else description end,
                base_required = coalesce($5, base_required), required = coalesce($5, required),
                allow_multiple = coalesce($6, allow_multiple) or coalesce($7, both_sides),
                both_sides = coalesce($7, both_sides),
                max_files = case when coalesce($7, both_sides) then 2
                                 when coalesce($6, allow_multiple) then greatest(max_files, 10) else 1 end
          where id = $1`,
        [docId, dto.name ?? null, dto.description !== undefined, dto.description ?? null, dto.required ?? null, dto.allowMultiple ?? null, dto.bothSides ?? null],
        c,
      );
      if (dto.notApplicable !== undefined) {
        if (dto.notApplicable) {
          await this.db.exec(
            `update request_documents set is_applicable = false, applicability_source = 'MANUAL', awaiting_answer = false, na_reason = $2 where id = $1`,
            [docId, dto.naReason ?? 'Marcado como N/A pelo RH'],
            c,
          );
          await this.audit.log(actor, 'DOCUMENT_MARKED_NA', { requestId: id, entityType: 'request_document', entityId: docId, details: { name: d.name, reason: dto.naReason } }, c);
        } else {
          await this.db.exec(`update request_documents set is_applicable = true, applicability_source = 'DEFAULT', na_reason = null where id = $1`, [docId], c);
          await this.audit.log(actor, 'DOCUMENT_UNMARKED_NA', { requestId: id, entityType: 'request_document', entityId: docId, details: { name: d.name } }, c);
          await this.applyRules(c, id);
        }
      } else {
        await this.audit.log(actor, 'DOCUMENT_UPDATED', { requestId: id, entityType: 'request_document', entityId: docId, details: { name: d.name, fields: Object.keys(dto) } }, c);
      }
      await this.applyRules(c, id);
      await this.recalc(id, actor, c);
    });
  }

  async removeDocument(id: string, docId: string, actor: Actor) {
    const r = await this.getRow(id);
    if (!OPEN_FOR_EDIT.includes(r.status)) throw new BadRequestException('Solicitação encerrada não pode ser alterada.');
    await this.db.tx(async (c) => {
      const d = await this.getDoc(id, docId, c);
      const hasFiles = await this.db.maybe('select 1 from files where request_document_id = $1 limit 1', [docId], c);
      if (hasFiles || d.text_value || d.submission_count > 0 || d.na_requested) {
        throw new ConflictException('O documento já recebeu envios. Marque-o como N/A em vez de remover (o histórico é preservado).');
      }
      await this.db.exec('delete from request_documents where id = $1', [docId], c);
      const rules = (await this.db.one<{ rules: RuleDef[] }>('select rules from requests where id = $1', [id], c)).rules.filter((x) => x.target !== docId);
      await this.db.exec('update requests set rules = $2 where id = $1', [id, JSON.stringify(rules)], c);
      await this.audit.log(actor, 'DOCUMENT_REMOVED', { requestId: id, entityType: 'request_document', entityId: docId, details: { name: d.name } }, c);
      await this.recalc(id, actor, c);
    });
  }

  async reorderDocuments(id: string, order: string[], actor: Actor) {
    await this.getRow(id);
    await this.db.tx(async (c) => {
      const docs = await this.db.many<{ id: string }>('select id from request_documents where request_id = $1', [id], c);
      const set = new Set(docs.map((d) => d.id));
      if (order.length !== set.size || !order.every((o) => set.has(o))) throw new BadRequestException('A ordem deve conter todos os documentos.');
      for (const [i, docId] of order.entries()) {
        await this.db.exec('update request_documents set position = $2 where id = $1', [docId, i + 1], c);
      }
      await this.audit.log(actor, 'DOCUMENT_UPDATED', { requestId: id, details: { reordered: true } }, c);
    });
  }
}

export function addDays(d: Date, days: number): string {
  const x = new Date(d.getTime() + days * 86400_000);
  return x.toLocaleDateString('sv-SE', { timeZone: 'America/Sao_Paulo' });
}

/**
 * Expiração padrão do link: LINK_DEFAULT_EXPIRATION_DAYS após a geração, nunca antes do fim do dia do prazo.
 * O RH pode alterar a expiração de cada solicitação.
 */
export function defaultExpiry(deadline: string | null, days: number): string {
  const byDays = Date.now() + days * 86400_000;
  const byDeadline = deadline ? new Date(`${deadline}T23:59:59-03:00`).getTime() : 0;
  return new Date(Math.max(byDays, byDeadline)).toISOString();
}

export function formatDate(d: string | Date): string {
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d)) {
    const [y, m, day] = d.split('-');
    return `${day}/${m}/${y}`;
  }
  return new Date(d).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}
