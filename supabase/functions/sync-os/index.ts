import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
let lastCallTime = 0;

// All EXECUTADO situation IDs from GestãoClick
// Deslocamento service to exclude from technician metrics
const DESLOCAMENTO_SERVICO_CODIGO = "2094836555801";
const DESLOCAMENTO_SERVICO_ID = "66773231";

const EXECUTADO_SITUACAO_IDS = [
  "7261986",  // EXECUTADO POR CONTRATO
  "7116099",  // EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA
  "7063724",  // EXECUTADO - AGUARDANDO PAGAMENTO
  "7124107",  // EXECUTADO COM NOTA EMITIDA
  "7438044",  // EXECUTADO EM GARANTIA
  "7535001",  // EXECUTADO -PATRIMÔNIO
  "7720756",  // EXECUTADO - FINANCEIRO SEPARADO
  "8677491",  // EXECUTADO - CIGAM
  "8760417",  // EXECUTADO - LIBERADO P/ FATURAMENTO (CIGAM SEM BAIXA ESTOQ)
  "8889036",  // EXECUTADO - FECHADO CHAMADO
];

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
}

function computeDeslocamento(os: Record<string, unknown>): number {
  const servicos = os.servicos as Array<{ servico?: { codigo?: string; id?: string; servico_id?: string; valor_total?: string } }> | undefined;
  if (!Array.isArray(servicos)) return 0;
  let total = 0;
  for (const s of servicos) {
    const srv = s?.servico;
    if (!srv) continue;
    const srvId = String(srv.servico_id || srv.id || "");
    const srvCodigo = String(srv.codigo || "");
    if (srvCodigo === DESLOCAMENTO_SERVICO_CODIGO || srvId === DESLOCAMENTO_SERVICO_ID) {
      total += parseFloat(String(srv.valor_total || "0")) || 0;
    }
  }
  return total;
}

function computeValorFromPayload(os: Record<string, unknown>): number {
  // Try pagamentos array first (most reliable — represents actual invoiced value)
  const pagamentos = os.pagamentos as Array<{ pagamento?: { valor?: string } }> | undefined;
  if (Array.isArray(pagamentos) && pagamentos.length > 0) {
    let sum = 0;
    for (const p of pagamentos) {
      sum += parseFloat(String(p?.pagamento?.valor || "0")) || 0;
    }
    if (sum > 0) return sum;
  }

  // Fallback: sum servicos + produtos
  let total = 0;
  const servicos = os.servicos as Array<{ servico?: { valor_total?: string } }> | undefined;
  if (Array.isArray(servicos)) {
    for (const s of servicos) {
      total += parseFloat(String(s?.servico?.valor_total || "0")) || 0;
    }
  }
  const produtos = os.produtos as Array<{ produto?: { valor_total?: string } }> | undefined;
  if (Array.isArray(produtos)) {
    for (const p of produtos) {
      total += parseFloat(String(p?.produto?.valor_total || "0")) || 0;
    }
  }
  return total;
}

function computeValorPecasCusto(
  os: Record<string, unknown>,
  custoMap: Map<string, number>,
  custoTributosMap: Map<string, number>,
): number {
  const produtos = os.produtos as Array<{ produto?: Record<string, any> }> | undefined;
  if (!Array.isArray(produtos)) return 0;
  let total = 0;
  for (const p of produtos) {
    const prod = p?.produto;
    if (!prod) continue;
    const qtd = parseFloat(String(prod.quantidade || "0")) || 0;
    if (qtd === 0) continue;
    const prodId = String(prod.produto_id || prod.id || "");
    // PRIORIDADE 1: custo validado por NF (fin_produto_tributos.custo_efetivo_unit)
    let custoUnit = 0;
    if (prodId && custoTributosMap.has(prodId)) {
      custoUnit = custoTributosMap.get(prodId) || 0;
    }
    // PRIORIDADE 2: custo inline no payload da OS (se GC enviar)
    if (custoUnit === 0) {
      custoUnit = parseFloat(String(prod.valor_custo || "0")) || 0;
    }
    // PRIORIDADE 3: cache gc_produtos_cache (custo atual)
    if (custoUnit === 0 && prodId && custoMap.has(prodId)) {
      custoUnit = custoMap.get(prodId) || 0;
    }
    total += qtd * custoUnit;
  }
  return total;
}

function mapOsRecord(os: Record<string, unknown>, custoMap: Map<string, number>) {
  const osId = String(os.id || "");
  const osCodigo = String(os.codigo || "");
  if (!osId || !osCodigo) return null;

  let valorTotal = parseFloat(String(os.valor_total || "0")) || 0;
  // GC sometimes returns valor_total=0 even when pagamentos exist — compute from nested arrays
  if (valorTotal === 0) {
    valorTotal = computeValorFromPayload(os);
  }

  const valorServicos = parseFloat(String(os.valor_servicos || "0")) || 0;
  const valorProdutos = parseFloat(String(os.valor_produtos || "0")) || 0;
  const valorPecasCusto = computeValorPecasCusto(os, custoMap);

  let dataSaida: string | null = null;
  const rawDataSaida = String(os.data_saida || "");
  if (rawDataSaida) {
    const match = rawDataSaida.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) dataSaida = match[1];
  }
  // Resultados operacionais must use the real execution خروج date only.
  // Falling back to modification/entry dates pulls OS into the wrong month
  // and inflates Execução + Coifas vs. the GestãoClick report.

  const valorDeslocamento = computeDeslocamento(os);

  return {
    os_id: osId,
    os_codigo: osCodigo,
    orc_codigo: osCodigo,
    nome_cliente: String(os.nome_cliente || "") || null,
    nome_situacao: String(os.nome_situacao || ""),
    nome_vendedor: String(os.nome_vendedor || "") || null,
    data_saida: dataSaida,
    valor_total: valorTotal || null,
    valor_servicos: valorServicos || null,
    valor_pecas: valorProdutos || null,
    valor_pecas_custo: valorPecasCusto || null,
    valor_deslocamento: valorDeslocamento || 0,
    numero_os: osCodigo,
    built_at: new Date().toISOString(),
  };
}


serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(
        JSON.stringify({ error: "GC credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // Accept optional params: situacao_ids, page_start (for resuming large batches)
    let situacaoIds = EXECUTADO_SITUACAO_IDS;
    let pageStart = 1;
    try {
      const body = await req.json();
      if (body?.situacao_ids && Array.isArray(body.situacao_ids)) {
        situacaoIds = body.situacao_ids;
      }
      if (body?.page_start) pageStart = body.page_start;
    } catch { /* no body */ }

    let totalFetched = 0;
    let upserted = 0;
    let errors = 0;
    const statusCounts: Record<string, number> = {};

    // Pre-carrega mapa produto_gc_id -> valor_custo (fallback quando GC não envia valor_custo no payload da OS)
    const custoMap = new Map<string, number>();
    {
      let from = 0;
      const PAGE = 1000;
      while (true) {
        const { data: prods, error: prodErr } = await supabase
          .from("gc_produtos_cache")
          .select("produto_gc_id, valor_custo")
          .not("valor_custo", "is", null)
          .range(from, from + PAGE - 1);
        if (prodErr) { console.warn("[sync-os] falha ao carregar gc_produtos_cache:", prodErr.message); break; }
        if (!prods || prods.length === 0) break;
        for (const p of prods as any[]) {
          if (p.produto_gc_id) custoMap.set(String(p.produto_gc_id), Number(p.valor_custo) || 0);
        }
        if (prods.length < PAGE) break;
        from += PAGE;
      }
      console.log(`[sync-os] custoMap carregado: ${custoMap.size} produtos`);
    }

    for (const sitId of situacaoIds) {
      let page = pageStart;
      let totalPages = 999;

      while (page <= totalPages) {
        const params = new URLSearchParams({
          limite: "100",
          pagina: String(page),
          situacao_id: sitId,
        });
        const url = `${GC_BASE_URL}/api/ordens_servicos?${params.toString()}`;
        const response = await rateLimitedFetch(url, { headers: gcHeaders });

        if (response.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!response.ok) {
          console.error(`[sync-os] GC API error for situacao_id=${sitId}: ${response.status}`);
          errors++;
          break;
        }

        const data = await response.json();
        const records = Array.isArray(data?.data) ? data.data : [];
        const meta = data?.meta || {};
        totalPages = meta?.total_paginas || 1;

        // Batch map records
        const batch = [];
        const allOsIds: string[] = [];
        for (const os of records) {
          totalFetched++;
          const nomeSituacao = String(os.nome_situacao || "");
          statusCounts[nomeSituacao] = (statusCounts[nomeSituacao] || 0) + 1;

          const mapped = mapOsRecord(os, custoMap);

          if (mapped) {
            batch.push(mapped);
            allOsIds.push(String(os.id));
          } else {
            errors++;
          }
        }

        // Batch upsert (up to 100 at once)
        // Note: individual detail fetching (for deslocamento) is handled by sync-os-details function
        if (batch.length > 0) {
          const { error: upsertErr, count } = await supabase
            .from("os_index")
            .upsert(batch, { onConflict: "os_id,orc_codigo", count: "exact" });

          if (upsertErr) {
            console.error(`[sync-os] Batch upsert error: ${upsertErr.message}`);
            errors += batch.length;
          } else {
            upserted += count || batch.length;
          }
        }

        console.log(`[sync-os] sit=${sitId} page ${page}/${totalPages} — ${records.length} recs, ${upserted} total`);
        page++;
      }
      // Reset page_start for subsequent situacao_ids
      pageStart = 1;
    }

    const duration = Date.now() - startTime;

    await supabase.from("os_index_meta").upsert({
      id: 1, status: "done", total_os: upserted, built_at: new Date().toISOString(),
    });

    await supabase.from("sync_log").insert({
      tipo: "sync-os",
      status: errors > 0 ? "partial" : "ok",
      payload: { totalFetched, upserted, errors, statusCounts, situacaoCount: situacaoIds.length },
      duracao_ms: duration,
    });

    return new Response(JSON.stringify({
      success: true,
      totalFetched, upserted, errors, statusCounts, duration_ms: duration,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = (error as Error).message;
    console.error("[sync-os] Fatal error:", errorMsg);
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("sync_log").insert({ tipo: "sync-os", status: "erro", erro: errorMsg, duracao_ms: duration });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
