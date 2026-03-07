// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_BASE_URL = "https://cdpj.partners.bancointer.com.br";

// ─── Cache ─────────────────────────────────────────────────────
let cachedToken: { access_token: string; expires_at: number } | null = null;
let cachedCert: string | null = null;
let cachedKey: string | null = null;

// ─── Baixar certificados do Storage ────────────────────────────
async function loadCerts(): Promise<{ cert: string; key: string }> {
  if (cachedCert && cachedKey) return { cert: cachedCert, key: cachedKey };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: certData, error: certError } = await supabase.storage
    .from("inter-certs")
    .download("cert.pem");

  if (certError || !certData) {
    throw new Error(`Erro ao baixar cert.pem do storage: ${certError?.message ?? "arquivo não encontrado"}`);
  }

  const { data: keyData, error: keyError } = await supabase.storage
    .from("inter-certs")
    .download("key.pem");

  if (keyError || !keyData) {
    throw new Error(`Erro ao baixar key.pem do storage: ${keyError?.message ?? "arquivo não encontrado"}`);
  }

  cachedCert = await certData.text();
  cachedKey = await keyData.text();

  console.log("[inter-proxy] Certificados carregados do storage");
  console.log("[inter-proxy] cert lines:", cachedCert.split("\n").length);
  console.log("[inter-proxy] key lines:", cachedKey.split("\n").length);
  console.log("[inter-proxy] cert valid:", cachedCert.includes("BEGIN CERTIFICATE"));
  console.log("[inter-proxy] key valid:", cachedKey.includes("PRIVATE KEY"));

  return { cert: cachedCert, key: cachedKey };
}

// ─── OAuth Token ───────────────────────────────────────────────
async function getToken(cert: string, key: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expires_at) {
    return cachedToken.access_token;
  }

  const clientId = (Deno.env.get("INTER_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();

  if (!clientId || !clientSecret) {
    throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET não configurados");
  }

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read",
  });

  console.log("[inter-proxy] OAuth → POST /oauth/v2/token");
  console.log("[inter-proxy] client_id:", clientId.substring(0, 8) + "...");

  const httpClient = Deno.createHttpClient({ certChain: cert, privateKey: key });

  const res = await fetch(`${INTER_BASE_URL}/oauth/v2/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
    client: httpClient,
  });

  const responseText = await res.text();
  console.log("[inter-proxy] OAuth status:", res.status);
  console.log("[inter-proxy] OAuth body:", responseText.substring(0, 300));

  if (!res.ok) {
    throw new Error(`OAuth failed: ${res.status} - ${responseText}`);
  }

  const data = JSON.parse(responseText);
  cachedToken = {
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in - 60) * 1000,
  };
  return cachedToken.access_token;
}

// ─── Handler ───────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { path, method = "GET", payload } = await req.json();

    if (!path) {
      return new Response(
        JSON.stringify({ error: "Campo 'path' obrigatório" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const { cert, key } = await loadCerts();

    // Rota de diagnóstico
    if (path === "/test-auth") {
      const token = await getToken(cert, key);
      return new Response(
        JSON.stringify({ ok: true, preview: token.substring(0, 20) + "..." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const token = await getToken(cert, key);

    const httpClient = Deno.createHttpClient({ certChain: cert, privateKey: key });

    const fetchOptions = {
      method: method.toUpperCase(),
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-conta-corrente": Deno.env.get("INTER_NUMERO_CONTA") ?? "",
      },
      client: httpClient,
    };

    if (payload && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      fetchOptions.body = JSON.stringify(payload);
    }

    const response = await fetch(`${INTER_BASE_URL}${path}`, fetchOptions);
    const responseText = await response.text();

    let responseData;
    try { responseData = JSON.parse(responseText); }
    catch { responseData = { raw: responseText }; }

    return new Response(JSON.stringify(responseData), {
      status: response.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[inter-proxy] ERRO:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
