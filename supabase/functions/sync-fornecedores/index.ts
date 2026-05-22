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

let lastGcCall = 0;
async function gcProxyCall(endpoint: string, params: Record<string, string>): Promise<Response> {
  const elapsed = Date.now() - lastGcCall;
  if (elapsed < 400) await new Promise((r) => setTimeout(r, 400 - elapsed));
  lastGcCall = Date.now();
  return await fetch(`${Deno.env.get("SUPABASE_URL")}/functions/v1/gc-proxy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")}`,
    },
    body: JSON.stringify({ endpoint, method: "GET", params }),
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const inicio = Date.now();
  const TIMEOUT_MS = 55_000;
  const pageSize = 100;

  try {
    let body: any = {};
    try { body = await req.json(); } catch { /* sem body */ }

    let pagina: number = body?.pagina_inicial ?? 1;
    let totalProcessados = 0;
    let cnpjAtualizados = 0;
    let novos = 0;
    let paginasProcessadas = 0;

    while (true) {
      if ((Date.now() - inicio) >= TIMEOUT_MS) {
        return new Response(JSON.stringify({
          status: "em_progresso",
          proxima_pagina: pagina,
          total_processados: totalProcessados,
          cnpj_atualizados: cnpjAtualizados,
          novos,
          paginas_processadas: paginasProcessadas,
          tempo_ms: Date.now() - inicio,
        }), { status: 202, headers: { ...corsHeaders, "Content-Type": "application/json" } });
      }

      const resp = await gcProxyCall("/api/fornecedores", { limite: String(pageSize), pagina: String(pagina) });
      if (!resp.ok) {
        console.error(`[sync-fornecedores] pag ${pagina} HTTP ${resp.status}`);
        break;
      }
      const proxyJson = await resp.json();
      const inner = proxyJson?.data ?? proxyJson;
      const items: any[] = Array.isArray(inner?.data) ? inner.data : [];
      if (items.length === 0) break;

      // Buscar registros existentes para decidir preservação de cpf_cnpj manual
      const gcIds = items.map((p) => String(p.id));
      const { data: existentes } = await supabase
        .from("fin_fornecedores")
        .select("gc_id, cpf_cnpj")
        .in("gc_id", gcIds);
      const existMap = new Map<string, string | null>(
        (existentes ?? []).map((e: any) => [e.gc_id, e.cpf_cnpj])
      );

      const rows = items.map((p: any) => {
        const gc_id = String(p.id);
        const cnpjGc = (p.cnpj || p.cpf || "").toString().trim() || null;
        const cnpjLocal = existMap.get(gc_id) ?? null;
        // Preserva manual: só usa o do GC quando o local está vazio
        const cpf_cnpj = (cnpjLocal && cnpjLocal !== "") ? cnpjLocal : cnpjGc;

        if (!existMap.has(gc_id)) novos++;
        else if ((!cnpjLocal || cnpjLocal === "") && cnpjGc) cnpjAtualizados++;

        const end = p?.enderecos?.[0]?.endereco ?? {};
        return {
          gc_id,
          nome: p.nome ?? "(sem nome)",
          razao_social: p.razao_social ?? null,
          tipo_pessoa: p.tipo_pessoa ?? null,
          cpf_cnpj,
          telefone: p.telefone || p.celular || null,
          email: p.email ?? null,
          cep: end.cep ?? null,
          endereco: end.logradouro ?? null,
          bairro: end.bairro ?? null,
          cidade: end.nome_cidade ?? null,
          estado: end.estado ?? null,
          data_cadastro: p.cadastrado_em ?? null,
          payload_raw: p,
          last_synced: new Date().toISOString(),
        };
      });

      const { error: upsertErr } = await supabase
        .from("fin_fornecedores")
        .upsert(rows, { onConflict: "gc_id" });

      if (upsertErr) {
        console.error(`[sync-fornecedores] upsert pag ${pagina}: ${upsertErr.message}`);
      } else {
        totalProcessados += rows.length;
      }

      paginasProcessadas++;
      if (items.length < pageSize) break;
      pagina++;
    }

    return new Response(JSON.stringify({
      status: "completo",
      total_processados: totalProcessados,
      cnpj_atualizados: cnpjAtualizados,
      novos,
      paginas_processadas: paginasProcessadas,
      tempo_ms: Date.now() - inicio,
    }), { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (e: any) {
    console.error("[sync-fornecedores] erro:", e?.message ?? e);
    return new Response(JSON.stringify({ error: e?.message ?? String(e), tempo_ms: Date.now() - inicio }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
