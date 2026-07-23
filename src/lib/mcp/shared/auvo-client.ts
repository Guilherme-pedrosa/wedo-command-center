import { McpToolError } from "./errors";

const AUVO_BASE_URL = "https://api.auvo.com.br/v2";
let cachedToken: { value: string; expiresAt: number } | null = null;

function credentials() {
  const apiKey = process.env.AUVO_API_KEY ?? process.env.AUVO_APP_KEY;
  const apiToken =
    process.env.AUVO_USER_TOKEN ?? process.env.AUVO_API_TOKEN ?? process.env.AUVO_TOKEN;
  if (!apiKey || !apiToken) {
    throw new McpToolError("INTERNAL_ERROR", "Credenciais do Auvo não configuradas.");
  }
  return { apiKey, apiToken };
}

async function login(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now()) return cachedToken.value;
  const { apiKey, apiToken } = credentials();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const url = `${AUVO_BASE_URL}/login/?apiKey=${encodeURIComponent(apiKey)}&apiToken=${encodeURIComponent(apiToken)}`;
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    const json = await response.json().catch(() => ({}));
    const token = json?.result?.accessToken;
    if (!response.ok || !token) {
      throw new McpToolError("AUVO_UNAUTHORIZED", "Falha ao autenticar no Auvo.");
    }
    cachedToken = { value: token, expiresAt: Date.now() + 45 * 60_000 };
    return token;
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpToolError("UPSTREAM_TIMEOUT", "O Auvo excedeu 15 segundos.", true);
    }
    throw new McpToolError("AUVO_UNAVAILABLE", "Falha de conexão com o Auvo.", true);
  } finally {
    clearTimeout(timer);
  }
}

function auvoError(status: number, body: string): McpToolError {
  if (status === 401 || status === 403) {
    cachedToken = null;
    return new McpToolError("AUVO_UNAUTHORIZED", "Sessão do Auvo inválida.", false);
  }
  if (status === 429) {
    return new McpToolError("AUVO_RATE_LIMITED", "Limite temporário do Auvo atingido.", true);
  }
  if (status === 404) return new McpToolError("NOT_FOUND", "Registro não encontrado no Auvo.");
  if (status >= 400 && status < 500) {
    return new McpToolError("INVALID_INPUT", `O Auvo rejeitou os dados (HTTP ${status}).`, false, {
      resposta: body.slice(0, 300),
    });
  }
  return new McpToolError("AUVO_UNAVAILABLE", "Auvo temporariamente indisponível.", true);
}

export async function auvoRequest<T>(
  path: string,
  method: "GET" | "PUT" = "GET",
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/") || path.includes("://")) {
    throw new McpToolError("INVALID_INPUT", "Rota Auvo inválida.");
  }
  const token = await login();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${AUVO_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw auvoError(response.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new McpToolError("AUVO_UNAVAILABLE", "Resposta inválida do Auvo.", true);
    }
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpToolError("UPSTREAM_TIMEOUT", "O Auvo excedeu 15 segundos.", true);
    }
    throw new McpToolError("AUVO_UNAVAILABLE", "Falha de conexão com o Auvo.", true);
  } finally {
    clearTimeout(timer);
  }
}

export function auvoListPath(
  resource: string,
  filter: Record<string, unknown>,
  page: number,
  pageSize: number,
): string {
  const query = new URLSearchParams({
    paramFilter: JSON.stringify(filter),
    page: String(page),
    pageSize: String(pageSize),
    order: "asc",
  });
  return `/${resource}/?${query.toString()}`;
}

export function auvoResult<T>(response: unknown): T {
  if (response && typeof response === "object" && "result" in response) {
    return (response as { result: T }).result;
  }
  return response as T;
}
