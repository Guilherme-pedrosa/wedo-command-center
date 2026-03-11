import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    const { recebimento_id, atributo_id, valor } = await req.json();
    if (!recebimento_id || !atributo_id || valor === undefined) {
      return new Response(JSON.stringify({ error: "Parâmetros obrigatórios: recebimento_id, atributo_id, valor" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken!,
      "secret-access-token": gcSecretToken!,
      "Content-Type": "application/json",
    };

    const results: Record<string, unknown> = {};

    // ── Tentativa 1: PUT /api/recebimentos/{id}/atributos/{atributo_id}
    const t1 = await fetch(
      `${GC_BASE_URL}/api/recebimentos/${recebimento_id}/atributos/${atributo_id}`,
      { method: "PUT", headers: gcHeaders, body: JSON.stringify({ valor: String(valor) }) }
    );
    results.t1_status = t1.status;
    results.t1_body = await t1.text();

    if (t1.status < 400) {
      return new Response(JSON.stringify({ success: true, method: "PUT_sub_endpoint", ...results }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Tentativa 2: POST /api/recebimentos/{id}/atributos
    const t2 = await fetch(
      `${GC_BASE_URL}/api/recebimentos/${recebimento_id}/atributos`,
      { method: "POST", headers: gcHeaders, body: JSON.stringify({ atributo_id: Number(atributo_id), valor: String(valor) }) }
    );
    results.t2_status = t2.status;
    results.t2_body = await t2.text();

    if (t2.status < 400) {
      return new Response(JSON.stringify({ success: true, method: "POST_sub_endpoint", ...results }), {
        status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // ── Tentativa 3: PUT /api/recebimentos/{id} com atributos usando chave "id"
    const getResp = await fetch(`${GC_BASE_URL}/api/recebimentos/${recebimento_id}`, { headers: gcHeaders });
    const getRaw = await getResp.json();
    const payloadAtual = getRaw?.data ?? getRaw;

    const payloadT3 = {
      ...payloadAtual,
      atributos: [{ id: Number(atributo_id), valor: String(valor) }],
    };
    delete payloadT3.liquidado;
    delete payloadT3.data_liquidacao;

    const t3 = await fetch(`${GC_BASE_URL}/api/recebimentos/${recebimento_id}`, {
      method: "PUT", headers: gcHeaders, body: JSON.stringify(payloadT3),
    });
    results.t3_status = t3.status;
    results.t3_body = await t3.text();

    if (t3.status < 400) {
      try {
        const t3Json = JSON.parse(results.t3_body as string);
        const atribSalvo = t3Json?.data?.atributos?.find(
          (a: Record<string, unknown>) => a.id == atributo_id || a.atributo_id == atributo_id
        );
        if (atribSalvo?.valor === String(valor)) {
          return new Response(JSON.stringify({ success: true, method: "PUT_id_key", ...results }), {
            status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
          });
        }
      } catch { /* parse error, fall through */ }
    }

    return new Response(JSON.stringify({ success: false, message: "Nenhum método funcionou", ...results }), {
      status: 422, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
