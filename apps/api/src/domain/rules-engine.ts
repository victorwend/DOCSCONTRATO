/**
 * Motor de regras condicionais (puro, sem dependências).
 *
 * Semântica das ações:
 *  - SHOW_ITEM:    o item só é solicitado quando ao menos uma regra SHOW_ITEM dele for verdadeira.
 *                  Enquanto a pergunta não for respondida, o item fica "aguardando resposta".
 *  - HIDE_ITEM:    quando verdadeira, o item não se aplica (N/A). Prevalece sobre SHOW_ITEM.
 *  - REQUIRE_ITEM: quando verdadeira, o item passa a ser obrigatório.
 */

export type RuleOperator = 'EQUALS' | 'NOT_EQUALS' | 'IN' | 'NOT_IN' | 'ANSWERED';
export type RuleAction = 'SHOW_ITEM' | 'HIDE_ITEM' | 'REQUIRE_ITEM';

export interface RuleDef {
  questionKey: string;
  operator: RuleOperator;
  value: unknown;
  action: RuleAction;
  target: string; // referência do item (id do item do modelo ou do documento da solicitação)
}

export interface QuestionDef {
  key: string;
  label: string;
  type: 'BOOLEAN' | 'SELECT' | 'TEXT' | 'NUMBER' | 'DATE';
  options?: Array<{ value: unknown; label: string } | string>;
  required?: boolean;
  answeredBy?: 'INTERNAL' | 'APPLICANT';
}

export interface ItemEvaluation {
  applicable: boolean;
  required: boolean;
  awaitingAnswer: boolean;
  conditional: boolean;
  reason: string | null;
}

export type Answers = Record<string, unknown>;

export function isAnswered(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === 'string') return v.trim().length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function norm(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (v === null || v === undefined) return '';
  return String(v).trim().toLowerCase();
}

export function ruleMatches(rule: Pick<RuleDef, 'operator' | 'value' | 'questionKey'>, answers: Answers): boolean {
  const a = answers[rule.questionKey];
  if (!isAnswered(a)) return false;
  switch (rule.operator) {
    case 'ANSWERED':
      return true;
    case 'EQUALS':
      return norm(a) === norm(rule.value);
    case 'NOT_EQUALS':
      return norm(a) !== norm(rule.value);
    case 'IN':
    case 'NOT_IN': {
      const list = Array.isArray(rule.value) ? rule.value.map(norm) : [norm(rule.value)];
      const hit = list.includes(norm(a));
      return rule.operator === 'IN' ? hit : !hit;
    }
    default:
      return false;
  }
}

export function answerLabel(q: QuestionDef | undefined, value: unknown): string {
  if (!isAnswered(value)) return '—';
  if (q?.options && q.options.length) {
    const opt = q.options.find((o) => typeof o !== 'string' && norm(o.value) === norm(value));
    if (opt && typeof opt !== 'string') return opt.label;
  }
  if (typeof value === 'boolean') return value ? 'Sim' : 'Não';
  return String(value);
}

export function evaluateItem(
  target: string,
  baseRequired: boolean,
  rules: RuleDef[],
  answers: Answers,
  questions: QuestionDef[] = [],
): ItemEvaluation {
  const mine = rules.filter((r) => r.target === target);
  const show = mine.filter((r) => r.action === 'SHOW_ITEM');
  const hide = mine.filter((r) => r.action === 'HIDE_ITEM');
  const req = mine.filter((r) => r.action === 'REQUIRE_ITEM');
  const qByKey = new Map(questions.map((q) => [q.key, q]));

  const describe = (r: RuleDef) => {
    const q = qByKey.get(r.questionKey);
    return `${q?.label ?? r.questionKey}: ${answerLabel(q, answers[r.questionKey])}`;
  };

  const hideHit = hide.find((r) => ruleMatches(r, answers));
  const required = baseRequired || req.some((r) => ruleMatches(r, answers));
  const conditional = show.length > 0 || hide.length > 0;

  if (hideHit) {
    return { applicable: false, required, awaitingAnswer: false, conditional, reason: `Não se aplica (${describe(hideHit)})` };
  }
  if (show.length > 0) {
    if (show.some((r) => ruleMatches(r, answers))) {
      return { applicable: true, required, awaitingAnswer: false, conditional, reason: null };
    }
    const unanswered = show.filter((r) => !isAnswered(answers[r.questionKey]));
    if (unanswered.length > 0) {
      const q = qByKey.get(unanswered[0].questionKey);
      return {
        applicable: false,
        required,
        awaitingAnswer: true,
        conditional,
        reason: `Depende da resposta: ${q?.label ?? unanswered[0].questionKey}`,
      };
    }
    return { applicable: false, required, awaitingAnswer: false, conditional, reason: `Não se aplica (${describe(show[0])})` };
  }
  return { applicable: true, required, awaitingAnswer: false, conditional, reason: null };
}

/** Converte respostas recebidas (strings de formulário) para o tipo da pergunta. */
export function coerceAnswer(q: QuestionDef, raw: unknown): unknown {
  if (raw === undefined || raw === null) return null;
  if (typeof raw === 'string' && raw.trim() === '') return null;
  switch (q.type) {
    case 'BOOLEAN':
      if (typeof raw === 'boolean') return raw;
      if (['true', 'sim', '1', 'yes'].includes(norm(raw))) return true;
      if (['false', 'nao', 'não', '0', 'no'].includes(norm(raw))) return false;
      throw new Error(`Resposta inválida para "${q.label}"`);
    case 'NUMBER': {
      const n = typeof raw === 'number' ? raw : Number(String(raw).replace(',', '.'));
      if (!Number.isFinite(n)) throw new Error(`Número inválido para "${q.label}"`);
      return n;
    }
    case 'SELECT': {
      const opts = (q.options ?? []).map((o) => (typeof o === 'string' ? o : o.value));
      const hit = opts.find((o) => norm(o) === norm(raw));
      if (opts.length && hit === undefined) throw new Error(`Opção inválida para "${q.label}"`);
      return hit ?? raw;
    }
    case 'DATE': {
      const s = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`Data inválida para "${q.label}"`);
      return s;
    }
    default: {
      const s = String(raw).trim();
      if (s.length > 2000) throw new Error(`Resposta muito longa para "${q.label}"`);
      return s;
    }
  }
}
