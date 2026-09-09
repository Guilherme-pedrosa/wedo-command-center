import { supabase } from "@/integrations/supabase/client";
import { callGC } from "@/lib/gc-client";
import { startOfMonth, endOfMonth, addMonths, format as fnsFormat } from "date-fns";
import { ptBR } from "date-fns/locale";

// ─── Types ───────────────────────────────────────────────────────────

export interface GCRecebimentoRaw {
  id: string;
  codigo: string;
  descricao: string;
  valor_total: string;
  cliente_id?: string;
  nome_cliente?: string;
  plano_contas_id?: string;
  nome_plano_conta?: string;
  conta_bancaria_id?: string;
  nome_conta_bancaria?: string;
  forma_pagamento_id?: string;
  nome_forma_pagamento?: string;
  centro_custo_id?: string;
  nome_centro_custo?: string;
  data_vencimento: string;
  data_competencia?: string;
  data_liquidacao?: string | null;
  liquidado: string; // "0" or "1"
  [key: string]: unknown;
}

export interface GCPagamentoRaw {
  id: string;
  codigo: string;
  descricao: string;
  valor_total: string;
  fornecedor_id?: string;
  nome_fornecedor?: string;
  plano_contas_id?: string;
  nome_plano_conta?: string;
  conta_bancaria_id?: string;
  nome_conta_bancaria?: string;
  forma_pagamento_id?: string;
  nome_forma_pagamento?: string;
  centro_custo_id?: string;
  nome_centro_custo?: string;
  data_vencimento: string;
  data_competencia?: string;
  data_liquidacao?: string | null;
  liquidado: string;
  [key: string]: unknown;
}

// Keep old exports for backward compat
export type GCRecebimento = GCRecebimentoRaw;
export type GCPagamentoItem = GCPagamentoRaw;

