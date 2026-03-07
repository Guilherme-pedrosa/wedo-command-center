import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_BASE_URL = "https://cdpj.partners.bancointer.com.br";

// In-memory token cache
let cachedToken: { access_token: string; expires_at: number } | null = null;

/** Normalize PEM: secrets often arrive with literal "\n" instead of newlines */
function normalizePem(pem: string): string {
  // Replace literal \n with real newlines
  let normalized = pem.replace(/\\n/g, "\n");
  // Ensure proper PEM structure with newlines after header and before footer
  normalized = normalized.replace(/-----BEGIN ([A-Z ]+)-----\s*/g, "-----BEGIN $1-----\n");
  normalized = normalized.replace(/\s*-----END ([A-Z ]+)-----/g, "\n-----END $1-----\n");
  return normalized.trim();
}

async function getAccessToken(
  clientId: string,
  clientSecret: string,
  cert: string,
  key: string
): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope:
      "extrato.read cobv.write cobv.read cobv.cancel pagamento-pix.write pagamento-pix.read",
  });

  // @ts-ignore - Deno supports createHttpClient
  const client = Deno.createHttpClient({ certChain: cert, privateKey: key });

  const response = await fetch(`${INTER_BASE_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    // @ts-ignore
    client,
  });

  if (!response.ok) {
    const text = await response.text();
    console.error("OAuth error:", response.status, text, "clientId:", clientId?.substring(0, 8) + "...");
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
    const clientId = Deno.env.get("INTER_CLIENT_ID")?.trim();
    const clientSecret = Deno.env.get("INTER_CLIENT_SECRET")?.trim();
    const cert = normalizePem(Deno.env.get("INTER_CERT") ?? "");
    const key = normalizePem(Deno.env.get("INTER_KEY") ?? "");

    if (!clientId || !clientSecret || !cert || !key) {
      return new Response(
        JSON.stringify({
          error: "INTER_NOT_CONFIGURED",
          message:
            "Certificados mTLS não configurados. Configure INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT e INTER_KEY.",
        }),
        {
          status: 503,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
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
        {
          status: 400,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
    }

    const token = await getAccessToken(clientId, clientSecret, cert, key);

    // @ts-ignore
    const client = Deno.createHttpClient({ certChain: cert, privateKey: key });

    const fetchOptions: RequestInit & { client?: unknown } = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-conta-corrente": Deno.env.get("INTER_NUMERO_CONTA") ?? "",
      },
      // @ts-ignore
      client,
    };

    if (
      payload &&
      ["POST", "PUT", "PATCH"].includes(method.toUpperCase())
    ) {
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
      responseData = { raw: responseText };
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
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
