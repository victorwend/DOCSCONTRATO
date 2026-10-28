'use client';

import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes, createContext, forwardRef, useCallback, useContext, useEffect, useState } from 'react';
import { DOC_STATUS, REQUEST_STATUS } from '@/lib/format';

export function cx(...c: Array<string | false | null | undefined>) {
  return c.filter(Boolean).join(' ');
}

type Variant = 'primary' | 'dark' | 'secondary' | 'danger' | 'ghost' | 'success';
const variants: Record<Variant, string> = {
  primary: 'bg-brand text-ink hover:bg-brand-500 focus-visible:ring-ink',
  dark: 'bg-ink text-white hover:bg-ink-600 focus-visible:ring-brand',
  secondary: 'bg-white text-ink ring-1 ring-inset ring-neutral-300 hover:bg-neutral-50',
  danger: 'bg-red-600 text-white hover:bg-red-700',
  success: 'bg-emerald-600 text-white hover:bg-emerald-700',
  ghost: 'text-ink hover:bg-neutral-100',
};

export const Button = forwardRef<HTMLButtonElement, ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md' | 'lg'; loading?: boolean }>(
  function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }, ref) {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={cx(
          'inline-flex items-center justify-center gap-2 rounded-md font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50',
          size === 'sm' && 'px-2.5 py-1.5 text-xs',
          size === 'md' && 'px-3.5 py-2 text-sm',
          size === 'lg' && 'px-5 py-3.5 text-base',
          variants[variant],
          className,
        )}
        {...rest}
      >
        {loading && <Spinner className="h-4 w-4" />}
        {children}
      </button>
    );
  },
);

export function Spinner({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg className={cx('animate-spin', className)} viewBox="0 0 24 24" fill="none" aria-hidden>
      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity=".25" strokeWidth="4" />
      <path d="M22 12a10 10 0 0 1-10 10" stroke="currentColor" strokeWidth="4" strokeLinecap="round" />
    </svg>
  );
}

export function Field({ label, hint, error, children, required }: { label: string; hint?: ReactNode; error?: string | null; children: ReactNode; required?: boolean }) {
  return (
    <label className="block">
      <span className="mb-1 block text-sm font-medium text-neutral-800">
        {label}
        {required && <span className="text-red-600"> *</span>}
      </span>
      {children}
      {hint && !error && <span className="mt-1 block text-xs text-neutral-500">{hint}</span>}
      {error && <span className="mt-1 block text-xs text-red-600">{error}</span>}
    </label>
  );
}

const inputCls =
  'block w-full rounded-md border-0 bg-white px-3 py-2 text-sm text-ink shadow-sm ring-1 ring-inset ring-neutral-300 placeholder:text-neutral-400 focus:ring-2 focus:ring-inset focus:ring-ink disabled:bg-neutral-50 disabled:text-neutral-500';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} className={cx(inputCls, className)} {...p} />;
});
export function Textarea({ className, ...p }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cx(inputCls, 'min-h-[90px]', className)} {...p} />;
}
export function Select({ className, children, ...p }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(inputCls, 'pr-8', className)} {...p}>
      {children}
    </select>
  );
}

export function Checkbox({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: ReactNode; disabled?: boolean }) {
  return (
    <label className={cx('inline-flex items-center gap-2 text-sm', disabled ? 'opacity-60' : 'cursor-pointer')}>
      <input type="checkbox" className="h-4 w-4 rounded border-neutral-300 text-ink accent-ink" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      {label}
    </label>
  );
}

export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('rounded-lg bg-white shadow-card ring-1 ring-neutral-200', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-neutral-200 px-4 py-3">
          {title && <h2 className="text-sm font-bold uppercase tracking-wide text-neutral-800">{title}</h2>}
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={cx('p-4', bodyClass)}>{children}</div>
    </section>
  );
}

export function Badge({ className, children }: { className?: string; children: ReactNode }) {
  return <span className={cx('inline-flex items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset', className)}>{children}</span>;
}

export function RequestStatusBadge({ status }: { status: string }) {
  const s = REQUEST_STATUS[status] ?? { label: status, className: 'bg-neutral-100 ring-neutral-300' };
  return <Badge className={s.className}>{s.label}</Badge>;
}

export function DocStatusBadge({ status, na }: { status: string; na?: boolean }) {
  if (na) return <Badge className="bg-neutral-100 text-neutral-600 ring-neutral-300">N/A</Badge>;
  const s = DOC_STATUS[status] ?? { label: status, className: '' };
  return <Badge className={s.className}>{s.label}</Badge>;
}

export function ProgressBar({ value, total, className }: { value: number; total: number; className?: string }) {
  const pct = total ? Math.round((value / total) * 100) : 0;
  return (
    <div className={cx('h-2.5 w-full overflow-hidden rounded-full bg-neutral-200', className)} role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-full rounded-full transition-all', pct === 100 ? 'bg-emerald-500' : 'bg-ink')} style={{ width: `${pct}%` }} />
    </div>
  );
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 p-0 sm:items-center sm:p-4" onMouseDown={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        className={cx('flex max-h-[95vh] w-full flex-col rounded-t-xl bg-white shadow-xl sm:rounded-xl', wide ? 'sm:max-w-5xl' : 'sm:max-w-lg')}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h3 className="text-base font-bold">{title}</h3>
          <button onClick={onClose} className="rounded p-1 text-neutral-500 hover:bg-neutral-100" aria-label="Fechar">
            ✕
          </button>
        </div>
        <div className="overflow-y-auto p-4">{children}</div>
        {footer && <div className="flex flex-wrap justify-end gap-2 border-t px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Alert({ kind = 'info', children }: { kind?: 'info' | 'error' | 'success' | 'warning'; children: ReactNode }) {
  const c = {
    info: 'bg-sky-50 text-sky-900 ring-sky-200',
    error: 'bg-red-50 text-red-900 ring-red-200',
    success: 'bg-emerald-50 text-emerald-900 ring-emerald-200',
    warning: 'bg-amber-50 text-amber-900 ring-amber-200',
  }[kind];
  return <div className={cx('rounded-md px-3 py-2 text-sm ring-1 ring-inset', c)}>{children}</div>;
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-neutral-300 p-8 text-center">
      <p className="font-semibold text-neutral-800">{title}</p>
      {children && <div className="mt-2 text-sm text-neutral-500">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
type Toast = { id: number; kind: 'success' | 'error' | 'info'; text: string };
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'error' ? 7000 : 3500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4" aria-live="polite">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cx(
              'pointer-events-auto max-w-md rounded-md px-4 py-2.5 text-sm font-medium shadow-lg',
              t.kind === 'success' && 'bg-emerald-700 text-white',
              t.kind === 'error' && 'bg-red-700 text-white',
              t.kind === 'info' && 'bg-ink text-white',
            )}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
