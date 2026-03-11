import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// redeploy: 2026-03-11-v2-fin-tables

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

// ─── GC paginated fetch ──────────────────────────────────────────────
async function fetchAllPages(
  endpoint: string,
  gcHeaders: Record<string, string>,
  extraParams?: Record<string, string>
): Promise<{ records: any[]; pages: number }> {
  const allRecords: any[] = [];
  let page = 1;
  let totalPages = 1;

  while (page <= totalPages) {
    const params: Record<string, string> = { limite: "100", pagina: String(page), ...extraParams };
    const url = `${GC_BASE_URL}${endpoint}?${new URLSearchParams(params).toString()}`;
    const response = await rateLimitedFetch(url, { headers: gcHeaders });

    if (response.status === 429) {
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (!response.ok) {
      console.error(`[sync-all] ${endpoint} error: ${response.status}`);
      break;
    }

    const data = await response.json();
    const records = Array.isArray(data?.data) ? data.data : [];
    totalPages = data?.meta?.total_paginas || 1;
    allRecords.push(...records);
    page++;
  }

  return { records: allRecords, pages: totalPages };
}

// ─── Call sibling edge function ──────────────────────────────────────
async function callEdgeFunction(
  supabaseUrl: string,
  serviceKey: string,
  functionName: string,
  body?: Record<string, unknown>
): Promise<{ ok: boolean; data?: any; error?: string; duration_ms: number }> {
  const start = Date.now();
  try {
    const url = `${supabaseUrl}/functions/v1/${functionName}`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify(body || {}),
    });
    const data = await response.json().catch(() => ({}));
    return { ok: response.ok, data, duration_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, error: (err as Error).message, duration_ms: Date.now() - start };
  }
}

// ─── Helpers (same logic as client-side financeiro.ts) ───────────────
function extrairOsCodigo(descricao: string | null | undefined): string | null {
  if (!descricao) return null;
  const match = descricao.match(/Ordem de serviço de nº\s*(\d+)/i);
  return match ? match[1] : null;
}

function inferirTipo(descricao: string | null | undefined): string {
  if (!descricao) return "outro";
  if (/ordem de serviço/i.test(descricao)) return "os";
  if (/venda/i.test(descricao)) return "venda";
  if (/contrato/i.test(descricao)) return "contrato";
  return "outro";
}

function inferirOrigem(descricao?: string | null): string {
  if (!descricao) return "outro";
  if (/ordem de serviço/i.test(descricao)) return "gc_os";
  if (/venda/i.test(descricao)) return "gc_venda";
  if (/contrato/i.test(descricao)) return "gc_contrato";
  return "outro";
}

