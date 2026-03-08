import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

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

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(
        JSON.stringify({ error: "GC credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { endpoint, method = "GET", payload, params } = body as {
      endpoint: string;
      method?: string;
      payload?: Record<string, unknown>;
      params?: Record<string, string>;
    };

    if (!endpoint) {
      return new Response(
        JSON.stringify({ error: "Missing 'endpoint' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build URL with query params
    let url = `${GC_BASE_URL}${endpoint}`;
    if (params && Object.keys(params).length > 0) {
      const searchParams = new URLSearchParams(params);
      url += `?${searchParams.toString()}`;
    }

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: gcHeaders,
    };

    if (payload && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const startTime = Date.now();
    const response = await rateLimitedFetch(url, fetchOptions);
    const duration = Date.now() - startTime;

    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    // ── ENRIQUECIMENTO DE CNPJ para contas a pagar ──
    if (
      method.toUpperCase() === "GET" &&
      (endpoint.includes("contasapagar") ||
       endpoint.includes("contas_a_pagar") ||
       endpoint.includes("financeiro"))
    ) {
      try {
        const { createClient } = await import("https://esm.sh/@supabase/supabase-js@2");
        const supabase = createClient(
          Deno.env.get("SUPABASE_URL")!,
          Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
        );

        const lista: any[] = Array.isArray(responseData)
          ? responseData
          : (responseData as any)?.data ?? [];

        for (const item of lista) {
          const codigoGc = item.codigo ?? item.id;
          const contatoId = item.contato_id ?? item.fornecedor_id ?? item.cliente_id;
          if (!codigoGc || !contatoId) continue;

          const contatoResp = await rateLimitedFetch(
            `${GC_BASE_URL}/contatos/${contatoId}`,
            { headers: gcHeaders }
          ).then(r => r.json()).catch(() => null);

          const cnpjRaw = contatoResp?.cnpj ?? contatoResp?.cpf_cnpj ?? contatoResp?.cpf ?? null;
          if (!cnpjRaw) continue;

          const cnpj = String(cnpjRaw).replace(/\D/g, "");
          if (cnpj.length < 11) continue;

          await supabase
            .from("fin_pagamentos")
            .update({ recipient_document: cnpj })
            .eq("gc_codigo", String(codigoGc))
            .is("recipient_document", null)
            .then(({ error }: any) => {
              if (error) console.error(`[gc-proxy] Erro enriquecer ${codigoGc}:`, error.message);
            });
        }
      } catch (enrichErr: any) {
        console.error("[gc-proxy] Erro no enriquecimento CNPJ:", enrichErr.message);
      }
    }

    return new Response(
      JSON.stringify({
        status: response.status,
        data: responseData,
        duration_ms: duration,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
