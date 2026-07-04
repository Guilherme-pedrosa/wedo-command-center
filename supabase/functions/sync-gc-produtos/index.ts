import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } }
);

async function getConfig(chave: string): Promise<string | null> {
  const { data } = await supabase
    .from("fin_configuracoes")
    .select("valor")
    .eq("chave", chave)
    .maybeSingle();
  return (data as any)?.valor ?? null;
}

async function setConfig(chave: string, valor: string): Promise<void> {
  await supabase
    .from("fin_configuracoes")
    .upsert({ chave, valor }, { onConflict: "chave" });
}

function numericOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

// Throttle: mínimo 500ms entre chamadas ao gc-proxy (~2 req/s, sob limite GC de 3 req/s)
let lastGcCall = 0;
async function gcProxyCall(endpoint: string): Promise<Response> {
  const elapsed = Date.now() - lastGcCall;
  if (elapsed < 500) await new Promise((r) => setTimeout(r, 500 - elapsed));
  lastGcCall = Date.now();

  return await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/gc-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({ endpoint, method: "GET" }),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const inicio = Date.now();
  const timeoutSec = parseInt((await getConfig("SYNC_GC_PRODUTOS_TIMEOUT_SEGUNDOS")) || "25", 10);
  const timeoutMs = timeoutSec * 1000;
  const pageSize = 100;

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* sem body */ }

    const lastPage = parseInt((await getConfig("LAST_SYNC_GC_PRODUTOS_PAGE")) || "0", 10);
    let pagina: number = body?.pagina_inicial ?? (lastPage > 0 ? lastPage : 1);

    let totalSincronizados = 0;
    let paginasProcessadas = 0;
    let pageErrors = 0;

    if (lastPage === 0 && !body?.pagina_inicial) {
      await setConfig("LAST_SYNC_GC_PRODUTOS_STARTED_AT", new Date().toISOString());
    }

    while (true) {
      // CHECKPOINT F1
      if ((Date.now() - inicio) >= timeoutMs) {
        await setConfig("LAST_SYNC_GC_PRODUTOS_PAGE", String(pagina));
        return new Response(JSON.stringify({
          status: "em_progresso",
          proxima_pagina: pagina,
          produtos_sincronizados: totalSincronizados,
          paginas_processadas: paginasProcessadas,
          tempo_ms: Date.now() - inicio,
          page_errors: pageErrors,
        }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const resp = await gcProxyCall(`/api/produtos?limite=${pageSize}&pagina=${pagina}`);

      if (!resp.ok) {
        pageErrors++;
        console.error(`[sync-gc-produtos] pagina ${pagina} HTTP ${resp.status}`);
        if (pageErrors >= 3) break;
        pagina++;
        continue;
      }

      const proxyJson = await resp.json();
      // gc-proxy embrulha em { status, data, duration_ms }
      const inner = proxyJson?.data ?? proxyJson;
      const items: any[] = Array.isArray(inner?.data) ? inner.data : [];

      if (items.length === 0) break;

      const rows = items.map((p: any) => ({
        produto_gc_id: String(p.id),
        nome: p.nome ?? "(sem nome)",
        codigo_interno: p.codigo_interno ?? null,
        codigo_barra: p.codigo_barra ?? null,
        nome_grupo: p.nome_grupo ?? null,
        grupo_id: p.grupo_id ? String(p.grupo_id) : null,
        ncm: p.fiscal?.ncm ?? p.ncm ?? null,
        unidade: p.unidade ?? null,
        estoque: numericOrNull(p.estoque),
        valor_custo: numericOrNull(p.valor_custo),
        valor_venda_padrao: numericOrNull(p.valor_venda),
        valores: Array.isArray(p.valores) ? p.valores : [],
        possui_variacao: p.possui_variacao === "1" || p.possui_variacao === true,
        possui_composicao: p.possui_composicao === "1" || p.possui_composicao === true,
        movimenta_estoque: p.movimenta_estoque !== "0" && p.movimenta_estoque !== false,
        peso: numericOrNull(p.peso),
        ativo: p.ativo !== "0" && p.ativo !== false && p.ativo !== 0,
        raw_gc: p,
        ultima_sincronizacao: new Date().toISOString(),
      }));

      const { error: upsertErr } = await supabase
        .from("gc_produtos_cache")
        .upsert(rows, { onConflict: "produto_gc_id" });

      if (upsertErr) {
        pageErrors++;
        console.error(`[sync-gc-produtos] upsert pagina ${pagina} erro: ${upsertErr.message}`);
      } else {
        totalSincronizados += rows.length;
      }

      paginasProcessadas++;

      if (items.length < pageSize) break;

      pagina++;
    }

    // SYNC COMPLETO — remove órfãos (produtos que sumiram do GC)
    await setConfig("LAST_SYNC_GC_PRODUTOS_PAGE", "0");
    await setConfig("LAST_SYNC_GC_PRODUTOS_COMPLETED_AT", new Date().toISOString());

    let orfaosRemovidos = 0;
    // Só faz cleanup se o run rodou sem page_errors — evita apagar tudo por falha transitória
    if (pageErrors === 0) {
      const startedAt = await getConfig("LAST_SYNC_GC_PRODUTOS_STARTED_AT");
      if (startedAt) {
        const { data: orfaos, error: selErr } = await supabase
          .from("gc_produtos_cache")
          .select("produto_gc_id, nome, codigo_interno")
          .lt("ultima_sincronizacao", startedAt);
        if (!selErr && orfaos && orfaos.length > 0) {
          const ids = (orfaos as any[]).map((o) => o.produto_gc_id);
          const { error: delErr } = await supabase
            .from("gc_produtos_cache")
            .delete()
            .in("produto_gc_id", ids);
          if (delErr) {
            console.error(`[sync-gc-produtos] falha ao remover órfãos: ${delErr.message}`);
          } else {
            orfaosRemovidos = ids.length;
            console.log(`[sync-gc-produtos] removidos ${ids.length} produto(s) órfão(s) do GC:`, ids.slice(0, 20));
          }
        }
      }
    }

    return new Response(JSON.stringify({
      status: "completo",
      produtos_sincronizados: totalSincronizados,
      paginas_processadas: paginasProcessadas,
      orfaos_removidos: orfaosRemovidos,
      page_errors: pageErrors,
      tempo_ms: Date.now() - inicio,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    console.error("[sync-gc-produtos] erro fatal:", e?.message ?? e);
    return new Response(JSON.stringify({
      error: e?.message ?? String(e),
      tempo_ms: Date.now() - inicio,
    }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
