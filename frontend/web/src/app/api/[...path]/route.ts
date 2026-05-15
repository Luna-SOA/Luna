export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const apiProxyTarget = process.env.API_PROXY_TARGET ?? "http://127.0.0.1:8081";
const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host"
]);

type RouteContext = {
  params: Promise<{ path: string[] }>;
};

function proxyUrl(request: Request, path: string[]) {
  const base = apiProxyTarget.endsWith("/") ? apiProxyTarget : `${apiProxyTarget}/`;
  const url = new URL(path.map(encodeURIComponent).join("/"), base);
  url.search = new URL(request.url).search;
  return url;
}

function proxyHeaders(headers: Headers) {
  const nextHeaders = new Headers(headers);
  for (const header of hopByHopHeaders) nextHeaders.delete(header);
  return nextHeaders;
}

async function proxy(request: Request, context: RouteContext) {
  const { path } = await context.params;
  const method = request.method.toUpperCase();
  const init: RequestInit = {
    method,
    headers: proxyHeaders(request.headers),
    redirect: "manual"
  };

  if (method !== "GET" && method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }

  const response = await fetch(proxyUrl(request, path), init);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

export const GET = proxy;
export const POST = proxy;
export const PATCH = proxy;
export const DELETE = proxy;
export const OPTIONS = proxy;
