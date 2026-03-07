import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_BASE_URL = "https://cdpj.partners.bancointer.com.br";

// In-memory token cache
let cachedToken: { access_token: string; expires_at: number } | null = null;

async function getAccessToken(clientId: string, clientSecret: string, cert: string, key: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read",
  });

  const response = await fetch(`${INTER_BASE_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    // @ts-ignore - Deno supports client certificates
    client: {
      certChain: cert,
      privateKey: key,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`OAuth failed: ${response.status} - ${text}`);
  }

  const data = await response.json();
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };

  return cachedToken.access_token;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const clientId = Deno.env.get("INTER_CLIENT_ID");
    const clientSecret = Deno.env.get("INTER_CLIENT_SECRET");
    const cert = Deno.env.get("INTER_CERT");
    const key = Deno.env.get("INTER_KEY");

    if (!clientId || !clientSecret || !cert || !key) {
      return new Response(
        JSON.stringify({ error: "Inter não configurado. Configure INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT e INTER_KEY." }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const body = await req.json();
    const { path, method = "GET", payload } = body as {
      path: string;
      method?: string;
      payload?: Record<string, unknown>;
    };

    if (!path) {
      return new Response(
        JSON.stringify({ error: "Missing 'path' parameter" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const token = await getAccessToken(clientId, clientSecret, cert, key);

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      // @ts-ignore
      client: { certChain: cert, privateKey: key },
    };

    if (payload && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const startTime = Date.now();
    const response = await fetch(`${INTER_BASE_URL}${path}`, fetchOptions);
    const duration = Date.now() - startTime;

    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
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