interface GCApiResponse<T> {
  code: number;
  data: T[];
  meta: {
    limite_por_pagina: number;
    pagina_atual: number;
    total_paginas: number;
    total_registros: number;
    total_registros_pagina: number;
  };
  status: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────

export const gcDelay = (ms = 100) => new Promise((r) => setTimeout(r, ms));

const roundMoney = (value: number) => Math.round(value * 100) / 100;

export function extrairOsCodigo(descricao: string | null | undefined): string | null {
  if (!descricao) return null;
  const match = descricao.match(/Ordem de serviço de nº\s*(\d+)/i);
  return match?.[1] ?? null;
}

export function inferirTipo(descricao: string | null | undefined): "os" | "venda" | "contrato" | "outro" {
  if (!descricao) return "outro";
  if (/ordem de serviço/i.test(descricao)) return "os";
  if (/venda/i.test(descricao)) return "venda";
  if (/contrato/i.test(descricao)) return "contrato";
  return "outro";
}

export function inferirOrigem(
  descricao?: string | null
): "gc_os" | "gc_venda" | "gc_contrato" | "manual" | "outro" {
  if (!descricao) return "manual";
  if (/ordem de serviço/i.test(descricao)) return "gc_os";
  if (/\bvenda\b/i.test(descricao)) return "gc_venda";
  if (/contrato/i.test(descricao)) return "gc_contrato";
  return "outro";
}

type FinLancamentoStatus = "pendente" | "pago" | "vencido" | "cancelado";

function isLiquidadoGC(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase().trim();
  return value === true || value === 1 || normalized === "1" || normalized === "pg" || normalized === "pago" || normalized === "liquidado" || normalized === "baixado";
}

function coerceLancamentoStatus(value: unknown, fallback: FinLancamentoStatus = "pendente"): FinLancamentoStatus {
  const normalized = String(value ?? "").toLowerCase().trim();

  if (["liquidado", "pago", "paga", "baixado", "recebido", "quitado"].includes(normalized)) {
    return "pago";
  }

  if (["cancelado", "cancelada", "cancelar"].includes(normalized)) {
    return "cancelado";
  }

  if (normalized === "vencido") return "vencido";
  if (normalized === "pendente") return "pendente";

  return fallback;
}

function normalizeLancamentoStatus(item: Record<string, any>): FinLancamentoStatus {
  const rawStatus = String(item.status || item.situacao || item.nome_situacao || item.status_pagamento || "").toLowerCase().trim();
  const liquidado = isLiquidadoGC(item.liquidado);

  if (liquidado) return "pago";

  const coerced = coerceLancamentoStatus(rawStatus);
  if (coerced !== "pendente" || rawStatus === "pendente") return coerced;

  const dataVencimento = item.data_vencimento ? new Date(item.data_vencimento) : null;
  const hoje = new Date();
  hoje.setHours(0, 0, 0, 0);

  if (dataVencimento && !Number.isNaN(dataVencimento.getTime())) {
    dataVencimento.setHours(0, 0, 0, 0);
    if (dataVencimento < hoje) return "vencido";
  }

  return "pendente";
}
/**
 * Extrai o nome do remetente/destinatário da descrição do extrato Inter.
 */
export function extrairNomeDaDescricao(descricao: string | null | undefined): string | null {
  if (!descricao) return null;

  // "PAGAMENTO DE TITULO - NOME" ou "RECEBIMENTO TITULO - NOME"
  const tituloMatch = descricao.match(/(?:PAGAMENTO|RECEBIMENTO)\s+(?:DE\s+)?TITULO\s*-\s*(.+)$/i);
  if (tituloMatch?.[1]) return tituloMatch[1].trim();

  // "Cp :CNPJ-NOME"
  const cpMatch = descricao.match(/Cp\s*:\d+-(.+)$/i);
  if (cpMatch?.[1]) return cpMatch[1].trim();

  // "- números NOME" (PIX/TED com agência/conta)
  const dashMatch = descricao.match(/-\s+(?:[\d\s]+?\s)([A-Za-z][A-Za-z\s.&]+[A-Za-z.])$/);
  if (dashMatch?.[1]) return dashMatch[1].trim();

  // CPF/CNPJ formatado seguido de nome
  const docMatch = descricao.match(/\d{2}\s*\.?\d{3}\s*\.?\d{3}\s+([A-Za-z][A-Za-z\s.]+)$/);
  if (docMatch?.[1]) return docMatch[1].trim();

  // Fallback: texto após último número
  const fallback = descricao.match(/\d\s+([A-Za-z][A-Za-z\s.&]{2,})\s*$/);
  if (fallback?.[1]) return fallback[1].trim();

  return null;
}


async function fetchPaginatedGC<T>(
  endpoint: string,
  params?: Record<string, string>,
  onProgress?: (current: number, total: number) => void
): Promise<T[]> {
  const allRecords: T[] = [];
  let page = 1;
  let totalPages = 1;
  let retries = 0;

  while (page <= totalPages) {
    const res = await callGC<GCApiResponse<T>>({
      endpoint,
      params: { limite: "200", pagina: String(page), ...params },
    });

    if (res.status === 401) throw new Error("GC_AUTH_ERROR");
    if (res.status === 429) {
      if (++retries > 3) throw new Error("GC temporariamente indisponível (429); sincronização incompleta, histórico preservado.");
      await gcDelay(2000);
      continue;
    }
    if (res.status >= 500) throw new Error(`GC server error: ${res.status}`);

    retries = 0;
    const gcResponse = res.data;
    if (!gcResponse?.data) {
      // Resposta inesperada: abortar em vez de devolver lista parcial
      // (lista parcial faria a limpeza de órfãos apagar registros válidos).
      throw new Error(`GC incomplete response on page ${page} (HTTP ${res.status})`);
    }
    allRecords.push(...gcResponse.data);
    totalPages = gcResponse.meta?.total_paginas || 1;
    onProgress?.(allRecords.length, gcResponse.meta?.total_registros ?? allRecords.length);


    page++;
    if (page <= totalPages) await gcDelay();
  }

  return allRecords;
}

// ─── Inter Request ───────────────────────────────────────────────────

async function interRequest<T = unknown>(
  path: string,
  method = "GET",
  payload?: Record<string, unknown>,
  options?: { idempotencyKey?: string }
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("inter-proxy", {
    body: { path, method, payload, idempotencyKey: options?.idempotencyKey },
  });
  if (error) throw new Error(error.message);
  if (data?.error) throw new Error(data.error);
  return data as T;
}

// ─── Recebimentos (GC) ──────────────────────────────────────────────

export async function listRecebimentos(params?: {
  pagina?: number;
  liquidado?: "0" | "1";
  cliente_id?: string;
}): Promise<{ data: GCRecebimentoRaw[]; meta: { total_registros: number; total_paginas: number } }> {
  const queryParams: Record<string, string> = { limite: "100" };
  if (params?.pagina) queryParams.pagina = String(params.pagina);
  if (params?.liquidado !== undefined) queryParams.liquidado = params.liquidado;
  if (params?.cliente_id) queryParams.cliente_id = params.cliente_id;

  const res = await callGC<GCApiResponse<GCRecebimentoRaw>>({
    endpoint: "/api/recebimentos",
    params: queryParams,
  });

  return {
    data: res.data?.data || [],
    meta: {
      total_registros: res.data?.meta?.total_registros || 0,
      total_paginas: res.data?.meta?.total_paginas || 0,
    },
  };
}

export async function importarRecebimentosPendentes(
  onProgress?: (current: number, total: number) => void,
  filtros?: { dataInicio?: string; dataFim?: string; liquidado?: string; incluirTodos?: boolean }
): Promise<GCRecebimentoRaw[]> {
  const params: Record<string, string> = {};
  // Always fetch ALL records (open + paid) — never filter by liquidado
  if (filtros?.dataInicio) params.data_inicio = filtros.dataInicio;
  if (filtros?.dataFim) params.data_fim = filtros.dataFim;
  return fetchPaginatedGC<GCRecebimentoRaw>(
    "/api/recebimentos",
    params,
    onProgress
  );
}

export async function importarRecebimentosGC(
  onProgress?: (current: number, total: number) => void
): Promise<GCRecebimentoRaw[]> {
  return importarRecebimentosPendentes(onProgress);
}

export async function baixarRecebimentoGC(
  gcId: string,
  gcPayloadRaw: Record<string, unknown>,
  dataLiquidacao?: string
): Promise<{ status: number; data: unknown; duration_ms: number }> {
  const hoje = new Date().toISOString().split("T")[0];
  const payload = {
    ...gcPayloadRaw,
    liquidado: 1,
    data_liquidacao: dataLiquidacao || hoje,
  };

  const res = await callGC({
    endpoint: `/api/recebimentos/${gcId}`,
    method: "PUT",
    payload,
  });

  if (res.status >= 400) {
    throw new Error(`Erro ao baixar recebimento ${gcId}: HTTP ${res.status}`);
  }

  return res;
}

// ─── Atualizar recebimento no GC (sem baixa) ─────────────────────────
export async function vincularNfseRecebimentoGC(gcId: string, nfseNumero: string): Promise<Record<string, any>> {
  const res = await callGC<any>({ endpoint: `/api/recebimentos/${gcId}`, method: "PUT",
    operation: "receivable_nfse", payload: { nfse_numero: nfseNumero } });
  const body = typeof res.data === "string" ? JSON.parse(res.data) : res.data;
  const raw = body?.data?.data ?? body?.data ?? body;
  if (res.status >= 400 || Number(body?.code ?? 200) >= 400 || String(raw?.id) !== gcId) {
    throw new Error("A vinculação da NFS-e não foi confirmada no GC.");
  }
  return raw;
}

export async function atualizarRecebimentoGC(
  gcId: string,
  _gcPayloadRaw: Record<string, unknown>,
  campos: {
    data_vencimento?: string;
    descricao?: string;
    observacao?: string;
    nf_numero?: string;
    atributos?: Array<{ atributo_id: number; valor: string } | { id: number; valor: string }>;
  },
  expected?: { expectedValue?: number; expectedClientId?: string },
): Promise<{ status: number; data: unknown; duration_ms: number }> {
  const endpoint = `/api/recebimentos/${gcId}`;
  const checkedBody = (response: { status: number; data: unknown }) => {
    const body = typeof response.data === "string" ? JSON.parse(response.data) : response.data as any;
    if (response.status >= 400 || Number(body?.code ?? 200) >= 400 || ["error", "erro"].includes(body?.status) || body?.success === false) {
      throw new Error(body?.data?.mensagem || body?.message || `GC não confirmou o título ${gcId}.`);
    }
    return body;
  };
  const read = async () => {
    const response = await callGC({ endpoint });
    const body = checkedBody(response);
    const raw = body?.data?.data ?? body?.data ?? body;
    if (String(raw?.id) !== String(gcId)) throw new Error(`Identidade do título ${gcId} não confirmada pelo GC.`);
    return { response, raw };
  };
  const fresh = await read();
  const gcPayloadRaw = fresh.raw;
  const cents = (value: unknown) => Math.round(Number(value) * 100);
  const originalCents = cents(gcPayloadRaw.valor ?? gcPayloadRaw.valor_total);
  if (!Number.isSafeInteger(originalCents) || originalCents < 0) throw new Error("Valor atual do GC inválido.");
  if (expected && (![false, 0, "0"].includes(gcPayloadRaw.liquidado) || /cancel/i.test(String(gcPayloadRaw.situacao_nome ?? gcPayloadRaw.situacao ?? "")))) {
    throw new Error("O título já foi liquidado, cancelado ou não tem situação confirmada no GC.");
  }
  if ((expected?.expectedValue !== undefined && originalCents !== cents(expected.expectedValue)) ||
      (expected?.expectedClientId && String(gcPayloadRaw.cliente_id) !== expected.expectedClientId)) {
    throw new Error("Valor ou cliente mudou no GC. Atualize a seleção antes de agrupar.");
  }
  if (!Object.keys(campos).length) return fresh.response;
  // Required fields come from a current GET, never the stale local mirror.
  const payload: Record<string, unknown> = {
    descricao:          campos.descricao          ?? gcPayloadRaw.descricao ?? '',
    data_vencimento:    campos.data_vencimento    ?? gcPayloadRaw.data_vencimento,
    valor:              gcPayloadRaw.valor ?? gcPayloadRaw.valor_total,
    data_competencia:   gcPayloadRaw.data_competencia ?? gcPayloadRaw.data_vencimento,
    plano_contas_id:    gcPayloadRaw.plano_contas_id,
    forma_pagamento_id: gcPayloadRaw.forma_pagamento_id,
    conta_bancaria_id:  gcPayloadRaw.conta_bancaria_id,
  };

  for (const key of ["data_vencimento", "data_competencia", "plano_contas_id", "forma_pagamento_id", "conta_bancaria_id"]) {
    if (!payload[key]) throw new Error(`Título ${gcId}: ${key} ausente no GC; atualização interrompida.`);
  }
  for (const key of ["cliente_id", "entidade", "centro_custo_id", "juros", "multa", "desconto", "taxa_banco", "taxa_operadora", "funcionario_id", "transportadora_id", "rateios", "atributos"]) {
    if (gcPayloadRaw[key] !== undefined && gcPayloadRaw[key] !== null) payload[key] = gcPayloadRaw[key];
  }

  // Atributos (campos extras financeiros) — se enviados
  if (campos.atributos?.length) {
    const replacements = campos.atributos.map((a) => ({
      atributo_id: "atributo_id" in a ? a.atributo_id : (a as any).id,
      valor: String(a.valor ?? ""),
    }));
    const ids = new Set(replacements.map(a => String(a.atributo_id)));
    const existing = Array.isArray(gcPayloadRaw.atributos) ? gcPayloadRaw.atributos : [];
    payload.atributos = [...existing.filter((a: any) => !ids.has(String(a.atributo_id ?? a.id ?? a.atributo?.atributo_id))), ...replacements];
  }

  const res = await callGC({
    endpoint: `/api/recebimentos/${gcId}`,
    method: "PUT",
    payload,
  });

  checkedBody(res);
  const confirmed = (await read()).raw;
  if (cents(confirmed.valor ?? confirmed.valor_total) !== originalCents ||
      String(confirmed.cliente_id ?? "") !== String(gcPayloadRaw.cliente_id ?? "") ||
      (campos.data_vencimento && String(confirmed.data_vencimento).slice(0, 10) !== campos.data_vencimento) ||
      (campos.descricao !== undefined && confirmed.descricao !== campos.descricao)) {
    throw new Error(`O GC não confirmou valor, cliente ou alteração do título ${gcId}. Confira antes de repetir.`);
  }

  return res;
}

/**
 * Impede que clientes antigos criem passivo apenas localmente.
 * A divisão de título pertence ao executor de negociação com reserva e plano.
 */
export async function registrarResidualNegociacao(params: {
  recebimentoId: string;
  valorOriginal: number;
  valorNegociado: number;
  clienteGcId: string | null;
  nomeCliente: string | null;
  osCodigo: string | null;
  gcRecebimentoId: string | null;
  gcCodigo: string | null;
  negociacaoNumero?: number | null;
}): Promise<void> {
  if (Math.round(params.valorOriginal * 100) !== Math.round(params.valorNegociado * 100)) {
    throw new Error("Alteração parcial bloqueada: o título precisa ser dividido e conferido no GestãoClick antes de gerar saldo residual.");
  }
}

async function bloquearGruposComTituloAusente(recebimentoIds: string[]): Promise<void> {
  if (!recebimentoIds.length) return;
  const { data: links, error: linkError } = await supabase.from("fin_grupo_receber_itens").select("grupo_id").in("recebimento_id", recebimentoIds);
  if (linkError) throw linkError;
  const groupIds = [...new Set((links || []).map(link => link.grupo_id))];
  if (!groupIds.length) return;
  const { data: groups, error: groupError } = await supabase.from("fin_grupos_receber").select("*").in("id", groupIds);
  if (groupError) throw groupError;
  for (const group of (groups || []) as any[]) {
    const previous = Array.isArray(group.integridade_motivos) ? group.integridade_motivos : [];
    const reason = { codigo: "titulo_ausente_gc", mensagem: "Título vinculado não existe mais no GC. Confira sua identidade; o acordo e os comprovantes foram preservados." };
    const reasons = previous.some((entry: any) => entry?.codigo === reason.codigo) ? previous : [...previous, reason];
    const { error } = await supabase.from("fin_grupos_receber").update({ integridade_status: "pendente", bloqueio_financeiro: true, integridade_motivos: reasons, updated_at: new Date().toISOString() } as any).eq("id", group.id);
    if (error) throw error;
  }
}

// ─── Re-sync individual recebimento from GC by gc_id ─────────────────
export async function resyncRecebimentoFromGC(gcId: string, osCodigo?: string | null, clienteGcId?: string | null): Promise<boolean> {
  const res = await callGC<any>({ endpoint: `/api/recebimentos/${gcId}` });
  const raw = res.data?.data ?? res.data;
  if (res.status >= 400 || !raw?.id || String(raw.id) !== String(gcId)) {
    if (res.status === 404) {
      const { data: missing } = await supabase.from("fin_recebimentos").select("id").eq("gc_id", gcId).maybeSingle();
      if (missing) await bloquearGruposComTituloAusente([missing.id]);
    }
    await supabase.from("fin_sync_log" as any).insert({
      tipo: "gc_recebimento_pendente", status: "partial",
      resposta: { gc_id: gcId, os_codigo: osCodigo, http_status: res.status, motivo: "Identidade GC não confirmada; referências e conciliação preservadas" },
    });
    return false;
  }
  if (clienteGcId && String(raw.cliente_id || "") !== String(clienteGcId)) {
    throw new Error("Cliente do título no GestãoClick diverge do grupo. A vinculação deve ser conferida.");
  }

  const valor = parseFloat(String(raw.valor_total ?? raw.valor ?? "0"));
  const descricao = raw.descricao || "";

  const updateFields: Record<string, unknown> = {
    descricao,
    valor,
    data_vencimento: raw.data_vencimento || null,
    data_competencia: raw.data_competencia || null,
    data_emissao: raw.data_emissao || null,
    data_liquidacao: raw.data_liquidacao || null,
    liquidado: raw.liquidado === "1" || raw.liquidado === true,
    nome_cliente: raw.nome_cliente || null,
    os_codigo: extrairOsCodigo(descricao),
    gc_payload_raw: raw,
    last_synced_at: new Date().toISOString(),
  };

  const { error } = await supabase
    .from("fin_recebimentos")
    .update(updateFields as any)
    .eq("gc_id", gcId);

  if (error) {
    console.error(`[resync] Erro ao atualizar fin_recebimentos gc_id=${gcId}:`, error.message);
    return false;
  }

  // O snapshot original e o valor alocado registram o acordo; sincronização atualiza só o título.

  return true;
}

export const baixarRecebimentoNoGC = async (
  gcId: string,
  gcPayloadRaw: Record<string, unknown>,
  dataLiquidacao: string
) => {
  await baixarRecebimentoGC(gcId, gcPayloadRaw, dataLiquidacao);
};

// ─── Pagamentos (GC) ────────────────────────────────────────────────

export async function listPagamentos(params?: {
  pagina?: number;
  liquidado?: "0" | "1";
  fornecedor_id?: string;
}): Promise<{ data: GCPagamentoRaw[]; meta: { total_registros: number; total_paginas: number } }> {
  const queryParams: Record<string, string> = { limite: "100" };
  if (params?.pagina) queryParams.pagina = String(params.pagina);
  if (params?.liquidado !== undefined) queryParams.liquidado = params.liquidado;
  if (params?.fornecedor_id) queryParams.fornecedor_id = params.fornecedor_id;

  const res = await callGC<GCApiResponse<GCPagamentoRaw>>({
    endpoint: "/api/pagamentos",
    params: queryParams,
  });

  return {
    data: res.data?.data || [],
    meta: {
      total_registros: res.data?.meta?.total_registros || 0,
      total_paginas: res.data?.meta?.total_paginas || 0,
    },
  };
}

export async function importarPagamentosPendentes(
  onProgress?: (current: number, total: number) => void,
  filtros?: { dataInicio?: string; dataFim?: string; liquidado?: string; incluirTodos?: boolean }
): Promise<GCPagamentoRaw[]> {
  const params: Record<string, string> = {};
  // Always fetch ALL records (open + paid) — never filter by liquidado
  if (filtros?.dataInicio) params.data_inicio = filtros.dataInicio;
  if (filtros?.dataFim) params.data_fim = filtros.dataFim;
  return fetchPaginatedGC<GCPagamentoRaw>(
    "/api/pagamentos",
    params,
    onProgress
  );
}

export async function importarPagamentosGC(
  onProgress?: (current: number, total: number) => void
): Promise<GCPagamentoRaw[]> {
  return importarPagamentosPendentes(onProgress);
}

export async function baixarPagamentoGC(
  gcId: string,
  gcPayloadRaw: Record<string, unknown>,
  dataLiquidacao?: string
): Promise<{ status: number; data: unknown; duration_ms: number }> {
  const hoje = new Date().toISOString().split("T")[0];
  const payload = {
    ...gcPayloadRaw,
    liquidado: 1,
    data_liquidacao: dataLiquidacao || hoje,
  };

  const res = await callGC({
    endpoint: `/api/pagamentos/${gcId}`,
    method: "PUT",
    payload,
  });

  if (res.status >= 400) {
    throw new Error(`Erro ao baixar pagamento ${gcId}: HTTP ${res.status}`);
  }

  return res;
}

export const baixarPagamentoNoGC = async (
  gcId: string,
  gcPayloadRaw: Record<string, unknown>,
  dataLiquidacao: string
) => {
  await baixarPagamentoGC(gcId, gcPayloadRaw, dataLiquidacao);
};

// ─── Baixa de Grupo no GC (REQUER AÇÃO EXPLÍCITA DO USUÁRIO) ────────

export async function baixarGrupoReceberNoGC(
  grupoId: string,
  dataLiquidacao: string,
  onItemDone?: (ok: boolean, gcId: string, erro?: string) => void
): Promise<{ sucesso: number; falha: number }> {
  if (!grupoId || !/^\d{4}-\d{2}-\d{2}$/.test(dataLiquidacao)) throw new Error("Grupo e data de liquidação válidos são obrigatórios.");
  const [{ data: grupo, error: grupoError }, { data: itens, error: itensError }] = await Promise.all([
    supabase.from("fin_grupos_receber").select("*").eq("id", grupoId).single(),
    supabase.from("fin_grupo_receber_itens").select("*, fin_recebimentos(*)").eq("grupo_id", grupoId),
  ]);
  if (grupoError || itensError) throw new Error(grupoError?.message || itensError?.message);
  const group = grupo as any;
  const allItems = (itens || []) as any[];
  if (!group || group.bloqueio_financeiro || (group.integridade_status && !["ok", "nao_verificado"].includes(group.integridade_status))) {
    throw new Error("Grupo bloqueado para conferência financeira. Resolva os motivos de integridade antes da baixa.");
  }
  if (!allItems.length || (Number(group.itens_total) > 0 && allItems.length !== Number(group.itens_total))) {
    throw new Error("Composição incompleta: nenhum título será baixado.");
  }
  const expectedOS = (group.os_codigos || []).map(String);
  const actualOS = new Set(allItems.map(i => String(i.os_codigo_original || i.fin_recebimentos?.os_codigo || "")));
  if (expectedOS.some((code: string) => !actualOS.has(code))) throw new Error("Há OS do acordo sem título vinculado. Confira a composição.");
  const allocatedCents = allItems.reduce((sum, i) => sum + Math.round(Number(i.valor) * 100), 0);
  if (!Number.isFinite(allocatedCents) || allocatedCents !== Math.round(Number(group.valor_total) * 100)) {
    throw new Error("O valor dos itens diverge do acordo. A baixa exige composição conferida, inclusive descontos.");
  }
  if (new Set(allItems.map(i => i.recebimento_id)).size !== allItems.length) throw new Error("Título duplicado na composição.");

  // Confira todos os títulos antes da primeira escrita, inclusive os já marcados pagos localmente.
  const validated: Array<{ item: any; raw: any; paid: boolean; cents: number }> = [];
  for (const item of allItems) {
    const rec = item.fin_recebimentos;
    if (!rec?.gc_id) throw new Error("Item sem referência GC; confira a vinculação antes da baixa.");
    const response = await callGC<any>({ endpoint: `/api/recebimentos/${rec.gc_id}` });
    const raw = response.data?.data ?? response.data;
    if (response.status >= 400 || String(raw?.id || "") !== String(rec.gc_id)) throw new Error(`Título GC ${rec.gc_id} não pôde ser confirmado; nada foi baixado.`);
    if (!group.cliente_gc_id || String(raw.cliente_id || "") !== String(group.cliente_gc_id)) throw new Error(`Cliente divergente no título GC ${rec.gc_id}.`);
    const liveCents = Math.round(Number(raw.valor_total ?? raw.valor) * 100);
    const itemCents = Math.round(Number(item.valor) * 100);
    if (!Number.isFinite(liveCents) || liveCents <= 0 || liveCents !== itemCents) throw new Error(`Título GC ${rec.gc_id} difere do valor alocado ou tem valor inválido; confira descontos e composição antes da baixa.`);
    const paid = isLiquidadoGC(raw.liquidado);
    if (!paid && (item.gc_baixado || rec.liquidado || rec.status === "pago")) throw new Error(`Baixa local do título ${rec.gc_id} diverge do GC; confira antes de repetir.`);
    validated.push({ item, raw, paid, cents: liveCents });
  }
  const pending = validated.filter(v => !v.paid);
  if (pending.length) {
    const { data: links, error } = await supabase.from("fin_extrato_lancamentos" as any)
      .select("*, fin_extrato_inter(reconciliado)").in("lancamento_id", pending.map(v => v.item.recebimento_id))
      .in("tabela", ["recebimentos", "fin_recebimentos"]);
    if (error) throw new Error(error.message);
    for (const entry of pending) {
      const confirmed = (links || []).filter((link: any) => link.lancamento_id === entry.item.recebimento_id && link.fin_extrato_inter?.reconciliado === true)
        .reduce((sum: number, link: any) => sum + Math.round(Number(link.valor_alocado || 0) * 100), 0);
      if (confirmed < entry.cents) throw new Error(`Título ${entry.raw.id} sem recebimento bancário conciliado suficiente. Vincule o comprovante antes da baixa.`);
    }
  }

  await conferirGrupoNegociacao(grupoId);
  let sucesso = 0, falha = 0;
  for (const { item, raw, paid } of validated) {
    try {
      let settledRaw = raw;
      if (!paid) {
        await baixarRecebimentoNoGC(String(raw.id), raw, dataLiquidacao);
        const check = await callGC<any>({ endpoint: `/api/recebimentos/${raw.id}` });
        const confirmed = check.data?.data ?? check.data;
        if (check.status >= 400 || String(confirmed?.id) !== String(raw.id) || !isLiquidadoGC(confirmed.liquidado)) throw new Error("GC não confirmou a liquidação; conferência necessária antes de repetir.");
        settledRaw = confirmed;
      }
      const paidAt = settledRaw.data_liquidacao || null;
      const { error: recError } = await supabase.from("fin_recebimentos").update({ liquidado: true, status: "pago", gc_baixado: true, gc_baixado_em: paidAt, data_liquidacao: paidAt }).eq("id", item.recebimento_id);
      if (recError) throw recError;
      const { error: itemError } = await supabase.from("fin_grupo_receber_itens").update({ gc_baixado: true, gc_baixado_em: paidAt, tentativas: (item.tentativas || 0) + (paid ? 0 : 1), ultimo_erro: null }).eq("id", item.id);
      if (itemError) throw itemError;
      sucesso++; onItemDone?.(true, String(raw.id));
    } catch (error) {
      falha++;
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("fin_grupo_receber_itens").update({ ultimo_erro: message, tentativas: (item.tentativas || 0) + 1 }).eq("id", item.id);
      onItemDone?.(false, String(raw.id), message);
    }
  }
  // Status e contagens do grupo pertencem ao trigger/RPC; o navegador não força quitação.
  const { error: refreshError } = await supabase.from("fin_grupos_receber").select("status, itens_baixados, gc_baixado").eq("id", grupoId).single();
  if (refreshError) throw new Error(`Títulos conferidos, mas não foi possível reler o grupo: ${refreshError.message}`);
  await supabase.from("fin_sync_log" as any).insert({ tipo: "gc_baixa_grupo_receber", referencia_id: grupoId, status: falha ? "partial" : "success", resposta: { sucesso, falha, data_liquidacao: dataLiquidacao } });
  if (falha) throw new Error(`${falha} título(s) sem confirmação completa. Confira o histórico antes de repetir.`);
  return { sucesso, falha };
}

export async function conferirGrupoNegociacao(grupoId: string): Promise<void> {
  const { data, error } = await supabase.functions.invoke("negotiate-os", { body: { action: "verify_group", grupo_id: grupoId } });
  if (error) throw error;
  if (data?.success !== true || data?.integrity_verified !== true) throw new Error(data?.error || "A conferência do grupo não foi concluída no servidor.");
}

export async function solicitarCancelamentoNegociacao(grupoIds: string[], motivo: string): Promise<void> {
  if (!grupoIds.length || motivo.trim().length < 10) throw new Error("Informe o motivo do cancelamento (mínimo de 10 caracteres).");
  const { error } = await (supabase.rpc as any)("fin_solicitar_cancelamento_negociacao", { p_grupo_ids: grupoIds, p_motivo: motivo.trim() });
  if (error) throw new Error(error.message);
}

export async function baixarGrupoPagarNoGC(
  grupoId: string,
  dataLiquidacao: string,
  onItemDone?: (ok: boolean, gcId: string, erro?: string) => void
): Promise<{ sucesso: number; falha: number }> {
  const { data: itens } = await supabase
    .from("fin_grupo_pagar_itens" as any)
    .select("id, pagamento_id, tentativas")
    .eq("grupo_id", grupoId)
    .eq("gc_baixado", false);

  let sucesso = 0;
  let falha = 0;

  for (const item of (itens as any[]) ?? []) {
    const { data: pag } = await supabase
      .from("fin_pagamentos" as any)
      .select("gc_id, gc_payload_raw")
      .eq("id", item.pagamento_id)
      .single() as any;

    const pagData = pag as any;
    if (!pagData?.gc_id || !pagData?.gc_payload_raw) {
      falha++;
      onItemDone?.(false, "unknown", "Dados GC ausentes");
      continue;
    }

    try {
      await baixarPagamentoNoGC(
        pagData.gc_id as string,
        pagData.gc_payload_raw as Record<string, unknown>,
        dataLiquidacao
      );

      await supabase
        .from("fin_grupo_pagar_itens" as any)
        .update({
          gc_baixado: true,
          gc_baixado_em: new Date().toISOString(),
          tentativas: (item.tentativas ?? 0) + 1,
        })
        .eq("id", item.id);

      await supabase
        .from("fin_pagamentos" as any)
        .update({
          gc_baixado: true,
          gc_baixado_em: new Date().toISOString(),
          liquidado: true,
          status: "pago",
          data_liquidacao: dataLiquidacao,
        })
        .eq("gc_id", pagData.gc_id);

      sucesso++;
      onItemDone?.(true, pagData.gc_id as string);
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      await supabase
        .from("fin_grupo_pagar_itens" as any)
        .update({
          tentativas: (item.tentativas ?? 0) + 1,
          ultimo_erro: erro,
        })
        .eq("id", item.id);
      falha++;
      onItemDone?.(false, pagData.gc_id as string, erro);
    }
    await gcDelay();
  }

  const { data: allItens } = await supabase
    .from("fin_grupo_pagar_itens" as any)
    .select("gc_baixado")
    .eq("grupo_id", grupoId);
  const allDone = (allItens as any[])?.every((i) => i.gc_baixado) ?? false;

  await supabase
    .from("fin_grupos_pagar" as any)
    .update({
      status: falha === 0 ? "pago" : "pago_parcial",
      gc_baixado: allDone,
      gc_baixado_em: allDone ? new Date().toISOString() : null,
      itens_baixados: sucesso,
      updated_at: new Date().toISOString(),
    })
    .eq("id", grupoId);

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_baixa_grupo_pagar",
    referencia_id: grupoId,
    status: falha === 0 ? "success" : "partial",
    resposta: { sucesso, falha, data_liquidacao: dataLiquidacao },
  });

  return { sucesso, falha };
}

