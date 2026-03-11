// @ts-nocheck
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const INTER_HOST = "cdpj.partners.bancointer.com.br";
const INTER_PORT = 443;

// ─── Cache ─────────────────────────────────────────────────────
let cachedCert: string | null = null;
let cachedKey: string | null = null;
const tokenCache: Record<string, { token: string; expiry: number }> = {};

// ─── PEM builder ──────────────────────────────────────────────
function buildPEM(raw: string, type: "CERTIFICATE" | "PRIVATE KEY"): string {
  if (!raw?.trim()) throw new Error(`PEM ${type} vazio`);
  if (raw.includes(`-----BEGIN ${type}-----`)) {
    return raw.replace(/\\n/g, "\n").trim() + "\n";
  }
  const b64 = raw
    .replace(/-----BEGIN[^-]*-----/g, "")
    .replace(/-----END[^-]*-----/g, "")
    .replace(/\\n/g, "")
    .replace(/\s+/g, "");
  if (!b64) throw new Error(`Base64 de ${type} vazio`);
  const lines = b64.match(/.{1,64}/g)?.join("\n") ?? b64;
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
}

// ─── Carregar certs ───────────────────────────────────────────
async function loadCerts(): Promise<{ cert: string; key: string }> {
  if (cachedCert && cachedKey) return { cert: cachedCert, key: cachedKey };

  const certSecret = (Deno.env.get("INTER_CERT") ?? "").trim();
  const keySecret  = (Deno.env.get("INTER_KEY")  ?? "").trim();

  if (certSecret && keySecret) {
    cachedCert = buildPEM(certSecret, "CERTIFICATE");
    cachedKey  = buildPEM(keySecret,  "PRIVATE KEY");
    console.log("[inter-proxy] Certs das Secrets ✅ cert_len:", cachedCert.length, "key_len:", cachedKey.length);
    return { cert: cachedCert, key: cachedKey };
  }

  // Fallback: Storage
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );
  const { data: certData, error: certErr } = await supabase.storage
    .from("inter-certs").download("cert.pem");
  if (certErr || !certData) throw new Error(`cert.pem não encontrado: ${certErr?.message}`);
  const { data: keyData, error: keyErr } = await supabase.storage
    .from("inter-certs").download("key.pem");
  if (keyErr || !keyData) throw new Error(`key.pem não encontrado: ${keyErr?.message}`);

  cachedCert = await certData.text();
  cachedKey  = await keyData.text();
  console.log("[inter-proxy] Certs do Storage ✅");
  return { cert: cachedCert, key: cachedKey };
}

