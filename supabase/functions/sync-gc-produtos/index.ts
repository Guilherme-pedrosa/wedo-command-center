import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
const PAGE_SIZE = 200;
const MAX_PAGES = 50; // hard cap 10k produtos por execução
let lastCall = 0;

async function rl(url: string, init: RequestInit): Promise<Response> {
  const now = Date.now();
  const delta = now - lastCall;
  if (delta < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - delta));
  lastCall = Date.now();
  return fetch(url, init);
}

function num(v: any): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : parseFloat(String(v).replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const t0 = Date.now();
  try {
    const accessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const secretToken = Deno.env.get("GC_SECRET_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!accessToken || !secretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, serviceKey);
    const headers: Record<string, string> = {
      "access-token": accessToken,
      "secret-access-token": secretToken,
      "Content-Type": "application/json",
    };

    let source = "manual";
    try { const b = await req.json(); source = b?.source ?? "manual"; } catch {}

    let totalUpserted = 0;
    let totalFetched = 0;
    let pageErrors = 0;

    for (let page = 1; page <= MAX_PAGES; page++) {
      const url = `${GC_BASE_URL}/api/produtos?pagina=${page}&limite=${PAGE_SIZE}`;
      const resp = await rl(url, { headers });
      if (!resp.ok) {
        const txt = await resp.text();
        console.error(`[sync-gc-produtos] page=${page} status=${resp.status} body=${txt.slice(0,200)}`);
        pageErrors++;
        if (resp.status === 429 || resp.status >= 500) {
          await new Promise((r) => setTimeout(r, 5000));
          continue;
        }
        break;
      }
      const json = await resp.json();
      const items: any[] = Array.isArray(json?.data) ? json.data : [];
      if (items.length === 0) break;
      totalFetched += items.length;

      const rows = items.map((p) => ({
        gc_id: String(p.id),
        codigo: p.codigo_interno ?? p.codigo ?? null,
        nome: p.nome ?? "(sem nome)",
        descricao: p.descricao ?? null,
        unidade: p.unidade ?? null,
        ncm: p.ncm ?? null,
        cfop: p.cfop ?? null,
        preco_venda: num(p.valor_venda ?? p.preco_venda ?? p.preco),
        preco_custo: num(p.valor_custo ?? p.preco_custo ?? p.custo),
        estoque: num(p.estoque ?? p.estoque_atual),
        marca: p.marca?.nome ?? p.marca ?? null,
        categoria: p.categoria?.nome ?? p.categoria ?? null,
        ativo: p.ativo === undefined ? true : !(p.ativo === false || p.ativo === "0" || p.ativo === 0),
        payload_raw: p,
        last_synced_at: new Date().toISOString(),
      }));

      const { error } = await supabase
        .from("gc_produtos_cache")
        .upsert(rows, { onConflict: "gc_id" });

      if (error) {
        console.error(`[sync-gc-produtos] upsert page=${page} error=${error.message}`);
        pageErrors++;
      } else {
        totalUpserted += rows.length;
      }

      if (items.length < PAGE_SIZE) break;
    }

    const elapsedMs = Date.now() - t0;
    const result = { ok: true, source, totalFetched, totalUpserted, pageErrors, elapsedMs };
    console.log(`[sync-gc-produtos] done`, result);

    return new Response(JSON.stringify(result), {
      status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e: any) {
    console.error("[sync-gc-produtos] fatal", e?.message ?? e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e) }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
