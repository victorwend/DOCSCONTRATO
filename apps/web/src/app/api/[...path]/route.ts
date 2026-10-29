// Repassa /api/* do site para o serviço da API (mesma origem => cookie httpOnly funciona).
export const dynamic = 'force-dynamic';

function getApiBaseUrl() {
  const value = process.env.API_URL;
  if (value) return value.replace(/\/$/, '');
  if (process.env.NODE_ENV === 'production') throw new Error('API_URL não está configurada.');
  return 'http://localhost:4000';
}

// Cabeçalhos que não podem ser repassados como estão:
// - fetch() já descompacta o corpo, então content-encoding/content-length originais ficariam errados
//   e o navegador falharia ao ler a resposta ("Failed to fetch").
// - cabeçalhos de conexão valem só para um salto.
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate'];
const STRIP_RESPONSE = [...HOP_BY_HOP, 'content-encoding', 'content-length'];
const STRIP_REQUEST = [...HOP_BY_HOP, 'host', 'accept-encoding', 'content-length'];

async function proxy(request: Request): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const targetUrl = `${getApiBaseUrl()}${incomingUrl.pathname}${incomingUrl.search}`;

  const headers = new Headers(request.headers);
  for (const h of STRIP_REQUEST) headers.delete(h);

  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method: request.method,
      headers,
      body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
      redirect: 'manual',
      cache: 'no-store',
    });
  } catch (e) {
    return Response.json({ statusCode: 502, message: `API indisponível: ${(e as Error).message}` }, { status: 502 });
  }

  const outHeaders = new Headers();
  response.headers.forEach((value, key) => {
    if (STRIP_RESPONSE.includes(key.toLowerCase()) || key.toLowerCase() === 'set-cookie') return;
    outHeaders.set(key, value);
  });
  // vários cookies precisam ser repassados um a um
  for (const c of response.headers.getSetCookie?.() ?? []) outHeaders.append('set-cookie', c);

  return new Response(request.method === 'HEAD' ? null : await response.arrayBuffer(), {
    status: response.status,
    statusText: response.statusText,
    headers: outHeaders,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
