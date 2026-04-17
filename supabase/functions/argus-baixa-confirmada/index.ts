// Edge Function: argus-baixa-confirmada
// Baixa no GC pagamentos/recebimentos já conciliados pelo Argus (vínculos em fin_extrato_lancamentos)
// usando situacao_id = 949476 (Confirmado Argus).
// Regras:
//   - Só processa vínculos cuja data do extrato seja >= 2026-04-01
//   - data_liquidacao no GC = data do extrato (yyyy-mm-dd)
//   - Pode rodar em modo "auto" (varre todos pendentes) ou "links" (lista específica)

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const SITUACAO_CONFIRMADO_ARGUS = "949476";
const CUTOFF_DATE = "2026-04-01"; // ponto de corte: só baixa vínculos a partir desta data

const GC_BASE_URL = "https://api.gestaoclick.com";
const GC_ACCESS_TOKEN = Deno.env.get("GC_ACCESS_TOKEN")!;
const GC_SECRET_TOKEN = Deno.env.get("GC_SECRET_TOKEN")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const gcHeaders = {
  "Content-Type": "application/json",
  "access-token": GC_ACCESS_TOKEN,
  "secret-access-token": GC_SECRET_TOKEN,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface LinkInput {
  lancamento_id: string;
  tabela: string; // "fin_pagamentos" | "fin_recebimentos"
}

interface BaixaResult {
  lancamento_id: string;
  tabela: string;
  ok: boolean;
  erro?: string;
  gc_id?: string;
}

function normalizeTabela(t: string): "fin_pagamentos" | "fin_recebimentos" | null {
  const clean = (t || "").replace(/^fin_/, "");
  if (clean === "pagamentos") return "fin_pagamentos";
  if (clean === "recebimentos") return "fin_recebimentos";
  return null;
}

function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  return iso.substring(0, 10);
}