// Build mapping from GC IDs to local UUIDs
async function buildPcCcFpMaps(supabase: any): Promise<{
  pcMap: Record<string, string>;
  ccMap: Record<string, string>;
  fpMap: Record<string, string>;
}> {
  const [{ data: pcs }, { data: ccs }, { data: fps }] = await Promise.all([
    supabase.from("fin_plano_contas").select("id, gc_id").not("gc_id", "is", null),
    supabase.from("fin_centros_custo").select("id, codigo").not("codigo", "is", null),
    supabase.from("fin_formas_pagamento").select("id, gc_id").not("gc_id", "is", null),
  ]);
  const pcMap: Record<string, string> = {};
  for (const pc of pcs ?? []) { if (pc.gc_id) pcMap[pc.gc_id] = pc.id; }
  const ccMap: Record<string, string> = {};
  for (const cc of ccs ?? []) { if (cc.codigo) ccMap[cc.codigo] = cc.id; }
  const fpMap: Record<string, string> = {};
  for (const fp of fps ?? []) { if (fp.gc_id) fpMap[fp.gc_id] = fp.id; }
  return { pcMap, ccMap, fpMap };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();
  const results: Record<string, any> = {};

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // ─── 1-4. Sync OS, Vendas, Compras, Auvo in parallel ───────────
    console.log("[sync-all] Starting OS, Vendas, Compras, Auvo in parallel...");
    const [osResult, vendasResult, comprasResult, auvoResult] = await Promise.all([
      callEdgeFunction(supabaseUrl, supabaseKey, "sync-os"),
      callEdgeFunction(supabaseUrl, supabaseKey, "sync-vendas"),
      callEdgeFunction(supabaseUrl, supabaseKey, "sync-compras"),
      callEdgeFunction(supabaseUrl, supabaseKey, "sync-auvo-expenses"),
    ]);

    results.os = osResult.ok
      ? { status: "ok", duration_ms: osResult.duration_ms, ...osResult.data }
      : { status: "error", error: osResult.error, duration_ms: osResult.duration_ms };
    results.vendas = vendasResult.ok
      ? { status: "ok", duration_ms: vendasResult.duration_ms, ...vendasResult.data }
      : { status: "error", error: vendasResult.error, duration_ms: vendasResult.duration_ms };
    results.compras = comprasResult.ok
      ? { status: "ok", duration_ms: comprasResult.duration_ms, ...comprasResult.data }
      : { status: "error", error: comprasResult.error, duration_ms: comprasResult.duration_ms };
    results.auvo = auvoResult.ok
      ? { status: "ok", duration_ms: auvoResult.duration_ms, ...auvoResult.data }
      : { status: "error", error: auvoResult.error, duration_ms: auvoResult.duration_ms };
    console.log(`[sync-all] Parallel batch done: OS=${osResult.ok}, Vendas=${vendasResult.ok}, Compras=${comprasResult.ok}, Auvo=${auvoResult.ok}`);

    // ─── Build PC/CC/FP maps for fin_* upserts ──────────────────────
    const { pcMap, ccMap, fpMap } = await buildPcCcFpMaps(supabase);

    // Fetch cancelled gc_ids to skip during fin_* upserts
    const [{ data: cancelledRecs }, { data: cancelledPags }] = await Promise.all([
      supabase.from("fin_recebimentos").select("gc_id").eq("status", "cancelado").not("gc_id", "is", null),
      supabase.from("fin_pagamentos").select("gc_id").eq("status", "cancelado").not("gc_id", "is", null),
    ]);
    const cancelledRecGcIds = new Set((cancelledRecs ?? []).map((r: any) => r.gc_id));
    const cancelledPagGcIds = new Set((cancelledPags ?? []).map((p: any) => p.gc_id));

    // Fetch fornecedores for recipient_document backfill
    const { data: fornecedores } = await supabase
      .from("fin_fornecedores")
      .select("gc_id, cpf_cnpj")
      .not("cpf_cnpj", "is", null);
    const fornDocMap: Record<string, string> = {};
    for (const f of (fornecedores ?? []) as any[]) {
      if (f.cpf_cnpj) fornDocMap[f.gc_id] = f.cpf_cnpj;
    }

    // ─── 5. Sync GC Recebimentos ─────────────────────────────────────
    console.log("[sync-all] Starting recebimentos sync...");
    const recStart = Date.now();
    try {
      const { records: recRecords } = await fetchAllPages("/api/recebimentos", gcHeaders);
      let gcRecUpserted = 0;
      let finRecUpserted = 0;
      let recErrors = 0;

      for (let i = 0; i < recRecords.length; i += 50) {
        const rawBatch = recRecords.slice(i, i + 50);

        // 5a. Upsert into gc_recebimentos (mirror table)
        const gcBatch = rawBatch.map((item: any) => ({
          gc_id: String(item.id),
          gc_codigo: item.codigo || null,
          descricao: item.descricao || null,
          os_codigo: (item.descricao?.match(/Ordem de serviço de nº\s*(\d+)/i)?.[1]) || null,
          tipo: /ordem de serviço/i.test(item.descricao || "") ? "os" : /venda/i.test(item.descricao || "") ? "venda" : "outro",
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
          gc_payload_raw: item,
          last_synced_at: new Date().toISOString(),
        }));

        const { error: gcErr } = await supabase
          .from("gc_recebimentos")
          .upsert(gcBatch, { onConflict: "gc_id" });
        if (gcErr) {
          console.error(`[sync-all] gc_recebimentos upsert error: ${gcErr.message}`);
          recErrors += gcBatch.length;
        } else {
          gcRecUpserted += gcBatch.length;
        }

        // 5b. Upsert into fin_recebimentos (financial table)
        const finBatch = rawBatch
          .filter((item: any) => !cancelledRecGcIds.has(String(item.id)))
          .map((item: any) => ({
            gc_id: String(item.id),
            gc_codigo: item.codigo || null,
            gc_payload_raw: item,
            descricao: item.descricao ?? "Sem descrição",
            os_codigo: extrairOsCodigo(item.descricao),
            tipo: inferirTipo(item.descricao),
            origem: inferirOrigem(item.descricao),
            valor: parseFloat(item.valor_total ?? "0"),
            cliente_gc_id: item.cliente_id ?? null,
            nome_cliente: item.nome_cliente ?? null,
            plano_contas_id: item.plano_contas_id ? (pcMap[item.plano_contas_id] ?? null) : null,
            centro_custo_id: item.centro_custo_id ? (ccMap[item.centro_custo_id] ?? null) : null,
            forma_pagamento_id: item.forma_pagamento_id ? (fpMap[item.forma_pagamento_id] ?? null) : null,
            data_vencimento: item.data_vencimento || null,
            data_competencia: item.data_competencia || null,
            data_liquidacao: item.data_liquidacao || null,
            liquidado: item.liquidado === "1",
            status: item.liquidado === "1" ? "pago" : "pendente",
            last_synced_at: new Date().toISOString(),
          }));

        if (finBatch.length > 0) {
          const { error: finErr } = await supabase
            .from("fin_recebimentos")
            .upsert(finBatch, { onConflict: "gc_id" });
          if (finErr) {
            console.error(`[sync-all] fin_recebimentos upsert error: ${finErr.message}`);
          } else {
            finRecUpserted += finBatch.length;
          }
        }
      }

      results.recebimentos = {
        status: recErrors > 0 ? "partial" : "ok",
        fetched: recRecords.length,
        gc_upserted: gcRecUpserted,
        fin_upserted: finRecUpserted,
        errors: recErrors,
        duration_ms: Date.now() - recStart,
      };
      console.log(`[sync-all] recebimentos done: ${recRecords.length} fetched, gc=${gcRecUpserted}, fin=${finRecUpserted} (${Date.now() - recStart}ms)`);
    } catch (err) {
      results.recebimentos = { status: "error", error: (err as Error).message, duration_ms: Date.now() - recStart };
      console.error(`[sync-all] recebimentos error: ${(err as Error).message}`);
    }

    // ─── 6. Sync GC Pagamentos ──────────────────────────────────────
    console.log("[sync-all] Starting pagamentos sync...");
    const pagStart = Date.now();
    try {
      const { records: pagRecords } = await fetchAllPages("/api/pagamentos", gcHeaders);
      let gcPagUpserted = 0;
      let finPagUpserted = 0;
      let pagErrors = 0;

      for (let i = 0; i < pagRecords.length; i += 50) {
        const rawBatch = pagRecords.slice(i, i + 50);

        // 6a. Upsert into gc_pagamentos (mirror table)
        const gcBatch = rawBatch.map((item: any) => ({
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
          gc_payload_raw: item,
          last_synced_at: new Date().toISOString(),
        }));

        const { error: gcErr } = await supabase
          .from("gc_pagamentos")
          .upsert(gcBatch, { onConflict: "gc_id" });
        if (gcErr) {
          console.error(`[sync-all] gc_pagamentos upsert error: ${gcErr.message}`);
          pagErrors += gcBatch.length;
        } else {
          gcPagUpserted += gcBatch.length;
        }

        // 6b. Upsert into fin_pagamentos (financial table)
        const finBatch = rawBatch
          .filter((item: any) => !cancelledPagGcIds.has(String(item.id)))
          .map((item: any) => ({
            gc_id: String(item.id),
            gc_codigo: item.codigo || null,
            gc_payload_raw: item,
            descricao: item.descricao ?? "Sem descrição",
            os_codigo: extrairOsCodigo(item.descricao),
            tipo: inferirTipo(item.descricao),
            origem: inferirOrigem(item.descricao),
            valor: parseFloat(item.valor_total ?? "0"),
            fornecedor_gc_id: item.fornecedor_id ?? null,
            nome_fornecedor: item.nome_fornecedor ?? null,
            recipient_document: item.fornecedor_id ? (fornDocMap[item.fornecedor_id] ?? null) : null,
            plano_contas_id: item.plano_contas_id ? (pcMap[item.plano_contas_id] ?? null) : null,
            centro_custo_id: item.centro_custo_id ? (ccMap[item.centro_custo_id] ?? null) : null,
            forma_pagamento_id: item.forma_pagamento_id ? (fpMap[item.forma_pagamento_id] ?? null) : null,
            data_vencimento: item.data_vencimento || null,
            data_competencia: item.data_competencia || null,
            data_liquidacao: item.data_liquidacao || null,
            liquidado: item.liquidado === "1",
            status: item.liquidado === "1" ? "pago" : "pendente",
            last_synced_at: new Date().toISOString(),
          }));

        if (finBatch.length > 0) {
          const { error: finErr } = await supabase
            .from("fin_pagamentos")
            .upsert(finBatch, { onConflict: "gc_id" });
          if (finErr) {
            console.error(`[sync-all] fin_pagamentos upsert error: ${finErr.message}`);
          } else {
            finPagUpserted += finBatch.length;
          }
        }
      }

      // Backfill recipient_document for records missing it
      try {
        const { data: missing } = await supabase
          .from("fin_pagamentos")
          .select("id, fornecedor_gc_id")
          .is("recipient_document", null)
          .not("fornecedor_gc_id", "is", null)
          .limit(500);

        const updatesByDoc: Record<string, string[]> = {};
        for (const p of (missing ?? []) as any[]) {
          const doc = fornDocMap[p.fornecedor_gc_id];
          if (doc) {
            if (!updatesByDoc[doc]) updatesByDoc[doc] = [];
            updatesByDoc[doc].push(p.id);
          }
        }
        for (const [doc, ids] of Object.entries(updatesByDoc)) {
          await supabase.from("fin_pagamentos")
            .update({ recipient_document: doc })
            .in("id", ids);
        }
      } catch (e) {
        console.error("[sync-all] Backfill recipient_document error:", e);
      }

      results.pagamentos = {
        status: pagErrors > 0 ? "partial" : "ok",
        fetched: pagRecords.length,
        gc_upserted: gcPagUpserted,
        fin_upserted: finPagUpserted,
        errors: pagErrors,
        duration_ms: Date.now() - pagStart,
      };
      console.log(`[sync-all] pagamentos done: ${pagRecords.length} fetched, gc=${gcPagUpserted}, fin=${finPagUpserted} (${Date.now() - pagStart}ms)`);
    } catch (err) {
      results.pagamentos = { status: "error", error: (err as Error).message, duration_ms: Date.now() - pagStart };
      console.error(`[sync-all] pagamentos error: ${(err as Error).message}`);
    }

    // ─── Log final ───────────────────────────────────────────────────
    const totalDuration = Date.now() - startTime;
    const hasErrors = Object.values(results).some((r: any) => r.status === "error");

    await supabase.from("fin_sync_log").insert({
      tipo: "sync-all",
      status: hasErrors ? "partial" : "success",
      payload: results,
      duracao_ms: totalDuration,
    });

    console.log(`[sync-all] Complete in ${totalDuration}ms`);

    return new Response(JSON.stringify({ success: true, results, duration_ms: totalDuration }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const duration = Date.now() - startTime;
    const errorMsg = (error as Error).message;
    console.error("[sync-all] Fatal error:", errorMsg);

    try {
      const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
      await supabase.from("fin_sync_log").insert({
        tipo: "sync-all",
        status: "erro",
        erro: errorMsg,
        duracao_ms: duration,
      });
    } catch { /* ignore */ }

    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
