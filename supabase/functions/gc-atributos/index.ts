import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { recebimento_id, atributo_id, valor } = await req.json();
    if (!recebimento_id || !atributo_id || valor === undefined) {
      return new Response(JSON.stringify({ error: "Parâmetros obrigatórios: recebimento_id, atributo_id, valor" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // 1. GET fresh payload from GC
    console.log(`[gc-atributos] GET /api/recebimentos/${recebimento_id}`);
    const getResp = await fetch(`${GC_BASE_URL}/api/recebimentos/${recebimento_id}`, { headers: gcHeaders });
    const getRaw = await getResp.json();
    const payloadAtual = getRaw?.data ?? getRaw;

    if (!payloadAtual?.id) {
      return new Response(JSON.stringify({ success: false, message: `Recebimento ${recebimento_id} não encontrado no GC`, getRaw }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // 2. Build PUT payload with atributo_id key (what GC expects)
    const payload = {
      ...payloadAtual,
      atributos: [{ atributo_id: Number(atributo_id), valor: String(valor) }],
    };

    // Remove campos que causam conflito
    delete payload.liquidado;
    delete payload.data_liquidacao;

    console.log(`[gc-atributos] PUT /api/recebimentos/${recebimento_id} atributos:`, JSON.stringify(payload.atributos));

    await new Promise((r) => setTimeout(r, MIN_DELAY_MS));

    const putResp = await fetch(`${GC_BASE_URL}/api/recebimentos/${recebimento_id}`, {
      method: "PUT", headers: gcHeaders, body: JSON.stringify(payload),
    });
    const putStatus = putResp.status;
    const putBody = await putResp.text();

    console.log(`[gc-atributos] PUT status=${putStatus} body=${putBody.substring(0, 500)}`);

    // Parse response — GC sometimes returns HTML errors before JSON
    const jsonMatch = putBody.match(/\{"code":\d+.*\}$/s);
    let parsedResponse: any = null;
    if (jsonMatch) {
      try { parsedResponse = JSON.parse(jsonMatch[0]); } catch { /* ignore */ }
    } else {
      try { parsedResponse = JSON.parse(putBody); } catch { /* ignore */ }
    }

    // Check if GC returned success
    if (parsedResponse?.status === "success" || parsedResponse?.code === 200) {
      // Verify attribute was actually saved
      const savedAttrs = parsedResponse?.data?.atributos || [];
      const found = savedAttrs.find((a: any) =>
        (a.atributo_id == atributo_id || a.id == atributo_id) && a.valor === String(valor)
      );

      return new Response(JSON.stringify({
        success: true,
        verified: !!found,
        put_status: putStatus,
        gc_response: parsedResponse,
      }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Error from GC
    return new Response(JSON.stringify({
      success: false,
      message: parsedResponse?.data?.mensagem || "GC retornou erro ao gravar atributo",
      put_status: putStatus,
      gc_response: parsedResponse,
      raw_body_preview: putBody.substring(0, 300),
    }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("[gc-atributos] Error:", (err as Error).message);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
