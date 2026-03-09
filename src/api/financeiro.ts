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

export const gcDelay = (ms = 350) => new Promise((r) => setTimeout(r, ms));

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

  while (page <= totalPages) {
    const res = await callGC<GCApiResponse<T>>({
      endpoint,
      params: { limite: "100", pagina: String(page), ...params },
    });

    if (res.status === 401) throw new Error("GC_AUTH_ERROR");
    if (res.status === 429) {
      await gcDelay(2000);
      continue;
    }
    if (res.status >= 500) throw new Error(`GC server error: ${res.status}`);

    const gcResponse = res.data;
    if (gcResponse?.data) {
      allRecords.push(...gcResponse.data);
      totalPages = gcResponse.meta?.total_paginas || 1;
      onProgress?.(allRecords.length, gcResponse.meta?.total_registros ?? allRecords.length);
    }

    page++;
    if (page <= totalPages) await gcDelay();
  }

  return allRecords;
}

// ─── Inter Request ───────────────────────────────────────────────────

async function interRequest<T = unknown>(
  path: string,
  method = "GET",
  payload?: Record<string, unknown>
): Promise<T> {
  const { data, error } = await supabase.functions.invoke("inter-proxy", {
    body: { path, method, payload },
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
  if (filtros?.incluirTodos) {
    // Don't set liquidado filter — fetch ALL records
  } else if (filtros?.liquidado !== undefined) {
    params.liquidado = filtros.liquidado;
  } else {
    params.liquidado = "ab";
  }
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
    liquidado: "1",
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
  if (filtros?.incluirTodos) {
    // Don't set liquidado filter — fetch ALL records
  } else if (filtros?.liquidado !== undefined) {
    params.liquidado = filtros.liquidado;
  } else {
    params.liquidado = "0";
  }
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
    liquidado: "1",
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
  const { data: itens } = await supabase
    .from("fin_grupo_receber_itens" as any)
    .select("id, recebimento_id, tentativas")
    .eq("grupo_id", grupoId)
    .eq("gc_baixado", false);

  let sucesso = 0;
  let falha = 0;

  for (const item of (itens as any[]) ?? []) {
    const { data: rec } = await supabase
      .from("fin_recebimentos" as any)
      .select("gc_id, gc_payload_raw")
      .eq("id", item.recebimento_id)
      .single() as any;

    const recData = rec as any;
    if (!recData?.gc_id || !recData?.gc_payload_raw) {
      falha++;
      onItemDone?.(false, "unknown", "Dados GC ausentes");
      continue;
    }

    try {
      await baixarRecebimentoNoGC(
        recData.gc_id as string,
        recData.gc_payload_raw as Record<string, unknown>,
        dataLiquidacao
      );

      await supabase
        .from("fin_grupo_receber_itens" as any)
        .update({
          gc_baixado: true,
          gc_baixado_em: new Date().toISOString(),
          tentativas: (item.tentativas ?? 0) + 1,
        })
        .eq("id", item.id);

      await supabase
        .from("fin_recebimentos" as any)
        .update({
          gc_baixado: true,
          gc_baixado_em: new Date().toISOString(),
          liquidado: true,
          status: "pago",
          data_liquidacao: dataLiquidacao,
        })
        .eq("gc_id", recData.gc_id);

      sucesso++;
      onItemDone?.(true, recData.gc_id as string);
    } catch (e) {
      const erro = e instanceof Error ? e.message : String(e);
      await supabase
        .from("fin_grupo_receber_itens" as any)
        .update({
          tentativas: (item.tentativas ?? 0) + 1,
          ultimo_erro: erro,
        })
        .eq("id", item.id);
      falha++;
      onItemDone?.(false, recData.gc_id as string, erro);
    }
    await gcDelay();
  }

  const { data: allItens } = await supabase
    .from("fin_grupo_receber_itens" as any)
    .select("gc_baixado")
    .eq("grupo_id", grupoId);
  const allDone = (allItens as any[])?.every((i) => i.gc_baixado) ?? false;

  await supabase
    .from("fin_grupos_receber" as any)
    .update({
      status: falha === 0 ? "pago" : "pago_parcial",
      gc_baixado: allDone,
      gc_baixado_em: allDone ? new Date().toISOString() : null,
      itens_baixados: sucesso,
      updated_at: new Date().toISOString(),
    })
    .eq("id", grupoId);

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_baixa_grupo_receber",
    referencia_id: grupoId,
    status: falha === 0 ? "success" : "partial",
    resposta: { sucesso, falha, data_liquidacao: dataLiquidacao },
  });

  return { sucesso, falha };
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

// ─── Helpers: Map GC IDs to local UUIDs ─────────────────────────────

async function buildPcCcMaps(): Promise<{
  pcMap: Record<string, string>;
  ccMap: Record<string, string>;
}> {
  const [{ data: pcs }, { data: ccs }] = await Promise.all([
    supabase.from("fin_plano_contas").select("id, gc_id").not("gc_id", "is", null),
    supabase.from("fin_centros_custo").select("id, codigo").not("codigo", "is", null),
  ]);
  const pcMap: Record<string, string> = {};
  for (const pc of pcs ?? []) { if (pc.gc_id) pcMap[pc.gc_id] = pc.id; }
  const ccMap: Record<string, string> = {};
  for (const cc of ccs ?? []) { if (cc.codigo) ccMap[cc.codigo] = cc.id; }
  return { pcMap, ccMap };
}

// ─── Sync Service (GC → fin_* tables) ───────────────────────────────

export interface SyncDateFilter {
  dataInicio?: string;
  dataFim?: string;
  incluirLiquidados?: boolean;
}

// ─── Chunked sync by month (splits large ranges) ────────────────────

export async function syncByMonthChunks(
  filtros: SyncDateFilter,
  onProgress?: (atual: number, total: number) => void,
  onStep?: (etapa: string) => void
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const start = new Date((filtros.dataInicio || fnsFormat(new Date(), "yyyy-MM-dd")) + "T00:00:00");
  const end = new Date((filtros.dataFim || fnsFormat(new Date(), "yyyy-MM-dd")) + "T23:59:59");

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

  const totals = { importados: 0, atualizados: 0, erros: 0 };

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    onStep?.(`[${i + 1}/${chunks.length}] Sincronizando ${chunk.label}...`);

    const chunkFiltros: SyncDateFilter = {
      dataInicio: chunk.from,
      dataFim: chunk.to,
      incluirLiquidados: filtros.incluirLiquidados,
    };

    try {
      const [r, p] = await Promise.all([
        syncRecebimentosGC(
          (atual, total) => onProgress?.(
            i * 100 + Math.round((atual / Math.max(total, 1)) * 100),
            chunks.length * 100
          ),
          chunkFiltros
        ),
        syncPagamentosGC(undefined, chunkFiltros),
      ]);
      totals.importados += r.importados + p.importados;
      totals.atualizados += r.atualizados + p.atualizados;
      totals.erros += r.erros + p.erros;
    } catch (err) {
      console.error(`[syncByMonthChunks] Erro no chunk ${chunk.label}:`, err);
      totals.erros++;
      // Continue to next chunk even if this one fails
    }
  }

  return totals;
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
  const { pcMap, ccMap } = await buildPcCcMaps();
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  const batchSize = 50;
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize).map((raw) => ({
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
      data_vencimento: raw.data_vencimento || null,
      data_competencia: raw.data_competencia || null,
      data_liquidacao: raw.data_liquidacao || null,
      liquidado: raw.liquidado === "1",
      status: raw.liquidado === "1" ? "pago" : "pendente",
      last_synced_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("fin_recebimentos" as any)
      .upsert(batch, { onConflict: "gc_id" });

    if (error) {
      erros += batch.length;
    } else {
      importados += batch.length;
    }
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_recebimentos",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, atualizados, erros, total: raws.length },
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
  const { pcMap, ccMap } = await buildPcCcMaps();
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  const batchSize = 50;
  for (let i = 0; i < raws.length; i += batchSize) {
    const batch = raws.slice(i, i + batchSize).map((raw) => ({
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
      data_vencimento: raw.data_vencimento || null,
      data_competencia: raw.data_competencia || null,
      data_liquidacao: raw.data_liquidacao || null,
      liquidado: raw.liquidado === "1",
      status: raw.liquidado === "1" ? "pago" : "pendente",
      last_synced_at: new Date().toISOString(),
    }));

    const { error } = await supabase
      .from("fin_pagamentos" as any)
      .upsert(batch, { onConflict: "gc_id" });

    if (error) {
      erros += batch.length;
    } else {
      importados += batch.length;
    }
  }

  // Backfill recipient_document from fin_fornecedores (batched)
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
    resposta: { importados, atualizados, erros, total: raws.length },
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
        cpf_cnpj: cpfCnpj,
        email: raw.email || null,
        telefone: raw.telefone || raw.celular || null,
        chave_pix: raw.chave_pix || null,
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
        cpf_cnpj: cpfCnpj,
        email: raw.email || null,
        telefone: raw.telefone || raw.celular || null,
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
      "/api/plano_contas",
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
      "/api/centros_custo",
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

// ─── Sync Formas de Pagamento (extraído dos recebimentos/pagamentos GC) ─

export async function syncFormasPagamentoGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; erros: number }> {
  const inicio = Date.now();
  let importados = 0;
  let erros = 0;

  // Extract from GC payloads
  const fpMap = new Map<string, { gc_id: string; nome: string; tipo: string | null }>();

  const { data: recs } = await supabase
    .from("fin_recebimentos" as any)
    .select("gc_payload_raw")
    .not("gc_payload_raw", "is", null)
    .limit(1000) as any;

  for (const r of (recs ?? []) as any[]) {
    const raw = r.gc_payload_raw;
    if (raw?.forma_pagamento_id && raw?.nome_forma_pagamento) {
      fpMap.set(String(raw.forma_pagamento_id), {
        gc_id: String(raw.forma_pagamento_id),
        nome: raw.nome_forma_pagamento,
        tipo: null,
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
    if (raw?.forma_pagamento_id && raw?.nome_forma_pagamento) {
      fpMap.set(String(raw.forma_pagamento_id), {
        gc_id: String(raw.forma_pagamento_id),
        nome: raw.nome_forma_pagamento,
        tipo: null,
      });
    }
  }

  const entries = Array.from(fpMap.values());
  onProgress?.(0, entries.length);
  const batchSize = 50;
  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize).map((e) => ({
      gc_id: e.gc_id,
      nome: e.nome,
      tipo: e.tipo,
      ativo: true,
    }));
    const { error } = await supabase
      .from("fin_formas_pagamento" as any)
      .upsert(batch, { onConflict: "gc_id" });
    if (error) {
      console.error("Upsert formas_pagamento error:", error);
      erros += batch.length;
    } else {
      importados += batch.length;
    }
    onProgress?.(Math.min(i + batchSize, entries.length), entries.length);
  }

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_formas_pagamento",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, erros, total: entries.length, source: "payload_extraction" },
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
    .select("valor_total, nome_cliente, cliente_gc_id, data_vencimento")
    .eq("id", grupoId)
    .single();

  if (!grupo) throw new Error("Grupo não encontrado");

  const txid = `WEDO${grupoId.replace(/-/g, "").substring(0, 26).toUpperCase()}`;

  const { data: cfg } = await supabase
    .from("fin_configuracoes" as any)
    .select("chave, valor")
    .in("chave", ["inter_chave_pix", "inter_titular_conta"]);

  const configs = Object.fromEntries(
    ((cfg as any[]) ?? []).map((c: any) => [c.chave, c.valor])
  );

  const g = grupo as any;
  const payload = {
    calendario: {
      expiracao: 86400,
      ...(g.data_vencimento
        ? { dataDeVencimento: g.data_vencimento, validadeAposVencimento: 3 }
        : {}),
    },
    devedor: { nome: g.nome_cliente ?? "Cliente", cpf: "00000000000" },
    valor: { original: parseFloat(String(g.valor_total)).toFixed(2) },
    chave: configs.inter_chave_pix ?? "",
    solicitacaoPagador: `WeDo - ${g.nome_cliente ?? "Pagamento"}`,
    infoAdicionais: [{ nome: "GrupoId", valor: grupoId }],
  };

  const resp = await interRequest<any>(`/pix/v2/cob/${txid}`, "PUT", payload);

  await supabase
    .from("fin_grupos_receber" as any)
    .update({
      inter_txid: resp.txid ?? txid,
      inter_qrcode: resp.pixCopiaECola ?? resp.qrcode ?? "",
      inter_copia_cola: resp.pixCopiaECola ?? "",
      status: "aguardando_pagamento",
      updated_at: new Date().toISOString(),
    })
    .eq("id", grupoId);

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
  const resp = await interRequest<any>(`/pix/v2/cob/${txid}`, "GET");
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

export async function buscarExtratoInter(
  dataInicio: string,
  dataFim: string
): Promise<any[]> {
  const { data, error } = await supabase.functions.invoke("inter-extrato", {
    body: { dataInicio, dataFim },
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

  const inserted = result?.extrato?.inserted ?? 0;
  const total = result?.extrato?.total ?? 0;
  const chunks = result?.extrato?.chunks ?? 1;
  // Return array with meaningful length for toast
  return new Array(total).fill({ inserted, chunks });
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
  const payload = {
    valor: parseFloat(String(ag.valor)).toFixed(2),
    dataPagamento: ag.data_vencimento,
    descricao: ag.descricao,
    destinatario: {
      tipo: "CHAVE",
      chave: {
        tipo: ag.tipo_chave?.toUpperCase() ?? "CNPJ",
        chave: ag.chave_pix_destino,
      },
    },
  };

  const resp = await interRequest<any>("/banking/v2/pix", "POST", payload);
  const endToEndId = resp.endToEndId ?? resp.codigoTransacao ?? "";

  await supabase
    .from("fin_agenda_pagamentos" as any)
    .update({
      inter_pagamento_id: endToEndId,
      status: "executado",
      executado_em: new Date().toISOString(),
    })
    .eq("id", agendaId);

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "inter_pagamento_pix",
    referencia_id: agendaId,
    status: "success",
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
