export type McpErrorCode =
  | "AUTH_REQUIRED"
  | "PERMISSION_DENIED"
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "MULTIPLE_MATCHES"
  | "CONFIRMATION_EXPIRED"
  | "CONFIRMATION_INVALID"
  | "IDEMPOTENCY_CONFLICT"
  | "GC_UNAUTHORIZED"
  | "GC_RATE_LIMITED"
  | "GC_VALIDATION_ERROR"
  | "GC_UNAVAILABLE"
  | "AUVO_UNAUTHORIZED"
  | "AUVO_RATE_LIMITED"
  | "AUVO_UNAVAILABLE"
  | "SUPABASE_ERROR"
  | "UPSTREAM_TIMEOUT"
  | "INTERNAL_ERROR";

export class McpToolError extends Error {
  constructor(
    public readonly code: McpErrorCode,
    message: string,
    public readonly retryable = false,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "McpToolError";
  }
}

export function asMcpError(error: unknown): McpToolError {
  if (error instanceof McpToolError) return error;
  const message = error instanceof Error ? error.message : "Erro interno inesperado.";
  return new McpToolError("INTERNAL_ERROR", message, false);
}

export function successResult(data: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export function errorResult(error: unknown, requestId?: string) {
  const safe = asMcpError(error);
  const body = {
    ok: false,
    error: {
      code: safe.code,
      message: safe.message,
      retryable: safe.retryable,
      request_id: requestId,
      ...(safe.details ? { details: safe.details } : {}),
    },
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(body) }],
    structuredContent: body,
    isError: true,
  };
}
