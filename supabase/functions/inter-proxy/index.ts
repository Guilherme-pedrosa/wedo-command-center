// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import * as https from "node:https";
import * as querystring from "node:querystring";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_BASE = "cdpj.partners.bancointer.com.br";

// ─── Reconstrução de PEM ───────────────────────────────────────
function buildPEM(raw: string, type: "CERTIFICATE" | "PRIVATE KEY"): string {
  if (!raw) return "";
  const stripped = raw
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  const lines = stripped.match(/.{1,64}/g)?.join("\n") ?? stripped;
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
}

// ─── HTTPS com mTLS via node:https ─────────────────────────────
function nodeRequest(
  path: string,
  method: string,
  headers: Record<string, string>,
  body: string,
  cert: string,
  key: string
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: INTER_BASE,
      path,
      method,
      cert,
      key,
      headers: { ...headers, "Content-Length": Buffer.byteLength(body) },
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

// ─── Cache de token ────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(cert: string, key: string): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 30_000) return cachedToken;

  const clientId     = (Deno.env.get("INTER_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();

  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausentes");
  if (!cert || !key) throw new Error("INTER_CERT ou INTER_KEY ausentes");

  const scope = "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read";

  const bodyStr = querystring.stringify({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  console.log("[inter-proxy] OAuth → POST /oauth/v2/token");
  console.log("[inter-proxy] cert_ok:", cert.includes("BEGIN CERTIFICATE"));
  console.log("[inter-proxy] key_ok:", key.includes("PRIVATE KEY"));
  console.log("[inter-proxy] client_id:", clientId.substring(0, 8) + "...");

  const { status, body } = await nodeRequest(
    "/oauth/v2/token",
    "POST",
    { "Content-Type": "application/x-www-form-urlencoded" },
    bodyStr,
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

// ─── Handler principal ─────────────────────────────────────────
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

    const cert = buildPEM(Deno.env.get("INTER_CERT") ?? "", "CERTIFICATE");
    const key  = buildPEM(Deno.env.get("INTER_KEY") ?? "", "PRIVATE KEY");

    // Rota de diagnóstico
    if (path === "/test-auth") {
      const token = await getToken(cert, key);
      return new Response(
        JSON.stringify({ ok: true, preview: token.substring(0, 20) + "..." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const token   = await getToken(cert, key);
    const bodyStr = payload ? JSON.stringify(payload) : "";

    const { status, body } = await nodeRequest(
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
