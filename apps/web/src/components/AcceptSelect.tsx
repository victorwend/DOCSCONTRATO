'use client';

import { Select } from './ui';

export function AcceptSelect({ value, onChange, disabled }: { value: 'ANY' | 'IMAGE' | 'PDF'; onChange: (v: 'ANY' | 'IMAGE' | 'PDF') => void; disabled?: boolean }) {
  return (
    <label className="inline-flex items-center gap-2 text-sm">
      Aceitar:
      <Select value={value} onChange={(e) => onChange(e.target.value as any)} disabled={disabled} className="w-auto py-1 text-xs">
        <option value="ANY">Foto ou PDF</option>
        <option value="IMAGE">Somente foto</option>
        <option value="PDF">Somente PDF</option>
      </Select>
    </label>
  );
}
