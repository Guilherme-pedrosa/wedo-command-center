export const GC_API_HOST = "api.gestaoclick.com";

function requireApiUserId(apiUserId: string): string {
  const normalized = String(apiUserId || "").trim();
  if (!normalized) throw new Error("GC_API_USER_ID não está configurado");
  return normalized;
}

export function isGestaoClickApiUrl(rawUrl: string): boolean {
  try {
    return new URL(rawUrl).hostname.toLowerCase() === GC_API_HOST;
  } catch {
    return false;
  }
}

export function forceGcApiUserInUrl(rawUrl: string, apiUserId: string): string {
  const url = new URL(rawUrl);
  url.searchParams.set("usuario_id", requireApiUserId(apiUserId));
  return url.toString();
}

export function forceGcApiUserInHeaders(headersInit: HeadersInit | undefined, apiUserId: string): Headers {
  const headers = new Headers(headersInit ?? {});
  headers.set("usuario-id", requireApiUserId(apiUserId));
  return headers;
}

export function forceGcApiUserInBody(body: unknown, apiUserId: string): unknown {
  if (typeof body !== "string") return body;
  const requiredApiUserId = requireApiUserId(apiUserId);

  try {
    const parsed = JSON.parse(body);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parsed.usuario_id = requiredApiUserId;
      return JSON.stringify(parsed);
    }
  } catch {
    // Corpos não JSON continuam protegidos pelo query param e pelo cabeçalho.
  }

  return body;
}

export async function forceGcApiUserInRequest(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  apiUserId: string,
): Promise<Request> {
  const request = new Request(input, init);
  const method = request.method.toUpperCase();
  let body: BodyInit | undefined;

  if (method !== "GET" && method !== "HEAD") {
    const text = await request.clone().text();
    body = forceGcApiUserInBody(text, apiUserId) as BodyInit;
  }

  const headers = forceGcApiUserInHeaders(request.headers, apiUserId);
  headers.delete("content-length");

  return new Request(forceGcApiUserInUrl(request.url, apiUserId), {
    method: request.method,
    headers,
    body,
    redirect: request.redirect,
  });
}

let installed = false;

/** Instala uma fronteira fail-closed para todo fetch ao host oficial do GC. */
export function installGcUsuarioId(apiUserId: string) {
  if (installed) return;
  const requiredApiUserId = requireApiUserId(apiUserId);
  installed = true;

  const originalFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const rawUrl =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;

    if (!isGestaoClickApiUrl(rawUrl)) return originalFetch(input, init);

    try {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
      const protectedRequest = await forceGcApiUserInRequest(input, init, requiredApiUserId);
      return originalFetch(protectedRequest, signal ? { signal } : undefined);
    } catch {
      throw new Error(
        "Chamada ao GestãoClick bloqueada: não foi possível garantir o usuário da API GC",
      );
    }
  }) as typeof fetch;
}
