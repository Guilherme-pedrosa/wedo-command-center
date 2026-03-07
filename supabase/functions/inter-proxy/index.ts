import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// ─── Reconstrução de PEM à prova de formatação ─────────────────
function buildPEM(raw: string, type: "CERTIFICATE" | "PRIVATE KEY"): string {
  if (!raw) return "";
  const stripped = raw
    .replace(/-----BEGIN[^-]+-----/g, "")
    .replace(/-----END[^-]+-----/g, "")
    .replace(/\s+/g, "")
    .replace(/\\n/g, "");
  const lines = stripped.match(/.{1,64}/g)?.join("\n") ?? stripped;
  return `-----BEGIN ${type}-----\n${lines}\n-----END ${type}-----\n`;
}

// ─── Cache de token ────────────────────────────────────────────
let cachedToken: string | null = null;
let tokenExpiry = 0;

async function getToken(): Promise<string> {
  const now = Date.now();
  if (cachedToken && now < tokenExpiry - 30_000) return cachedToken;

  const clientId     = (Deno.env.get("INTER_CLIENT_ID") ?? "").trim();
  const clientSecret = (Deno.env.get("INTER_CLIENT_SECRET") ?? "").trim();
  const certRaw      = Deno.env.get("INTER_CERT") ?? "";
  const keyRaw       = Deno.env.get("INTER_KEY") ?? "";

  if (!clientId || !clientSecret) throw new Error("INTER_CLIENT_ID ou INTER_CLIENT_SECRET não configurados");
  if (!certRaw || !keyRaw) throw new Error("INTER_CERT ou INTER_KEY não configurados");

  const cert = buildPEM(certRaw, "CERTIFICATE");
  const key  = buildPEM(keyRaw, "PRIVATE KEY");

  console.log("[inter-proxy] cert lines:", cert.split("\n").length, "key lines:", key.split("\n").length);
  console.log("[inter-proxy] cert valid:", cert.startsWith("-----BEGIN CERTIFICATE-----"));
  console.log("[inter-proxy] key valid:", key.startsWith("-----BEGIN PRIVATE KEY-----"));
  console.log("[inter-proxy] client_id prefix:", clientId.substring(0, 8));

  // @ts-ignore - Deno 1.x (Supabase edge runtime)
  let httpClient: Deno.HttpClient;
  try {
    // @ts-ignore
    httpClient = Deno.createHttpClient({ certChain: cert, privateKey: key });
  } catch (e) {
    console.warn("[inter-proxy] certChain falhou, tentando cert/key:", e.message);
    // @ts-ignore - fallback Deno 2.x
    httpClient = Deno.createHttpClient({ cert, key });
  }

  // Scopes mínimos — apenas os que existem na API Inter CDPJ
  const scope = "extrato.read cobv.write cobv.read pagamento-pix.write pagamento-pix.read";

  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  // Diagnóstico extra: primeiros 40 chars do base64 do cert e key
  const certB64 = certRaw.replace(/-----BEGIN[^-]+-----/g, "").replace(/-----END[^-]+-----/g, "").replace(/\s+/g, "").replace(/\\n/g, "");
  const keyB64 = keyRaw.replace(/-----BEGIN[^-]+-----/g, "").replace(/-----END[^-]+-----/g, "").replace(/\s+/g, "").replace(/\\n/g, "");
  console.log("[inter-proxy] cert b64 prefix:", certB64.substring(0, 40));
  console.log("[inter-proxy] key b64 prefix:", keyB64.substring(0, 40));
  console.log("[inter-proxy] cert b64 length:", certB64.length);
  console.log("[inter-proxy] key b64 length:", keyB64.length);

  console.log("[inter-proxy] POST /oauth/v2/token scope:", scope);

  const res = await fetch("https://cdpj.partners.bancointer.com.br/oauth/v2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    // @ts-ignore
    client: httpClient,
  });

  const responseText = await res.text();
  console.log("[inter-proxy] OAuth status:", res.status);
  console.log("[inter-proxy] OAuth body:", responseText.substring(0, 500));

  if (!res.ok) {
    throw new Error(`OAuth failed: ${res.status} - ${responseText}`);
  }

  const data = JSON.parse(responseText);
  cachedToken = data.access_token;
  tokenExpiry = now + (data.expires_in ?? 3600) * 1_000;
  return cachedToken!;
}

// ─── Handler principal ─────────────────────────────────────────
serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: CORS });
  }

  try {
    const { path, method = "GET", payload } = await req.json();

    if (!path) {
      return new Response(
        JSON.stringify({ error: "Campo 'path' é obrigatório" }),
        { status: 400, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    // Rota especial: testar autenticação
    if (path === "/test-auth") {
      const token = await getToken();
      return new Response(
        JSON.stringify({ ok: true, token_preview: token.substring(0, 20) + "..." }),
        { status: 200, headers: { ...CORS, "Content-Type": "application/json" } }
      );
    }

    const token = await getToken();
    const BASE = "https://cdpj.partners.bancointer.com.br";

    const certRaw = Deno.env.get("INTER_CERT") ?? "";
    const keyRaw  = Deno.env.get("INTER_KEY") ?? "";
    const cert = buildPEM(certRaw, "CERTIFICATE");
    const key  = buildPEM(keyRaw, "PRIVATE KEY");

    // @ts-ignore
    const apiClient = Deno.createHttpClient({ certChain: cert, privateKey: key });

    const fetchOptions: RequestInit & { client?: unknown } = {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-conta-corrente": Deno.env.get("INTER_NUMERO_CONTA") ?? "",
      },
      // @ts-ignore
      client: apiClient,
    };

    if (payload && method !== "GET") {
      fetchOptions.body = JSON.stringify(payload);
    }

    const apiRes = await fetch(`${BASE}${path}`, fetchOptions);
    const apiBody = await apiRes.text();

    let parsed: unknown;
    try { parsed = JSON.parse(apiBody); }
    catch { parsed = { raw: apiBody }; }

    return new Response(JSON.stringify(parsed), {
      status: apiRes.status,
      headers: { ...CORS, "Content-Type": "application/json" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[inter-proxy] ERRO:", msg);
    return new Response(
      JSON.stringify({ error: msg }),
      { status: 500, headers: { ...CORS, "Content-Type": "application/json" } }
    );
  }
});