// ─── Helpers: Map GC IDs to local UUIDs (cached per sync session) ────

let _pcCcMapsCache: { pcMap: Record<string, string>; ccMap: Record<string, string>; fpMap: Record<string, string> } | null = null;
let _pcCcMapsCacheTime = 0;
const MAPS_CACHE_TTL = 60_000; // 1 minute

async function buildPcCcMaps(): Promise<{
  pcMap: Record<string, string>;
  ccMap: Record<string, string>;
  fpMap: Record<string, string>;
}> {
  if (_pcCcMapsCache && Date.now() - _pcCcMapsCacheTime < MAPS_CACHE_TTL) {
    return _pcCcMapsCache;
  }
  const [{ data: pcs }, { data: ccs }, { data: fps }] = await Promise.all([
    supabase.from("fin_plano_contas").select("id, gc_id").not("gc_id", "is", null),
    supabase.from("fin_centros_custo").select("id, codigo").not("codigo", "is", null),
    supabase.from("fin_formas_pagamento").select("id, gc_id").not("gc_id", "is", null),
  ]);
  const pcMap: Record<string, string> = {};
  for (const pc of pcs ?? []) { if (pc.gc_id) pcMap[pc.gc_id] = pc.id; }
  const ccMap: Record<string, string> = {};
  for (const cc of ccs ?? []) { if (cc.codigo) ccMap[cc.codigo] = cc.id; }
  const fpMap: Record<string, string> = {};
  for (const fp of fps ?? []) { if (fp.gc_id) fpMap[fp.gc_id] = fp.id; }
  _pcCcMapsCache = { pcMap, ccMap, fpMap };
  _pcCcMapsCacheTime = Date.now();
  return _pcCcMapsCache;
}

