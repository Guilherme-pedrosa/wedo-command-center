import { supabase } from "@/integrations/supabase/client";
import { atualizarRecebimentoGC } from "@/api/financeiro";

export interface GroupReceipt {
  id: string;
  valor: number | string;
  selectedValue?: number;
  gc_id?: string | null;
  gc_payload_raw?: Record<string, unknown> | null;
  cliente_gc_id?: string | null;
  nome_cliente?: string | null;
  grupo_id?: string | null;
  liquidado?: boolean;
  status?: string;
}

/** Validate the entire selection before creating a group or changing a GC title. */
export function validateGroupReceipts(receipts: GroupReceipt[]) {
  if (!receipts.length || receipts.length > 100 || new Set(receipts.map(r => r.id)).size !== receipts.length) {
    throw new Error("Selecione de 1 a 100 recebimentos distintos.");
  }
  const client = receipts[0].cliente_gc_id || null;
  const name = receipts[0].nome_cliente || "";
  for (const receipt of receipts) {
    const cents = Math.round(Number(receipt.valor) * 100);
    if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Há título sem valor válido na seleção.");
    if (receipt.grupo_id || receipt.liquidado || ["pago", "cancelado"].includes(receipt.status || "")) {
      throw new Error("Há título pago, cancelado ou já agrupado. Atualize a lista.");
    }
    if ((receipt.cliente_gc_id || null) !== client || (!client && (receipt.gc_id || receipt.nome_cliente !== name))) {
      throw new Error("Confira a identidade do cliente de todos os títulos antes de agrupar.");
    }
    if (receipt.selectedValue !== undefined && Math.round(receipt.selectedValue * 100) !== cents) {
      throw new Error("Para dividir o valor de um título, use a negociação com divisão e conferência no GC. Nenhum grupo foi criado.");
    }
  }
  return { client, name, total: receipts.reduce((sum, r) => sum + Math.round(Number(r.valor) * 100), 0) / 100 };
}

export async function createVerifiedReceivableGroup(input: {
  id: string; name: string; observation?: string; dueDate?: string | null; receipts: GroupReceipt[];
}) {
  const selection = validateGroupReceipts(input.receipts);
  if (!input.name.trim()) throw new Error("Informe o nome do grupo.");
  const expected = Object.fromEntries(input.receipts.map(r => [r.id, Number(r.valor)]));
  const persist = (checkOnly: boolean) => supabase.rpc("fin_create_receivable_group" as never, {
    p_id: input.id, p_nome: input.name.trim(), p_observacao: input.observation || null,
    p_receipt_ids: input.receipts.map(r => r.id), p_data_vencimento: input.dueDate || null,
    p_expected_values: expected, p_check_only: checkOnly,
  } as never);
  const previous = await persist(true);
  if (previous.error) throw new Error(previous.error.message);
  // A lost response must not repeat GC writes after the group was committed.
  if ((previous.data as any)?.id) return { ...(previous.data as any), ...selection };
  // GC is updated while these titles are still ungrouped. Updating them after
  // linking would correctly hit the protection for already negotiated titles.
  for (const receipt of input.receipts) {
    if (!receipt.gc_id) continue;
    await atualizarRecebimentoGC(receipt.gc_id, receipt.gc_payload_raw || {},
      { ...(input.dueDate ? { data_vencimento: input.dueDate } : {}) },
      { expectedValue: Number(receipt.valor), expectedClientId: selection.client || undefined });
  }
  const { data, error } = await persist(false);
  if (error || !(data as any)?.id) throw new Error(error?.message || "O banco não confirmou o grupo. Confira antes de repetir.");
  return { ...(data as any), ...selection };
}
