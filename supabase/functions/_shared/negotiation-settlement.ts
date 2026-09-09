// Shared verification for UI, proxy and Argus. Verification never writes to the ERP.
import { receiptOsCodes } from "./negotiation-execution.ts";
export const settlementCents = (value: unknown): number => {
  if (value === null || value === undefined || value === "") throw new Error("Valor financeiro ausente");
  const cents = Math.round(Number(value) * 100);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error("Valor financeiro inválido");
  return cents;
};
export type FreshReceiptReader = (gcId: string) => Promise<Record<string, any>>;

export async function verifyNegotiationGroup(admin: any, groupId: string, getReceipt: FreshReceiptReader) {
  const { data: group, error: groupError } = await admin.from("fin_grupos_receber").select("*").eq("id", groupId).single();
  const { data: items, error: itemError } = await admin.from("fin_grupo_receber_itens").select("*,fin_recebimentos(id,gc_id,grupo_id,cliente_gc_id,os_codigo,valor,liquidado,status)").eq("grupo_id", groupId);
  if (groupError || itemError) throw new Error(groupError?.message || itemError?.message);
  if (!group || group.status === "cancelado" || group.bloqueio_financeiro || !["ok", "nao_verificado", null, undefined].includes(group.integridade_status)) throw new Error("Negociação bloqueada ou com pendência explícita; revisão necessária.");
  if (!items?.length || items.length !== Number(group.itens_total) || new Set(items.map((i: any) => i.recebimento_id)).size !== items.length) throw new Error("Composição da negociação incompleta ou duplicada");
  if (items.reduce((sum: number, i: any) => sum + settlementCents(i.valor), 0) !== settlementCents(group.valor_total)) throw new Error("Itens divergem do valor contratado");
  const actualOS = new Set(items.map((i: any) => String(i.os_codigo_original || i.fin_recebimentos?.os_codigo || "")));
  if ((group.os_codigos || []).some((code: string) => !actualOS.has(String(code)))) throw new Error("Há OS sem título na negociação");
  const { data: facts, error: factsError } = await admin.rpc("fin_grupo_integrity_facts", { p_grupo_id: groupId });
  if (factsError || facts?.completo !== true) throw new Error("Composição, origens ou vínculos ainda não estão completos no banco.");
  const records = new Map<string, Record<string, any>>();
  for (const item of items) {
    const local = item.fin_recebimentos;
    if (!local?.gc_id || local.grupo_id !== group.id || String(local.cliente_gc_id) !== String(group.cliente_gc_id) || records.has(String(local.gc_id))) throw new Error("Título sem vínculo completo, duplicado ou com cliente divergente");
    const fresh = await getReceipt(String(local.gc_id));
    if (String(fresh?.id) !== String(local.gc_id) || String(fresh.cliente_id) !== String(group.cliente_gc_id)) throw new Error("Identidade do título GC diverge do acordo");
    if (!["0", "1", 0, 1, false, true].includes(fresh.liquidado) || /cancel/i.test(String(fresh.situacao_nome ?? fresh.situacao ?? ""))) throw new Error("Título cancelado ou sem liquidação confirmada");
    if (settlementCents(fresh.valor_total ?? fresh.valor) !== settlementCents(item.valor)) throw new Error("Valor GC diverge da alocação; desconto ou diferença exige revisão explícita");
    if (group.data_vencimento && String(fresh.data_vencimento).slice(0, 10) !== String(group.data_vencimento).slice(0, 10)) throw new Error("Vencimento GC diverge da parcela acordada");
    const expectedOS = String(item.os_codigo_original || local.os_codigo || "");
    const gcOS = receiptOsCodes(fresh);
    if (expectedOS && gcOS.length && !gcOS.includes(expectedOS)) throw new Error("OS do título GC diverge da origem alocada");
    const paid = ["1", 1, true].includes(fresh.liquidado);
    if ((local.liquidado || local.status === "pago") && !paid) throw new Error("Quitação local diverge do estado atual no GC");
    records.set(String(local.gc_id), fresh);
  }
  if (group.integridade_status !== "ok") {
    // A conditional update and the SQL integrity trigger prevent promoting a concurrently blocked group.
    const { data: marked, error: markError } = await admin.from("fin_grupos_receber").update({ integridade_status: "ok", integridade_verificado_em: new Date().toISOString(), integridade_motivos: [] }).eq("id", groupId).eq("integridade_status", "nao_verificado").eq("bloqueio_financeiro", false).select("id").maybeSingle();
    if (markError || !marked) throw new Error("O grupo mudou durante a conferência; promoção de integridade recusada.");
    const { error: logError } = await admin.from("fin_audit_log").insert({ acao: "negotiation_legacy_verified", ator: "backend", entidade_tipo: "fin_grupos_receber", entidade_id: groupId, depois: { gc_ids: [...records.keys()], facts }, justificativa: "Composição, identidade, valores, vencimentos e OS conferidos por GET antes de liberar operação financeira." });
    if (logError) throw new Error(`Conferência feita, mas auditoria falhou: ${logError.message}`);
  }
  return { group, items, records };
}

