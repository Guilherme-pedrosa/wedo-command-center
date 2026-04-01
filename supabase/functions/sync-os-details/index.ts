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

const DESLOCAMENTO_SERVICO_CODIGO = "2094836555801";
const DESLOCAMENTO_SERVICO_ID = "66773231";

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
}

function computeDeslocamento(os: Record<string, unknown>): number {
  const servicos = os.servicos as Array<{ servico?: { codigo?: string; id?: string; servico_id?: string; valor_total?: string } }> | undefined;
  if (!Array.isArray(servicos)) return 0;
  let total = 0;
  for (const s of servicos) {
    const srv = s?.servico;
    if (!srv) continue;
    const srvId = String(srv.servico_id || srv.id || "");
    const srvCodigo = String(srv.codigo || "");
    if (srvCodigo === DESLOCAMENTO_SERVICO_CODIGO || srvId === DESLOCAMENTO_SERVICO_ID) {
      total += parseFloat(String(srv.valor_total || "0")) || 0;
    }
  }
  return total;
}

function computeValorFromPayload(os: Record<string, unknown>): number {
  const pagamentos = os.pagamentos as Array<{ pagamento?: { valor?: string } }> | undefined;
  if (Array.isArray(pagamentos) && pagamentos.length > 0) {
    let sum = 0;
    for (const p of pagamentos) {
      sum += parseFloat(String(p?.pagamento?.valor || "0")) || 0;
    }
    if (sum > 0) return sum;
  }
  let total = 0;
  const servicos = os.servicos as Array<{ servico?: { valor_total?: string } }> | undefined;
  if (Array.isArray(servicos)) {
    for (const s of servicos) {
      total += parseFloat(String(s?.servico?.valor_total || "0")) || 0;
    }
  }
  const produtos = os.produtos as Array<{ produto?: { valor_total?: string } }> | undefined;
  if (Array.isArray(produtos)) {
    for (const p of produtos) {
      total += parseFloat(String(p?.produto?.valor_total || "0")) || 0;
    }
  }
  return total;
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

    // Accept optional params: batch_size (default 50), month (e.g. "2026-03")
    let batchSize = 50;
    let monthFilter: string | null = null;
    try {
      const body = await req.json();
      if (body?.batch_size) batchSize = Math.min(body.batch_size, 100);
      if (body?.month) monthFilter = body.month;
    } catch { /* no body */ }

    // Find OS records that need detail fetching (valor_deslocamento = 0 or null)
    let query = supabase
      .from("os_index")
      .select("os_id, os_codigo, valor_total, valor_deslocamento")
      .or("valor_deslocamento.is.null,valor_deslocamento.eq.0")
      .limit(batchSize);

    if (monthFilter) {
      query = query
        .gte("data_saida", `${monthFilter}-01`)
        .lt("data_saida", `${monthFilter}-01`);
      // Compute next month for lt filter
      const [y, m] = monthFilter.split("-").map(Number);
      const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      query = supabase
        .from("os_index")
        .select("os_id, os_codigo, valor_total, valor_deslocamento")
        .or("valor_deslocamento.is.null,valor_deslocamento.eq.0")
        .gte("data_saida", `${monthFilter}-01`)
        .lt("data_saida", `${nextMonth}-01`)
        .limit(batchSize);
    }

    const { data: osList, error: fetchErr } = await query;
    if (fetchErr) throw new Error(`DB fetch error: ${fetchErr.message}`);

    if (!osList || osList.length === 0) {
      return new Response(JSON.stringify({
        success: true,
        message: "No OS records need detail fetching",
        processed: 0,
        remaining: 0,
      }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    let updated = 0;
    let errors = 0;
    const debugLogs: string[] = [];

    for (const os of osList) {
      try {
        const detailUrl = `${GC_BASE_URL}/api/ordens_servicos/${os.os_id}`;
        let detailRes = await rateLimitedFetch(detailUrl, { headers: gcHeaders });
        
        if (detailRes.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          detailRes = await rateLimitedFetch(detailUrl, { headers: gcHeaders });
        }
        
        if (!detailRes.ok) {
          console.warn(`[sync-os-details] API error for OS ${os.os_id}: ${detailRes.status}`);
          errors++;
          continue;
        }

        const detailData = await detailRes.json();
        const osDetail = detailData?.data || detailData;
        
        const desloc = computeDeslocamento(osDetail);
        
        // Debug: log first 3 to verify structure
        if (debugLogs.length < 3) {
          const servicos = osDetail.servicos as Array<unknown> | undefined;
          debugLogs.push(`OS ${os.os_id}: servicos=${JSON.stringify(servicos?.slice(0, 2))}, desloc=${desloc}`);
        }

        const updateData: Record<string, unknown> = {
          valor_deslocamento: desloc,
        };

        // Also fix zero-value OS
        if (!os.valor_total || os.valor_total === 0) {
          const computedVal = computeValorFromPayload(osDetail);
          if (computedVal > 0) {
            updateData.valor_total = computedVal;
          }
        }

        // Use -1 sentinel for "processed but no deslocamento found" to avoid re-processing
        if (desloc === 0) {
          updateData.valor_deslocamento = -0.001; // sentinel: processed, no desloc
        }

        const { error: updateErr } = await supabase
          .from("os_index")
          .update(updateData)
          .eq("os_id", os.os_id);

        if (updateErr) {
          console.error(`[sync-os-details] Update error for OS ${os.os_id}: ${updateErr.message}`);
          errors++;
        } else {
          updated++;
        }
      } catch (e) {
        console.warn(`[sync-os-details] Error for OS ${os.os_id}: ${(e as Error).message}`);
        errors++;
      }
    }

    // Check how many remain
    let remainQuery = supabase
      .from("os_index")
      .select("os_id", { count: "exact", head: true })
      .or("valor_deslocamento.is.null,valor_deslocamento.eq.0");

    if (monthFilter) {
      const [y, m] = monthFilter.split("-").map(Number);
      const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
      remainQuery = supabase
        .from("os_index")
        .select("os_id", { count: "exact", head: true })
        .or("valor_deslocamento.is.null,valor_deslocamento.eq.0")
        .gte("data_saida", `${monthFilter}-01`)
        .lt("data_saida", `${nextMonth}-01`);
    }

    const { count: remaining } = await remainQuery;

    const duration = Date.now() - startTime;
    console.log(`[sync-os-details] Done: ${updated} updated, ${errors} errors, ${remaining ?? "?"} remaining, ${duration}ms`);
    
    for (const log of debugLogs) {
      console.log(`[sync-os-details] DEBUG: ${log}`);
    }

    return new Response(JSON.stringify({
      success: true,
      processed: osList.length,
      updated,
      errors,
      remaining: remaining ?? 0,
      duration_ms: duration,
      debug: debugLogs,
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMsg = (error as Error).message;
    console.error("[sync-os-details] Fatal error:", errorMsg);
    return new Response(JSON.stringify({ error: errorMsg }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
