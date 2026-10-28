'use client';

import { Input, Select, Textarea, cx } from './ui';

export interface Question {
  key: string;
  label: string;
  help_text?: string | null;
  helpText?: string | null;
  type: 'BOOLEAN' | 'SELECT' | 'TEXT' | 'NUMBER' | 'DATE';
  options?: any[];
  required?: boolean;
}

/** Campo de resposta para perguntas configuradas no modelo. */
export function QuestionInput({ q, value, onChange, large, disabled }: { q: Question; value: unknown; onChange: (v: unknown) => void; large?: boolean; disabled?: boolean }) {
  const opts = (q.options ?? []) as any[];
  if (q.type === 'BOOLEAN') {
    return (
      <div className="flex gap-2" role="radiogroup" aria-label={q.label}>
        {[
          { v: true, l: 'Sim' },
          { v: false, l: 'Não' },
        ].map((o) => (
          <button
            type="button"
            key={o.l}
            disabled={disabled}
            role="radio"
            aria-checked={value === o.v}
            onClick={() => onChange(value === o.v ? null : o.v)}
            className={cx(
              'flex-1 rounded-md px-4 font-semibold ring-1 ring-inset transition disabled:opacity-60',
              large ? 'py-3 text-base' : 'py-2 text-sm',
              value === o.v ? 'bg-ink text-white ring-ink' : 'bg-white text-ink ring-neutral-300 hover:bg-neutral-50',
            )}
          >
            {o.l}
          </button>
        ))}
      </div>
    );
  }
  if (q.type === 'SELECT') {
    return (
      <Select value={value === null || value === undefined ? '' : String(value)} onChange={(e) => onChange(e.target.value || null)} disabled={disabled} className={large ? 'py-3 text-base' : ''}>
        <option value="">Selecione…</option>
        {opts.map((o) => {
          const v = typeof o === 'string' ? o : String(o.value);
          const l = typeof o === 'string' ? o : o.label;
          return (
            <option key={v} value={v}>
              {l}
            </option>
          );
        })}
      </Select>
    );
  }
  const listId = opts.length ? `dl-${q.key}` : undefined;
  if (q.type === 'TEXT' && /endere[cç]o|descri|observa|condi[cç]/i.test(q.label)) {
    return <Textarea value={(value as string) ?? ''} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={large ? 'text-base' : ''} />;
  }
  return (
    <>
      <Input
        type={q.type === 'NUMBER' ? 'number' : q.type === 'DATE' ? 'date' : 'text'}
        inputMode={q.type === 'NUMBER' ? 'decimal' : undefined}
        list={listId}
        value={value === null || value === undefined ? '' : String(value)}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={large ? 'py-3 text-base' : ''}
      />
      {listId && (
        <datalist id={listId}>
          {opts.map((o) => (
            <option key={typeof o === 'string' ? o : String(o.value)} value={typeof o === 'string' ? o : String(o.value)} />
          ))}
        </datalist>
      )}
    </>
  );
}
