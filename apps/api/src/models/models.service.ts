import { Injectable, NotFoundException } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { Db } from '../db/pool';
import { ModelInput } from './models.schema';

export interface ModelItemRow {
  id: string;
  section: string | null;
  name: string;
  description: string | null;
  kind: 'FILE' | 'TEXT';
  required: boolean;
  position: number;
  allow_multiple: boolean;
  max_files: number;
  both_sides: boolean;
  accept: 'ANY' | 'IMAGE' | 'PDF';
}
export interface ModelQuestionRow {
  id: string;
  key: string;
  label: string;
  help_text: string | null;
  type: 'BOOLEAN' | 'SELECT' | 'TEXT' | 'NUMBER' | 'DATE';
  options: any[];
  required: boolean;
  answered_by: 'INTERNAL' | 'APPLICANT';
  section: string | null;
  position: number;
  maps_to: string | null;
}
export interface ModelRuleRow {
  id: string;
  question_id: string;
  question_key: string;
  operator: any;
  value: unknown;
  action: any;
  target_item_id: string;
}
export interface FullModel {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  category: string;
  portal_title: string;
  default_message: string | null;
  default_deadline_days: number | null;
  submission_mode: 'SEPARATE' | 'SINGLE_FILE';
  single_file_label: string;
  output_file_pattern: string;
  active: boolean;
  created_at: string;
  updated_at: string;
  items: ModelItemRow[];
  questions: ModelQuestionRow[];
  rules: ModelRuleRow[];
}

function slugify(s: string) {
  return (
    s
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'modelo'
  );
}

@Injectable()
export class ModelsService {
  constructor(private readonly db: Db) {}

  list(onlyActive: boolean) {
    return this.db.many(
      `select m.id, m.name, m.slug, m.description, m.category, m.active, m.submission_mode, m.default_deadline_days,
              m.updated_at,
              (select count(*) from document_model_items i where i.model_id = m.id) as items_count,
              (select count(*) from document_model_questions q where q.model_id = m.id) as questions_count,
              (select count(*) from document_model_rules r where r.model_id = m.id) as rules_count,
              (select count(*) from requests r where r.model_id = m.id) as requests_count
         from document_models m
        where ($1::boolean is false or m.active)
        order by m.active desc, m.created_at`,
      [onlyActive],
    );
  }

  async get(id: string): Promise<FullModel> {
    const model = await this.db.maybe<FullModel>('select * from document_models where id = $1', [id]);
    if (!model) throw new NotFoundException('Modelo não encontrado');
    model.items = await this.db.many(
      `select id, section, name, description, kind, required, position, allow_multiple, max_files, both_sides, accept
         from document_model_items where model_id = $1 and active order by position, created_at`,
      [id],
    );
    model.questions = await this.db.many(
      `select id, key, label, help_text, type, options, required, answered_by, section, position, maps_to
         from document_model_questions where model_id = $1 order by position, created_at`,
      [id],
    );
    model.rules = await this.db.many(
      `select r.id, r.question_id, q.key as question_key, r.operator, r.value, r.action, r.target_item_id
         from document_model_rules r join document_model_questions q on q.id = r.question_id
        where r.model_id = $1 order by r.created_at`,
      [id],
    );
    return model;
  }

  private async uniqueSlug(c: PoolClient, name: string, exceptId?: string) {
    const base = slugify(name);
    for (let n = 1; n < 1000; n++) {
      const slug = n === 1 ? base : `${base}-${n}`;
      const hit = await this.db.maybe('select 1 from document_models where slug = $1 and id is distinct from $2', [slug, exceptId ?? null], c);
      if (!hit) return slug;
    }
    throw new Error('Não foi possível gerar identificador do modelo');
  }

