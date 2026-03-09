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

// Status de OS executadas no GestãoClick
const EXECUTADO_STATUSES = [
  "EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA",
  "EXECUTADO - AGUARDANDO PAGAMENTO",
  "EXECUTADO COM NOTA EMITIDA",
  "EXECUTADO - FINANCEIRO SEPARADO",
  "EXECUTADO - CIGAM",
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

    // Parse optional page range from request body
    // Supports: { page_start, page_end } for chunked execution
    let pageStart = 1;
    let pageEnd = 999;
    let onlyExecutados = true;
    try {
      const body = await req.json();
      if (body?.page_start) pageStart = body.page_start;
      if (body?.page_end) pageEnd = body.page_end;
      if (body?.all === true) onlyExecutados = false;
    } catch {
      // No body — fetch all, filter EXECUTADO only
    }

    const allOS: any[] = [];
    let page = pageStart;
    let totalPages = pageStart; // Will be updated on first response
    let totalSkipped = 0;

    while (page <= Math.min(totalPages, pageEnd)) {
      const params = new URLSearchParams({
        limite: "100",
        pagina: String(page),
      });

      const url = `${GC_BASE_URL}/api/orcamentos?${params.toString()}`;
      const response = await rateLimitedFetch(url, { headers: gcHeaders });

      if (response.status === 401) {
        throw new Error("GC_AUTH_ERROR: Invalid credentials");
      }
      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GC API error ${response.status}: ${text}`);
      }

      const data = await response.json();
      const gcData = data?.data || data;
      const records = gcData?.data || [];
      const meta = gcData?.meta || data?.meta || {};

      // Filter for EXECUTADO statuses client-side (GC ignores nome_situacao filter)
      for (const rec of records) {
        const situacao = rec.nome_situacao || "";
        if (!onlyExecutados || EXECUTADO_STATUSES.some(s => situacao.toUpperCase().includes(s.toUpperCase().split(" ")[0]) && situacao.toUpperCase().startsWith("EXECUTADO"))) {
          allOS.push(rec);
        } else {
          totalSkipped++;
        }
      }

      totalPages = meta?.total_paginas || 1;
      console.log(`[sync-os] Page ${page}/${totalPages} — ${records.length} fetched, ${allOS.length} executados so far`);
      page++;
    }

    console.log(`[sync-os] Total EXECUTADO: ${allOS.length}, skipped: ${totalSkipped}`);

    // Upsert into os_index
    let upserted = 0;
    let errors = 0;
    const statusCounts: Record<string, number> = {};

    for (const os of allOS) {
      const osId = String(os.id || "");
      const osCodigo = String(os.codigo || "");
      const situacao = os.nome_situacao || "unknown";

      statusCounts[situacao] = (statusCounts[situacao] || 0) + 1;

      if (!osId || !osCodigo) {
        errors++;
        continue;
      }

      const valorTotal = parseFloat(os.valor_total || "0") || null;
      const valorServicos = parseFloat(os.valor_servicos || "0") || null;
      const valorProdutos = parseFloat(os.valor_produtos || "0") || null;

      let dataSaida: string | null = null;
      const modificadoEm = os.modificado_em || os.data || null;
      if (modificadoEm) {
        const match = modificadoEm.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) dataSaida = match[1];
      }

      const record = {
        os_id: osId,
        os_codigo: osCodigo,
        orc_codigo: osCodigo,
        todos_orcs: null,
        nome_cliente: os.nome_cliente || null,
        nome_situacao: situacao,
        data_saida: dataSaida,
        valor_total: valorTotal,
        valor_servicos: valorServicos,
        valor_pecas: valorProdutos,
        numero_os: osCodigo,
        built_at: new Date().toISOString(),
      };

      const { error: upsertErr } = await supabase
        .from("os_index")
        .upsert(record, { onConflict: "os_id,orc_codigo" });

      if (upsertErr) {
        console.error(`[sync-os] Upsert error OS ${osCodigo}:`, upsertErr.message);
        errors++;
      } else {
        upserted++;
      }
    }

    // Update os_index_meta
    await supabase.from("os_index_meta").upsert({
      id: 1,
      status: "done",
      total_os: allOS.length,
      built_at: new Date().toISOString(),
    });

    const duration = Date.now() - startTime;
    await supabase.from("sync_log").insert({
      tipo: "sync-os",
      status: errors > 0 ? "partial" : "ok",
      payload: { pageStart, pageEnd, totalPages, total_fetched: allOS.length, totalSkipped, upserted, errors, statusCounts },
      duracao_ms: duration,
    });

    const result = {
      success: true,
      total_fetched: allOS.length,
      totalSkipped,
      upserted,
      errors,
      statusCounts,
      pages_processed: `${pageStart}-${Math.min(page - 1, pageEnd)}/${totalPages}`,
      duration_ms: duration,
    };

    console.log(`[sync-os] Done:`, result);

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = (error as Error).message;
    console.error("[sync-os] Fatal error:", errorMsg);

    try {
      const supabase = createClient(
        Deno.env.get("SUPABASE_URL")!,
        Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
      );
      await supabase.from("sync_log").insert({
        tipo: "sync-os",
        status: "erro",
        erro: errorMsg,
        duracao_ms: duration,
      });
    } catch { /* ignore */ }

    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