// ─── Sync Service (GC → fin_* tables) ───────────────────────────────

export interface SyncDateFilter {
  dataInicio?: string;
  dataFim?: string;
  incluirLiquidados?: boolean;
}

// ─── Chunked sync by month (splits large ranges) ────────────────────

export type SyncScope = "recebimentos" | "pagamentos" | "ambos";

export interface SyncFinanceiroResult {
  importados: number;
  atualizados: number;
  erros: number;
  extrato?: {
    ok: boolean;
    processados: number;
    error?: string;
  };
  baixaGC?: {
    ok: boolean;
    processados: number;
    sucesso: number;
    falha: number;
    error?: string;
    jobId?: string;
  };
  conciliacao?: {
    ok: boolean;
    conciliados: number;
    revisar: number;
    error?: string;
  };
}

const ARGUS_BAIXA_CUTOFF = "2026-04-01";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function executarBaixaGCConciliados(
  filtros: { dataInicio?: string; dataFim?: string },
  scope: SyncScope = "ambos",
  onStep?: (etapa: string) => void,
): Promise<NonNullable<SyncFinanceiroResult["baixaGC"]>> {
  const { data, error } = await supabase.functions.invoke("argus-baixa-confirmada", {
    body: {
      mode: "auto",
      scope,
      dataInicio: filtros.dataInicio,
      dataFim: filtros.dataFim,
      forceConfirmSituacao: true,
      background: true,
    },
  });

  if (error) throw new Error(error.message);
  if (data?.ok === false && data?.status !== "partial") {
    throw new Error(String(data?.error ?? "A baixa automática no GC não foi iniciada"));
  }

  const jobId = typeof data?.job_id === "string" ? data.job_id : undefined;
  if (!jobId) {
    const falha = Number(data?.falha ?? 0);
    return {
      ok: data?.ok !== false && falha === 0,
      processados: Number(data?.processados ?? 0),
      sucesso: Number(data?.sucesso ?? 0),
      falha,
      error: data?.error ? String(data.error) : undefined,
    };
  }

  const deadline = Date.now() + 10 * 60_000;
  while (Date.now() < deadline) {
    const { data: job, error: jobError } = await supabase
      .from("fin_sync_log" as any)
      .select("status, erro, resposta, payload")
      .eq("id", jobId)
      .maybeSingle() as any;
    if (jobError) throw new Error(`Erro ao acompanhar a baixa no GC: ${jobError.message}`);

    const snapshot = job?.resposta ?? job?.payload ?? {};
    const processados = Number(snapshot.processados ?? 0);
    const total = Number(snapshot.total ?? data?.total ?? 0);
    onStep?.(`Confirmando baixas no GC... ${processados}/${total}`);

    if (job && job.status !== "running") {
      const sucesso = Number(snapshot.sucesso ?? 0);
      const falha = Number(snapshot.falha ?? 0);
      return {
        ok: job.status === "success" && falha === 0,
        processados,
        sucesso,
        falha,
        error: job.erro ? String(job.erro) : undefined,
        jobId,
      };
    }
    await wait(1_500);
  }

  throw new Error(`A baixa no GC continua em processamento (execução ${jobId}). Consulte novamente em alguns minutos.`);
}

export async function baixarLinksGCConfirmados(
  links: Array<{ lancamento_id: string; tabela: "fin_pagamentos" | "fin_recebimentos" | "pagamentos" | "recebimentos" }>,
) {
  if (links.length === 0) return { ok: true, processados: 0, sucesso: 0, falha: 0 };
  const { data, error } = await supabase.functions.invoke("argus-baixa-confirmada", {
    body: {
      mode: "links",
      links,
      forceConfirmSituacao: true,
      background: false,
    },
  });
  if (error) throw new Error(error.message);
  if (data?.ok === false || Number(data?.falha ?? 0) > 0) {
    const detail = data?.resultados?.find((item: any) => !item.ok)?.erro;
    throw new Error(String(detail ?? data?.error ?? "A baixa não foi confirmada no GC"));
  }
  return data;
}

async function resetExtratosByLancamentos(
  lancamentoIds: string[],
  tabelas: string[]
): Promise<number> {
  if (!lancamentoIds.length || !tabelas.length) return 0;

  const [{ data: links }, { data: primaryExtratos }] = await Promise.all([
    supabase
      .from("fin_extrato_lancamentos" as any)
      .select("extrato_id")
      .in("lancamento_id", lancamentoIds)
      .in("tabela", tabelas) as any,
    supabase
      .from("fin_extrato_inter" as any)
      .select("id")
      .in("lancamento_id", lancamentoIds) as any,
  ]);

  const extratoIds = Array.from(new Set([
    ...((links ?? []) as any[]).map((row: any) => row.extrato_id).filter(Boolean),
    ...((primaryExtratos ?? []) as any[]).map((row: any) => row.id).filter(Boolean),
  ]));

  if (!extratoIds.length) return 0;

  await supabase.from("fin_extrato_lancamentos" as any).delete().in("extrato_id", extratoIds);
  await supabase.from("fin_extrato_inter" as any).update({
    reconciliado: false,
    reconciliado_em: null,
    reconciliation_rule: null,
    lancamento_id: null,
  } as any).in("id", extratoIds);

  return extratoIds.length;
}

async function buildFullSweepFilters(): Promise<SyncDateFilter> {
  const today = fnsFormat(new Date(), "yyyy-MM-dd");
  const fallbackStart = `${new Date().getFullYear() - 2}-01-01`;

  const [recRes, pagRes] = await Promise.all([
    supabase
      .from("fin_recebimentos" as any)
      .select("data_vencimento")
      .not("gc_id", "is", null)
      .order("data_vencimento", { ascending: true })
      .limit(1),
    supabase
      .from("fin_pagamentos" as any)
      .select("data_vencimento")
      .not("gc_id", "is", null)
      .order("data_vencimento", { ascending: true })
      .limit(1),
  ]);

  const candidates = [
    ...((recRes.data ?? []) as any[]).map((row: any) => row.data_vencimento).filter(Boolean),
    ...((pagRes.data ?? []) as any[]).map((row: any) => row.data_vencimento).filter(Boolean),
  ].sort();

  return {
    dataInicio: candidates[0] ?? fallbackStart,
    dataFim: today,
    incluirLiquidados: true,
  };
}

export async function syncFinanceiroFullSweep(
  onProgress?: (atual: number, total: number) => void,
  onStep?: (etapa: string) => void,
  scope: SyncScope = "ambos"
): Promise<SyncFinanceiroResult> {
  const filtros = await buildFullSweepFilters();
  return syncByMonthChunks(filtros, onProgress, onStep, scope);
}

