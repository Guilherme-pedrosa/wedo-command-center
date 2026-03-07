import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_BASE_URL = "https://cdpj.partners.bancointer.com.br";

// In-memory token cache
let cachedToken: { access_token: string; expires_at: number } | null = null;

// ─── Reconstrói PEM a partir do base64 puro, à prova de formatação ───
function rebuildPEM(raw: string, type: "CERTIFICATE" | "PRIVATE KEY"): string {
  if (!raw) return "";
  const header = `-----BEGIN ${type}-----`;
  const footer = `-----END ${type}-----`;
  // Remove headers/footers caso existam, e qualquer whitespace
  const clean = raw
    .replace(/-----BEGIN [A-Z ]+-----/g, "")
    .replace(/-----END [A-Z ]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const lines = clean.match(/.{1,64}/g)?.join("\n") ?? clean;
  return `${header}\n${lines}\n${footer}\n`;
}

async function getToken(
  clientId: string,
  clientSecret: string,
  cert: string,
  key: string
): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  // @ts-ignore - Deno supports createHttpClient
  const httpClient = Deno.createHttpClient({ certChain: cert, privateKey: key });

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "extrato.read cobv.write cobv.read pix.write pix.read pagamento-pix.write pagamento-pix.read",
  });

  const res = await fetch(`${INTER_BASE_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    // @ts-ignore
    client: httpClient,
  });

  if (!res.ok) {
    const errorBody = await res.text();
    console.error("[inter-proxy] OAuth falhou", {
      status: res.status,
      body: errorBody,
      cert_ok: cert.includes("BEGIN CERTIFICATE"),
      key_ok: key.includes("PRIVATE KEY"),
      client_id: clientId ? clientId.substring(0, 8) + "..." : "AUSENTE",
      secret_set: !!clientSecret,
      cert_lines: cert.split("\n").length,
      key_lines: key.split("\n").length,
    });
    throw new Error(`OAuth ${res.status}: ${errorBody}`);
  }

  const data = await res.json();
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
    const clientId = Deno.env.get("INTER_CLIENT_ID")?.trim() ?? "";
    const clientSecret = Deno.env.get("INTER_CLIENT_SECRET")?.trim() ?? "";
    const certRaw = Deno.env.get("INTER_CERT") ?? "";
    const keyRaw = Deno.env.get("INTER_KEY") ?? "";

    const cert = rebuildPEM(certRaw, "CERTIFICATE");
    const key = rebuildPEM(keyRaw, "PRIVATE KEY");

    if (!clientId || !clientSecret) {
      return new Response(
        JSON.stringify({ error: "INTER_NOT_CONFIGURED", message: "INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausentes." }),
        { status: 503, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!cert.includes("-----BEGIN CERTIFICATE-----")) {
      return new Response(
        JSON.stringify({ error: "INTER_CERT inválido ou ausente", raw_length: certRaw.length }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (!key.includes("PRIVATE KEY")) {
      return new Response(
        JSON.stringify({ error: "INTER_KEY inválido ou ausente", raw_length: keyRaw.length }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const reqBody = await req.json();
    const { path, method = "GET", payload } = reqBody as {
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

    const token = await getToken(clientId, clientSecret, cert, key);

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
      responseData = { raw: responseText };
    }

    return new Response(
      JSON.stringify({ status: response.status, data: responseData, duration_ms: duration }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
