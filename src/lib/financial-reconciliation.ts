import { supabase } from "@/integrations/supabase/client";

export type FinancialLinkTable = "pagamentos" | "recebimentos";

export interface AtomicFinancialLink {
  lancamento_id: string;
  tabela: FinancialLinkTable;
  valor_alocado: number;
}

export async function reconcileExtratoAtomic(
  extratoId: string,
  links: AtomicFinancialLink[],
  reconciliationRule: string,
) {
  const { data, error } = await supabase.rpc("fin_reconcile_extrato_atomic", {
    p_extrato_id: extratoId,
    p_links: links,
    p_reconciliation_rule: reconciliationRule,
  });

  if (error) throw new Error(error.message);
  const result = data as { success?: boolean; idempotent?: boolean } | null;
  if (!result?.success) throw new Error("A conciliação não foi confirmada pelo banco de dados");
  return result;
}

export async function undoExtratoReconciliationAtomic(extratoId: string) {
  const { data, error } = await supabase.rpc("fin_undo_reconcile_extrato_atomic", {
    p_extrato_id: extratoId,
  });

  if (error) throw new Error(error.message);
  const result = data as { success?: boolean; links_removidos?: number } | null;
  if (!result?.success) throw new Error("Não foi possível desfazer a conciliação");
  return result;
}

export function isGcSettled(item: {
  gc_baixado?: boolean | null;
  liquidado?: boolean | null;
  status?: string | null;
}) {
  return item.gc_baixado === true || item.liquidado === true || item.status === "pago";
}
