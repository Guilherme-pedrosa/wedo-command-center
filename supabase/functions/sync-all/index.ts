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

    // ─── 5. Sync GC Recebimentos (inline — no dedicated edge fn) ─────
    console.log("[sync-all] Starting gc_recebimentos sync...");
    const recStart = Date.now();
    try {
      const { records: recRecords } = await fetchAllPages("/api/recebimentos", gcHeaders);
      let recUpserted = 0;
      let recErrors = 0;

      for (let i = 0; i < recRecords.length; i += 50) {
        const batch = recRecords.slice(i, i + 50).map((item: any) => ({
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

        const { error } = await supabase
          .from("gc_recebimentos")
          .upsert(batch, { onConflict: "gc_id" });

        if (error) {
          console.error(`[sync-all] gc_recebimentos upsert error: ${error.message}`);
          recErrors += batch.length;
        } else {
          recUpserted += batch.length;
        }
      }

      results.recebimentos = { status: recErrors > 0 ? "partial" : "ok", fetched: recRecords.length, upserted: recUpserted, errors: recErrors, duration_ms: Date.now() - recStart };
      console.log(`[sync-all] gc_recebimentos done: ${recRecords.length} fetched, ${recUpserted} upserted (${Date.now() - recStart}ms)`);
    } catch (err) {
      results.recebimentos = { status: "error", error: (err as Error).message, duration_ms: Date.now() - recStart };
      console.error(`[sync-all] gc_recebimentos error: ${(err as Error).message}`);
    }

    // ─── 6. Sync GC Pagamentos (inline) ──────────────────────────────
    console.log("[sync-all] Starting gc_pagamentos sync...");
    const pagStart = Date.now();
    try {
      const { records: pagRecords } = await fetchAllPages("/api/pagamentos", gcHeaders);
      let pagUpserted = 0;
      let pagErrors = 0;

      for (let i = 0; i < pagRecords.length; i += 50) {
        const batch = pagRecords.slice(i, i + 50).map((item: any) => ({
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

        const { error } = await supabase
          .from("gc_pagamentos")
          .upsert(batch, { onConflict: "gc_id" });

        if (error) {
          console.error(`[sync-all] gc_pagamentos upsert error: ${error.message}`);
          pagErrors += batch.length;
        } else {
          pagUpserted += batch.length;
        }
      }

      results.pagamentos = { status: pagErrors > 0 ? "partial" : "ok", fetched: pagRecords.length, upserted: pagUpserted, errors: pagErrors, duration_ms: Date.now() - pagStart };
      console.log(`[sync-all] gc_pagamentos done: ${pagRecords.length} fetched, ${pagUpserted} upserted (${Date.now() - pagStart}ms)`);
    } catch (err) {
      results.pagamentos = { status: "error", error: (err as Error).message, duration_ms: Date.now() - pagStart };
      console.error(`[sync-all] gc_pagamentos error: ${(err as Error).message}`);
    }

    // ─── Log final ───────────────────────────────────────────────────
    const totalDuration = Date.now() - startTime;
    const hasErrors = Object.values(results).some((r: any) => r.status === "error");

    await supabase.from("sync_log").insert({
      tipo: "sync-all",
      status: hasErrors ? "partial" : "ok",
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
      await supabase.from("sync_log").insert({
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