async function baixarNoGC(
  endpoint: "recebimentos" | "pagamentos",
  gcId: string,
  payloadRaw: Record<string, unknown>,
  dataLiquidacao: string
): Promise<{ ok: boolean; erro?: string }> {
  // PUT /pagamentos e /recebimentos do GC NÃO suportam situacao_id
  // (testado em 2026-04-17: enviar 949476 retorna "Erro ao salvar dados").
  // O endpoint "Alterar situação" do GC (do print do usuário) é um endpoint
  // interno não exposto na API pública. Por isso baixamos só com liquidado=1.
  // A marcação "Confirmado Argus" fica no estado local (gc_baixado=true + log).
  const payload: Record<string, unknown> = {
    descricao: payloadRaw.descricao ?? "",
    data_vencimento: payloadRaw.data_vencimento,
    valor: payloadRaw.valor ?? payloadRaw.valor_total,
    data_competencia: payloadRaw.data_competencia ?? payloadRaw.data_vencimento,
    plano_contas_id: payloadRaw.plano_contas_id,
    forma_pagamento_id: payloadRaw.forma_pagamento_id,
    conta_bancaria_id: payloadRaw.conta_bancaria_id,
    liquidado: "1",
    data_liquidacao: dataLiquidacao,
  };

  // Campos opcionais
  if (payloadRaw.cliente_id) payload.cliente_id = payloadRaw.cliente_id;
  if (payloadRaw.fornecedor_id) payload.fornecedor_id = payloadRaw.fornecedor_id;
  if (payloadRaw.entidade) payload.entidade = payloadRaw.entidade;
  if (payloadRaw.centro_custo_id) payload.centro_custo_id = payloadRaw.centro_custo_id;
  if (payloadRaw.juros) payload.juros = payloadRaw.juros;
  if (payloadRaw.desconto) payload.desconto = payloadRaw.desconto;

  try {
    const res = await fetch(`${GC_BASE_URL}/api/${endpoint}/${gcId}`, {
      method: "PUT",
      headers: gcHeaders,
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* ignore */ }

    const embeddedCode = body?.code;
    const embeddedStatus = body?.status;
    const embeddedMsg = body?.data?.mensagem || body?.message;

    if (res.status >= 400 || (embeddedCode && embeddedCode >= 400) || embeddedStatus === "error") {
      return { ok: false, erro: embeddedMsg || `HTTP ${res.status}: ${text.substring(0, 200)}` };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, erro: err instanceof Error ? err.message : String(err) };
  }
}

async function processarLink(link: LinkInput): Promise<BaixaResult> {
  const tabela = normalizeTabela(link.tabela);
  if (!tabela) {
    return { ...link, ok: false, erro: `Tabela inválida: ${link.tabela}` };
  }

  // Buscar registro local
  const { data: lanc, error: lancErr } = await supabase
    .from(tabela)
    .select("id, gc_id, gc_payload_raw, gc_baixado, liquidado")
    .eq("id", link.lancamento_id)
    .maybeSingle();

  if (lancErr || !lanc) {
    return { ...link, ok: false, erro: lancErr?.message || "Lançamento não encontrado" };
  }
  if (!lanc.gc_id || !lanc.gc_payload_raw) {
    return { ...link, ok: false, erro: "Sem gc_id ou payload" };
  }
  if (lanc.gc_baixado) {
    return { ...link, ok: true, gc_id: lanc.gc_id, erro: "Já baixado (skip)" };
  }

  // Buscar data do extrato vinculado (a mais recente, caso N:N)
  // Aceita tanto "fin_pagamentos"/"fin_recebimentos" quanto sem prefixo (legado)
  const tabelaShort = tabela.replace(/^fin_/, "");
  const { data: vinculos, error: vincErr } = await supabase
    .from("fin_extrato_lancamentos")
    .select("extrato_id, tabela")
    .eq("lancamento_id", link.lancamento_id);

  console.log(`[processarLink] ${link.lancamento_id} (${tabela}): vinculos=`, JSON.stringify(vinculos), "err=", vincErr?.message);

  const vinculosFiltrados = (vinculos || []).filter((v: any) => {
    const t = (v.tabela || "").toString();
    return t === tabela || t === tabelaShort;
  });

  const extratoIds = Array.from(new Set(vinculosFiltrados.map((v: any) => v.extrato_id).filter(Boolean)));
  if (extratoIds.length === 0) {
    return { ...link, ok: false, erro: `Sem extrato vinculado (raw=${vinculos?.length ?? 0}, filt=${vinculosFiltrados.length}, tab=${tabela})` };
  }

  const { data: extratos } = await supabase
    .from("fin_extrato_inter")
    .select("id, data_hora")
    .in("id", extratoIds);

  const datas = (extratos || [])
    .map((e: any) => dateOnly(e.data_hora))
    .filter((d: string | null): d is string => !!d);

  if (datas.length === 0) {
    return { ...link, ok: false, erro: "Sem extrato vinculado" };
  }

  // Maior data (última liquidação)
  datas.sort();
  const dataLiq = datas[datas.length - 1];

  if (dataLiq < CUTOFF_DATE) {
    return { ...link, ok: false, erro: `Antes do cutoff ${CUTOFF_DATE}` };
  }

  const endpoint = tabela === "fin_pagamentos" ? "pagamentos" : "recebimentos";
  const result = await baixarNoGC(
    endpoint,
    lanc.gc_id,
    lanc.gc_payload_raw as Record<string, unknown>,
    dataLiq
  );

  if (!result.ok) {
    // Log do erro local
    await supabase.from("fin_sync_log").insert({
      tipo: "argus_baixa_confirmada",
      referencia_id: lanc.gc_id,
      status: "error",
      erro: result.erro,
      payload: { tabela, lancamento_id: link.lancamento_id, data_liquidacao: dataLiq },
    });
    return { ...link, ok: false, erro: result.erro, gc_id: lanc.gc_id };
  }

  // Atualizar tabela local
  await supabase
    .from(tabela)
    .update({
      liquidado: true,
      gc_baixado: true,
      gc_baixado_em: new Date().toISOString(),
      data_liquidacao: dataLiq,
      status: "pago",
    })
    .eq("id", link.lancamento_id);

  await supabase.from("fin_sync_log").insert({
    tipo: "argus_baixa_confirmada",
    referencia_id: lanc.gc_id,
    status: "success",
    payload: { tabela, lancamento_id: link.lancamento_id, data_liquidacao: dataLiq },
  });

  return { ...link, ok: true, gc_id: lanc.gc_id };
}

async function buscarPendentes(): Promise<LinkInput[]> {
  // Vínculos cujo extrato é >= CUTOFF_DATE e cujo lançamento ainda não foi baixado no GC
  // Busca em duas etapas (pagamentos e recebimentos) pra evitar joins complicados.
  const out: LinkInput[] = [];

  for (const tabela of ["fin_pagamentos", "fin_recebimentos"] as const) {
    // Pega IDs de lançamentos NÃO baixados
    const { data: pendentes } = await supabase
      .from(tabela)
      .select("id")
      .eq("gc_baixado", false)
      .not("gc_id", "is", null);

    const ids = (pendentes || []).map((r: any) => r.id);
    if (ids.length === 0) continue;

    // Buscar vínculos em chunks
    const chunkSize = 200;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const { data: links } = await supabase
        .from("fin_extrato_lancamentos")
        .select("lancamento_id, tabela, extrato_id")
        .in("lancamento_id", chunk);

      const linksRel = ((links || []) as any[]).filter((l) => normalizeTabela(l.tabela) === tabela);
      const extIds = Array.from(new Set(linksRel.map((l) => l.extrato_id).filter(Boolean)));
      if (extIds.length === 0) continue;

      const { data: extratos } = await supabase
        .from("fin_extrato_inter")
        .select("id, data_hora")
        .in("id", extIds);

      const dataMap: Record<string, string> = {};
      for (const e of (extratos || []) as any[]) {
        const d = dateOnly(e.data_hora);
        if (d) dataMap[e.id] = d;
      }

      const seen = new Set<string>();
      for (const l of linksRel) {
        const d = dataMap[l.extrato_id];
        if (!d || d < CUTOFF_DATE) continue;
        const k = `${tabela}|${l.lancamento_id}`;
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ lancamento_id: l.lancamento_id, tabela });
      }
    }
  }
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const mode: "auto" | "links" = body.mode === "auto" ? "auto" : "links";

    let alvos: LinkInput[] = [];
    if (mode === "auto") {
      alvos = await buscarPendentes();
    } else if (Array.isArray(body.links)) {
      alvos = body.links.filter((l: any) => l?.lancamento_id && l?.tabela);
    }

    if (alvos.length === 0) {
      return new Response(JSON.stringify({ ok: true, processados: 0, sucesso: 0, falha: 0, resultados: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const resultados: BaixaResult[] = [];
    for (const link of alvos) {
      const r = await processarLink(link);
      resultados.push(r);
      await sleep(200); // throttle GC
    }

    const sucesso = resultados.filter((r) => r.ok).length;
    const falha = resultados.length - sucesso;

    return new Response(
      JSON.stringify({ ok: true, processados: resultados.length, sucesso, falha, resultados }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    console.error("[argus-baixa-confirmada] fatal", err);
    return new Response(
      JSON.stringify({ ok: false, error: err instanceof Error ? err.message : String(err) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
