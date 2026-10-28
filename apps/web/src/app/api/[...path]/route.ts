const apiBaseUrl = process.env.API_URL || process.env.API_INTERNAL_URL || 'http://localhost:4000';

async function proxy(request: Request): Promise<Response> {
  const incomingUrl = new URL(request.url);
  const targetUrl = `${apiBaseUrl.replace(/\/$/, '')}${incomingUrl.pathname}${incomingUrl.search}`;
  const headers = new Headers(request.headers);
  headers.delete('host');

  const response = await fetch(targetUrl, {
    method: request.method,
    headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(),
    redirect: 'manual',
  });

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

export const GET = proxy;
export const HEAD = proxy;
export const OPTIONS = proxy;
export const POST = proxy;
export const PUT = proxy;
export const PATCH = proxy;
export const DELETE = proxy;