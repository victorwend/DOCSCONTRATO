export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function handle<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = data?.message ?? (res.status === 413 ? 'Arquivo muito grande.' : `Erro ${res.status}`);
    if (res.status === 401 && typeof window !== 'undefined' && !window.location.pathname.startsWith('/login') && !window.location.pathname.startsWith('/enviar')) {
      const next = encodeURIComponent(window.location.pathname + window.location.search);
      window.location.href = `/login?next=${next}`;
    }
    throw new ApiError(res.status, Array.isArray(msg) ? msg.join('; ') : String(msg));
  }
  return data as T;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
    cache: 'no-store',
    signal: opts.signal,
  });
  return handle<T>(res);
}

/** Upload com progresso (XMLHttpRequest) — importante para fotos grandes no celular. */
export function upload<T = any>(path: string, form: FormData, onProgress?: (pct: number) => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api${path}`);
    xhr.withCredentials = true;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      handle<T>(res).then(resolve, reject);
    };
    xhr.onerror = () => reject(new ApiError(0, 'Falha de conexão. Verifique a internet e tente novamente.'));
    xhr.send(form);
  });
}
