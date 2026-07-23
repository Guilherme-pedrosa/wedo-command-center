import { McpToolError } from "./errors";

const GC_BASE_URL = "https://api.gestaoclick.com";
let lastGcCallAt = 0;
let gcQueue = Promise.resolve();

function env(name: string): string {
  const value = process.env[name];
  if (!value) throw new McpToolError("INTERNAL_ERROR", `Secret ${name} não configurado.`);
  return value;
}

async function throttle(): Promise<void> {
  const waitMs = Math.max(0, 360 - (Date.now() - lastGcCallAt));
  if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
  lastGcCallAt = Date.now();
}

function gcError(status: number, body: string): McpToolError {
  if (status === 401 || status === 403) {
    return new McpToolError("GC_UNAUTHORIZED", "Credenciais do GestãoClick inválidas.", false);
  }
  if (status === 429) {
    return new McpToolError(
      "GC_RATE_LIMITED",
      "Limite temporário do GestãoClick atingido.",
      true,
    );
  }
  if (status >= 400 && status < 500) {
    return new McpToolError(
      "GC_VALIDATION_ERROR",
      `O GestãoClick rejeitou os dados (HTTP ${status}).`,
      false,
      { resposta: body.slice(0, 300) },
    );
  }
  return new McpToolError("GC_UNAVAILABLE", "GestãoClick temporariamente indisponível.", true);
}

async function perform<T>(
  path: string,
  method: "GET" | "POST" | "PUT",
  body?: unknown,
): Promise<T> {
  if (!path.startsWith("/") || path.includes("://")) {
    throw new McpToolError("INVALID_INPUT", "Rota GestãoClick inválida.");
  }
  await throttle();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${GC_BASE_URL}${path}`, {
      method,
      headers: {
        "access-token": env("GC_ACCESS_TOKEN"),
        "secret-access-token":
          process.env.GC_SECRET_TOKEN ?? env("GC_SECRET_ACCESS_TOKEN"),
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw gcError(response.status, text);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new McpToolError("GC_UNAVAILABLE", "Resposta inválida do GestãoClick.", true);
    }
  } catch (error) {
    if (error instanceof McpToolError) throw error;
    if (error instanceof Error && error.name === "AbortError") {
      throw new McpToolError("UPSTREAM_TIMEOUT", "O GestãoClick excedeu 15 segundos.", true);
    }
    throw new McpToolError("GC_UNAVAILABLE", "Falha de conexão com o GestãoClick.", true);
  } finally {
    clearTimeout(timer);
  }
}

export function gcRequest<T>(
  path: string,
  method: "GET" | "POST" | "PUT" = "GET",
  body?: unknown,
): Promise<T> {
  const scheduled = gcQueue.then(() => perform<T>(path, method, body));
  gcQueue = scheduled.then(
    () => undefined,
    () => undefined,
  );
  return scheduled;
}

export function gcData<T>(response: unknown): T {
  if (
    response &&
    typeof response === "object" &&
    "data" in response
  ) {
    return (response as { data: T }).data;
  }
  return response as T;
}

export function queryString(values: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null || value === "") continue;
    query.set(key, String(value));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}
