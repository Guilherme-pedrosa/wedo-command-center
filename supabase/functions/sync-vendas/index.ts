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
    let situacaoIds: string[] = [];
    try {
      const body = await req.json();
      dataInicio = body?.data_inicio ?? null;
      dataFim = body?.data_fim ?? null;
      if (body?.situacao_ids && Array.isArray(body.situacao_ids)) {
        situacaoIds = body.situacao_ids;
      }
    } catch { /* no body */ }

    // Step 1: If no situacao_ids provided, fetch all situações de vendas and find Concretizado + Venda Futura
    if (situacaoIds.length === 0) {
      console.log("[sync-vendas] Fetching situacoes_vendas...");
      const sitResp = await rateLimitedFetch(
        `${GC_BASE_URL}/api/situacoes_vendas`,
        { headers: gcHeaders }
      );
      if (sitResp.ok) {
        const sitData = await sitResp.json();
        const situacoes = Array.isArray(sitData?.data) ? sitData.data : [];
        for (const sit of situacoes) {
          const nome = String(sit.nome || "").toLowerCase().trim();
          // Somente "Concretizado" (exato) e "Venda Futura" — NÃO incluir "Concretizado Peças Reserva" etc.
          if (nome === "concretizado" || nome === "concretizada" || nome === "venda futura") {
            situacaoIds.push(String(sit.id));
            console.log(`[sync-vendas] Found situacao: ${sit.nome} (id=${sit.id})`);
          }
        }
      } else {
        console.error(`[sync-vendas] Failed to fetch situacoes_vendas: ${sitResp.status}`);
      }
    }

    if (situacaoIds.length === 0) {
      return new Response(
        JSON.stringify({ error: "No matching situacao_ids found for Concretizado/Venda Futura" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let totalFetched = 0;
    let upserted = 0;
    let errors = 0;

    for (const sitId of situacaoIds) {
      let page = 1;
      let totalPages = 999;

      while (page <= totalPages) {
        const params: Record<string, string> = {
          limite: "100",
          pagina: String(page),
          situacao_id: sitId,
          tipo: "produto",
        };
        if (dataInicio) params.data_inicio = dataInicio;
        if (dataFim) params.data_fim = dataFim;

        const url = `${GC_BASE_URL}/api/vendas?${new URLSearchParams(params).toString()}`;
        const response = await rateLimitedFetch(url, { headers: gcHeaders });

        if (response.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }
        if (!response.ok) {
          console.error(`[sync-vendas] GC API error sit=${sitId}: ${response.status}`);
          errors++;
          break;
        }

        const data = await response.json();
        const records = Array.isArray(data?.data) ? data.data : [];
        const meta = data?.meta || {};
        totalPages = meta?.total_paginas || 1;

        const batch = [];
        for (const venda of records) {
          totalFetched++;
          const gcId = String(venda.id || "");
          if (!gcId) { errors++; continue; }

          let dataVenda: string | null = null;
          const rawData = String(venda.data || "");
          if (rawData) {
            const match = rawData.match(/^(\d{4}-\d{2}-\d{2})/);
            if (match) dataVenda = match[1];
          }

          batch.push({
            gc_id: gcId,
            codigo: String(venda.codigo || ""),
            tipo: String(venda.tipo || "produto"),
            nome_cliente: String(venda.nome_cliente || venda.cliente_nome || "") || null,
            cliente_id: String(venda.cliente_id || venda.cliente_codigo || "") || null,
            nome_situacao: String(venda.nome_situacao || venda.situacao_nome || ""),
            situacao_id: sitId,
            data: dataVenda,
            valor_total: parseFloat(String(venda.valor_total || "0")) || null,
            valor_produtos: parseFloat(String(venda.valor_produtos || "0")) || null,
            valor_servicos: parseFloat(String(venda.valor_servicos || "0")) || null,
            desconto: parseFloat(String(venda.desconto || "0")) || 0,
            observacao: String(venda.observacao || "") || null,
            gc_payload_raw: venda,
            last_synced_at: new Date().toISOString(),
          });
        }

        if (batch.length > 0) {
          const { error: upsertErr, count } = await supabase
            .from("gc_vendas")
            .upsert(batch, { onConflict: "gc_id", count: "exact" });

          if (upsertErr) {
            console.error(`[sync-vendas] Upsert error: ${upsertErr.message}`);
            errors += batch.length;
          } else {
            upserted += count || batch.length;
          }
        }

        console.log(`[sync-vendas] sit=${sitId} page ${page}/${totalPages} — ${records.length} recs`);
        page++;
      }
    }

    const duration = Date.now() - startTime;

    await supabase.from("sync_log").insert({
      tipo: "sync-vendas",
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
    console.error("[sync-vendas] Fatal error:", errorMsg);
    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("sync_log").insert({ tipo: "sync-vendas", status: "erro", erro: errorMsg, duracao_ms: duration });
    } catch { /* ignore */ }
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
