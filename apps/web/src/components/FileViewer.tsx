'use client';

import { useEffect, useState } from 'react';
import { api } from '@/lib/api';
import { fmtBytes, fmtDateTime } from '@/lib/format';
import { Button, cx, Spinner } from './ui';

export interface FileMeta {
  id: string;
  original_name: string;
  mime_type: string;
  size_bytes: number;
  side: string | null;
  created_at: string;
  is_current: boolean;
  security_flags?: string[];
  submission_number?: number;
}

/** Visualização de arquivos privados via URL temporária assinada. */
export function FileViewer({ files }: { files: FileMeta[] }) {
  const [active, setActive] = useState(files[0]?.id ?? null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const f = files.find((x) => x.id === active);

  useEffect(() => {
    if (!active) return;
    setUrl(null);
    setError(null);
    api(`/files/${active}/url?disposition=inline`)
      .then((r) => setUrl(r.url))
      .catch((e) => setError(e.message));
  }, [active]);

  async function download(id: string) {
    const r = await api(`/files/${id}/url?disposition=attachment`);
    window.location.href = r.url;
  }

  if (!files.length) return <p className="text-sm text-neutral-500">Nenhum arquivo.</p>;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2">
        {files.map((x) => (
          <button
            key={x.id}
            onClick={() => setActive(x.id)}
            className={cx('rounded-md px-2.5 py-1.5 text-xs font-semibold ring-1 ring-inset', x.id === active ? 'bg-ink text-white ring-ink' : 'bg-white ring-neutral-300')}
          >
            {x.side === 'FRONT' ? 'Frente · ' : x.side === 'BACK' ? 'Verso · ' : ''}
            {x.original_name}
          </button>
        ))}
      </div>
      {f && (
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-neutral-500">
          <span>
            {f.mime_type} · {fmtBytes(f.size_bytes)} · enviado em {fmtDateTime(f.created_at)}
            {f.security_flags?.length ? <span className="ml-2 font-semibold text-amber-700">⚠ {f.security_flags.join(', ')}</span> : null}
          </span>
          <Button size="sm" onClick={() => download(f.id)}>
            Baixar original
          </Button>
        </div>
      )}
      <div className="flex h-[65vh] items-center justify-center overflow-auto rounded-md bg-neutral-800">
        {error ? (
          <p className="text-sm text-red-200">{error}</p>
        ) : !url || !f ? (
          <Spinner className="h-6 w-6 text-white" />
        ) : f.mime_type === 'application/pdf' ? (
          <iframe src={url} title={f.original_name} className="h-full w-full bg-white" />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt={f.original_name} className="max-h-full max-w-full object-contain" />
        )}
      </div>
    </div>
  );
}
