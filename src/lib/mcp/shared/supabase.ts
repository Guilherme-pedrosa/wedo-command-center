import { createClient, type SupabaseClient, type User } from "@supabase/supabase-js";
import type { ToolContext } from "@lovable.dev/mcp-js";
import { McpToolError } from "./errors";

export type AppRole =
  | "admin"
  | "user"
  | "ceo"
  | "gerente_comercial"
  | "gerente_financeiro"
  | "vendedor";

export interface AuthenticatedActor {
  id: string;
  email: string | null;
  roles: AppRole[];
  token: string;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new McpToolError("INTERNAL_ERROR", `Variável segura ${name} não configurada.`);
  }
  return value;
}

export function userClient(token: string): SupabaseClient {
  const publicKey =
    process.env.SUPABASE_PUBLISHABLE_KEY ?? process.env.SUPABASE_ANON_KEY;
  if (!publicKey) {
    throw new McpToolError(
      "INTERNAL_ERROR",
      "SUPABASE_PUBLISHABLE_KEY/SUPABASE_ANON_KEY não configurada.",
    );
  }
  return createClient(requiredEnv("SUPABASE_URL"), publicKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function serviceClient(): SupabaseClient {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function verifiedUser(token: string): Promise<User> {
  const { data, error } = await userClient(token).auth.getUser(token);
  if (error || !data.user) {
    throw new McpToolError("AUTH_REQUIRED", "Sessão inválida ou expirada.");
  }
  return data.user;
}

export async function requireActor(
  ctx: ToolContext,
  allowedRoles?: readonly AppRole[],
): Promise<AuthenticatedActor> {
  if (!ctx.isAuthenticated()) {
    throw new McpToolError("AUTH_REQUIRED", "Faça login no aplicativo WeDo Operações.");
  }

  const token = ctx.getToken();
  if (!token) throw new McpToolError("AUTH_REQUIRED", "Token de acesso ausente.");
  const user = await verifiedUser(token);
  const { data, error } = await userClient(token)
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id);

  if (error) {
    throw new McpToolError("SUPABASE_ERROR", "Não foi possível validar as permissões do usuário.");
  }

  const roles = (data ?? []).map((row) => row.role as AppRole);
  if (allowedRoles?.length && !roles.some((role) => allowedRoles.includes(role))) {
    throw new McpToolError(
      "PERMISSION_DENIED",
      `Esta operação exige um dos perfis: ${allowedRoles.join(", ")}.`,
    );
  }

  return { id: user.id, email: user.email ?? null, roles, token };
}

const sensitiveKey =
  /token|secret|password|senha|authorization|cpf|cnpj|bank|banco|certificate|certificado/i;

export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[limite]";
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return value.length > 180 ? `${value.slice(0, 180)}…` : value;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeForAudit(item, depth + 1));

  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .slice(0, 40)
      .map(([key, item]) => [
        key,
        sensitiveKey.test(key) ? "[REDACTED]" : sanitizeForAudit(item, depth + 1),
      ]),
  );
}

export async function writeAudit(entry: {
  requestId: string;
  actor?: AuthenticatedActor;
  toolName: string;
  operationType: "read" | "prepare" | "write";
  sourceSystem: "gestaoclick" | "auvo" | "supabase" | "multiple";
  parameters?: unknown;
  status: "success" | "error";
  durationMs: number;
  targetEntity?: string;
  targetId?: string | null;
  upstreamStatus?: number | null;
  errorCode?: string | null;
  errorSummary?: string | null;
}) {
  try {
    await serviceClient().from("mcp_audit_log").insert({
      request_id: entry.requestId,
      user_id: entry.actor?.id ?? null,
      user_email: entry.actor?.email ?? null,
      role: entry.actor?.roles.join(",") ?? null,
      tool_name: entry.toolName,
      operation_type: entry.operationType,
      source_system: entry.sourceSystem,
      target_entity: entry.targetEntity ?? null,
      target_id: entry.targetId ?? null,
      parameters_sanitized: sanitizeForAudit(entry.parameters ?? {}),
      result_status: entry.status,
      upstream_status: entry.upstreamStatus ?? null,
      duration_ms: entry.durationMs,
      error_code: entry.errorCode ?? null,
      error_summary: entry.errorSummary?.slice(0, 300) ?? null,
    });
  } catch {
    // Auditoria não deve revelar detalhes nem substituir o resultado principal.
  }
}

export async function runAudited<T>(
  ctx: ToolContext,
  options: {
    toolName: string;
    operationType: "read" | "prepare" | "write";
    sourceSystem: "gestaoclick" | "auvo" | "supabase" | "multiple";
    allowedRoles?: readonly AppRole[];
    parameters?: unknown;
    targetEntity?: string;
  },
  operation: (actor: AuthenticatedActor, requestId: string) => Promise<T>,
): Promise<{ data: T; requestId: string }> {
  const requestId = crypto.randomUUID();
  const startedAt = Date.now();
  let actor: AuthenticatedActor | undefined;
  try {
    actor = await requireActor(ctx, options.allowedRoles);
    const data = await operation(actor, requestId);
    await writeAudit({
      requestId,
      actor,
      toolName: options.toolName,
      operationType: options.operationType,
      sourceSystem: options.sourceSystem,
      parameters: options.parameters,
      status: "success",
      durationMs: Date.now() - startedAt,
      targetEntity: options.targetEntity,
    });
    return { data, requestId };
  } catch (error) {
    const code = error instanceof McpToolError ? error.code : "INTERNAL_ERROR";
    await writeAudit({
      requestId,
      actor,
      toolName: options.toolName,
      operationType: options.operationType,
      sourceSystem: options.sourceSystem,
      parameters: options.parameters,
      status: "error",
      durationMs: Date.now() - startedAt,
      targetEntity: options.targetEntity,
      errorCode: code,
      errorSummary: error instanceof Error ? error.message : "Erro interno",
    });
    throw Object.assign(error instanceof Error ? error : new Error("Erro interno"), { requestId });
  }
}

export function requestIdFrom(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "requestId" in error
    ? String((error as { requestId?: unknown }).requestId ?? "")
    : undefined;
}
