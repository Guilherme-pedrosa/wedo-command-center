import { negotiationCents } from "./negotiation-plan.ts";
import { receiptOsCodes } from "./negotiation-execution.ts";

export function residualScanDecision(existing: any, receipt: any, hasAllocation: boolean, hasReservation: boolean): { estado: string; utilizado: boolean; reason?: string } {
  if (!receipt?.id) return { estado: existing.estado ?? "em_revisao", utilizado: existing.utilizado ?? true, reason: "Título não confirmado; preservar histórico." };
  if (existing.cliente_gc_id && String(receipt.cliente_id) !== String(existing.cliente_gc_id)) return { estado: "em_revisao", utilizado: true, reason: "Cliente GC diverge da origem do saldo." };
  if (/cancel/i.test(String(receipt.situacao_nome ?? receipt.situacao ?? ""))) return { estado: "em_revisao", utilizado: true, reason: "Cancelamento externo exige conciliação; histórico preservado." };
  if (String(receipt.liquidado) === "1" || receipt.liquidado === true || /liquidad|recebid/i.test(String(receipt.situacao_nome ?? receipt.situacao ?? ""))) return { estado: "liquidado", utilizado: true };
  if (!["0", 0, false].includes(receipt.liquidado)) return { estado: "em_revisao", utilizado: true, reason: "Estado de liquidação não confirmado pelo GC." };
  if (hasAllocation) return { estado: "alocado", utilizado: true };
  if (hasReservation || existing.estado === "reservado") return { estado: "reservado", utilizado: true };
  if (existing.utilizado || ["alocado", "liquidado", "em_revisao", "pendente_vinculo"].includes(existing.estado)) return { estado: existing.estado ?? "em_revisao", utilizado: true, reason: "Saldo indisponível não é reaberto automaticamente pelo GC." };
  if (negotiationCents(existing.valor_residual) !== negotiationCents(receipt.valor_total ?? receipt.valor)) return { estado: "em_revisao", utilizado: true, reason: "Valor externo mudou; preservar saldo original até conciliação." };
  return { estado: "disponivel", utilizado: false };
}

