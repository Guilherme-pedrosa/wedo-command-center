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

    // Parse optional filters from request body
    let filters: { data_inicio?: string; data_fim?: string; situacao?: string } = {};
    try {
      const body = await req.json();
      filters = body || {};
    } catch {
      // No body, sync all
    }

    const allOS: any[] = [];
    let page = 1;
    let totalPages = 1;

    // Paginate through GC — endpoint: /api/orcamentos (GC usa orçamentos para OS)
    while (page <= totalPages) {
      const params = new URLSearchParams({
        limite: "100",
        pagina: String(page),
      });

      if (filters.data_inicio) params.set("data_inicio", filters.data_inicio);
      if (filters.data_fim) params.set("data_fim", filters.data_fim);
      if (filters.situacao) params.set("situacao", filters.situacao);

      const url = `${GC_BASE_URL}/api/orcamentos?${params.toString()}`;
      const response = await rateLimitedFetch(url, { headers: gcHeaders });

      if (response.status === 401) {
        throw new Error("GC_AUTH_ERROR: Invalid credentials");
      }
      if (response.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue; // retry same page
      }
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`GC API error ${response.status}: ${text}`);
      }

      const data = await response.json();
      const records = data?.data || [];
      allOS.push(...records);

      totalPages = data?.meta?.total_paginas || 1;
      console.log(`[sync-os] Page ${page}/${totalPages} — ${records.length} records fetched`);
      page++;
    }

    console.log(`[sync-os] Total records fetched from GC: ${allOS.length}`);

    // Upsert into os_index
    let upserted = 0;
    let errors = 0;

    for (const os of allOS) {
      // ── Mapeamento confirmado do JSON real do GC ──
      // os.id          = ID interno GC (ex: "355094680")
      // os.codigo      = Número da OS/orçamento (ex: "4973")
      // os.nome_cliente = nome do cliente ✅
      // os.nome_situacao = status ✅
      // os.valor_total  = valor total ✅ (string)
      // os.valor_servicos = valor serviços ✅ (string)
      // os.valor_produtos = valor peças/produtos ✅ (NÃO valor_pecas)
      // os.modificado_em = última modificação (ex: "2026-03-09 13:45:10")
      // os.data         = data do orçamento (ex: "2026-03-09")
      // NÃO existe campo data_saida — usar modificado_em como proxy

      const osId = String(os.id || "");
      const osCodigo = String(os.codigo || "");

      if (!osId || !osCodigo) {
        console.warn(`[sync-os] Skipping record without id/codigo`);
        errors++;
        continue;
      }

      // Valores monetários (GC retorna como string)
      const valorTotal = parseFloat(os.valor_total || "0") || null;
      const valorServicos = parseFloat(os.valor_servicos || "0") || null;
      const valorProdutos = parseFloat(os.valor_produtos || "0") || null;

      // data_saida: usar modificado_em como proxy (data da última mudança de status)
      // Formato GC: "2026-03-09 13:45:10" → extrair só a data
      let dataSaida: string | null = null;
      const modificadoEm = os.modificado_em || os.data || null;
      if (modificadoEm) {
        // "2026-03-09 13:45:10" → "2026-03-09"
        const match = modificadoEm.match(/^(\d{4}-\d{2}-\d{2})/);
        if (match) {
          dataSaida = match[1];
        }
      }

      const record = {
        os_id: osId,
        os_codigo: osCodigo,
        orc_codigo: osCodigo, // No GC, cada orçamento é um registro único
        todos_orcs: null,
        nome_cliente: os.nome_cliente || null,
        nome_situacao: os.nome_situacao || null,
        data_saida: dataSaida,
        valor_total: valorTotal,
        valor_servicos: valorServicos,
        valor_pecas: valorProdutos, // GC usa "valor_produtos"
        numero_os: osCodigo,
        built_at: new Date().toISOString(),
      };

      const { error: upsertErr } = await supabase
        .from("os_index")
        .upsert(record, { onConflict: "os_id,orc_codigo" });

      if (upsertErr) {
        console.error(`[sync-os] Upsert error for OS ${osCodigo}:`, upsertErr.message);
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

    // Log to sync_log
    const duration = Date.now() - startTime;
    await supabase.from("sync_log").insert({
      tipo: "sync-os",
      status: errors > 0 ? "partial" : "ok",
      payload: { filters, total_fetched: allOS.length, upserted, errors },
      duracao_ms: duration,
    });

    const result = {
      success: true,
      total_fetched: allOS.length,
      upserted,
      errors,
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
    } catch { /* ignore logging errors */ }

    return new Response(
      JSON.stringify({ error: errorMsg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
