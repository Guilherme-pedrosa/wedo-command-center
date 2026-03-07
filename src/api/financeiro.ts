import { callGC, fetchAllGCPages } from "@/lib/gc-client";

// ─── Types ───────────────────────────────────────────────────────────

export interface GCRecebimento {
  id: string;
  codigo: string;
  descricao: string;
  valor_total: string;
  cliente_id: string;
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

export interface GCPagamentoItem {
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
  const match = descricao.match(/Ordem de serviço de nº (\d+)/i);
  return match?.[1] ?? null;
}

export function inferirTipo(descricao: string | null | undefined): "os" | "venda" | "contrato" | "outro" {
  if (!descricao) return "outro";
  if (/ordem de serviço/i.test(descricao)) return "os";
  if (/venda/i.test(descricao)) return "venda";
  if (/contrato/i.test(descricao)) return "contrato";
  return "outro";
}

// ─── Paginated Fetch ─────────────────────────────────────────────────

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
      onProgress?.(page, totalPages);
    }

    page++;
    if (page <= totalPages) await gcDelay();
  }

  return allRecords;
}

// ─── Recebimentos ────────────────────────────────────────────────────

export async function listRecebimentos(params?: {
  pagina?: number;
  liquidado?: "0" | "1";
  cliente_id?: string;
}): Promise<{ data: GCRecebimento[]; meta: { total_registros: number; total_paginas: number } }> {
  const queryParams: Record<string, string> = { limite: "100" };
  if (params?.pagina) queryParams.pagina = String(params.pagina);
  if (params?.liquidado !== undefined) queryParams.liquidado = params.liquidado;
  if (params?.cliente_id) queryParams.cliente_id = params.cliente_id;

  const res = await callGC<GCApiResponse<GCRecebimento>>({
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
  onProgress?: (current: number, total: number) => void
): Promise<GCRecebimento[]> {
  return fetchPaginatedGC<GCRecebimento>(
    "/api/recebimentos",
    { liquidado: "0" },
    onProgress
  );
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

// ─── Pagamentos ──────────────────────────────────────────────────────

export async function listPagamentos(params?: {
  pagina?: number;
  liquidado?: "0" | "1";
  fornecedor_id?: string;
}): Promise<{ data: GCPagamentoItem[]; meta: { total_registros: number; total_paginas: number } }> {
  const queryParams: Record<string, string> = { limite: "100" };
  if (params?.pagina) queryParams.pagina = String(params.pagina);
  if (params?.liquidado !== undefined) queryParams.liquidado = params.liquidado;
  if (params?.fornecedor_id) queryParams.fornecedor_id = params.fornecedor_id;

  const res = await callGC<GCApiResponse<GCPagamentoItem>>({
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
  onProgress?: (current: number, total: number) => void
): Promise<GCPagamentoItem[]> {
  return fetchPaginatedGC<GCPagamentoItem>(
    "/api/pagamentos",
    { liquidado: "0" },
    onProgress
  );
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
