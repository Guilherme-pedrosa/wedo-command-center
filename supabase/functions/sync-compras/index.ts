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

    // Parse optional body params
    let dataInicio: string | null = null;
    let dataFim: string | null = null;
    let situacaoId: string | null = null;
    try {
      const body = await req.json();
      dataInicio = body?.data_inicio ?? null;
      dataFim = body?.data_fim ?? null;
      situacaoId = body?.situacao_id ?? null;
    } catch { /* no body */ }

    // Step 1: Fetch all situações and find target ones
    let situacaoIds: string[] = situacaoId ? [situacaoId] : [];
    if (situacaoIds.length === 0) {
      console.log("[sync-compras] Fetching situacoes_compras...");
      const sitResp = await rateLimitedFetch(
        `${GC_BASE_URL}/api/situacoes_compras`,
        { headers: gcHeaders }
      );
      if (sitResp.ok) {
        const sitData = await sitResp.json();
        const situacoes = Array.isArray(sitData?.data) ? sitData.data : [];
        for (const sit of situacoes) {
          const nome = String(sit.nome || "").toLowerCase().trim();
          if (
            (nome.includes("finalizado") && nome.includes("mercadoria chegou")) ||
            (nome.includes("comprado") && nome.includes("ag chegada"))
          ) {
            situacaoIds.push(String(sit.id));
            console.log(`[sync-compras] Found situacao: ${sit.nome} (id=${sit.id})`);
          }
        }
      } else {
        console.error(`[sync-compras] Failed to fetch situacoes_compras: ${sitResp.status}`);
      }
    }

    if (situacaoIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No matching situacao_ids found" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalFetched = 0;
    let upserted = 0;
    let errors = 0;

    for (const currentSitId of situacaoIds) {
      let page = 1;
      let totalPages = 999;

      while (page <= totalPages) {
        const params: Record<string, string> = {
          limite: "100",
          pagina: String(page),
          situacao_id: currentSitId,
        };
        if (dataInicio) params.data_inicio = dataInicio;
        if (dataFim) params.data_fim = dataFim;

        const url = `${GC_BASE_URL}/api/compras?${new URLSearchParams(params).toString()}`;
        const response = await rateLimitedFetch(url, { headers: gcHeaders });

        if (response.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!response.ok) {
          console.error(`[sync-compras] GC API error: ${response.status}`);
          errors++;
          break;
        }

        const data = await response.json();
        const records = Array.isArray(data?.data) ? data.data : [];
        const meta = data?.meta || {};
        totalPages = meta?.total_paginas || 1;

        const batch = [];
        for (const compra of records) {
          totalFetched++;
          const c = (compra as any).Compra ?? compra;
          const gcId = String(c.id || "");
          if (!gcId) { errors++; continue; }

          let dataCompra: string | null = null;
          const rawData = String(c.data_emissao || c.data || c.data_compra || "");
          if (rawData) {
            const match = rawData.match(/^(\d{4}-\d{2}-\d{2})/);
            if (match) dataCompra = match[1];
          }

          // Extract cadastrado_em (created date in GC)
          let cadastradoEm: string | null = null;
          const rawCad = String(c.cadastrado_em || c.created || c.data_cadastro || "");
          if (rawCad) {
            const match = rawCad.match(/^(\d{4}-\d{2}-\d{2})/);
            if (match) cadastradoEm = match[1];
          }

          batch.push({
            gc_id: gcId,
            codigo: String(c.codigo || c.numero || ""),
            nome_fornecedor: String(c.nome_fornecedor || c.fornecedor_nome || "") || null,
            fornecedor_id: String(c.fornecedor_id || "") || null,
            nome_situacao: String(c.nome_situacao || c.situacao_nome || ""),
            situacao_id: currentSitId,
            data: dataCompra,
            cadastrado_em: cadastradoEm,
            valor_total: parseFloat(String(c.valor_total || "0")) || null,
            valor_produtos: parseFloat(String(c.valor_produtos || "0")) || null,
            valor_frete: parseFloat(String(c.valor_frete || "0")) || null,
            desconto: parseFloat(String(c.desconto || "0")) || 0,
            observacao: String(c.observacao || c.observacoes || "") || null,
            gc_payload_raw: compra,
            last_synced_at: new Date().toISOString(),
          });
        }

        if (batch.length > 0) {
          const { error: upsertErr, count } = await supabase
            .from("gc_compras")
            .upsert(batch, { onConflict: "gc_id", count: "exact" });

          if (upsertErr) {
            console.error(`[sync-compras] Upsert error: ${upsertErr.message}`);
            errors += batch.length;
          } else {
            upserted += count || batch.length;
          }
        }

        console.log(`[sync-compras] sit=${currentSitId} page ${page}/${totalPages} — ${records.length} recs`);
        page++;
      }
    }

    const duration = Date.now() - startTime;

    await supabase.from("sync_log").insert({
      tipo: "sync-compras",
      status: errors > 0 ? "partial" : "ok",
      payload: { totalFetched, upserted, errors, situacaoIds },
      duracao_ms: duration,
    });

    return new Response(JSON.stringify({
      success: true,
      totalFetched, upserted, errors, situacaoIds, duration_ms: duration,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = (error as Error).message;
    console.error("[sync-compras] Fatal error:", errorMsg);
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("sync_log").insert({ tipo: "sync-compras", status: "erro", erro: errorMsg, duracao_ms: duration });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