export async function syncByMonthChunks(
  filtros: SyncDateFilter,
  onProgress?: (atual: number, total: number) => void,
  onStep?: (etapa: string) => void,
  scope: SyncScope = "ambos"
): Promise<SyncFinanceiroResult> {
  const start = new Date((filtros.dataInicio || fnsFormat(new Date(), "yyyy-MM-dd")) + "T00:00:00");
  const end = new Date((filtros.dataFim || fnsFormat(new Date(), "yyyy-MM-dd")) + "T23:59:59");
  const normalizedDataInicio = fnsFormat(start, "yyyy-MM-dd");
  const normalizedDataFim = fnsFormat(end, "yyyy-MM-dd");

  // Build monthly chunks
  const chunks: { from: string; to: string; label: string }[] = [];
  let cursor = startOfMonth(start);
  while (cursor <= end) {
    const chunkEnd = endOfMonth(cursor);
    chunks.push({
      from: fnsFormat(cursor < start ? start : cursor, "yyyy-MM-dd"),
      to: fnsFormat(chunkEnd > end ? end : chunkEnd, "yyyy-MM-dd"),
      label: fnsFormat(cursor, "MMMM yyyy", { locale: ptBR }),
    });
    cursor = startOfMonth(addMonths(cursor, 1));
  }

  const totals: SyncFinanceiroResult = { importados: 0, atualizados: 0, erros: 0 };

  // O extrato precisa existir antes da importação dos títulos e da conciliação.
  // O cutoff evita buscar períodos que o Argus deliberadamente não baixa no GC.
  const extratoInicio = normalizedDataInicio < ARGUS_BAIXA_CUTOFF ? ARGUS_BAIXA_CUTOFF : normalizedDataInicio;
  try {
    onStep?.("Importando extrato do Banco Inter...");
    const extrato = await buscarExtratoInter(extratoInicio, normalizedDataFim);
    totals.extrato = { ok: true, processados: extrato.total };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    totals.extrato = { ok: false, processados: 0, error: message };
    throw new Error(`Não foi possível atualizar o extrato do Inter. A conciliação foi interrompida: ${message}`);
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onStep?.(`[${i + 1}/${chunks.length}] Sincronizando ${chunk.label}...`);

    const chunkFiltros: SyncDateFilter = {
      dataInicio: chunk.from,
      dataFim: chunk.to,
      incluirLiquidados: filtros.incluirLiquidados,
    };

    try {
      const progressCb = (atual: number, total: number) => {
        onStep?.(`[${i + 1}/${chunks.length}] ${chunk.label} — ${atual}/${total} registros`);
        onProgress?.(
          i * 100 + Math.round((atual / Math.max(total, 1)) * 100),
          chunks.length * 100
        );
      };

      let importados = 0, atualizados = 0, erros = 0;

      if (scope === "recebimentos" || scope === "ambos") {
        const r = await syncRecebimentosGC(progressCb, chunkFiltros);
        importados += r.importados; atualizados += r.atualizados; erros += r.erros;
      }
      if (scope === "pagamentos" || scope === "ambos") {
        const p = await syncPagamentosGC(progressCb, chunkFiltros);
        importados += p.importados; atualizados += p.atualizados; erros += p.erros;
      }

      totals.importados += importados;
      totals.atualizados += atualizados;
      totals.erros += erros;
    } catch (err) {
      console.error(`[syncByMonthChunks] Erro no chunk ${chunk.label}:`, err);
      totals.erros++;
    }
  }

  // Dispara conciliação automática para vincular extratos aos lançamentos recém-sincronizados
  try {
    onStep?.("Conciliando extratos com lançamentos...");
    const { data: recData, error: recError } = await supabase.functions.invoke(
      "reconciliation-engine",
      {
        body: {
          dateFrom: `${normalizedDataInicio}T00:00:00-03:00`,
          dateTo: `${normalizedDataFim}T23:59:59-03:00`,
          limit: 2000,
        },
      }
    );
    if (recError || recData?.success === false) {
      const recMessage = recError?.message
        ?? recData?.error
        ?? `${Number(recData?.stats?.errors ?? 0)} vínculo(s) falharam durante a conciliação`;
      totals.conciliacao = { ok: false, conciliados: 0, revisar: 0, error: recMessage };
      console.warn("[syncByMonthChunks] reconciliation-engine falhou:", recMessage);
    } else {
      const conciliados = Number(
        recData?.stats?.auto ?? recData?.conciliados ?? recData?.matched ?? recData?.reconciled ?? 0
      );
      const revisar = Number(recData?.stats?.review ?? recData?.revisar ?? recData?.review?.length ?? recData?.pending ?? 0);
      totals.conciliacao = { ok: true, conciliados, revisar };
      console.log("[syncByMonthChunks] reconciliation-engine:", recData);
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    totals.conciliacao = { ok: false, conciliados: 0, revisar: 0, error: message };
    console.warn("[syncByMonthChunks] não conseguiu rodar conciliação:", e);
  }

  // Never confirm titles in GestãoClick after a partial reconciliation run.
  // Failed links must remain visible and retryable first.
  if (!totals.conciliacao?.ok) return totals;

  try {
    onStep?.("Confirmando conciliados no GC...");
    totals.baixaGC = await executarBaixaGCConciliados({
      dataInicio: normalizedDataInicio,
      dataFim: normalizedDataFim,
    }, scope, onStep);
    if (!totals.baixaGC.ok) totals.erros += Math.max(1, totals.baixaGC.falha);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    totals.baixaGC = {
      ok: false,
      processados: 0,
      sucesso: 0,
      falha: 0,
      error: message,
    };
    totals.erros += 1;
    console.warn("[syncByMonthChunks] não conseguiu executar baixa:", e);
  }

  return totals;
}

// ─── Probe orphan candidates via per-id GET to preserve records whose
//     data_vencimento changed in GC (moved out of the fetched window).
//     Returns true-orphans (404 in GC) and count of refreshed records.
async function probeOrphansFromGC(
  scope: "recebimentos" | "pagamentos",
  orphans: Array<{ id: string; gc_id: string }>,
  pcMap: Record<string, string>,
  ccMap: Record<string, string>,
  fpMap: Record<string, string>,
): Promise<{ trueOrphans: Array<{ id: string; gc_id: string }>; refreshed: number }> {
  const trueOrphans: Array<{ id: string; gc_id: string }> = [];
  const refreshRows: any[] = [];
  const table = scope === "recebimentos" ? "fin_recebimentos" : "fin_pagamentos";

  const CONCURRENCY = 4;
  for (let i = 0; i < orphans.length; i += CONCURRENCY) {
    const slice = orphans.slice(i, i + CONCURRENCY);
    const results = await Promise.all(slice.map(async (o) => {
      // Só um 404 explícito prova que o registro não existe mais no GC.
      // Erros 5xx/rede são INCONCLUSIVOS: preservam o registro local.
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await callGC<any>({ endpoint: `/api/${scope}/${o.gc_id}` });
          const raw = res?.data?.data ?? res?.data;
          const status = Number(res?.status ?? 0);
          if (status === 404) return { orphan: o, raw: null as any, missing: true };
          if (status === 429 || status >= 500) {
            await gcDelay(1500 * (attempt + 1));
            continue;
          }
          if (status >= 400 || !raw?.id) return { orphan: o, raw: null as any, missing: false };
          return { orphan: o, raw, missing: false };
        } catch {
          await gcDelay(1500 * (attempt + 1));
        }
      }
      return { orphan: o, raw: null as any, missing: false };
    }));

    for (const { orphan, raw, missing } of results) {
      if (!raw) {
        if (missing) trueOrphans.push(orphan);
        else console.warn(`[probeOrphansFromGC:${scope}] inconclusivo para gc_id=${orphan.gc_id} — registro local preservado`);
        continue;
      }
      const base: any = {
        gc_id: raw.id,
        gc_codigo: raw.codigo,
        gc_payload_raw: raw,
        descricao: raw.descricao ?? "Sem descrição",
        os_codigo: extrairOsCodigo(raw.descricao),
        tipo: inferirTipo(raw.descricao),
        origem: inferirOrigem(raw.descricao),
        valor: parseFloat(raw.valor_total ?? raw.valor ?? "0"),
        plano_contas_id: raw.plano_contas_id ? (pcMap[raw.plano_contas_id] ?? null) : null,
        centro_custo_id: raw.centro_custo_id ? (ccMap[raw.centro_custo_id] ?? null) : null,
        forma_pagamento_id: raw.forma_pagamento_id ? (fpMap[raw.forma_pagamento_id] ?? null) : null,
        data_vencimento: raw.data_vencimento || null,
        data_competencia: raw.data_competencia || null,
        data_liquidacao: raw.data_liquidacao || null,
        liquidado: isLiquidadoGC(raw.liquidado),
        status: normalizeLancamentoStatus(raw),
        last_synced_at: new Date().toISOString(),
      };
      if (scope === "recebimentos") {
        base.cliente_gc_id = raw.cliente_id ?? null;
        base.nome_cliente = raw.nome_cliente ?? null;
      } else {
        base.fornecedor_gc_id = raw.fornecedor_id ?? null;
        base.nome_fornecedor = raw.nome_fornecedor ?? null;
      }
      refreshRows.push(base);
    }
  }

  if (refreshRows.length > 0) {
    const B = 50;
    for (let i = 0; i < refreshRows.length; i += B) {
      await supabase.from(table as any).upsert(refreshRows.slice(i, i + B), { onConflict: "gc_id" });
    }
    console.log(`[probeOrphansFromGC:${scope}] refreshed ${refreshRows.length} records (data_vencimento shifted in GC)`);
  }

  return { trueOrphans, refreshed: refreshRows.length };
}


