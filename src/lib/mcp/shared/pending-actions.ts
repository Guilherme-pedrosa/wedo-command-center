import { McpToolError } from "./errors";
import { serviceClient, type AuthenticatedActor } from "./supabase";

export type PendingActionKind =
  | "criar_orcamento_gc"
  | "criar_ordem_servico_gc"
  | "criar_tarefa_auvo";

export interface PreparedAction {
  pending_action_id: string;
  confirmation_token: string;
  expires_at: string;
  action: PendingActionKind;
  preview: Record<string, unknown>;
  confirmation_required: true;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToHex(new Uint8Array(digest));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

export async function prepareAction(options: {
  actor: AuthenticatedActor;
  action: PendingActionKind;
  payload: Record<string, unknown>;
  preview: Record<string, unknown>;
  requestId: string;
}): Promise<PreparedAction> {
  const id = crypto.randomUUID();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const payloadCanonical = canonicalJson(options.payload);
  const { error } = await serviceClient().from("mcp_pending_actions").insert({
    id,
    user_id: options.actor.id,
    tool_name: options.action,
    payload: options.payload,
    payload_hash: await sha256(payloadCanonical),
    confirmation_token_hash: await sha256(token),
    status: "pending",
    expires_at: expiresAt,
    request_id: options.requestId,
  });
  if (error) {
    throw new McpToolError("SUPABASE_ERROR", "Não foi possível preparar a confirmação.");
  }
  return {
    pending_action_id: id,
    confirmation_token: token,
    expires_at: expiresAt,
    action: options.action,
    preview: options.preview,
    confirmation_required: true,
  };
}

export async function claimAction(options: {
  actor: AuthenticatedActor;
  actionId: string;
  confirmationToken: string;
  expectedAction: PendingActionKind;
}): Promise<{ payload: Record<string, unknown>; payloadHash: string }> {
  const sb = serviceClient();
  const { data: current, error: readError } = await sb
    .from("mcp_pending_actions")
    .select("id,user_id,tool_name,payload,payload_hash,confirmation_token_hash,status,expires_at")
    .eq("id", options.actionId)
    .maybeSingle();

  if (readError) throw new McpToolError("SUPABASE_ERROR", "Falha ao validar a confirmação.");
  if (!current || current.user_id !== options.actor.id || current.tool_name !== options.expectedAction) {
    throw new McpToolError("CONFIRMATION_INVALID", "Confirmação inválida para este usuário.");
  }
  if (current.status !== "pending") {
    throw new McpToolError("IDEMPOTENCY_CONFLICT", "Esta ação já foi confirmada ou encerrada.");
  }
  if (new Date(current.expires_at).getTime() <= Date.now()) {
    await sb.from("mcp_pending_actions").update({ status: "expired" }).eq("id", current.id);
    throw new McpToolError("CONFIRMATION_EXPIRED", "A prévia expirou. Prepare a ação novamente.");
  }
  if ((await sha256(options.confirmationToken)) !== current.confirmation_token_hash) {
    throw new McpToolError("CONFIRMATION_INVALID", "Token de confirmação inválido.");
  }
  if ((await sha256(canonicalJson(current.payload))) !== current.payload_hash) {
    throw new McpToolError("CONFIRMATION_INVALID", "O conteúdo preparado foi alterado.");
  }

  const { data: claimed, error: claimError } = await sb
    .from("mcp_pending_actions")
    .update({ status: "executing" })
    .eq("id", current.id)
    .eq("status", "pending")
    .select("payload,payload_hash")
    .maybeSingle();

  if (claimError) throw new McpToolError("SUPABASE_ERROR", "Falha ao reservar a ação.");
  if (!claimed) {
    throw new McpToolError("IDEMPOTENCY_CONFLICT", "A ação já está sendo executada.");
  }
  return { payload: claimed.payload, payloadHash: claimed.payload_hash };
}

export async function completeAction(
  actionId: string,
  resultReference: Record<string, unknown>,
): Promise<void> {
  const sb = serviceClient();
  await sb.from("mcp_pending_actions").update({
    status: "completed",
    executed_at: new Date().toISOString(),
    result_reference: resultReference,
  }).eq("id", actionId);
  await sb.from("mcp_idempotency").upsert(
    {
      user_id: resultReference.user_id,
      tool_name: resultReference.tool_name,
      idempotency_key: actionId,
      payload_hash: resultReference.payload_hash,
      status: "completed",
      upstream_id: resultReference.upstream_id ?? null,
      response_summary: resultReference,
      completed_at: new Date().toISOString(),
    },
    { onConflict: "user_id,tool_name,idempotency_key" },
  );
}

export async function failAction(actionId: string, error: unknown): Promise<void> {
  await serviceClient().from("mcp_pending_actions").update({
    status: "failed",
    executed_at: new Date().toISOString(),
    result_reference: {
      error: error instanceof Error ? error.message.slice(0, 300) : "Erro interno",
    },
  }).eq("id", actionId);
}
