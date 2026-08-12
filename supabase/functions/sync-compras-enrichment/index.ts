// Enrichment de compras: GET /api/compras/{id} para popular numero_nfe + itens.
// Padrão checkpoint FASE D: HTTP 202 quando timeout, HTTP 200 quando completo.
import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

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

function normalizarNumeroNF(n: unknown): string {
  if (n === null || n === undefined) return "";
  return String(n).replace(/[^0-9]/g, "").replace(/^0+/, "");
}

function parseDateBR(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw);
  const m = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : null;
}

function parseDateTimeBR(raw: unknown): string | null {
  if (!raw) return null;
  const s = String(raw).trim();
  const m = s.match(/^(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/);
  if (m) return `${m[1]}T${m[2]}-03:00`;
  const d = s.match(/^(\d{4}-\d{2}-\d{2})/);
  return d ? `${d[1]}T00:00:00-03:00` : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, supabaseKey);

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // Body opcional
    let forceFull = false;
    let scope: "pending" | "all" | "modified" = "pending";
    try {
      const body = await req.json();
      forceFull = !!body?.force_full;
      if (body?.scope === "all" || body?.scope === "modified" || body?.scope === "pending") {
        scope = body.scope;
      }
    } catch { /* no body */ }

    if (forceFull) {
      await supabase.from("fin_configuracoes").upsert(
        { chave: "LAST_SYNC_COMPRAS_ENRICHMENT_CURSOR", valor: "0" },
        { onConflict: "chave" }
      );
    }

    // Carrega config
    const { data: cfgRows } = await supabase
      .from("fin_configuracoes")
      .select("chave,valor")
      .in("chave", [
        "LAST_SYNC_COMPRAS_ENRICHMENT_CURSOR",
        "SYNC_COMPRAS_ENRICHMENT_TIMEOUT_SEGUNDOS",
      ]);
    const cfg: Record<string, string> = {};
    for (const r of cfgRows ?? []) cfg[r.chave] = r.valor ?? "";

    const timeoutMs = (parseInt(cfg["SYNC_COMPRAS_ENRICHMENT_TIMEOUT_SEGUNDOS"] || "25", 10)) * 1000;
    let cursor = cfg["LAST_SYNC_COMPRAS_ENRICHMENT_CURSOR"] || "0";

    let processed = 0;
    let enriched = 0;
    let skipped = 0;
    let errors = 0;
    let itensInserted = 0;

    while (true) {
      if (Date.now() - startTime >= timeoutMs) {
        await supabase.from("fin_configuracoes").upsert(
          { chave: "LAST_SYNC_COMPRAS_ENRICHMENT_CURSOR", valor: cursor },
          { onConflict: "chave" }
        );
        return new Response(JSON.stringify({
          status: "in_progress",
          cursor,
          processed, enriched, skipped, errors, itensInserted,
          duration_ms: Date.now() - startTime,
        }), {
          status: 202,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      // Próxima compra a processar
      let q = supabase
        .from("gc_compras")
        .select("gc_id, numero_nfe, modificado_em, enriched_at")
        .order("gc_id", { ascending: true })
        .limit(1);

      if (cursor && cursor !== "0") {
        q = q.gt("gc_id", cursor);
      }

      if (scope === "pending") {
        q = q.is("numero_nfe", null);
      } else if (scope === "modified") {
        // Re-enriquece compras sem enriched_at (NULL = marcadas para reprocesso)
        q = q.is("enriched_at", null);
      }
      // scope='all' não filtra

      const { data: rows, error: qErr } = await q;
      if (qErr) {
        console.error("[enrichment] query error:", qErr.message);
        errors++;
        break;
      }
      if (!rows || rows.length === 0) {
        // Acabou: reset cursor, marca completed
        await supabase.from("fin_configuracoes").upsert([
          { chave: "LAST_SYNC_COMPRAS_ENRICHMENT_CURSOR", valor: "0" },
          { chave: "LAST_SYNC_COMPRAS_ENRICHMENT_COMPLETED_AT", valor: new Date().toISOString() },
        ], { onConflict: "chave" });
        return new Response(JSON.stringify({
          status: "completed",
          cursor: "0",
          processed, enriched, skipped, errors, itensInserted,
          duration_ms: Date.now() - startTime,
        }), {
          status: 200,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }

      const compra = rows[0];
      const compraGcId = String(compra.gc_id);
      cursor = compraGcId;
      processed++;

      // GET detalhe
      const url = `${GC_BASE_URL}/api/compras/${compraGcId}`;
      let resp: Response;
      try {
        resp = await rateLimitedFetch(url, { headers: gcHeaders });
      } catch (e) {
        console.error(`[enrichment] fetch fail ${compraGcId}: ${(e as Error).message}`);
        errors++;
        continue;
      }

      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        // Volta cursor para reprocessar
        cursor = (parseInt(compraGcId, 10) - 1).toString();
        continue;
      }
      if (!resp.ok) {
        console.error(`[enrichment] ${compraGcId} HTTP ${resp.status}`);
        errors++;
        continue;
      }

      const json = await resp.json();
      // GC retorna {data: {Compra: {...}}} (ou às vezes {data: {data: {...}}} / {data: {...}})
      const rawData = json?.data?.data ?? json?.data ?? null;
      const d = rawData?.Compra ?? rawData;
      if (!d || typeof d !== "object") {
        skipped++;
        continue;
      }

      const numeroNfeRaw = (d.numero_nfe ?? "").toString().trim();
      const numeroNfe = numeroNfeRaw || null;
      const cnpjFornecedor = (d.cnpj_fornecedor ?? d.fornecedor_cnpj ?? d.fornecedor?.cnpj ?? null) || null;
      const modificadoEm = parseDateTimeBR(d.modificado_em ?? d.cadastrado_em);
      const dataEmissao = parseDateBR(d.data_emissao ?? d.data);

      const updatePayload: Record<string, unknown> = {
        numero_nfe: numeroNfe,
        cnpj_fornecedor: cnpjFornecedor,
        modificado_em: modificadoEm,
        enriched_at: new Date().toISOString(),
        gc_payload_raw: d,
      };
      if (dataEmissao) updatePayload.data = dataEmissao;
      if (d.fornecedor_id) updatePayload.fornecedor_id = String(d.fornecedor_id);
      if (d.nome_fornecedor) updatePayload.nome_fornecedor = String(d.nome_fornecedor);
      if (d.valor_total) updatePayload.valor_total = parseFloat(String(d.valor_total)) || null;
      if (d.valor_produtos) updatePayload.valor_produtos = parseFloat(String(d.valor_produtos)) || null;
      if (d.valor_frete) updatePayload.valor_frete = parseFloat(String(d.valor_frete)) || null;

      const { error: updErr } = await supabase
        .from("gc_compras")
        .update(updatePayload)
        .eq("gc_id", compraGcId);

      if (updErr) {
        console.error(`[enrichment] update ${compraGcId}: ${updErr.message}`);
        errors++;
        continue;
      }
      enriched++;

      // Itens
      const produtos = Array.isArray(d.produtos) ? d.produtos : [];
      if (produtos.length > 0) {
        // Deleta itens antigos e reinsere (idempotente)
        await supabase.from("gc_compras_itens").delete().eq("compra_gc_id", compraGcId);

        const itensBatch = produtos.map((wrap: any, idx: number) => {
          const p = wrap?.produto ?? wrap ?? {};
          const rawItemId = (p.id ?? p.item_id ?? p.compra_item_id ?? "").toString().trim();
          const rawProdutoId = (p.produto_id ?? "").toString().trim();
          const temVinculo = !!rawProdutoId && rawProdutoId !== "0";
          return {
            compra_gc_id: compraGcId,
            item_gc_id: rawItemId || null,
            produto_gc_id: temVinculo ? rawProdutoId : null,
            nome_produto: (p.nome_produto ?? "").toString().trim() || null,
            unidade: p.unidade ?? null,
            quantidade: parseFloat(String(p.quantidade ?? "0")) || null,
            valor_custo: parseFloat(String(p.valor_custo ?? "0")) || null,
            valor_total: parseFloat(String(p.valor_total ?? "0")) || null,
            ordem_item: idx,
            origem_vinculo: temVinculo ? "produto_id_gc" : "legacy_sem_produto_id",
          };
        });

        if (itensBatch.length > 0) {
          const { error: insErr } = await supabase.from("gc_compras_itens").insert(itensBatch);
          if (insErr) {
            console.error(`[enrichment] itens insert ${compraGcId}: ${insErr.message}`);
            errors++;
          } else {
            itensInserted += itensBatch.length;
          }
        }
      }
    }

    return new Response(JSON.stringify({
      status: "unexpected_exit",
      cursor, processed, enriched, skipped, errors, itensInserted,
      duration_ms: Date.now() - startTime,
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("[enrichment] fatal:", (e as Error).message);
    return new Response(JSON.stringify({
      error: (e as Error).message,
      duration_ms: Date.now() - startTime,
    }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
