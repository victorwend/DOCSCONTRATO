/** Formatação dos valores inseridos no contrato (padrões brasileiros). */

export const FIELD_FORMATS = [
  'UPPER',
  'CPF_CNPJ',
  'CEP',
  'PHONE',
  'DATE_BR',
  'DATE_LONG',
  'DAY',
  'MONTH_NAME',
  'YEAR',
  'MONEY',
  'MONEY_NUMBER',
  'MONEY_WORDS',
  'MONEY_FULL',
  'NUMBER_WORDS',
  'NUMBER_FULL',
] as const;
export type FieldFormat = (typeof FIELD_FORMATS)[number];

export const FORMAT_LABELS: Record<FieldFormat, string> = {
  UPPER: 'MAIÚSCULAS',
  CPF_CNPJ: 'CPF/CNPJ (000.000.000-00)',
  CEP: 'CEP (00000-000)',
  PHONE: 'Telefone ((00) 00000-0000)',
  DATE_BR: 'Data (06/11/2026)',
  DATE_LONG: 'Data por extenso (6 de novembro de 2026)',
  DAY: 'Somente o dia (06)',
  MONTH_NAME: 'Somente o mês (novembro)',
  YEAR: 'Somente o ano (2026)',
  MONEY: 'Valor (R$ 1.500,00)',
  MONEY_NUMBER: 'Valor sem R$ (1.500,00)',
  MONEY_WORDS: 'Valor por extenso (mil e quinhentos reais)',
  MONEY_FULL: 'Valor + extenso (R$ 1.500,00 (mil e quinhentos reais))',
  NUMBER_WORDS: 'Número por extenso (doze)',
  NUMBER_FULL: 'Número + extenso (12 (doze))',
};

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];

export function parseDate(v: unknown): { y: number; m: number; d: number } | null {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return { y: +m[1], m: +m[2], d: +m[3] };
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s);
  if (m) return { y: +m[3], m: +m[2], d: +m[1] };
  return null;
}

export function parseMoney(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').replace(/R\$|\s/g, '');
  if (!s) return null;
  if (/,\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  else s = s.replace(/,/g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

export function moneyBR(n: number): string {
  return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const UNITS = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove', 'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const TENS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const HUNDREDS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos', 'setecentos', 'oitocentos', 'novecentos'];

function under1000(n: number): string {
  if (n === 0) return '';
  if (n === 100) return 'cem';
  const parts: string[] = [];
  const h = Math.floor(n / 100);
  const r = n % 100;
  if (h) parts.push(HUNDREDS[h]);
  if (r) {
    if (r < 20) parts.push(UNITS[r]);
    else {
      const t = Math.floor(r / 10);
      const u = r % 10;
      parts.push(u ? `${TENS[t]} e ${UNITS[u]}` : TENS[t]);
    }
  }
  return parts.join(' e ');
}

/** Número inteiro por extenso (até 999 bilhões). */
export function numberWords(n: number): string {
  n = Math.floor(Math.abs(n));
  if (n === 0) return 'zero';
  const scales: Array<[number, string, string]> = [
    [1e9, 'bilhão', 'bilhões'],
    [1e6, 'milhão', 'milhões'],
    [1e3, 'mil', 'mil'],
  ];
  const groups: Array<{ value: number; text: string }> = [];
  let rest = n;
  for (const [size, sing, plur] of scales) {
    const q = Math.floor(rest / size);
    rest %= size;
    if (q) {
      const t = size === 1e3 && q === 1 ? 'mil' : `${under1000(q)} ${q === 1 ? sing : plur}`;
      groups.push({ value: q * size, text: t });
    }
  }
  if (rest) groups.push({ value: rest, text: under1000(rest) });
  // conector "e" antes do último grupo quando ele é < 100 ou múltiplo de 100 ("mil e quinhentos")
  let out = groups[0].text;
  for (let i = 1; i < groups.length; i++) {
    const g = groups[i];
    const last = i === groups.length - 1;
    out += last && (g.value < 100 || g.value % 100 === 0) ? ` e ${g.text}` : ` ${g.text}`;
  }
  return out;
}

export function moneyWords(v: number): string {
  const cents = Math.round(Math.abs(v) * 100);
  const reais = Math.floor(cents / 100);
  const c = cents % 100;
  const parts: string[] = [];
  if (reais) {
    const w = numberWords(reais);
    // "um milhão de reais", "dois milhões de reais"
    const de = reais >= 1e6 && reais % 1e6 === 0 ? ' de' : '';
    parts.push(`${w}${de} ${reais === 1 ? 'real' : 'reais'}`);
  }
  if (c) parts.push(`${numberWords(c)} ${c === 1 ? 'centavo' : 'centavos'}`);
  return parts.length ? parts.join(' e ') : 'zero real';
}

function digits(s: string) {
  return s.replace(/\D/g, '');
}

export function formatCpfCnpj(v: string): string {
  const d = digits(v);
  if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
  return v;
}

export function formatValue(raw: unknown, type: string, format: FieldFormat | null): string {
  const s = typeof raw === 'string' ? raw.trim() : String(raw ?? '');
  if (!format) {
    if (type === 'DATE') {
      const d = parseDate(s);
      return d ? `${String(d.d).padStart(2, '0')}/${String(d.m).padStart(2, '0')}/${d.y}` : s;
    }
    if (type === 'MONEY') {
      const n = parseMoney(s);
      return n === null ? s : `R$ ${moneyBR(n)}`;
    }
    return s;
  }
  switch (format) {
    case 'UPPER':
      return s.toLocaleUpperCase('pt-BR');
    case 'CPF_CNPJ':
      return formatCpfCnpj(s);
    case 'CEP': {
      const d = digits(s);
      return d.length === 8 ? `${d.slice(0, 5)}-${d.slice(5)}` : s;
    }
    case 'PHONE': {
      const d = digits(s);
      if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
      if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
      return s;
    }
    case 'DATE_BR':
    case 'DATE_LONG':
    case 'DAY':
    case 'MONTH_NAME':
    case 'YEAR': {
      const d = parseDate(s);
      if (!d) return s;
      if (format === 'DATE_BR') return `${String(d.d).padStart(2, '0')}/${String(d.m).padStart(2, '0')}/${d.y}`;
      if (format === 'DATE_LONG') return `${d.d} de ${MONTHS[d.m - 1]} de ${d.y}`;
      if (format === 'DAY') return String(d.d).padStart(2, '0');
      if (format === 'MONTH_NAME') return MONTHS[d.m - 1];
      return String(d.y);
    }
    case 'MONEY':
    case 'MONEY_NUMBER':
    case 'MONEY_WORDS':
    case 'MONEY_FULL': {
      const n = parseMoney(s);
      if (n === null) return s;
      if (format === 'MONEY') return `R$ ${moneyBR(n)}`;
      if (format === 'MONEY_NUMBER') return moneyBR(n);
      if (format === 'MONEY_WORDS') return moneyWords(n);
      return `R$ ${moneyBR(n)} (${moneyWords(n)})`;
    }
    case 'NUMBER_WORDS':
    case 'NUMBER_FULL': {
      const n = Number(s.replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(n) || !Number.isInteger(n)) return s;
      return format === 'NUMBER_WORDS' ? numberWords(n) : `${n} (${numberWords(n)})`;
    }
  }
  return s;
}
