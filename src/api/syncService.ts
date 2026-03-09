import { supabase } from "@/integrations/supabase/client";
import {
  importarRecebimentosPendentes,
  importarPagamentosPendentes,
  baixarRecebimentoGC,
  baixarPagamentoGC,
  extrairOsCodigo,
  inferirTipo,
  gcDelay,
  type GCRecebimento,
  type GCPagamentoItem,
} from "@/api/financeiro";

// ─── Sync Log Helper ─────────────────────────────────────────────────

async function logSync(params: {
  tipo: string;
  referencia_id?: string;
  referencia_tipo?: string;
  status: string;
  payload?: unknown;
  resposta?: unknown;
  erro?: string;
  duracao_ms?: number;
}) {
  await supabase.from("sync_log").insert({
    tipo: params.tipo,
    referencia_id: params.referencia_id ?? null,
    referencia_tipo: params.referencia_tipo ?? null,
    status: params.status,
    payload: params.payload as any,
    resposta: params.resposta as any,
    erro: params.erro ?? null,
    duracao_ms: params.duracao_ms ?? null,
  });
}

// ─── Sync Recebimentos ───────────────────────────────────────────────

export async function syncRecebimentos(
  onProgress?: (n: number, t: number) => void
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const startTime = Date.now();
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  try {
    const items = await importarRecebimentosPendentes(onProgress);

    // Batch upsert
    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50).map((item: GCRecebimento) => ({
        gc_id: String(item.id),
        gc_codigo: item.codigo || null,
        descricao: item.descricao || null,
        os_codigo: extrairOsCodigo(item.descricao),
        tipo: inferirTipo(item.descricao),
        valor: parseFloat(item.valor_total) || 0,
        cliente_id: item.cliente_id || null,
        nome_cliente: item.nome_cliente || null,
        plano_contas_id: item.plano_contas_id || null,
        nome_plano_conta: item.nome_plano_conta || null,
        conta_bancaria_id: item.conta_bancaria_id || null,
        nome_conta_bancaria: item.nome_conta_bancaria || null,
        forma_pagamento_id: item.forma_pagamento_id || null,
        nome_forma_pagamento: item.nome_forma_pagamento || null,
        centro_custo_id: item.centro_custo_id || null,
        nome_centro_custo: item.nome_centro_custo || null,
        data_vencimento: item.data_vencimento || null,
        data_competencia: item.data_competencia || null,
        data_liquidacao: item.data_liquidacao || null,
        liquidado: item.liquidado === "1",
        gc_payload_raw: item as any,
        last_synced_at: new Date().toISOString(),
      }));

      const { error, count } = await supabase
        .from("gc_recebimentos")
        .upsert(batch, { onConflict: "gc_id" });

      if (error) {
        erros += batch.length;
        console.error("Upsert error:", error);
      } else {
        importados += batch.length;
      }
    }

    await logSync({
      tipo: "gc_import",
      referencia_tipo: "recebimentos",
      status: erros > 0 ? "partial" : "success",
      payload: { total_fetched: items.length },
      resposta: { importados, atualizados, erros },
      duracao_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSync({
      tipo: "gc_import",
      referencia_tipo: "recebimentos",
      status: "error",
      erro: msg,
      duracao_ms: Date.now() - startTime,
    });
    throw err;
  }

  return { importados, atualizados, erros };
}

// ─── Sync Pagamentos ─────────────────────────────────────────────────

