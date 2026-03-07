// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_HOST = "cdpj.partners.bancointer.com.br";

// ─── Cache ─────────────────────────────────────────────────────
let cachedCert: string | null = null;
let cachedKey: string | null = null;
let cachedToken = "";
let tokenExpiry = 0;

// ─── Carregar certs do Storage ─────────────────────────────────
async function loadCerts(): Promise<{ cert: string; key: string }> {
  if (cachedCert && cachedKey) return { cert: cachedCert, key: cachedKey };

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const { data: certData, error: certErr } = await supabase.storage.from("inter-certs").download("cert.pem");
  if (certErr || !certData) throw new Error(`Erro cert.pem: ${certErr?.message}`);

  const { data: keyData, error: keyErr } = await supabase.storage.from("inter-certs").download("key.pem");
  if (keyErr || !keyData) throw new Error(`Erro key.pem: ${keyErr?.message}`);

  cachedCert = await certData.text();
  cachedKey = await keyData.text();

  console.log("[inter] Certs carregados, cert valid:", cachedCert.includes("BEGIN CERTIFICATE"), "key valid:", cachedKey.includes("PRIVATE KEY"));
  return { cert: cachedCert, key: cachedKey };
}

// ─── Dechunk HTTP response ─────────────────────────────────────
function dechunk(body: string): string {
  let result = "";
  let rem = body;
  while (rem.length > 0) {
    const i = rem.indexOf("\r\n");
    if (i === -1) break;
    const size = parseInt(rem.slice(0, i).trim(), 16);
    if (isNaN(size) || size === 0) break;
    result += rem.slice(i + 2, i + 2 + size);
    rem = rem.slice(i + 2 + size + 2);
  }
  return result || body;
}

// ─── mTLS via Deno.connectTls (raw TLS socket) ────────────────
async function mTlsRequest(params: {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  cert: string;
  key: string;
}): Promise<{ status: number; body: string }> {
  const conn = await Deno.connectTls({
    hostname: INTER_HOST,
    port: 443,
    certChain: params.cert,
    privateKey: params.key,
  });

  try {
    const bodyBytes = params.body
      ? new TextEncoder().encode(params.body)
      : new Uint8Array(0);

    const headerStr = Object.entries({
      Host: INTER_HOST,
      "Content-Length": String(bodyBytes.length),
      Connection: "close",
      ...params.headers,
    })
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    const reqStr = `${params.method} ${params.path} HTTP/1.1\r\n${headerStr}\r\n\r\n`;
    const reqBytes = new TextEncoder().encode(reqStr);
    const full = new Uint8Array(reqBytes.length + bodyBytes.length);
    full.set(reqBytes);
    full.set(bodyBytes, reqBytes.length);

    await conn.write(full);

    // Lê resposta completa
    const buf = new Uint8Array(65536);
    const chunks: Uint8Array[] = [];
    let n: number | null;
    while ((n = await conn.read(buf)) !== null) {
      chunks.push(buf.slice(0, n));
    }

    const total = chunks.reduce((s, c) => s + c.length, 0);
    const all = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { all.set(c, off); off += c.length; }

    const text = new TextDecoder().decode(all);
    const sep = text.indexOf("\r\n\r\n");
    const headers = sep >= 0 ? text.slice(0, sep) : "";
    let bodyText = sep >= 0 ? text.slice(sep + 4) : text;

    if (headers.toLowerCase().includes("transfer-encoding: chunked")) {
      bodyText = dechunk(bodyText);
    }

    const m = headers.match(/HTTP\/\S+ (\d+)/);
    return { status: m ? parseInt(m[1]) : 0, body: bodyText.trim() };
  } finally {
    try { conn.close(); } catch { /* já fechado */ }
  }
}

// ─── OAuth Token ───────────────────────────────────────────────
async function getToken(cert: string, key: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) return cachedToken;

  const clientId = (Deno.env.get("INTER_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();

  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausentes");
  if (!cert.includes("BEGIN CERTIFICATE")) throw new Error("INTER_CERT inválido");
  if (!key.includes("PRIVATE KEY")) throw new Error("INTER_KEY inválido");

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope: "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read",
  }).toString();

  console.log("[inter] OAuth via Deno.connectTls, client_id:", clientId.slice(0, 8) + "...");

  const { status, body: resBody } = await mTlsRequest({
    path: "/oauth/v2/token",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    cert,
    key,
  });

  console.log("[inter] OAuth status:", status, "| body:", resBody.slice(0, 200));

  if (status !== 200) throw new Error(`OAuth failed: ${status} - ${resBody}`);

  const data = JSON.parse(resBody);
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  return cachedToken;
}

// ─── Handler ───────────────────────────────────────────────────
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

    if (path === "/test-auth") {
      const token = await getToken(cert, key);
      return new Response(
        JSON.stringify({ ok: true, preview: token.slice(0, 20) + "..." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const token = await getToken(cert, key);
    const bodyStr = payload && method !== "GET" ? JSON.stringify(payload) : undefined;

    const { status, body } = await mTlsRequest({
      path,
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-conta-corrente": Deno.env.get("INTER_NUMERO_CONTA") ?? "",
      },
      body: bodyStr,
      cert,
      key,
    });

    let parsed;
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
