import { supabase } from "@/integrations/supabase/client";
import { callGC } from "@/lib/gc-client";

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

// ─── GC Paginated Fetch ──────────────────────────────────────────────

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
  onProgress?: (current: number, total: number) => void
): Promise<GCRecebimentoRaw[]> {
  return fetchPaginatedGC<GCRecebimentoRaw>(
    "/api/recebimentos",
    { liquidado: "0" },
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
  onProgress?: (current: number, total: number) => void
): Promise<GCPagamentoRaw[]> {
  return fetchPaginatedGC<GCPagamentoRaw>(
    "/api/pagamentos",
    { liquidado: "0" },
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
        rec.gc_id as string,
        rec.gc_payload_raw as Record<string, unknown>,
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
        .eq("gc_id", rec.gc_id);

      sucesso++;
      onItemDone?.(true, rec.gc_id as string);
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
      onItemDone?.(false, rec.gc_id as string, erro);
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

// ─── Sync Service (GC → fin_* tables) ───────────────────────────────

export async function syncRecebimentosGC(
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const inicio = Date.now();
  const raws = await importarRecebimentosPendentes(onProgress);
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
  onProgress?: (atual: number, total: number) => void
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const inicio = Date.now();
  const raws = await importarPagamentosPendentes(onProgress);
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

  await supabase.from("fin_sync_log" as any).insert({
    tipo: "gc_import_pagamentos",
    status: erros === 0 ? "success" : "partial",
    resposta: { importados, atualizados, erros, total: raws.length },
    duracao_ms: Date.now() - inicio,
  });

  return { importados, atualizados, erros };
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
  const resp = await interRequest<any>(
    `/banking/v3/extrato?dataInicio=${dataInicio}&dataFim=${dataFim}`,
    "GET"
  );
  const transacoes = resp.transacoes ?? resp.data ?? [];

  for (const t of transacoes) {
    await supabase.from("fin_extrato_inter" as any).upsert(
      {
        end_to_end_id: t.endToEndId ?? t.id ?? `${t.dataHora}-${t.valor}`,
        tipo: t.tipoOperacao === "D" ? "DEBITO" : "CREDITO",
        valor: parseFloat(t.valor ?? "0"),
        data_hora: t.dataHora,
        descricao: t.descricao ?? "",
        contrapartida: t.nomeOrigem ?? t.nomeDestino ?? "",
        payload_raw: t,
      },
      { onConflict: "end_to_end_id", ignoreDuplicates: true }
    );
  }

  return transacoes;
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

  const resp = await interRequest<any>("/banking/v3/pix", "POST", payload);
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
      `/banking/v3/extrato?dataInicio=${today}&dataFim=${today}`,
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