export async function syncRecebimentosGC(
  onProgress?: (atual: number, total: number) => void,
  filtros?: SyncDateFilter
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const inicio = Date.now();
  const fetchFiltros = {
    dataInicio: filtros?.dataInicio,
    dataFim: filtros?.dataFim,
    incluirTodos: filtros?.incluirLiquidados || false,
  };
  const raws = await importarRecebimentosPendentes(onProgress, fetchFiltros);
  const { pcMap, ccMap, fpMap } = await buildPcCcMaps();
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  const batchSize = 50;
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize)
      .map((raw) => ({
        gc_id: raw.id,
        gc_codigo: raw.codigo,
        gc_payload_raw: raw as unknown,
        descricao: raw.descricao ?? "Sem descrição",
        os_codigo: extrairOsCodigo(raw.descricao),
        tipo: inferirTipo(raw.descricao),
        origem: inferirOrigem(raw.descricao),
        valor: parseFloat(raw.valor_total ?? "0"),
        cliente_gc_id: raw.cliente_id ?? null,
        nome_cliente: raw.nome_cliente ?? null,
        plano_contas_id: raw.plano_contas_id ? (pcMap[raw.plano_contas_id] ?? null) : null,
        centro_custo_id: raw.centro_custo_id ? (ccMap[raw.centro_custo_id] ?? null) : null,
        forma_pagamento_id: raw.forma_pagamento_id ? (fpMap[raw.forma_pagamento_id] ?? null) : null,
        data_vencimento: raw.data_vencimento || null,
        data_competencia: raw.data_competencia || null,
        data_liquidacao: raw.data_liquidacao || null,
        liquidado: isLiquidadoGC(raw.liquidado),
        status: normalizeLancamentoStatus(raw),
        last_synced_at: new Date().toISOString(),
      }));

    if (batch.length === 0) continue;

    const { error } = await supabase
      .from("fin_recebimentos" as any)
      .upsert(batch, { onConflict: "gc_id" });

    if (error) {
      erros += batch.length;
    } else {
      importados += batch.length;
    }
  }

  let orphansRemoved = 0;
  let extratosResetados = 0;

  // ── Cleanup: remove local records whose gc_id no longer exists in GC ──
  if (raws.length > 0 && filtros?.dataInicio && filtros?.dataFim) {
    const gcIdsFromGC = new Set(raws.map((r) => String(r.id)));

    const { data: localRecs } = await supabase
      .from("fin_recebimentos" as any)
      .select("id, gc_id")
      .gte("data_vencimento", filtros.dataInicio)
      .lte("data_vencimento", filtros.dataFim)
      .not("gc_id", "is", null) as any;

    const orphanCandidates = (localRecs ?? []).filter(
      (r: any) => r.gc_id && !gcIdsFromGC.has(String(r.gc_id))
    );

    if (orphanCandidates.length > 0) {
      // Probe each candidate via per-id GET — if GC still has it, refresh
      // (data_vencimento may have shifted out of the fetched window).
      const { trueOrphans } = await probeOrphansFromGC("recebimentos", orphanCandidates, pcMap, ccMap, fpMap);
      if (trueOrphans.length > 0) {
        const orphanIds = trueOrphans.map((o: any) => o.id);
        // Ausência no GC vira pendência; nunca apaga o acordo ou desfaz conciliação.
        erros += orphanIds.length;
        await bloquearGruposComTituloAusente(orphanIds);
        await supabase.from("fin_sync_log" as any).insert({
          tipo: "gc_recebimentos_ausentes", status: "partial",
          resposta: { recebimento_ids: orphanIds, motivo: "GC 404; histórico, vínculos e extratos preservados" },
        });
      }
    }
  }




  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_recebimentos",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, atualizados, erros, total: raws.length, orphans_removed: orphansRemoved, extratos_resetados: extratosResetados },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, atualizados, erros };
}

export async function syncPagamentosGC(
  onProgress?: (atual: number, total: number) => void,
  filtros?: SyncDateFilter
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const inicio = Date.now();
  const fetchFiltros = {
    dataInicio: filtros?.dataInicio,
    dataFim: filtros?.dataFim,
    incluirTodos: filtros?.incluirLiquidados || false,
  };
  const raws = await importarPagamentosPendentes(onProgress, fetchFiltros);
  const { pcMap, ccMap, fpMap } = await buildPcCcMaps();
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  const batchSize = 50;
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize)
      .map((raw) => ({
        gc_id: raw.id,
        gc_codigo: raw.codigo,
        gc_payload_raw: raw as unknown,
        descricao: raw.descricao ?? "Sem descrição",
        os_codigo: extrairOsCodigo(raw.descricao),
        tipo: inferirTipo(raw.descricao),
        origem: inferirOrigem(raw.descricao),
        valor: parseFloat(raw.valor_total ?? "0"),
        fornecedor_gc_id: raw.fornecedor_id ?? null,
        nome_fornecedor: raw.nome_fornecedor ?? null,
        plano_contas_id: raw.plano_contas_id ? (pcMap[raw.plano_contas_id] ?? null) : null,
        centro_custo_id: raw.centro_custo_id ? (ccMap[raw.centro_custo_id] ?? null) : null,
        forma_pagamento_id: raw.forma_pagamento_id ? (fpMap[raw.forma_pagamento_id] ?? null) : null,
        data_vencimento: raw.data_vencimento || null,
        data_competencia: raw.data_competencia || null,
        data_liquidacao: raw.data_liquidacao || null,
        liquidado: isLiquidadoGC(raw.liquidado),
        status: normalizeLancamentoStatus(raw),
        last_synced_at: new Date().toISOString(),
      }));

    if (batch.length === 0) continue;

    const { error } = await supabase
      .from("fin_pagamentos" as any)
      .upsert(batch, { onConflict: "gc_id" });

    if (error) {
      erros += batch.length;
    } else {
      importados += batch.length;
    }
  }

  let orphansRemoved = 0;
  let extratosResetados = 0;

  // Backfill recipient_document from fin_fornecedores (batched)
  // ── Cleanup: remove local pagamentos whose gc_id no longer exists in GC ──
  if (raws.length > 0 && filtros?.dataInicio && filtros?.dataFim) {
    const gcIdsFromGC = new Set(raws.map((r) => String(r.id)));
    const { data: localPags } = await supabase
      .from("fin_pagamentos" as any)
      .select("id, gc_id")
      .gte("data_vencimento", filtros.dataInicio)
      .lte("data_vencimento", filtros.dataFim)
      .not("gc_id", "is", null) as any;

    const orphanCandidates = (localPags ?? []).filter(
      (r: any) => r.gc_id && !gcIdsFromGC.has(String(r.gc_id))
    );
    if (orphanCandidates.length > 0) {
      // Probe each candidate via per-id GET — if GC still has it, refresh
      // (data_vencimento may have shifted out of the fetched window).
      const { trueOrphans } = await probeOrphansFromGC("pagamentos", orphanCandidates, pcMap, ccMap, fpMap);
      if (trueOrphans.length > 0) {
        const orphanIds = trueOrphans.map((o: any) => o.id);
        extratosResetados = await resetExtratosByLancamentos(orphanIds, ["pagamentos", "fin_pagamentos"]);
        await supabase.from("fin_grupo_pagar_itens" as any).delete().in("pagamento_id", orphanIds);
        await supabase.from("fin_pagamentos" as any).delete().in("id", orphanIds);
        orphansRemoved = orphanIds.length;
        console.log(`[syncPagamentosGC] Removed ${orphansRemoved} truly orphaned local pagamentos; reset ${extratosResetados} extratos`);
      }
    }

  }

  try {
    const { data: fornecedores } = await supabase
      .from("fin_fornecedores" as any)
      .select("gc_id, cpf_cnpj")
      .not("cpf_cnpj", "is", null) as any;

    if (fornecedores?.length) {
      const fornMap: Record<string, string> = {};
      for (const f of fornecedores as any[]) {
        if (f.cpf_cnpj) fornMap[f.gc_id] = f.cpf_cnpj;
      }

      const { data: missing } = await supabase
        .from("fin_pagamentos" as any)
        .select("id, fornecedor_gc_id")
        .is("recipient_document" as any, null)
        .not("fornecedor_gc_id", "is", null)
        .limit(500) as any;

      // Batch updates by document value to reduce DB calls
      const updatesByDoc: Record<string, string[]> = {};
      for (const p of (missing ?? []) as any[]) {
        const doc = fornMap[p.fornecedor_gc_id];
        if (doc) {
          if (!updatesByDoc[doc]) updatesByDoc[doc] = [];
          updatesByDoc[doc].push(p.id);
        }
      }
      for (const [doc, ids] of Object.entries(updatesByDoc)) {
        await supabase.from("fin_pagamentos" as any)
          .update({ recipient_document: doc } as any)
          .in("id", ids);
      }
    }
  } catch (e) {
    console.error("Backfill recipient_document error:", e);
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_pagamentos",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, atualizados, erros, total: raws.length, orphans_removed: orphansRemoved, extratos_resetados: extratosResetados },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, atualizados, erros };
}

// ─── Sync Fornecedores (GC → fin_fornecedores) ─────────────────────

export async function syncFornecedoresGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; erros: number }> {
  const inicio = Date.now();
  const raws = await fetchPaginatedGC<Record<string, any>>(
    "/api/fornecedores",
    {},
    onProgress
  );
  let importados = 0;
  let erros = 0;

  const batchSize = 50;
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize).map((raw) => {
      const cpfCnpj = (raw.cnpj || raw.cpf_cnpj || raw.cpf || "").replace(/\D/g, "") || null;
      return {
        gc_id: String(raw.id),
        nome: raw.nome_fantasia || raw.razao_social || raw.nome || "Sem nome",
        razao_social: raw.razao_social || null,
        nome_fantasia: raw.nome_fantasia || null,
        cpf_cnpj: cpfCnpj,
        email: raw.email || null,
        telefone: raw.telefone || raw.celular || null,
        chave_pix: raw.chave_pix || null,
        endereco: raw.endereco || raw.logradouro || null,
        cidade: raw.cidade || raw.nome_cidade || null,
        estado: raw.estado || raw.uf || null,
        cep: raw.cep ? String(raw.cep).replace(/\D/g, "") : null,
        bairro: raw.bairro || null,
        observacao: raw.observacao || raw.observacoes || null,
        data_cadastro: raw.data_cadastro || raw.created_at || null,
        tipo_pessoa: raw.tipo_pessoa || (cpfCnpj && cpfCnpj.length > 11 ? "juridica" : "fisica"),
        payload_raw: raw,
        last_synced: new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .from("fin_fornecedores" as any)
      .upsert(batch, { onConflict: "gc_id" });

    if (error) {
      console.error("Upsert fornecedores error:", error);
      erros += batch.length;
    } else {
      importados += batch.length;
    }
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_fornecedores",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, erros, total: raws.length },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, erros };
}

// ─── Sync Clientes (GC → fin_clientes) ──────────────────────────────

export async function syncClientesGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; erros: number }> {
  const inicio = Date.now();
  const raws = await fetchPaginatedGC<Record<string, any>>(
    "/api/clientes",
    {},
    onProgress
  );
  let importados = 0;
  let erros = 0;

  const batchSize = 50;
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize).map((raw) => {
      const cpfCnpj = (raw.cnpj || raw.cpf_cnpj || raw.cpf || "").replace(/\D/g, "") || null;
      return {
        gc_id: String(raw.id),
        nome: raw.nome_fantasia || raw.razao_social || raw.nome || "Sem nome",
        razao_social: raw.razao_social || null,
        nome_fantasia: raw.nome_fantasia || null,
        cpf_cnpj: cpfCnpj,
        email: raw.email || null,
        telefone: raw.telefone || raw.celular || null,
        endereco: raw.endereco || raw.logradouro || null,
        cidade: raw.cidade || raw.nome_cidade || null,
        estado: raw.estado || raw.uf || null,
        cep: raw.cep ? String(raw.cep).replace(/\D/g, "") : null,
        bairro: raw.bairro || null,
        observacao: raw.observacao || raw.observacoes || null,
        data_cadastro: raw.data_cadastro || raw.created_at || null,
        tipo_pessoa: raw.tipo_pessoa || (cpfCnpj && cpfCnpj.length > 11 ? "juridica" : "fisica"),
        payload_raw: raw,
        last_synced: new Date().toISOString(),
      };
    });

    const { error } = await supabase
      .from("fin_clientes" as any)
      .upsert(batch, { onConflict: "gc_id" });

    if (error) {
      console.error("Upsert clientes error:", error);
      erros += batch.length;
    } else {
      importados += batch.length;
    }
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_clientes",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, erros, total: raws.length },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, erros };
}

