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

function isLiquidadoGC(value: unknown): boolean {
  const normalized = String(value ?? "").toLowerCase().trim();
  return value === true || value === 1 || normalized === "1" || normalized === "pg" || normalized === "pago" || normalized === "liquidado" || normalized === "baixado";
}

interface LinkInput {
  lancamento_id: string;
  tabela: string; // "fin_pagamentos" | "fin_recebimentos"
}

interface ExtratoInfo {
  data: string;
  valor: number | null;
  descricao: string | null;
  contraparte: string | null;
  tipo: string | null;
  end_to_end_id: string | null;
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

// Converte ISO UTC para data (yyyy-mm-dd) no fuso de Brasília (UTC-3).
// Crítico: substring(0,10) direto do UTC retorna o dia errado para horários após 21:00 BRT.
// Ex.: 2026-04-17T00:00:20Z = 2026-04-16 21:00:20 BRT → deve retornar "2026-04-16".
function dateOnly(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso.substring(0, 10);
  // Subtrai 3h (BRT = UTC-3) e extrai a data em UTC
  const brt = new Date(d.getTime() - 3 * 60 * 60 * 1000);
  return brt.toISOString().substring(0, 10);
}

function fmtBR(iso: string): string {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : iso;
}

function fmtMoney(v: number | null | undefined): string {
  if (v === null || v === undefined) return "—";
  return v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function montarObservacaoArgus(extratos: ExtratoInfo[], dataLiq: string): string {
  const agora = new Date().toISOString();
  const linhas: string[] = [
    `[Argus] Baixa automática conciliada com extrato bancário`,
    `Data da liquidação: ${fmtBR(dataLiq)}`,
    `Conciliado em: ${fmtBR(agora)} via Argus Finance OS`,
  ];
  if (extratos.length === 0) {
    return linhas.join("\n");
  }
  if (extratos.length === 1) {
    const e = extratos[0];
    linhas.push("");
    linhas.push(`Extrato vinculado:`);
    linhas.push(`• ${fmtBR(e.data)} — ${fmtMoney(e.valor)}${e.tipo ? ` (${e.tipo})` : ""}`);
    if (e.contraparte) linhas.push(`• Contraparte: ${e.contraparte}`);
    if (e.descricao) linhas.push(`• Histórico: ${e.descricao.substring(0, 200)}`);
    if (e.end_to_end_id) linhas.push(`• E2E: ${e.end_to_end_id}`);
  } else {
    linhas.push("");
    linhas.push(`Extratos vinculados (${extratos.length}):`);
    for (const e of extratos) {
      const partes = [`${fmtBR(e.data)} — ${fmtMoney(e.valor)}`];
      if (e.contraparte) partes.push(e.contraparte);
      linhas.push(`• ${partes.join(" — ")}`);
    }
  }
  return linhas.join("\n");
}

async function baixarNoGC(
  endpoint: "recebimentos" | "pagamentos",
  gcId: string,
  payloadRaw: Record<string, unknown>,
  dataLiquidacao: string,
  extratos: ExtratoInfo[]
): Promise<{ ok: boolean; erro?: string }> {
  // PUT /pagamentos e /recebimentos do GC NÃO suportam situacao_id
  // (testado em 2026-04-17: enviar 949476 retorna "Erro ao salvar dados").
  // Como compensação, adicionamos a marca "Confirmado pelo Argus" no campo
  // `observacao` (Informações complementares na UI do GC) com detalhes da
  // sincronização (data, valor, contraparte do extrato).
  const obsArgus = montarObservacaoArgus(extratos, dataLiquidacao);
  const obsOriginal = (payloadRaw.observacao as string | undefined)?.trim() || "";
  const obsFinal = obsOriginal && !obsOriginal.includes("[Argus]")
    ? `${obsOriginal}\n\n${obsArgus}`
    : obsArgus;

  const payload: Record<string, unknown> = {
    descricao: payloadRaw.descricao ?? "",
    data_vencimento: payloadRaw.data_vencimento,
    valor: payloadRaw.valor ?? payloadRaw.valor_total,
    data_competencia: payloadRaw.data_competencia ?? payloadRaw.data_vencimento,
    plano_contas_id: payloadRaw.plano_contas_id,
    forma_pagamento_id: payloadRaw.forma_pagamento_id,
    conta_bancaria_id: payloadRaw.conta_bancaria_id,
    liquidado: "pg",
    data_liquidacao: dataLiquidacao,
    observacao: obsFinal,
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
    .select("id, gc_id, gc_payload_raw, gc_baixado, liquidado, status")
    .eq("id", link.lancamento_id)
    .maybeSingle();

  if (lancErr || !lanc) {
    return { ...link, ok: false, erro: lancErr?.message || "Lançamento não encontrado" };
  }
  if (String(lanc.status || "").toLowerCase() === "cancelado") {
    return { ...link, ok: false, erro: "Lançamento cancelado (skip)", gc_id: lanc.gc_id ?? undefined };
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
    .select("id, data_hora, valor, descricao, nome_contraparte, tipo, tipo_transacao, end_to_end_id")
    .in("id", extratoIds);

  const extratosNorm: ExtratoInfo[] = ((extratos || []) as any[])
    .map((e) => ({
      data: dateOnly(e.data_hora) || "",
      valor: e.valor != null ? Number(e.valor) : null,
      descricao: e.descricao || null,
      contraparte: e.nome_contraparte || null,
      tipo: e.tipo_transacao || e.tipo || null,
      end_to_end_id: e.end_to_end_id || null,
    }))
    .filter((e) => !!e.data)
    .sort((a, b) => a.data.localeCompare(b.data));

  if (extratosNorm.length === 0) {
    return { ...link, ok: false, erro: "Sem extrato vinculado" };
  }

  // Maior data (última liquidação)
  const dataLiq = extratosNorm[extratosNorm.length - 1].data;

  if (dataLiq < CUTOFF_DATE) {
    return { ...link, ok: false, erro: `Antes do cutoff ${CUTOFF_DATE}` };
  }

  const endpoint = tabela === "fin_pagamentos" ? "pagamentos" : "recebimentos";
  const result = await baixarNoGC(
    endpoint,
    lanc.gc_id,
    lanc.gc_payload_raw as Record<string, unknown>,
    dataLiq,
    extratosNorm
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
  const { data: extratosRecentes } = await supabase
    .from("fin_extrato_inter")
    .select("id, data_hora")
    .gte("data_hora", `${CUTOFF_DATE}T00:00:00+00:00`)
    .eq("reconciliado", true)
    .limit(5000);

  const extratoIds = Array.from(new Set((extratosRecentes || []).map((e: any) => e.id).filter(Boolean)));
  if (extratoIds.length === 0) return [];

  const { data: links } = await supabase
    .from("fin_extrato_lancamentos")
    .select("extrato_id, lancamento_id, tabela")
    .in("extrato_id", extratoIds)
    .limit(10000);

  const linksNorm = ((links || []) as any[])
    .map((l) => ({ ...l, tabela: normalizeTabela(l.tabela) }))
    .filter((l) => l.tabela && l.lancamento_id);

  const byTabela = {
    fin_pagamentos: Array.from(new Set(linksNorm.filter((l) => l.tabela === "fin_pagamentos").map((l) => l.lancamento_id))),
    fin_recebimentos: Array.from(new Set(linksNorm.filter((l) => l.tabela === "fin_recebimentos").map((l) => l.lancamento_id))),
  };

  const [pagRes, recRes] = await Promise.all([
    byTabela.fin_pagamentos.length
      ? supabase.from("fin_pagamentos").select("id, status, gc_baixado, gc_id, liquidado").in("id", byTabela.fin_pagamentos)
      : Promise.resolve({ data: [] as any[] }),
    byTabela.fin_recebimentos.length
      ? supabase.from("fin_recebimentos").select("id, status, gc_baixado, gc_id, liquidado").in("id", byTabela.fin_recebimentos)
      : Promise.resolve({ data: [] as any[] }),
  ]);

  const valid = new Set<string>();
  for (const row of (pagRes.data || []) as any[]) {
    if (!row.gc_id || row.gc_baixado || isLiquidadoGC(row.liquidado) || String(row.status || "").toLowerCase() === "cancelado") continue;
    valid.add(`fin_pagamentos|${row.id}`);
  }
  for (const row of (recRes.data || []) as any[]) {
    if (!row.gc_id || row.gc_baixado || isLiquidadoGC(row.liquidado) || String(row.status || "").toLowerCase() === "cancelado") continue;
    valid.add(`fin_recebimentos|${row.id}`);
  }

  const out: LinkInput[] = [];
  const seen = new Set<string>();
  for (const link of linksNorm) {
    const key = `${link.tabela}|${link.lancamento_id}`;
    if (!valid.has(key) || seen.has(key)) continue;
    seen.add(key);
    out.push({ lancamento_id: link.lancamento_id, tabela: link.tabela });
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
