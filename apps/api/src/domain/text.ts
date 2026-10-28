/** Utilitários de texto: CPF/CNPJ, nomes de arquivo e mensagens com variáveis. */

export const onlyDigits = (s: string | null | undefined) => (s ?? '').replace(/\D+/g, '');

export function isValidCpf(value: string): boolean {
  const c = onlyDigits(value);
  if (c.length !== 11 || /^(\d)\1{10}$/.test(c)) return false;
  const calc = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(c[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return r === 10 ? 0 : r;
  };
  return calc(9) === Number(c[9]) && calc(10) === Number(c[10]);
}

export function isValidCnpj(value: string): boolean {
  const c = onlyDigits(value);
  if (c.length !== 14 || /^(\d)\1{13}$/.test(c)) return false;
  const calc = (len: number) => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(c[i]) * w, 0);
    const r = sum % 11;
    return r < 2 ? 0 : 11 - r;
  };
  return calc(12) === Number(c[12]) && calc(13) === Number(c[13]);
}

export function formatDocument(doc: string | null | undefined): string {
  const d = onlyDigits(doc);
  if (d.length === 11) return d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4');
  if (d.length === 14) return d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');
  return doc ?? '';
}

/** "Caminhão-pipa João" -> "CAMINHAO_PIPA_JOAO" */
export function toFileToken(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase()
    .slice(0, 60);
}

export function placeholderKey(key: string): string {
  return toFileToken(key);
}

/**
 * Substitui [CHAVE] pelos valores informados. Chaves desconhecidas são mantidas como estão,
 * para o RH perceber que faltou informação.
 */
export function renderPlaceholders(template: string, vars: Record<string, string | null | undefined>): string {
  const map = new Map<string, string>();
  for (const [k, v] of Object.entries(vars)) {
    if (v !== null && v !== undefined && String(v).trim() !== '') map.set(placeholderKey(k), String(v));
  }
  return template.replace(/\[([A-Za-zÀ-ú0-9_ ]+)\]/g, (whole, name: string) => map.get(placeholderKey(name)) ?? whole);
}

export function buildOutputFileName(pattern: string, vars: Record<string, string | null | undefined>): string {
  const filled = renderPlaceholders(pattern, vars).replace(/\[[^\]]*\]/g, '');
  const token = toFileToken(filled) || 'DOCUMENTACAO';
  return `${token}.pdf`;
}

export function sanitizeOriginalName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'arquivo';
  return base.replace(/[\u0000-\u001f<>:"|?*]+/g, '_').slice(0, 180) || 'arquivo';
}

export function maskDocument(doc: string | null | undefined): string {
  const d = onlyDigits(doc);
  if (d.length === 11) return `***.${d.slice(3, 6)}.${d.slice(6, 9)}-**`;
  if (d.length === 14) return `**.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-**`;
  return doc ? '***' : '';
}