export async function syncPagamentos(
  onProgress?: (n: number, t: number) => void
): Promise<{ importados: number; atualizados: number; erros: number }> {
  const startTime = Date.now();
  let importados = 0;
  let atualizados = 0;
  let erros = 0;

  try {
    const items = await importarPagamentosPendentes(onProgress);

    for (let i = 0; i < items.length; i += 50) {
      const batch = items.slice(i, i + 50).map((item: GCPagamentoItem) => ({
        gc_id: String(item.id),
        gc_codigo: item.codigo || null,
        descricao: item.descricao || null,
        valor: parseFloat(item.valor_total) || 0,
        fornecedor_id: item.fornecedor_id || null,
        nome_fornecedor: item.nome_fornecedor || null,
        plano_contas_id: item.plano_contas_id || null,
        nome_plano_conta: item.nome_plano_conta || null,
        conta_bancaria_id: item.conta_bancaria_id || null,
        nome_conta_bancaria: item.nome_conta_bancaria || null,
        forma_pagamento_id: item.forma_pagamento_id || null,
        nome_forma_pagamento: item.nome_forma_pagamento || null,
        centro_custo_id: item.centro_custo_id || null,
        nome_centro_custo: item.nome_centro_custo || null,
        data_vencimento: item.data_vencimento || null,
        data_competencia: item.data_competencia || null,
        data_liquidacao: item.data_liquidacao || null,
        liquidado: item.liquidado === "1",
        gc_payload_raw: item as any,
        last_synced_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from("gc_pagamentos")
        .upsert(batch, { onConflict: "gc_id" });

      if (error) {
        erros += batch.length;
        console.error("Upsert error:", error);
      } else {
        importados += batch.length;
      }
    }

    await logSync({
      tipo: "gc_import",
      referencia_tipo: "pagamentos",
      status: erros > 0 ? "partial" : "success",
      payload: { total_fetched: items.length },
      resposta: { importados, atualizados, erros },
      duracao_ms: Date.now() - startTime,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logSync({
      tipo: "gc_import",
      referencia_tipo: "pagamentos",
      status: "error",
      erro: msg,
      duracao_ms: Date.now() - startTime,
    });
    throw err;
  }

  return { importados, atualizados, erros };
}

// ─── Baixar Grupo (Recebimentos) ─────────────────────────────────────

export async function baixarGrupo(
  grupoId: string,
  dataLiquidacao?: string
): Promise<{ sucesso: number; falha: number; itens: Array<{ id: string; ok: boolean; erro?: string }> }> {
  const startTime = Date.now();
  const resultados: Array<{ id: string; ok: boolean; erro?: string }> = [];

  // Fetch grupo_itens not yet settled
  const { data: itens, error: fetchError } = await supabase
    .from("grupo_itens")
    .select("*")
    .eq("grupo_id", grupoId)
    .eq("baixado_gc", false);

  if (fetchError) throw new Error(fetchError.message);
  if (!itens || itens.length === 0) return { sucesso: 0, falha: 0, itens: [] };

  for (const item of itens) {
    try {
      // Get the full gc_recebimento with payload
      const { data: rec } = await supabase
        .from("gc_recebimentos")
        .select("gc_id, gc_payload_raw, baixado_gc:liquidado")
        .eq("gc_id", item.gc_recebimento_id)
        .single();

      if (!rec) throw new Error("Recebimento não encontrado");
      if (rec.baixado_gc) throw new Error("Já liquidado");
      if (!rec.gc_payload_raw) throw new Error("Payload original ausente");

      const res = await baixarRecebimentoGC(
        rec.gc_id,
        rec.gc_payload_raw as Record<string, unknown>,
        dataLiquidacao
      );

      // Update grupo_itens
      await supabase
        .from("grupo_itens")
        .update({ baixado_gc: true, baixado_gc_em: new Date().toISOString(), tentativas: (item.tentativas || 0) + 1 })
        .eq("id", item.id);

      // Update gc_recebimentos
      await supabase
        .from("gc_recebimentos")
        .update({ liquidado: true, data_liquidacao: dataLiquidacao || new Date().toISOString().split("T")[0] })
        .eq("gc_id", item.gc_recebimento_id);

      await logSync({
        tipo: "gc_baixa",
        referencia_id: item.gc_recebimento_id,
        referencia_tipo: "recebimento",
        status: "success",
        resposta: res.data as any,
        duracao_ms: res.duration_ms,
      });

      resultados.push({ id: item.id, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await supabase
        .from("grupo_itens")
        .update({ tentativas: (item.tentativas || 0) + 1, erro_baixa: msg })
        .eq("id", item.id);

      await logSync({
        tipo: "gc_baixa",
        referencia_id: item.gc_recebimento_id,
        referencia_tipo: "recebimento",
        status: "error",
        erro: msg,
        duracao_ms: Date.now() - startTime,
      });

      resultados.push({ id: item.id, ok: false, erro: msg });
    }

    await gcDelay();
  }

  const sucesso = resultados.filter((r) => r.ok).length;
  const falha = resultados.filter((r) => !r.ok).length;

  // Update grupo status
  const newStatus = falha === 0 ? "pago" : sucesso > 0 ? "pago_parcial" : "aberto";
  await supabase
    .from("grupos_financeiros")
    .update({
      status: newStatus,
      baixado_gc: falha === 0,
      baixado_gc_em: falha === 0 ? new Date().toISOString() : null,
    })
    .eq("id", grupoId);

  return { sucesso, falha, itens: resultados };
}

// ─── Baixar Grupo Pagamento ──────────────────────────────────────────

export async function baixarGrupoPagamento(
  grupoId: string,
  dataLiquidacao?: string
): Promise<{ sucesso: number; falha: number; itens: Array<{ id: string; ok: boolean; erro?: string }> }> {
  const resultados: Array<{ id: string; ok: boolean; erro?: string }> = [];

  const { data: itens, error: fetchError } = await supabase
    .from("grupo_pagamento_itens" as any)
    .select("*")
    .eq("grupo_id", grupoId)
    .eq("baixado_gc", false);

  if (fetchError) throw new Error(fetchError.message);
  if (!itens || (itens as any[]).length === 0) return { sucesso: 0, falha: 0, itens: [] };

  for (const item of itens as any[]) {
    try {
      const { data: pag } = await supabase
        .from("gc_pagamentos")
        .select("gc_id, gc_payload_raw, liquidado")
        .eq("gc_id", item.gc_pagamento_id)
        .single();

      if (!pag) throw new Error("Pagamento não encontrado");
      if (pag.liquidado) throw new Error("Já liquidado");
      if (!pag.gc_payload_raw) throw new Error("Payload original ausente");

      await baixarPagamentoGC(
        pag.gc_id,
        pag.gc_payload_raw as Record<string, unknown>,
        dataLiquidacao
      );

      await supabase
        .from("grupo_pagamento_itens" as any)
        .update({ baixado_gc: true, baixado_gc_em: new Date().toISOString(), tentativas: (item.tentativas || 0) + 1 } as any)
        .eq("id", item.id);

      resultados.push({ id: item.id, ok: true });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      resultados.push({ id: item.id, ok: false, erro: msg });
    }

    await gcDelay();
  }

  const sucesso = resultados.filter((r) => r.ok).length;
  const falha = resultados.filter((r) => !r.ok).length;

  const newStatus = falha === 0 ? "pago" : sucesso > 0 ? "pago_parcial" : "aberto";
  await supabase
    .from("grupos_pagamentos" as any)
    .update({ status: newStatus, baixado_gc: falha === 0 } as any)
    .eq("id", grupoId);

  return { sucesso, falha, itens: resultados };
}

// ─── Inter PIX (optional) ────────────────────────────────────────────

export async function gerarCobrancaPix(grupoId: string): Promise<{
  txid: string; qrcode: string; copiaCola: string;
}> {
  const { data: grupo } = await supabase
    .from("grupos_financeiros")
    .select("*")
    .eq("id", grupoId)
    .single();

  if (!grupo) throw new Error("Grupo não encontrado");

  const txid = "WEDO" + grupoId.replace(/-/g, "").slice(0, 26);

  const res = await supabase.functions.invoke("inter-proxy", {
    body: {
      path: "/pix/v2/cob",
      method: "POST",
      payload: {
        calendario: { expiracao: 86400 },
        valor: { original: grupo.valor_total.toFixed(2) },
        chave: "", // filled by edge function from config
        txid,
        infoAdicionais: [{ nome: "Grupo", valor: grupo.nome }],
      },
    },
  });

  if (res.error) throw new Error(res.error.message);

  const pixData = res.data;
  const qrcode = pixData?.data?.pixCopiaECola || pixData?.data?.qrcode || "";
  const copiaCola = pixData?.data?.pixCopiaECola || "";

  await supabase
    .from("grupos_financeiros")
    .update({
      inter_txid: txid,
      inter_qrcode: qrcode,
      inter_copia_cola: copiaCola,
      status: "aguardando_pagamento",
    })
    .eq("id", grupoId);

  await logSync({
    tipo: "inter_cobranca",
    referencia_id: grupoId,
    referencia_tipo: "grupo",
    status: "success",
    resposta: pixData as any,
  });

  return { txid, qrcode, copiaCola };
}

export async function verificarCobrancaPix(txid: string): Promise<{
  status: string; pago: boolean; valor?: number; pagadorNome?: string;
}> {
  const res = await supabase.functions.invoke("inter-proxy", {
    body: { path: `/pix/v2/cob/${txid}`, method: "GET" },
  });

  if (res.error) throw new Error(res.error.message);

  const cobData = res.data?.data;
  const status = cobData?.status || "UNKNOWN";
  const pago = status === "CONCLUIDA";

  return {
    status,
    pago,
    valor: pago ? parseFloat(cobData?.valor?.original) : undefined,
    pagadorNome: cobData?.pagador?.nome,
  };
}

export async function executarPagamentoPix(pagamentoId: string): Promise<void> {
  const { data: pagamento } = await supabase
    .from("pagamentos_programados")
    .select("*")
    .eq("id", pagamentoId)
    .single();

  if (!pagamento) throw new Error("Pagamento não encontrado");

  const res = await supabase.functions.invoke("inter-proxy", {
    body: {
      path: "/banking/v3/pix",
      method: "POST",
      payload: {
        valor: pagamento.valor,
        chaveDestino: pagamento.chave_pix,
        descricao: pagamento.descricao,
      },
    },
  });

  if (res.error) throw new Error(res.error.message);

  await supabase
    .from("pagamentos_programados")
    .update({
      status: "executado",
      inter_pagamento_id: res.data?.data?.endToEndId || null,
    })
    .eq("id", pagamentoId);

  await logSync({
    tipo: "inter_pix",
    referencia_id: pagamentoId,
    referencia_tipo: "pagamento_programado",
    status: "success",
    resposta: res.data as any,
  });
}

// ─── Sync Vendas (GC → gc_vendas) ──────────────────────────────────

export async function syncVendas(
  dataInicio?: string,
  dataFim?: string
): Promise<{ totalFetched: number; upserted: number; errors: number }> {
  const startTime = Date.now();
  try {
    const { data, error } = await supabase.functions.invoke("sync-vendas", {
      body: {
        ...(dataInicio && { data_inicio: dataInicio }),
        ...(dataFim && { data_fim: dataFim }),
      },
    });

    if (error) throw error;
    return {
      totalFetched: data?.totalFetched ?? 0,
      upserted: data?.upserted ?? 0,
      errors: data?.errors ?? 0,
    };
  } catch (err: any) {
    await logSync({
      tipo: "sync-vendas",
      status: "erro",
      erro: err.message,
      duracao_ms: Date.now() - startTime,
    });
    throw err;
  }
}