  async create(input: ModelInput, userId: string): Promise<string> {
    return this.db.tx(async (c) => {
      const slug = await this.uniqueSlug(c, input.name);
      const { id } = await this.db.one<{ id: string }>(
        `insert into document_models (name, slug, description, category, portal_title, default_message, default_deadline_days,
                                      submission_mode, single_file_label, output_file_pattern, active, created_by)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
        [
          input.name, slug, input.description, input.category, input.portalTitle, input.defaultMessage,
          input.defaultDeadlineDays, input.submissionMode, input.singleFileLabel, input.outputFilePattern, input.active, userId,
        ],
        c,
      );
      await this.saveChildren(c, id, input);
      return id;
    });
  }

  async update(id: string, input: ModelInput): Promise<void> {
    await this.db.tx(async (c) => {
      const exists = await this.db.maybe('select 1 from document_models where id = $1 for update', [id], c);
      if (!exists) throw new NotFoundException('Modelo não encontrado');
      await this.db.exec(
        `update document_models set name=$2, description=$3, category=$4, portal_title=$5, default_message=$6,
                default_deadline_days=$7, submission_mode=$8, single_file_label=$9, output_file_pattern=$10, active=$11
          where id = $1`,
        [
          id, input.name, input.description, input.category, input.portalTitle, input.defaultMessage,
          input.defaultDeadlineDays, input.submissionMode, input.singleFileLabel, input.outputFilePattern, input.active,
        ],
        c,
      );
      await this.saveChildren(c, id, input);
    });
  }

  /** Grava itens, perguntas e regras. Itens/perguntas existentes mantêm o id (histórico das solicitações). */
  private async saveChildren(c: PoolClient, modelId: string, input: ModelInput) {
    const itemIds = new Map<string, string>();
    const keptItems: string[] = [];
    for (const [pos, it] of input.items.entries()) {
      const params = [modelId, it.section, it.name, it.description, it.kind, it.required, pos + 1, it.allowMultiple || it.bothSides, it.bothSides ? 2 : it.allowMultiple ? it.maxFiles : 1, it.bothSides, it.accept ?? 'ANY'];
      let id: string | null = null;
      if (it.id) {
        const r = await this.db.maybe<{ id: string }>(
          `update document_model_items set section=$2, name=$3, description=$4, kind=$5, required=$6, position=$7,
                  allow_multiple=$8, max_files=$9, both_sides=$10, accept=$11, active=true
            where id = $12 and model_id = $1 returning id`,
          [...params, it.id],
          c,
        );
        id = r?.id ?? null;
      }
      if (!id) {
        id = (
          await this.db.one<{ id: string }>(
            `insert into document_model_items (model_id, section, name, description, kind, required, position, allow_multiple, max_files, both_sides, accept)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
            params,
            c,
          )
        ).id;
      }
      itemIds.set(it.ref, id);
      keptItems.push(id);
    }
    await this.db.exec('delete from document_model_items where model_id = $1 and not (id = any($2::uuid[]))', [modelId, keptItems], c);

    const qIds = new Map<string, string>();
    const keptQs: string[] = [];
    // libera as chaves para permitir renomear/trocar chaves entre perguntas
    await this.db.exec(`update document_model_questions set key = 'tmp_' || replace(id::text, '-', '_') where model_id = $1`, [modelId], c);
    for (const [pos, q] of input.questions.entries()) {
      const params = [modelId, q.key, q.label, q.helpText, q.type, JSON.stringify(q.options), q.required, q.answeredBy, q.section, pos + 1, q.mapsTo];
      let id: string | null = null;
      if (q.id) {
        const r = await this.db.maybe<{ id: string }>(
          `update document_model_questions set key=$2, label=$3, help_text=$4, type=$5, options=$6, required=$7,
                  answered_by=$8, section=$9, position=$10, maps_to=$11
            where id = $12 and model_id = $1 returning id`,
          [...params, q.id],
          c,
        );
        id = r?.id ?? null;
      }
      if (!id) {
        id = (
          await this.db.one<{ id: string }>(
            `insert into document_model_questions (model_id, key, label, help_text, type, options, required, answered_by, section, position, maps_to)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
            params,
            c,
          )
        ).id;
      }
      qIds.set(q.ref, id);
      keptQs.push(id);
    }
    await this.db.exec('delete from document_model_questions where model_id = $1 and not (id = any($2::uuid[]))', [modelId, keptQs], c);

    await this.db.exec('delete from document_model_rules where model_id = $1', [modelId], c);
    for (const r of input.rules) {
      await this.db.exec(
        `insert into document_model_rules (model_id, question_id, operator, value, action, target_item_id)
         values ($1,$2,$3,$4,$5,$6)`,
        [modelId, qIds.get(r.questionRef), r.operator, JSON.stringify(r.value ?? null), r.action, itemIds.get(r.targetRef)],
        c,
      );
    }
  }

  async duplicate(id: string, userId: string): Promise<string> {
    const m = await this.get(id);
    const input: ModelInput = {
      name: `${m.name} (cópia)`,
      description: m.description,
      category: m.category,
      portalTitle: m.portal_title,
      defaultMessage: m.default_message,
      defaultDeadlineDays: m.default_deadline_days,
      submissionMode: m.submission_mode,
      singleFileLabel: m.single_file_label,
      outputFilePattern: m.output_file_pattern,
      active: false,
      items: m.items.map((i) => ({
        ref: i.id, section: i.section, name: i.name, description: i.description, kind: i.kind, required: i.required,
        allowMultiple: i.allow_multiple, maxFiles: i.max_files, bothSides: i.both_sides, accept: i.accept,
      })),
      questions: m.questions.map((q) => ({
        ref: q.id, key: q.key, label: q.label, helpText: q.help_text, type: q.type, options: q.options, required: q.required,
        answeredBy: q.answered_by, section: q.section, mapsTo: q.maps_to as any,
      })),
      rules: m.rules.map((r) => ({
        questionRef: r.question_id, operator: r.operator, value: r.value as any, action: r.action, targetRef: r.target_item_id,
      })),
    };
    return this.create(input, userId);
  }

  async setActive(id: string, active: boolean) {
    const n = await this.db.exec('update document_models set active = $2 where id = $1', [id, active]);
    if (!n) throw new NotFoundException('Modelo não encontrado');
  }
}
