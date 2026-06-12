import { supabase } from "@/integrations/supabase/client";

export type AuditActionType = "auth" | "data" | "business";

export interface AuditLogParams {
  actionType: AuditActionType;
  action: string;
  tableName?: string | null;
  recordId?: string | null;
  before?: any;
  after?: any;
  context?: Record<string, any>;
  severity?: "info" | "warning" | "critical";
}

/**
 * Registra um evento na trilha de auditoria.
 * Nunca quebra a UI: falhas são apenas logadas no console.
 */
export async function logAudit(params: AuditLogParams): Promise<void> {
  try {
    const ctx = {
      route: typeof window !== "undefined" ? window.location.pathname : null,
      user_agent: typeof navigator !== "undefined" ? navigator.userAgent : null,
      source: "frontend",
      ...(params.context ?? {}),
    };

    await supabase.rpc("log_audit_event", {
      _action_type: params.actionType,
      _action: params.action,
      _table_name: params.tableName ?? null,
      _record_id: params.recordId ?? null,
      _before: params.before ?? null,
      _after: params.after ?? null,
      _context: ctx,
      _severity: params.severity ?? "info",
    });
  } catch (err) {
    console.warn("[auditLog] falhou:", err);
  }
}