// ─── Sync Plano de Contas (extraído dos recebimentos/pagamentos GC) ──

export async function syncPlanoContasGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; erros: number }> {
  const inicio = Date.now();
  let importados = 0;
  let erros = 0;

  // Try dedicated API endpoint first
  try {
    const raws = await fetchPaginatedGC<Record<string, any>>(
      "/api/planos_contas",
      {},
      onProgress
    );
    if (raws.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < raws.length; i += batchSize) {
        const batch = raws.slice(i, i + batchSize).map((raw) => ({
          gc_id: String(raw.id),
          nome: raw.nome || "Sem nome",
          codigo: raw.codigo || null,
          tipo: (raw.tipo === "despesa" ? "despesa" : "receita") as "receita" | "despesa",
          ativo: raw.ativo !== "0" && raw.ativo !== false,
          updated_at: new Date().toISOString(),
        }));
        const { error } = await supabase
          .from("fin_plano_contas" as any)
          .upsert(batch, { onConflict: "gc_id" });
        if (error) erros += batch.length;
        else importados += batch.length;
      }
      await supabase.from("fin_sync_log" as any).insert({
        tipo: "gc_import_plano_contas",
        status: erros === 0 ? "success" : "partial",
        resposta: { importados, erros, source: "api" },
        duracao_ms: Date.now() - inicio,
      });
      return { importados, erros };
    }
  } catch {
    console.log("[syncPlanoContasGC] API endpoint not available, extracting from payloads...");
  }

  // Fallback: extract from GC recebimentos + pagamentos gc_payload_raw
  const pcMap = new Map<string, { gc_id: string; nome: string; tipo: "receita" | "despesa" }>();

  const { data: recs } = await supabase
    .from("fin_recebimentos" as any)
    .select("gc_payload_raw")
    .not("gc_payload_raw", "is", null)
    .limit(1000) as any;

  for (const r of (recs ?? []) as any[]) {
    const raw = r.gc_payload_raw;
    if (raw?.plano_contas_id && raw?.nome_plano_conta) {
      pcMap.set(String(raw.plano_contas_id), {
        gc_id: String(raw.plano_contas_id),
        nome: raw.nome_plano_conta,
        tipo: "receita",
      });
    }
  }

  const { data: pags } = await supabase
    .from("fin_pagamentos" as any)
    .select("gc_payload_raw")
    .not("gc_payload_raw", "is", null)
    .limit(1000) as any;

  for (const p of (pags ?? []) as any[]) {
    const raw = p.gc_payload_raw;
    if (raw?.plano_contas_id && raw?.nome_plano_conta) {
      pcMap.set(String(raw.plano_contas_id), {
        gc_id: String(raw.plano_contas_id),
        nome: raw.nome_plano_conta,
        tipo: "despesa",
      });
    }
  }

  const entries = Array.from(pcMap.values());
  onProgress?.(0, entries.length);
  const batchSize = 50;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize).map((e) => ({
      gc_id: e.gc_id,
      nome: e.nome,
      tipo: e.tipo,
      ativo: true,
      updated_at: new Date().toISOString(),
    }));
    const { error } = await supabase
      .from("fin_plano_contas" as any)
      .upsert(batch, { onConflict: "gc_id" });
    if (error) {
      console.error("Upsert plano_contas error:", error);
      erros += batch.length;
    } else {
      importados += batch.length;
    }
    onProgress?.(Math.min(i + batchSize, entries.length), entries.length);
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_plano_contas",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, erros, total: entries.length, source: "payload_extraction" },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, erros };
}

// ─── Sync Centros de Custo (extraído dos recebimentos/pagamentos GC) ─

export async function syncCentrosCustoGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; erros: number }> {
  const inicio = Date.now();
  let importados = 0;
  let erros = 0;

  // Try dedicated API endpoint first
  try {
    const raws = await fetchPaginatedGC<Record<string, any>>(
      "/api/centros_custos",
      {},
      onProgress
    );
    if (raws.length > 0) {
      const batchSize = 50;
      for (let i = 0; i < raws.length; i += batchSize) {
        const batch = raws.slice(i, i + batchSize).map((raw) => ({
          nome: raw.nome || "Sem nome",
          codigo: String(raw.id),
          ativo: raw.ativo !== "0" && raw.ativo !== false,
        }));
        for (const b of batch) {
          const { data: existing } = await supabase
            .from("fin_centros_custo" as any)
            .select("id")
            .eq("codigo", b.codigo)
            .maybeSingle();
          if (existing) {
            await supabase.from("fin_centros_custo" as any).update({ nome: b.nome, ativo: b.ativo }).eq("id", (existing as any).id);
          } else {
            await supabase.from("fin_centros_custo" as any).insert(b);
          }
          importados++;
        }
      }
      await supabase.from("fin_sync_log" as any).insert({
        tipo: "gc_import_centros_custo",
        status: "success",
        resposta: { importados, erros, source: "api" },
        duracao_ms: Date.now() - inicio,
      });
      return { importados, erros };
    }
  } catch {
    console.log("[syncCentrosCustoGC] API endpoint not available, extracting from payloads...");
  }

  // Fallback: extract from GC payloads
  const ccMap = new Map<string, { codigo: string; nome: string }>();

  const { data: recs } = await supabase
    .from("fin_recebimentos" as any)
    .select("gc_payload_raw")
    .not("gc_payload_raw", "is", null)
    .limit(1000) as any;

  for (const r of (recs ?? []) as any[]) {
    const raw = r.gc_payload_raw;
    if (raw?.centro_custo_id && raw?.nome_centro_custo) {
      ccMap.set(String(raw.centro_custo_id), {
        codigo: String(raw.centro_custo_id),
        nome: raw.nome_centro_custo,
      });
    }
  }

  const { data: pags } = await supabase
    .from("fin_pagamentos" as any)
    .select("gc_payload_raw")
    .not("gc_payload_raw", "is", null)
    .limit(1000) as any;

  for (const p of (pags ?? []) as any[]) {
    const raw = p.gc_payload_raw;
    if (raw?.centro_custo_id && raw?.nome_centro_custo) {
      ccMap.set(String(raw.centro_custo_id), {
        codigo: String(raw.centro_custo_id),
        nome: raw.nome_centro_custo,
      });
    }
  }

  const entries = Array.from(ccMap.values());
  onProgress?.(0, entries.length);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const { data: existing } = await supabase
      .from("fin_centros_custo" as any)
      .select("id")
      .eq("codigo", e.codigo)
      .maybeSingle();
    if (existing) {
      await supabase.from("fin_centros_custo" as any).update({ nome: e.nome, ativo: true }).eq("id", (existing as any).id);
    } else {
      const { error } = await supabase.from("fin_centros_custo" as any).insert({ nome: e.nome, codigo: e.codigo, ativo: true });
      if (error) erros++;
      else importados++;
    }
    onProgress?.(i + 1, entries.length);
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_centros_custo",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, erros, total: entries.length, source: "payload_extraction" },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, erros };
}

// ─── Sync Formas de Pagamento (GC → fin_formas_pagamento) ───────────

export async function syncFormasPagamentoGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; erros: number }> {
  const inicio = Date.now();
  const raws = await fetchPaginatedGC<Record<string, any>>(
    "/api/formas_pagamentos",
    {},
    onProgress
  );
  let importados = 0;
  let erros = 0;
  const sampleErrors: string[] = [];
  let sampleRawFull: any = null;

  // Debug: capture first raw completely
  if (raws.length > 0) {
    sampleRawFull = raws[0];
  }

  // Fetch existing gc_ids to decide insert vs update
  const { data: existing } = await supabase
    .from("fin_formas_pagamento")
    .select("id, gc_id");
  const existingMap: Record<string, string> = {};
  (existing || []).forEach((e: any) => { if (e.gc_id) existingMap[e.gc_id] = e.id; });

  for (let raw of raws) {
    // GC API wraps each item: { FormasPagamento: { id, nome, ... } }
    // Unwrap if needed
    const wrapperKey = Object.keys(raw).find(k => typeof raw[k] === "object" && raw[k] !== null && !Array.isArray(raw[k]) && ("id" in raw[k] || "nome" in raw[k]));
    if (wrapperKey && !raw.id && !raw.nome) {
      raw = raw[wrapperKey];
    }

    const gcId = String(raw.id || raw.codigo || raw.codigo_forma_pagamento || "");
    if (!gcId || gcId === "undefined" || gcId === "null") {
      if (sampleErrors.length < 3) sampleErrors.push(`no_id: keys=${Object.keys(raw).join(",")}`);
      erros++;
      continue;
    }
    
    const nome = raw.nome || raw.descricao || raw.nome_forma_pagamento || "Sem nome";
    const record = {
      gc_id: gcId,
      nome,
      tipo: raw.tipo || null,
      ativo: raw.ativo !== false && raw.ativo !== "0",
    };

    let error: any;
    if (existingMap[gcId]) {
      const res = await supabase
        .from("fin_formas_pagamento")
        .update(record)
        .eq("id", existingMap[gcId]);
      error = res.error;
    } else {
      const res = await supabase
        .from("fin_formas_pagamento")
        .insert(record);
      error = res.error;
      // If duplicate key error, try update instead
      if (error && (error.code === "23505" || error.message?.includes("duplicate"))) {
        const { data: dup } = await supabase
          .from("fin_formas_pagamento")
          .select("id")
          .eq("gc_id", gcId)
          .maybeSingle();
        if (dup) {
          const res2 = await supabase
            .from("fin_formas_pagamento")
            .update(record)
            .eq("id", dup.id);
          error = res2.error;
        }
      }
    }

    if (error) {
      if (sampleErrors.length < 5) sampleErrors.push(`${gcId}/${nome}: ${error.message} (code:${error.code})`);
      erros++;
    } else {
      importados++;
      existingMap[gcId] = existingMap[gcId] || "inserted";
    }
  }

  await supabase.from("fin_sync_log").insert({
    tipo: "gc_import_formas_pagamento",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, erros, total: raws.length, sampleErrors, sampleRaw: sampleRawFull } as any,
    duracao_ms: Date.now() - inicio,
  });

  return { importados, erros };
}

// ─── Inter: Gerar Cobrança PIX ──────────────────────────────────────

