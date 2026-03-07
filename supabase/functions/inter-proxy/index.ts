// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Buffer } from "node:buffer";
import * as https from "node:https";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_HOST = "cdpj.partners.bancointer.com.br";

// ─── Cache ─────────────────────────────────────────────────────
let cachedCert: string | null = null;
let cachedKey: string | null = null;
let cachedToken: string | null = null;
let tokenExpiry = 0;

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
  if (certError || !certData) throw new Error(`Erro cert.pem: ${certError?.message}`);

  const { data: keyData, error: keyError } = await supabase.storage
    .from("inter-certs")
    .download("key.pem");
  if (keyError || !keyData) throw new Error(`Erro key.pem: ${keyError?.message}`);

  cachedCert = await certData.text();
  cachedKey = await keyData.text();

  console.log("[inter-proxy] Certs carregados do storage");
  console.log("[inter-proxy] cert valid:", cachedCert.includes("BEGIN CERTIFICATE"));
  console.log("[inter-proxy] key valid:", cachedKey.includes("PRIVATE KEY"));

  return { cert: cachedCert, key: cachedKey };
}

// ─── HTTPS request com mTLS via node:https ─────────────────────
function httpsRequest(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  cert: string,
  key: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: INTER_HOST,
      port: 443,
      path,
      method,
      cert,
      key,
      headers: {
        ...headers,
        "Content-Length": Buffer.byteLength(body).toString(),
      },
      rejectUnauthorized: true,
    };

    const req = https.request(options, (res) => {
      let data = "";
      res.on("data", (chunk) => (data += chunk.toString()));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }));
    });

    req.on("error", (e) => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

// ─── OAuth Token ───────────────────────────────────────────────
async function getToken(cert: string, key: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 30_000) return cachedToken;

  const clientId = (Deno.env.get("INTER_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();

  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausentes");

  const params = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read",
  });

  console.log("[inter-proxy] OAuth via node:https, client_id:", clientId.substring(0, 8) + "...");

  const { status, body } = await httpsRequest(
    "/oauth/v2/token",
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    params.toString(),
    cert,
    key
  );

  console.log("[inter-proxy] OAuth status:", status);
  console.log("[inter-proxy] OAuth body:", body.substring(0, 300));

  if (status !== 200) throw new Error(`OAuth failed: ${status} - ${body}`);

  const data = JSON.parse(body);
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in ?? 3600) * 1_000;
  return cachedToken!;
}

// ─── Handler ───────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { path, method = "GET", payload } = await req.json();
    if (!path) {
      return new Response(
        JSON.stringify({ error: "Campo 'path' obrigatório" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const { cert, key } = await loadCerts();

    if (path === "/test-auth") {
      const token = await getToken(cert, key);
      return new Response(
        JSON.stringify({ ok: true, preview: token.substring(0, 20) + "..." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const token = await getToken(cert, key);
    const bodyStr = payload ? JSON.stringify(payload) : "";

    const { status, body } = await httpsRequest(
      path,
      method,
      {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-conta-corrente": Deno.env.get("INTER_NUMERO_CONTA") ?? "",
      },
      bodyStr,
      cert,
      key
    );

    let parsed;
    try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

    return new Response(JSON.stringify(parsed), {
      status,
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
