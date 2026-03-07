// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_BASE = "https://cdpj.partners.bancointer.com.br";

// ─── Cache ─────────────────────────────────────────────────────
let cachedCert: string | null = null;
let cachedKey: string | null = null;
let cachedToken = "";
let tokenExpiry = 0;
let cachedHttpClient: Deno.HttpClient | null = null;

// ─── PEM builder ──────────────────────────────────────────────
function buildPEM(raw: string, type: "CERTIFICATE" | "PRIVATE KEY"): string {
  if (!raw?.trim()) throw new Error(`PEM ${type} vazio`);
  // Se já tem header PEM, retorna direto (limpando \n literais)
  if (raw.includes(`-----BEGIN ${type}-----`)) {
    return raw.replace(/\\n/g, "\n");
  }
  // Senão, reconstrói a partir de base64 puro
  const b64 = raw
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error(`Base64 de ${type} vazio após limpeza`);
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
}

// ─── Carregar certs: Secrets primeiro, Storage fallback ───────
async function loadCerts(): Promise<{ cert: string; key: string }> {
  if (cachedCert && cachedKey) return { cert: cachedCert, key: cachedKey };

  // 1. Tenta Secrets
  const certSecret = (Deno.env.get("INTER_CERT") ?? "").trim();
  const keySecret = (Deno.env.get("INTER_KEY") ?? "").trim();

  if (certSecret && keySecret) {
    try {
      cachedCert = buildPEM(certSecret, "CERTIFICATE");
      cachedKey = buildPEM(keySecret, "PRIVATE KEY");
      console.log("[inter] Certs das Secrets ✅ cert_len:", cachedCert.length, "key_len:", cachedKey.length);
      return { cert: cachedCert, key: cachedKey };
    } catch (e) {
      console.warn("[inter] Falha ao parsear Secrets:", e.message);
    }
  }

  // 2. Fallback: Storage
  console.log("[inter] Tentando Storage...");
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: certData, error: certErr } = await supabase.storage.from("inter-certs").download("cert.pem");
  if (certErr || !certData) throw new Error(`cert.pem não encontrado: ${certErr?.message}`);

  const { data: keyData, error: keyErr } = await supabase.storage.from("inter-certs").download("key.pem");
  if (keyErr || !keyData) throw new Error(`key.pem não encontrado: ${keyErr?.message}`);

  cachedCert = await certData.text();
  cachedKey = await keyData.text();
  console.log("[inter] Certs do Storage ✅");
  return { cert: cachedCert, key: cachedKey };
}

// ─── Criar HTTP client com mTLS ───────────────────────────────
function getHttpClient(cert: string, key: string): Deno.HttpClient {
  if (cachedHttpClient) return cachedHttpClient;
  cachedHttpClient = Deno.createHttpClient({
    certChain: cert,
    privateKey: key,
  });
  return cachedHttpClient;
}

// ─── mTLS request via fetch + Deno.createHttpClient ───────────
async function mTlsFetch(opts: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cert: string;
  key: string;
}): Promise<{ status: number; body: string }> {
  const client = getHttpClient(opts.cert, opts.key);

  const response = await fetch(opts.url, {
    method: opts.method,
    headers: opts.headers,
    body: opts.body ?? undefined,
    client,
  });

  const body = await response.text();
  return { status: response.status, body };
}

// ─── OAuth Token ──────────────────────────────────────────────
async function getToken(cert: string, key: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) return cachedToken;

  const clientId = (Deno.env.get("INTER_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();

  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausentes");

  const scope = "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  }).toString();

  console.log("[inter] OAuth → client_id:", clientId.slice(0, 8) + "...", "method: fetch+createHttpClient");

  const { status, body: resBody } = await mTlsFetch({
    url: `${INTER_BASE}/oauth/v2/token`,
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cert,
    key,
  });

  console.log("[inter] OAuth status:", status, "| body:", resBody.slice(0, 300));

  if (status !== 200) throw new Error(`OAuth failed: ${status} - ${resBody}`);

  const data = JSON.parse(resBody);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

// ─── Handler ──────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  try {
    const { path, method = "GET", payload } = await req.json();
    if (!path) {
      return new Response(
        JSON.stringify({ error: "path obrigatório" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const { cert, key } = await loadCerts();

    // Diagnóstico: verificar certs
    if (path === "/test-certs") {
      return new Response(
        JSON.stringify({
          cert_ok: cert.includes("BEGIN CERTIFICATE"),
          key_ok: key.includes("PRIVATE KEY"),
          cert_len: cert.length,
          key_len: key.length,
          cert_preview: cert.slice(0, 80),
        }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Diagnóstico: testar OAuth
    if (path === "/test-auth") {
      const token = await getToken(cert, key);
      return new Response(
        JSON.stringify({ ok: true, preview: token.slice(0, 20) + "..." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const token = await getToken(cert, key);
    const bodyStr = payload && method !== "GET" ? JSON.stringify(payload) : undefined;
    const numeroConta = (Deno.env.get("INTER_NUMERO_CONTA") ?? "").trim();

    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (numeroConta) reqHeaders["x-conta-corrente"] = numeroConta;

    const { status, body } = await mTlsFetch({
      url: `${INTER_BASE}${path}`,
      method,
      headers: reqHeaders,
      body: bodyStr,
      cert,
      key,
    });

    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

    return new Response(JSON.stringify(parsed), {
      status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[inter] ERRO:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