export async function scanNegotiationResiduals(supabase: any, gc: (endpoint: string) => Promise<any>) {
  const { data: existing, error } = await supabase.from("fin_residuos_negociacao").select("*");
  if (error) throw error;
  const errors: string[] = [];
  const found = new Map<string, any>();
  const known = new Map<string, any>((existing ?? []).filter((r: any) => r.gc_recebimento_id).map((r: any) => [String(r.gc_recebimento_id), r]));
  const now = new Date();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 6, 1)).toISOString().slice(0, 10);
  const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 18, 0)).toISOString().slice(0, 10);
  let pages = 1;
  try {
    for (let page = 1; page <= pages; page++) {
      if (page > 200) throw new Error("Limite de páginas atingido; scan incompleto.");
      const response = await gc(`/api/recebimentos?${new URLSearchParams({ pagina: String(page), limite: "100", data_inicio: from, data_fim: to })}`);
      if (!Array.isArray(response.data)) throw new Error("Página GC inválida.");
      pages = Number(response.meta?.total_paginas ?? 1);
      if (!Number.isInteger(pages) || pages < 1) throw new Error("Paginação GC inválida.");
      for (const raw of response.data) {
        const receipt = raw.Recebimento ?? raw.recebimento ?? raw;
        // Last installment (2/2) and ex-Neg tags are not evidence of an available residual.
        if (receipt.id && (known.has(String(receipt.id)) || /\bpassivo\b/i.test(String(receipt.descricao)))) found.set(String(receipt.id), receipt);
      }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : String(error)); }
  for (const residual of existing ?? []) {
    if (!residual.gc_recebimento_id) {
      errors.push(`Saldo ${residual.id}: vínculo GC pendente; registro preservado.`);
      const { error: pendingError } = await supabase.from("fin_residuos_negociacao").update({ estado: "pendente_vinculo", utilizado: true, estado_motivo: "Sem título GC confirmado; saldo e histórico preservados." }).eq("id", residual.id);
      if (pendingError) errors.push(pendingError.message);
      continue;
    }
    const id = String(residual.gc_recebimento_id);
    if (found.has(id)) continue;
    try {
      const response = await gc(`/api/recebimentos/${encodeURIComponent(id)}`);
      const receipt = response.data?.Recebimento ?? response.data?.recebimento ?? response.data;
      if (!receipt?.id || String(receipt.id) !== id) throw new Error("Resposta de identidade inválida.");
      found.set(id, receipt);
    } catch (error) {
      errors.push(`Saldo ${residual.id}: ${error instanceof Error ? error.message : String(error)} Histórico preservado.`);
      if ((error as any)?.status === 404) {
        const { error: reviewError } = await supabase.from("fin_residuos_negociacao").update({ estado: "em_revisao", utilizado: true, estado_motivo: "Título GC retornou 404 individualmente; conciliar identidade, sem excluir histórico." }).eq("id", residual.id);
        if (reviewError) errors.push(reviewError.message);
      }
    }
  }
  let inserted = 0, baixados = 0, alocados = 0, revisao = 0;
  for (const [id, receipt] of found) {
    try {
      const residual = known.get(id);
      const { data: local, error: localError } = await supabase.from("fin_recebimentos").select("id,grupo_id").eq("gc_id", id).maybeSingle();
      if (localError) throw localError;
      let hasAllocation = !!local?.grupo_id;
      if (local?.id) {
        const { data: links, error: linkError } = await supabase.from("fin_grupo_receber_itens").select("id").eq("recebimento_id", local.id).limit(1);
        if (linkError) throw linkError;
        hasAllocation ||= !!links?.length;
      }
      let hasReservation = false;
      if (residual) {
        const { data: reservations, error: reservationError } = await supabase.from("fin_negociacao_reservas").select("id").eq("origin_key", `residual:${residual.id}`).in("estado", ["reservado", "consumido"]).limit(1);
        if (reservationError) throw reservationError;
        hasReservation = !!reservations?.length;
      }
      const cents = negotiationCents(receipt.valor_total ?? receipt.valor);
      if (!residual && (!cents || !receipt.cliente_id || !/\bpassivo\b/i.test(String(receipt.descricao)))) continue;
      const candidate = residual ?? { cliente_gc_id: String(receipt.cliente_id), valor_residual: cents / 100, estado: local ? "disponivel" : "pendente_vinculo", utilizado: !local };
      const decision = residualScanDecision(candidate, receipt, hasAllocation, hasReservation);
      if (!residual && ["liquidado", "alocado", "reservado"].includes(decision.estado)) continue;
      if (decision.reason) errors.push(`Título ${id}: ${decision.reason}`);
      if (residual) {
        const { error: updateError } = await supabase.from("fin_residuos_negociacao").update({ estado: decision.estado, utilizado: decision.utilizado, estado_motivo: decision.reason ?? `GC confirmado: ${decision.estado}` }).eq("id", residual.id);
        if (updateError) throw updateError;
      } else {
        const number = String(receipt.descricao).match(/negocia[çc][ãa]o\s+(\d+)\b|\bNEG(\d+)\b/i);
        const { error: insertError } = await supabase.from("fin_residuos_negociacao").insert({ cliente_gc_id: String(receipt.cliente_id), nome_cliente: String(receipt.nome_cliente ?? "Cliente"), valor_residual: cents / 100, negociacao_origem_numero: number ? Number(number[1] ?? number[2]) : null, gc_recebimento_id: id, gc_codigo: receipt.codigo ? String(receipt.codigo) : null, os_codigos: receiptOsCodes(receipt), observacao: `Identificado no GC em ${new Date().toISOString()}; ${receipt.descricao}`, estado: decision.estado, utilizado: decision.utilizado });
        if (insertError) throw insertError;
        inserted++;
      }
      if (decision.estado === "liquidado") baixados++;
      if (decision.estado === "alocado") alocados++;
      if (["em_revisao", "pendente_vinculo"].includes(decision.estado)) revisao++;
    } catch (error) { errors.push(`Título ${id}: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { success: errors.length === 0, partial: errors.length > 0, total_found: found.size, inserted, baixados, alocados, revisao, reabertos: 0, removidos: 0, errors };
}
