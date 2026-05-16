import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

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

function isLogStream(path: string[]) {
  return path.join("/") === "v1/logs/stream";
}

function proxyHeaderRecord(headers: Headers) {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
}

function proxyEventStream(request: Request, path: string[]) {
  const url = proxyUrl(request, path);
  let upstream: ReturnType<typeof httpRequest> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const client = url.protocol === "https:" ? httpsRequest : httpRequest;
      upstream = client(url, {
        method: request.method,
        headers: proxyHeaderRecord(proxyHeaders(request.headers))
      }, (response) => {
        response.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
        response.on("end", () => controller.close());
        response.on("error", (error) => controller.error(error));
      });

      upstream.on("error", (error) => controller.error(error));

      const abort = () => {
        upstream?.destroy();
        try {
          controller.close();
        } catch {}
      };
      request.signal.addEventListener("abort", abort, { once: true });
      upstream.end();
    },
    cancel() {
      upstream?.destroy();
    }
  });

  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no"
    }
  });
}

async function proxy(request: Request, context: RouteContext) {
  const { path } = await context.params;
  if (request.method.toUpperCase() === "GET" && isLogStream(path)) return proxyEventStream(request, path);

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
