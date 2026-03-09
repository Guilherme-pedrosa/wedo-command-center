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

function mapOsRecord(os: Record<string, unknown>) {
  const osId = String(os.id || "");
  const osCodigo = String(os.codigo || "");
  if (!osId || !osCodigo) return null;

  const valorTotal = parseFloat(String(os.valor_total || "0")) || null;
  const valorServicos = parseFloat(String(os.valor_servicos || "0")) || null;
  const valorProdutos = parseFloat(String(os.valor_produtos || "0")) || null;

  let dataSaida: string | null = null;
  const rawDataSaida = String(os.data_saida || "");
  if (rawDataSaida) {
    const match = rawDataSaida.match(/^(\d{4}-\d{2}-\d{2})/);
    if (match) dataSaida = match[1];
  }
  if (!dataSaida) {
    const fallback = String(os.modificado_em || os.data_entrada || "");
    if (fallback) {
      const match = fallback.match(/^(\d{4}-\d{2}-\d{2})/);
      if (match) dataSaida = match[1];
    }
  }

  return {
    os_id: osId,
    os_codigo: osCodigo,
    orc_codigo: osCodigo,
    nome_cliente: String(os.nome_cliente || "") || null,
    nome_situacao: String(os.nome_situacao || ""),
    data_saida: dataSaida,
    valor_total: valorTotal,
    valor_servicos: valorServicos,
    valor_pecas: valorProdutos,
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
        for (const os of records) {
          totalFetched++;
          const nomeSituacao = String(os.nome_situacao || "");
          statusCounts[nomeSituacao] = (statusCounts[nomeSituacao] || 0) + 1;

          const mapped = mapOsRecord(os);
          if (mapped) batch.push(mapped);
          else errors++;
        }

        // Batch upsert (up to 100 at once)
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
