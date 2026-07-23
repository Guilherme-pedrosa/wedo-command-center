// Edge Function: argus-baixa-confirmada
// Baixa no GC pagamentos/recebimentos já conciliados pelo Argus (vínculos em fin_extrato_lancamentos)
// usando id_situacao = 949476 (Confirmado Argus).
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
const GC_API_USER_ID = "1320473"; // usuário API GC — atribui operações automáticas a ele, não ao humano logado

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
  data_liquidacao_override?: string; // yyyy-mm-dd — força a data_liquidacao (bypass extrato)
  observacao_contexto?: string; // trecho de contexto adicional (ex.: fatura de cartão)
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

type BaixaScope = "pagamentos" | "recebimentos" | "ambos";

interface BaixaOptions {
  forceConfirmSituacao?: boolean;
}

function normalizeTabela(t: string): "fin_pagamentos" | "fin_recebimentos" | null {
  const clean = (t || "").replace(/^fin_/, "");
  if (clean === "pagamentos") return "fin_pagamentos";
  if (clean === "recebimentos") return "fin_recebimentos";
  return null;
}

function normalizeScope(value: unknown): BaixaScope {
  return value === "pagamentos" || value === "recebimentos" || value === "ambos" ? value : "ambos";
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
  // PUT /pagamentos e /recebimentos do GC: o campo para mudar a situação
  // é `id_situacao` (NÃO `situacao_id` — este último causa "Erro ao salvar dados").
  // Setamos id_situacao = 949476 ("Confirmado Argus") para tirar da situação "Atrasado".
  // Também gravamos observação com detalhes do extrato conciliado.
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
    liquidado: 1,
    data_liquidacao: dataLiquidacao,
    id_situacao: SITUACAO_CONFIRMADO_ARGUS,
    observacao: obsFinal,
    usuario_id: GC_API_USER_ID,
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

async function processarLink(link: LinkInput, options: BaixaOptions = {}): Promise<BaixaResult> {
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
  const statusLocal = String(lanc.status || "").toLowerCase();
  const jaPagoLocal = lanc.liquidado === true || statusLocal === "pago";
  if (lanc.gc_baixado && jaPagoLocal && !options.forceConfirmSituacao) {
    return { ...link, ok: true, gc_id: lanc.gc_id, erro: "Já baixado (skip)" };
  }

  // Se um override de data_liquidacao foi passado, pula toda a busca de extrato
  let dataLiq: string;
  let extratosNorm: ExtratoInfo[] = [];

  if (link.data_liquidacao_override && /^\d{4}-\d{2}-\d{2}$/.test(link.data_liquidacao_override)) {
    dataLiq = link.data_liquidacao_override;
    if (link.observacao_contexto) {
      extratosNorm = [{
        data: dataLiq,
        valor: null,
        descricao: link.observacao_contexto,
        contraparte: null,
        tipo: null,
        end_to_end_id: null,
      }];
    }
  } else {
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

    extratosNorm = ((extratos || []) as any[])
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
    dataLiq = extratosNorm[extratosNorm.length - 1].data;
  }

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

async function buscarPendentes(dataInicio?: string, dataFim?: string, scope: BaixaScope = "ambos", options: BaixaOptions = {}): Promise<LinkInput[]> {
  // Busca a partir dos lançamentos confirmados localmente. Antes a varredura partia do extrato,
  // o que deixava títulos pago_sistema=true fora da baixa quando a consulta de extratos não os alcançava.
  const inicio = dataInicio && dataInicio >= CUTOFF_DATE ? dataInicio : CUTOFF_DATE;
  const out: LinkInput[] = [];
  const seen = new Set<string>();

  async function collect(table: "fin_pagamentos" | "fin_recebimentos", aliases: string[]) {
    // Parte dos vínculos conciliados, não da tabela de lançamentos. A tabela pode ter milhares
    // de financeiros antigos; paginar por ela fazia a busca parar antes de alcançar todos os
    // registros realmente reconciliados no extrato.
    const links: any[] = [];
    const PAGE = 1000;
    let from = 0;
    for (let p = 0; p < 200; p++) {
      const { data: chunk, error } = await supabase
        .from("fin_extrato_lancamentos")
        .select("extrato_id, lancamento_id, tabela")
        .in("tabela", aliases)
        .order("lancamento_id", { ascending: true })
        .order("extrato_id", { ascending: true })
        .range(from, from + PAGE - 1);
      if (error) {
        console.warn(`[buscarPendentes] Falha ao buscar vínculos ${table} (page ${p}):`, error.message);
        break;
      }
      if (!chunk || chunk.length === 0) break;
      links.push(...chunk);
      if (chunk.length < PAGE) break;
      from += PAGE;
    }
    console.log(`[buscarPendentes] ${table}: links=${links.length}`);
    if (links.length === 0) return;

    const extratoIds = Array.from(new Set(links.map((l) => l.extrato_id).filter(Boolean)));
    const validExtratos = new Set<string>();
    for (let i = 0; i < extratoIds.length; i += 100) {
      let q = supabase
        .from("fin_extrato_inter")
        .select("id, data_hora")
        .in("id", extratoIds.slice(i, i + 100))
        .eq("reconciliado", true)
        .gte("data_hora", `${inicio}T00:00:00+00:00`);
      if (dataFim) q = q.lte("data_hora", `${dataFim}T23:59:59+00:00`);
      const { data: extratos, error: extratosErr } = await q;
      if (extratosErr) {
        console.warn(`[buscarPendentes] Falha ao buscar extratos ${table}:`, extratosErr.message);
        continue;
      }
      for (const e of (extratos || []) as any[]) validExtratos.add(e.id);
    }
    console.log(`[buscarPendentes] ${table}: extratosValidos=${validExtratos.size}`);

    let adicionados = 0;
    for (const link of links) {
      if (!validExtratos.has(link.extrato_id)) continue;
      const key = `${table}|${link.lancamento_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ lancamento_id: link.lancamento_id, tabela: table });
      adicionados++;
    }
    console.log(`[buscarPendentes] ${table}: adicionados=${adicionados}`);
  }

  if (scope === "pagamentos" || scope === "ambos") await collect("fin_pagamentos", ["pagamentos", "fin_pagamentos"]);
  if (scope === "recebimentos" || scope === "ambos") await collect("fin_recebimentos", ["recebimentos", "fin_recebimentos"]);

  return out;
}

async function runBaixaBatch(alvos: LinkInput[], options: BaixaOptions = {}): Promise<BaixaResult[]> {
  const CONCURRENCY = 5;
  const resultados: BaixaResult[] = [];
  let cursor = 0;
  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= alvos.length) return;
      try {
        const r = await processarLink(alvos[i], options);
        resultados.push(r);
      } catch (e) {
        resultados.push({ ...alvos[i], ok: false, erro: e instanceof Error ? e.message : String(e) });
      }
      await sleep(150); // throttle GC per worker
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, alvos.length) }, () => worker()));
  return resultados;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const mode: "auto" | "links" = body.mode === "auto" ? "auto" : "links";
    const background = body.background !== false; // default true
    const options: BaixaOptions = {
      forceConfirmSituacao: body.forceConfirmSituacao === true,
    };

    let alvos: LinkInput[] = [];
    if (mode === "auto") {
      const dataInicio = typeof body.dataInicio === "string" ? body.dataInicio : undefined;
      const dataFim = typeof body.dataFim === "string" ? body.dataFim : undefined;
      const scope = normalizeScope(body.scope);
      alvos = await buscarPendentes(dataInicio, dataFim, scope, options);
    } else if (Array.isArray(body.links)) {
      alvos = body.links
        .filter((l: any) => l?.lancamento_id && l?.tabela)
        .map((l: any) => ({
          lancamento_id: String(l.lancamento_id),
          tabela: String(l.tabela),
          data_liquidacao_override: typeof l.data_liquidacao_override === "string" ? l.data_liquidacao_override : undefined,
          observacao_contexto: typeof l.observacao_contexto === "string" ? l.observacao_contexto : undefined,
        }));
    }

    if (alvos.length === 0) {
      return new Response(JSON.stringify({ ok: true, processados: 0, sucesso: 0, falha: 0, resultados: [] }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Modo auto com muitos alvos: roda em background pra não estourar 150s idle timeout
    if (mode === "auto" && background) {
      const task = (async () => {
        try {
          const r = await runBaixaBatch(alvos, options);
          const ok = r.filter((x) => x.ok).length;
          console.log(`[argus-baixa-confirmada/bg] concluído: ${ok}/${r.length}`);
        } catch (e) {
          console.error("[argus-baixa-confirmada/bg] erro:", e);
        }
      })();
      // @ts-ignore EdgeRuntime existe no runtime da Supabase
      if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
        // @ts-ignore
        EdgeRuntime.waitUntil(task);
      }
      return new Response(
        JSON.stringify({ ok: true, dispatched: alvos.length, background: true }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resultados = await runBaixaBatch(alvos, options);
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