export async function assertNegotiationSettlement(admin: any, gcId: string, fresh: Record<string, any>, getReceipt?: FreshReceiptReader): Promise<boolean> {
  const { data: rec, error } = await admin.from("fin_recebimentos").select("id,grupo_id,cliente_gc_id").eq("gc_id", gcId).maybeSingle();
  if (error) throw new Error(`Não foi possível conferir o vínculo: ${error.message}`);
  if (!rec) return false;
  const { data: ownItems, error: ownError } = await admin.from("fin_grupo_receber_itens").select("grupo_id").eq("recebimento_id", rec.id);
  if (ownError) throw new Error(ownError.message);
  const groupIds = [...new Set([rec.grupo_id, ...(ownItems || []).map((i: any) => i.grupo_id)].filter(Boolean))];
  if (!groupIds.length) {
    const { data: reserved, error: reserveError } = await admin.from("fin_residuos_negociacao").select("id").eq("gc_recebimento_id", gcId).in("estado", ["reservado", "alocado", "em_revisao"]).limit(1);
    if (reserveError || reserved?.length) throw new Error("Título de saldo reservado ou em revisão; operação financeira bloqueada.");
    return false;
  }
  if (groupIds.length !== 1 || !rec.grupo_id) throw new Error("Vínculo da negociação inconsistente; baixa bloqueada");
  if (!getReceipt) throw new Error("Conferência de todos os títulos GC é obrigatória antes da baixa.");
  const { items, records } = await verifyNegotiationGroup(admin, String(groupIds[0]), async (id) => id === gcId ? fresh : getReceipt(id));
  const allocation = items.find((i: any) => i.recebimento_id === rec.id);
  if (!allocation || !records.has(gcId)) throw new Error("Título não pertence ao grupo conferido");
  // The target must be funded. Other installments may legitimately remain unpaid.
  for (const item of [allocation]) {
    const live = records.get(String(item.fin_recebimentos.gc_id))!;
    if (["1", 1, true].includes(live.liquidado)) continue;
    const { data: links, error: bankError } = await admin.from("fin_extrato_lancamentos").select("valor_alocado,fin_extrato_inter(reconciliado)").eq("lancamento_id", item.recebimento_id).in("tabela", ["recebimentos", "fin_recebimentos"]);
    if (bankError) throw new Error(bankError.message);
    const confirmed = (links || []).filter((link: any) => link.fin_extrato_inter?.reconciliado === true).reduce((sum: number, link: any) => sum + settlementCents(link.valor_alocado), 0);
    if (confirmed < settlementCents(live.valor_total ?? live.valor)) throw new Error("Recebimento bancário conciliado insuficiente para quitar o título");
  }
  return true;
}
