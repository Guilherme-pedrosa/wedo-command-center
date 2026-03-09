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

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
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

    // Chunked pagination: { page_start (default 1), page_end (default +4) }
    let pageStart = 1;
    let pageEnd = 5; // Process 5 pages per invocation (~2s each = ~10s)
    try {
      const body = await req.json();
      if (body?.page_start) pageStart = body.page_start;
      if (body?.page_end) pageEnd = body.page_end;
    } catch { /* no body */ }

    let page = pageStart;
    let totalPages = 999;
    let totalFetched = 0;
    let upserted = 0;
    let skipped = 0;
    let errors = 0;
    const statusCounts: Record<string, number> = {};

    while (page <= Math.min(totalPages, pageEnd)) {
      const params = new URLSearchParams({ limite: "100", pagina: String(page) });
      const url = `${GC_BASE_URL}/api/ordens_servicos?${params.toString()}`;
      const response = await rateLimitedFetch(url, { headers: gcHeaders });

      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GC API error ${response.status}: ${text}`);
      }

      const data = await response.json();
      const records = Array.isArray(data?.data) ? data.data : [];
      const meta = data?.meta || {};
      totalPages = meta?.total_paginas || 1;

      // Process each record: only upsert EXECUTADO ones
      for (const os of records) {
        totalFetched++;
        const situacao = (os.nome_situacao || "").toUpperCase().trim();

        if (!situacao.startsWith("EXECUTADO")) {
          skipped++;
          continue;
        }

        const nomeSituacao = os.nome_situacao || "";
        statusCounts[nomeSituacao] = (statusCounts[nomeSituacao] || 0) + 1;

        const osId = String(os.id || "");
        const osCodigo = String(os.codigo || "");
        if (!osId || !osCodigo) { errors++; continue; }

        const valorTotal = parseFloat(os.valor_total || "0") || null;
        const valorServicos = parseFloat(os.valor_servicos || "0") || null;
        const valorProdutos = parseFloat(os.valor_produtos || "0") || null;

        let dataSaida: string | null = null;
        // Use data_saida from OS; fallback to modificado_em or data_entrada
        const rawDataSaida = os.data_saida || "";
        if (rawDataSaida) {
          const match = rawDataSaida.match(/^(\d{4}-\d{2}-\d{2})/);
          if (match) dataSaida = match[1];
        }
        if (!dataSaida) {
          const fallback = os.modificado_em || os.data_entrada || null;
          if (fallback) {
            const match = fallback.match(/^(\d{4}-\d{2}-\d{2})/);
            if (match) dataSaida = match[1];
          }
        }

        const { error: upsertErr } = await supabase
          .from("os_index")
          .upsert({
            os_id: osId,
            os_codigo: osCodigo,
            orc_codigo: osCodigo,
            nome_cliente: os.nome_cliente || null,
            nome_situacao: nomeSituacao,
            data_saida: dataSaida,
            valor_total: valorTotal,
            valor_servicos: valorServicos,
            valor_pecas: valorProdutos,
            numero_os: osCodigo,
            built_at: new Date().toISOString(),
          }, { onConflict: "os_id,orc_codigo" });

        if (upsertErr) { errors++; } else { upserted++; }
      }

      console.log(`[sync-os] Page ${page}/${totalPages} — ${records.length} records, ${upserted} upserted so far`);
      page++;
    }

    const hasMore = page <= totalPages;
    const duration = Date.now() - startTime;

    // Update meta only when we've processed all pages
    if (!hasMore) {
      await supabase.from("os_index_meta").upsert({
        id: 1, status: "done", total_os: upserted, built_at: new Date().toISOString(),
      });
    }

    await supabase.from("sync_log").insert({
      tipo: "sync-os",
      status: errors > 0 ? "partial" : "ok",
      payload: { pageStart, pageEnd: Math.min(page - 1, pageEnd), totalPages, totalFetched, upserted, skipped, errors, statusCounts },
      duracao_ms: duration,
    });

    return new Response(JSON.stringify({
      success: true,
      pages_processed: `${pageStart}-${Math.min(page - 1, pageEnd)}/${totalPages}`,
      has_more: hasMore,
      next_page_start: hasMore ? page : null,
      totalFetched, upserted, skipped, errors, statusCounts, duration_ms: duration,
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