// ─── Concat Uint8Arrays ───────────────────────────────────────
function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((acc, arr) => acc + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

// ─── Parse chunked body ───────────────────────────────────────
function parseChunkedBody(chunkedBody: string): string {
  try {
    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    const bodyBytes = encoder.encode(chunkedBody);

    const resultChunks: Uint8Array[] = [];
    let offset = 0;
    let iterations = 0;
    const maxIterations = 500;

    while (offset < bodyBytes.length && iterations < maxIterations) {
      iterations++;

      let lineEnd = -1;
      for (let i = offset; i < bodyBytes.length - 1; i++) {
        if (bodyBytes[i] === 0x0D && bodyBytes[i + 1] === 0x0A) {
          lineEnd = i;
          break;
        }
      }
      if (lineEnd === -1) break;

      const sizeStr = decoder.decode(bodyBytes.subarray(offset, lineEnd)).trim();
      if (!sizeStr || !/^[0-9a-fA-F]+$/.test(sizeStr)) break;

      const chunkSize = parseInt(sizeStr, 16);
      if (isNaN(chunkSize) || chunkSize === 0) break;
      if (chunkSize > 10000000) break;

      const chunkStart = lineEnd + 2;
      const chunkEnd = chunkStart + chunkSize;

      if (chunkEnd > bodyBytes.length) break;

      resultChunks.push(bodyBytes.subarray(chunkStart, chunkEnd));
      offset = chunkEnd + 2;
    }

    const totalLength = resultChunks.reduce((acc, chunk) => acc + chunk.length, 0);
    const result = new Uint8Array(totalLength);
    let pos = 0;
    for (const chunk of resultChunks) {
      result.set(chunk, pos);
      pos += chunk.length;
    }

    return decoder.decode(result);
  } catch (e) {
    console.error("[inter-proxy] Erro no parseChunkedBody:", e);
    return "";
  }
}

// ─── mTLS via Deno.connectTls (usando cert/key como no WAI ERP) ──
async function makeHttpsRequest(
  method: string,
  path: string,
  headers: Record<string, string>,
  body: string | null,
  cert: string,
  key: string
): Promise<{ status: number; body: string }> {
  console.log(`[inter-proxy] Making ${method} request to ${path}`);

  // IMPORTANTE: usar "cert" e "key" (não "certChain"/"privateKey")
  // Isso é o que funciona no WAI ERP
  const conn = await Deno.connectTls({
    hostname: INTER_HOST,
    port: INTER_PORT,
    cert: cert,
    key: key,
  });

  try {
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\r\n");

    let request = `${method} ${path} HTTP/1.1\r\n`;
    request += `Host: ${INTER_HOST}\r\n`;
    request += headerLines + "\r\n";

    if (body) {
      request += `Content-Length: ${new TextEncoder().encode(body).length}\r\n`;
    }
    request += "\r\n";

    if (body) {
      request += body;
    }

    const encoder = new TextEncoder();
    await conn.write(encoder.encode(request));

    const decoder = new TextDecoder();
    const chunks: Uint8Array[] = [];
    let totalSize = 0;

    let readAttempts = 0;
    const maxAttempts = 50;

    while (readAttempts < maxAttempts) {
      const buffer = new Uint8Array(131072);
      const n = await conn.read(buffer);
      if (n === null) break;

      chunks.push(buffer.subarray(0, n));
      totalSize += n;

      const tempResponse = decoder.decode(concatUint8Arrays(chunks));

      if (tempResponse.includes("\r\n\r\n")) {
        const headerEndIndex = tempResponse.indexOf("\r\n\r\n");
        const headersPart = tempResponse.substring(0, headerEndIndex);

        const contentLengthMatch = headersPart.match(/Content-Length:\s*(\d+)/i);
        if (contentLengthMatch) {
          const contentLength = parseInt(contentLengthMatch[1]);
          const bodyStart = headerEndIndex + 4;
          const currentBodyLength = new TextEncoder().encode(tempResponse.substring(bodyStart)).length;
          if (currentBodyLength >= contentLength) break;
        } else if (headersPart.toLowerCase().includes("transfer-encoding: chunked")) {
          if (tempResponse.includes("\r\n0\r\n\r\n")) break;
        }
      }

      readAttempts++;

      if (readAttempts % 5 === 0) {
        await new Promise(r => setTimeout(r, 50));
      }
    }

    const response = decoder.decode(concatUint8Arrays(chunks));
    console.log(`[inter-proxy] Total bytes lidos: ${totalSize}`);

    const headerEndIndex = response.indexOf("\r\n\r\n");
    if (headerEndIndex === -1) {
      throw new Error("Invalid HTTP response - no header end found");
    }

    const headersPart = response.substring(0, headerEndIndex);
    const bodyPart = response.substring(headerEndIndex + 4);

    const statusLine = headersPart.split("\r\n")[0];
    const statusMatch = statusLine.match(/HTTP\/[\d.]+\s+(\d+)/);
    const status = statusMatch ? parseInt(statusMatch[1]) : 500;

    let finalBody = bodyPart;
    if (headersPart.toLowerCase().includes("transfer-encoding: chunked")) {
      finalBody = parseChunkedBody(bodyPart);
    }

    console.log(`[inter-proxy] Response status: ${status}, body length: ${finalBody.length}`);
    return { status, body: finalBody };
  } finally {
    conn.close();
  }
}

// ─── OAuth Token ──────────────────────────────────────────────
async function getToken(cert: string, key: string): Promise<string> {
  if (cachedToken && Date.now() < tokenExpiry - 30_000) return cachedToken;

  const clientId     = (Deno.env.get("INTER_CLIENT_ID")     ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();
  if (!clientId || !clientSecret)
    throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET ausentes");

  const scope = "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read";
  const bodyStr = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
    scope,
  }).toString();

  console.log("[inter-proxy] OAuth via Deno.connectTls (cert/key), client_id:", clientId.slice(0, 8) + "...");

  const { status, body: resBody } = await makeHttpsRequest(
    "POST",
    "/oauth/v2/token",
    { "Content-Type": "application/x-www-form-urlencoded" },
    bodyStr,
    cert,
    key
  );

  console.log("[inter-proxy] OAuth status:", status, "| body:", resBody.slice(0, 300));

  if (status !== 200) throw new Error(`OAuth failed (${status}): ${resBody}`);

  const data = JSON.parse(resBody);
  if (!data.access_token) throw new Error(`OAuth response missing access_token: ${resBody}`);

  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in ?? 3600) * 1000;
  console.log("[inter-proxy] OAuth token obtained, scope:", data.scope);
  return cachedToken;
}

// ─── Handler ──────────────────────────────────────────────────
serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const { path, method = "GET", payload } = await req.json();
    if (!path) {
      return new Response(
        JSON.stringify({ error: "path obrigatório" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const { cert, key } = await loadCerts();

    // ── Diagnóstico: test-certs ──────────────────────────────
    if (path === "/test-certs") {
      return new Response(
        JSON.stringify({
          cert_ok: cert.includes("BEGIN CERTIFICATE"),
          key_ok: key.includes("PRIVATE KEY"),
          cert_len: cert.length,
          key_len: key.length,
          method: "Deno.connectTls(cert,key)",
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Diagnóstico: test-auth ───────────────────────────────
    if (path === "/test-auth") {
      const token = await getToken(cert, key);
      return new Response(
        JSON.stringify({ ok: true, preview: token.slice(0, 20) + "...", method: "Deno.connectTls(cert,key)" }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ── Requisição normal ────────────────────────────────────
    const token = await getToken(cert, key);
    const bodyStr = payload && method !== "GET" ? JSON.stringify(payload) : undefined;
    const numeroConta = (Deno.env.get("INTER_NUMERO_CONTA") ?? "").trim();

    const reqHeaders: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (numeroConta) reqHeaders["x-conta-corrente"] = numeroConta;

    const { status, body } = await makeHttpsRequest(
      method,
      path,
      reqHeaders,
      bodyStr ?? null,
      cert,
      key
    );

    let parsed: unknown;
    try { parsed = JSON.parse(body); } catch { parsed = { raw: body }; }

    return new Response(JSON.stringify(parsed), {
      status,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[inter-proxy] ERRO:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
