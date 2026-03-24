import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 400;
let lastCallTime = 0;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  lastCallTime = Date.now();
  return fetch(url, options);
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    const body = await req.json();
    const { cliente_gc_id, negociacao_numero, os_codigos } = body;

    if (!cliente_gc_id || !os_codigos?.length) {
      return new Response(JSON.stringify({ error: "cliente_gc_id e os_codigos são obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const negNum = negociacao_numero || 0;
    console.log(`[tag-passivos] Cliente ${cliente_gc_id}, Neg ${negNum}, OS: ${os_codigos.join(", ")}`);

    // Buscar TODOS recebimentos do cliente
    const now = new Date();
    const dataInicio = new Date(now.getFullYear(), now.getMonth() - 6, 1).toISOString().slice(0, 10);
    const dataFim = new Date(now.getFullYear(), now.getMonth() + 12, 0).toISOString().slice(0, 10);

    let page = 1;
    let totalPages = 1;
    const allRecs: any[] = [];

    while (page <= totalPages) {
      const params = new URLSearchParams({
        limite: "100", pagina: String(page),
        cliente_id: cliente_gc_id, data_inicio: dataInicio, data_fim: dataFim,
      });
      const resp = await rateLimitedFetch(
        `${GC_BASE_URL}/api/recebimentos?${params.toString()}`, { headers: gcHeaders }
      );
      if (resp.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
      if (!resp.ok) { const t = await resp.text(); console.error(`[tag-passivos] list error ${resp.status}: ${t}`); break; }
      const data = await resp.json();
      allRecs.push(...(Array.isArray(data?.data) ? data.data : []));
      totalPages = data?.meta?.total_paginas || 1;
      page++;
    }

    console.log(`[tag-passivos] ${allRecs.length} recebimentos encontrados`);

    const osCodigosLower = os_codigos.map((c: string) => c.toLowerCase());
    let tagged = 0;
    let skipped = 0;
    const errors: string[] = [];

    for (const item of allRecs) {
      const rec = item?.Recebimento || item?.recebimento || item;
      const recId = String(rec?.id || "").trim();
      if (!recId) continue;

      const desc = String(rec?.descricao || "");
      const descUpper = desc.toUpperCase();

      // Já tageado? Pula
      if (descUpper.includes("NEG") || descUpper.includes("PASSIVO")) { skipped++; continue; }

      // Contém código de alguma OS?
      const descLower = desc.toLowerCase();
      const matchedIdx = osCodigosLower.findIndex((cod: string) =>
        descLower.includes(cod) || descLower.includes(`nº ${cod}`) || descLower.includes(`n° ${cod}`)
      );
      if (matchedIdx === -1) continue;

      const osOriginal = os_codigos[matchedIdx];

      // GET completo para campos obrigatórios do PUT
      const getResp = await rateLimitedFetch(
        `${GC_BASE_URL}/api/recebimentos/${recId}`, { headers: gcHeaders }
      );
      if (!getResp.ok) {
        const errText = await getResp.text();
        errors.push(`GET ${recId}: ${getResp.status} ${errText.slice(0, 100)}`);
        continue;
      }

      const getBody = await getResp.json();
      const recFull = getBody?.data?.[0]?.Recebimento || getBody?.data || getBody;
      if (!recFull) { errors.push(`${recId} not found`); continue; }

      const novaDescricao = `Passivo OS ${osOriginal} (negociação ${negNum}) - ${desc}`;

      // PUT — MESMOS 7 campos obrigatórios que o GC aceita
      // SEM observacoes (não existe na API de recebimentos do GC)
      const putPayload: Record<string, unknown> = {
        descricao: novaDescricao,
        data_vencimento: recFull.data_vencimento,
        plano_contas_id: recFull.plano_contas_id,
        forma_pagamento_id: recFull.forma_pagamento_id,
        conta_bancaria_id: recFull.conta_bancaria_id,
        valor: recFull.valor,
        data_competencia: recFull.data_competencia || recFull.data_vencimento,
      };

      console.log(`[tag-passivos] PUT ${recId} payload:`, JSON.stringify(putPayload));

      const putResp = await rateLimitedFetch(
        `${GC_BASE_URL}/api/recebimentos/${recId}`,
        { method: "PUT", headers: gcHeaders, body: JSON.stringify(putPayload) }
      );
      const putText = await putResp.text();
      let putData: any;
      try { putData = JSON.parse(putText); } catch { putData = {}; }

      if (putResp.ok || putData?.code === 200) {
        tagged++;
        console.log(`[tag-passivos] ✅ ${recId} → "${novaDescricao}"`);
      } else {
        errors.push(`PUT ${recId} (${putResp.status}): ${putText.slice(0, 150)}`);
        console.error(`[tag-passivos] ❌ PUT ${recId} (${putResp.status}): ${putText.slice(0, 200)}`);
      }
    }

    // Rodar scan-passivos para importar
    let scanResult: any = null;
    if (tagged > 0) {
      console.log(`[tag-passivos] Triggering scan-passivos...`);
      try {
        const scanResp = await fetch(`${supabaseUrl}/functions/v1/scan-passivos`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${supabaseKey}`, "Content-Type": "application/json" },
          body: "{}",
        });
        scanResult = await scanResp.json();
        console.log(`[tag-passivos] scan-passivos result:`, JSON.stringify(scanResult));
      } catch (e) { console.error(`[tag-passivos] Scan falhou:`, (e as Error).message); }
    }

    const result = {
      success: true, total_recebimentos: allRecs.length,
      tagged, skipped, errors: errors.length > 0 ? errors : undefined, scan_result: scanResult,
    };
    console.log(`[tag-passivos] Done:`, JSON.stringify(result));

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (error) {
    console.error(`[tag-passivos] Fatal:`, (error as Error).message);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