export async function gerarCobrancaPix(grupoId: string): Promise<{
  txid: string;
  qrcode: string;
  copiaCola: string;
}> {
  const { data: grupo } = await supabase
    .from("fin_grupos_receber" as any)
    .select("*")
    .eq("id", grupoId)
    .single();

  if (!grupo) throw new Error("Grupo não encontrado");

  const checkedGroup = grupo as any;
  if (checkedGroup.bloqueio_financeiro || (checkedGroup.integridade_status && !["ok", "nao_verificado"].includes(checkedGroup.integridade_status)) || ["pago", "pago_parcial", "cancelado"].includes(checkedGroup.status)) {
    throw new Error("Cobrança bloqueada: confira a composição, as pendências e os pagamentos do grupo.");
  }
  const { data: items, error: itemsError } = await supabase.from("fin_grupo_receber_itens").select("valor, os_codigo_original, fin_recebimentos(gc_id, os_codigo, liquidado, status)").eq("grupo_id", grupoId);
  if (itemsError) throw itemsError;
  if (!items?.length || items.length !== Number(checkedGroup.itens_total) || items.some((item: any) => item.fin_recebimentos?.liquidado || item.fin_recebimentos?.status === "pago") || items.reduce((sum: number, item: any) => sum + Math.round(Number(item.valor) * 100), 0) !== Math.round(Number(checkedGroup.valor_total) * 100)) {
    throw new Error("Cobrança bloqueada: os títulos não representam integralmente um acordo em aberto.");
  }

  const itemOS = new Set(items.map((item: any) => String(item.os_codigo_original || item.fin_recebimentos?.os_codigo || "")));
  if ((checkedGroup.os_codigos || []).some((code: string) => !itemOS.has(String(code)))) throw new Error("Há OS sem título no grupo. Confira antes de cobrar.");
  for (const item of items as any[]) {
    const gcId = item.fin_recebimentos?.gc_id;
    if (!gcId) throw new Error("Há título sem referência GC. Cobrança bloqueada.");
    const { status, data } = await callGC<any>({ endpoint: `/api/recebimentos/${gcId}` });
    const fresh = data?.data ?? data;
    if (status >= 400 || String(fresh?.id || "") !== String(gcId) || String(fresh.cliente_id || "") !== String(checkedGroup.cliente_gc_id) || isLiquidadoGC(fresh.liquidado) || Math.round(Number(fresh.valor_total ?? fresh.valor) * 100) !== Math.round(Number(item.valor) * 100)) {
      throw new Error("Título pago, ausente ou divergente no GC. Confira antes de gerar cobrança PIX.");
    }
  }
  await conferirGrupoNegociacao(grupoId);

  const txid = `WEDO${grupoId.replace(/-/g, "").substring(0, 26).toUpperCase()}`;

  const { data: cfg } = await supabase
    .from("fin_configuracoes" as any)
    .select("chave, valor")
    .in("chave", ["inter_chave_pix", "inter_titular_conta"]);

  const configs = Object.fromEntries(
    ((cfg as any[]) ?? []).map((c: any) => [c.chave, c.valor])
  );

  const g = grupo as any;
  const valor = Number(g.valor_total);
  if (!Number.isFinite(valor) || valor <= 0) {
    throw new Error("Valor da cobrança PIX inválido");
  }

  const chavePix = String(configs.inter_chave_pix ?? "").trim();
  if (!chavePix) throw new Error("Chave PIX do Inter não configurada");

  const { data: cliente, error: clienteError } = await supabase
    .from("fin_clientes" as any)
    .select("cpf_cnpj")
    .eq("gc_id", String(g.cliente_gc_id ?? ""))
    .maybeSingle();
  if (clienteError) throw new Error(`Falha ao consultar CPF/CNPJ do cliente: ${clienteError.message}`);

  const documento = String((cliente as any)?.cpf_cnpj ?? "").replace(/\D/g, "");
  if (documento.length !== 11 && documento.length !== 14) {
    throw new Error("Cadastre um CPF ou CNPJ válido para gerar a cobrança PIX");
  }

  const nomeDevedor = String(g.nome_cliente ?? "Cliente").trim().slice(0, 200);
  const devedor = documento.length === 14
    ? { nome: nomeDevedor, cnpj: documento }
    : { nome: nomeDevedor, cpf: documento };
  const comVencimento = Boolean(g.data_vencimento);
  if (comVencimento && !/^\d{4}-\d{2}-\d{2}$/.test(String(g.data_vencimento))) {
    throw new Error("Data de vencimento inválida para cobrança PIX");
  }

  const payload = {
    calendario: comVencimento
      ? { dataDeVencimento: g.data_vencimento, validadeAposVencimento: 3 }
      : { expiracao: 86400 },
    devedor,
    valor: { original: valor.toFixed(2) },
    chave: chavePix,
    solicitacaoPagador: `WeDo - ${g.nome_cliente ?? "Pagamento"}`.slice(0, 140),
    infoAdicionais: [{ nome: "GrupoId", valor: grupoId }],
  };

  const endpoint = comVencimento ? `/pix/v2/cobv/${txid}` : `/pix/v2/cob/${txid}`;
  const resp = await interRequest<any>(endpoint, "PUT", payload);

  const { error: saveError } = await supabase
    .from("fin_grupos_receber" as any)
    .update({
      inter_txid: resp.txid ?? txid,
      inter_qrcode: resp.pixCopiaECola ?? resp.qrcode ?? "",
      inter_copia_cola: resp.pixCopiaECola ?? "",
      updated_at: new Date().toISOString(),
    })
    .eq("id", grupoId);

  if (saveError) throw new Error(`PIX ${txid} criado no Inter, mas vínculo local não confirmado. Confira essa cobrança antes de repetir: ${saveError.message}`);

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "inter_cobranca_pix",
    referencia_id: grupoId,
    status: "success",
    payload,
    resposta: resp,
  });

  return {
    txid: resp.txid ?? txid,
    qrcode: resp.pixCopiaECola ?? "",
    copiaCola: resp.pixCopiaECola ?? "",
  };
}

// ─── Inter: Verificar Cobrança ──────────────────────────────────────

export async function verificarCobrancaPix(txid: string): Promise<{
  status: string;
  pago: boolean;
  valor?: number;
  pagadorNome?: string;
  horario?: string;
}> {
  // Try cobv first (cobrança com vencimento), fallback to cob
  let resp: any;
  try {
    resp = await interRequest<any>(`/pix/v2/cobv/${txid}`, "GET");
  } catch {
    resp = await interRequest<any>(`/pix/v2/cob/${txid}`, "GET");
  }
  const pago = resp.status === "CONCLUIDA";
  const pix = resp.pix?.[0];
  return {
    status: resp.status,
    pago,
    valor: pix ? parseFloat(pix.valor) : undefined,
    pagadorNome: pix?.pagador?.nome,
    horario: pix?.horario,
  };
}

// ─── Inter: Extrato ─────────────────────────────────────────────────

export interface InterExtratoImportResult {
  total: number;
  inserted: number;
  skipped: number;
  chunks: number;
  runs: number;
}

export async function buscarExtratoInter(
  dataInicio: string,
  dataFim: string
): Promise<InterExtratoImportResult> {
  let cursor = dataInicio;
  let total = 0;
  let inserted = 0;
  let skipped = 0;
  let chunks = 0;
  let runs = 0;

  while (cursor <= dataFim && runs < 24) {
    const { data, error } = await supabase.functions.invoke("inter-extrato", {
      body: { dataInicio: cursor, dataFim },
    });

    if (error) {
      const msg = error.message ?? "";
      if (msg.includes("non-2xx") || msg.includes("429")) {
        throw new Error("API do Inter com limite de taxa. Aguarde alguns minutos e tente novamente.");
      }
      throw new Error(msg || "Erro ao buscar extrato");
    }

    const result = data as any;
    if (!result?.success) throw new Error(result?.error ?? "Erro ao buscar extrato");

    const current = result?.extrato ?? {};
    total += Number(current.total ?? 0);
    inserted += Number(current.inserted ?? 0);
    skipped += Number(current.skipped ?? 0);
    chunks += Number(current.chunks_processados ?? current.chunks ?? 0);
    runs += 1;

    if (!current.truncado) {
      return { total, inserted, skipped, chunks, runs };
    }

    const nextCursor = String(current?.proximo_periodo?.dataInicio ?? "");
    if (!nextCursor || nextCursor <= cursor || nextCursor > dataFim) {
      throw new Error(`Importação parcial do Inter sem continuação válida após ${cursor}. Tente novamente a partir dessa data.`);
    }
    cursor = nextCursor;
  }

  throw new Error(`Importação do Inter não terminou após ${runs} etapas. Continue a partir de ${cursor}.`);
}

// ─── Inter: Enviar Pagamento PIX ────────────────────────────────────

export async function enviarPagamentoPix(
  agendaId: string
): Promise<{ endToEndId: string }> {
  const { data: agenda } = await supabase
    .from("fin_agenda_pagamentos" as any)
    .select("*")
    .eq("id", agendaId)
    .single();

  if (!agenda) throw new Error("Agendamento não encontrado");

  const ag = agenda as any;
  const valor = Number(ag.valor);
  if (!Number.isFinite(valor) || valor <= 0) throw new Error("Valor do PIX inválido");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ag.data_vencimento ?? ""))) {
    throw new Error("Data de pagamento do PIX inválida");
  }
  const chave = String(ag.chave_pix_destino ?? "").trim();
  if (!chave) throw new Error("Chave PIX do destinatário não informada");

  const payload = {
    valor: Math.round(valor * 100) / 100,
    dataPagamento: ag.data_vencimento,
    descricao: String(ag.descricao ?? "").slice(0, 140),
    destinatario: { tipo: "CHAVE", chave },
  };

  const resp = await interRequest<any>("/banking/v2/pix", "POST", payload, {
    idempotencyKey: agendaId,
  });
  const endToEndId = resp.codigoSolicitacao ?? resp.endToEndId ?? resp.codigoTransacao ?? "";
  if (!endToEndId) throw new Error("Inter não retornou o código da solicitação PIX");
  const executado = resp.tipoRetorno === "PAGAMENTO";

  await supabase
    .from("fin_agenda_pagamentos" as any)
    .update({
      inter_pagamento_id: endToEndId,
      status: executado ? "executado" : "pendente",
      executado_em: executado ? new Date().toISOString() : null,
    })
    .eq("id", agendaId);

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "inter_pagamento_pix",
    referencia_id: agendaId,
    status: executado ? "success" : "pending_approval",
    payload,
    resposta: resp,
  });

  return { endToEndId };
}

// ─── Test Connections ───────────────────────────────────────────────

export async function testInterConnection(): Promise<{
  ok: boolean;
  message: string;
}> {
  try {
    const today = new Date().toISOString().split("T")[0];
    await interRequest(
      `/banking/v2/extrato?dataInicio=${today}&dataFim=${today}`,
      "GET"
    );
    return { ok: true, message: "Conexão Inter OK" };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("INTER_NOT_CONFIGURED")) {
      return { ok: false, message: "Inter não configurado (secrets ausentes)" };
    }
    return { ok: false, message: `Erro: ${msg}` };
  }
}
