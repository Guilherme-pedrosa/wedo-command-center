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

function parseNumber(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const s = String(raw).trim();
  const normalized = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = parseFloat(normalized);
  return Number.isFinite(n) ? n : null;
}

function extrairItensCompra(compraGcId: string, compraRaw: any) {
  const c = compraRaw?.Compra ?? compraRaw ?? {};
  const produtos = Array.isArray(c.produtos) ? c.produtos : [];
  return produtos.map((wrap: any, idx: number) => {
    const p = wrap?.produto ?? wrap ?? {};
    const rawItemId = (p.id ?? p.item_id ?? p.compra_item_id ?? "").toString().trim();
    const rawProdutoId = (p.produto_id ?? p.id_produto ?? "").toString().trim();
    const temVinculo = !!rawProdutoId && rawProdutoId !== "0";
    return {
      compra_gc_id: compraGcId,
      item_gc_id: rawItemId || null,
      produto_gc_id: temVinculo ? rawProdutoId : null,
      nome_produto: (p.nome_produto ?? p.nome ?? "").toString().trim() || null,
      unidade: p.unidade ?? null,
      quantidade: parseNumber(p.quantidade),
      valor_custo: parseNumber(p.valor_custo),
      valor_total: parseNumber(p.valor_total),
      ordem_item: idx,
      origem_vinculo: temVinculo ? "produto_id_gc" : "legacy_sem_produto_id",
    };
  });
}

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

    // Step 1: Use hardcoded situação IDs for purchases
    // Inclui produto + serviços. Serviços podem ser pedido de frete e precisam entrar no rateio.
    // Situações que NÃO contam como custo final continuam sincronizadas para capturar transições.
    // para capturar transições de status — assim uma compra movida pra fora de "Finalizado/AG CHEGADA"
    // tem o nome_situacao local atualizado e sai do custo de peças.
    let situacaoIds: string[] = situacaoId
      ? [situacaoId]
      : ["1675083", "1675070", "1739937", "2072508", "2072571", "2072608"];
    console.log(`[sync-compras] Using situacaoIds: ${situacaoIds.join(", ")}`);

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
        const itensPorCompra = new Map<string, ReturnType<typeof extrairItensCompra>>();
        const cancelledIds: string[] = [];
        for (const compra of records) {
          totalFetched++;
          const c = (compra as any).Compra ?? compra;
          const gcId = String(c.id || "");
          if (!gcId) { errors++; continue; }

          const nomeSit = String(c.nome_situacao || c.situacao_nome || "");
          if (/cancel/i.test(nomeSit)) {
            cancelledIds.push(gcId);
            continue;
          }


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

          const itens = extrairItensCompra(gcId, compra);
          if (itens.length > 0) itensPorCompra.set(gcId, itens);
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

          for (const [compraGcId, itens] of itensPorCompra.entries()) {
            const { error: delErr } = await supabase
              .from("gc_compras_itens")
              .delete()
              .eq("compra_gc_id", compraGcId);
            if (delErr) {
              console.error(`[sync-compras] Delete itens ${compraGcId}: ${delErr.message}`);
              errors++;
              continue;
            }

            const { error: itensErr } = await supabase
              .from("gc_compras_itens")
              .insert(itens);
            if (itensErr) {
              console.error(`[sync-compras] Insert itens ${compraGcId}: ${itensErr.message}`);
              errors++;
            }
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
