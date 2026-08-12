// Edge Function: argus-baixa-confirmada
// Baixa no GC pagamentos/recebimentos já conciliados pelo Argus (vínculos em fin_extrato_lancamentos)
// e confirma a baixa no GestãoClick antes de alterar o estado local.
// Regras:
//   - Só processa vínculos cuja data do extrato seja >= 2026-04-01
//   - data_liquidacao no GC = data do extrato (yyyy-mm-dd)
//   - Pode rodar em modo "auto" (varre todos pendentes) ou "links" (lista específica)

import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import "https://deno.land/x/xhr@0.1.0/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

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
const GC_MIN_INTERVAL_MS = 450;
let lastGcRequestAt = 0;

async function gcFetch(url: string, options: RequestInit = {}): Promise<Response> {
  let lastResponse: Response | null = null;
  for (let attempt = 0; attempt < 4; attempt++) {
    const wait = GC_MIN_INTERVAL_MS - (Date.now() - lastGcRequestAt);
    if (wait > 0) await sleep(wait);
    lastGcRequestAt = Date.now();
    const response = await fetch(url, options);
    lastResponse = response;
    if (response.status !== 403 && response.status !== 429 && response.status < 500) return response;
    if (attempt < 3) await sleep(750 * 2 ** attempt);
  }
  if (lastResponse) return lastResponse;
  throw new Error("Falha ao comunicar com o GestãoClick");
}

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
  retryable?: boolean;
}

type BaixaScope = "pagamentos" | "recebimentos" | "ambos";

interface BaixaOptions {
  forceConfirmSituacao?: boolean;
}

interface JobProgress {
  jobId: string;
  total: number;
  processados: number;
  sucesso: number;
  falha: number;
  erros: Array<{ lancamento_id: string; tabela: string; gc_id?: string; erro: string; retryable?: boolean }>;
  parentRunId?: string;
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

function unwrapGcRecord(body: any, endpoint: "recebimentos" | "pagamentos"): Record<string, unknown> | null {
  const entityKey = endpoint === "pagamentos" ? "Pagamento" : "Recebimento";
  const candidates = [body?.data?.data, body?.data, body];

  for (const candidate of candidates) {
    const first = Array.isArray(candidate) ? candidate[0] : candidate;
    const record = first?.[entityKey] ?? first?.[entityKey.toLowerCase()] ?? first;
    if (record && typeof record === "object" && !Array.isArray(record)) return record;
  }
  return null;
}

async function buscarRegistroGC(
  endpoint: "recebimentos" | "pagamentos",
  gcId: string,
): Promise<{ ok: boolean; registro?: Record<string, unknown>; erro?: string }> {
  try {
    const res = await gcFetch(`${GC_BASE_URL}/api/${endpoint}/${gcId}`, { headers: gcHeaders });
    const text = await res.text();
    let body: any = null;
    try { body = JSON.parse(text); } catch { /* resposta não JSON */ }
    if (!res.ok) return { ok: false, erro: `GET HTTP ${res.status}: ${text.substring(0, 200)}` };
    const registro = unwrapGcRecord(body, endpoint);
    if (!registro) return { ok: false, erro: "GET do GC não retornou um financeiro válido" };
    return { ok: true, registro };
  } catch (error) {
    return { ok: false, erro: error instanceof Error ? error.message : String(error) };
  }
}

async function diagnosticarPagamentoOrfao(
  payloadAtual: Record<string, unknown>,
): Promise<string | null> {
  const descricao = String(payloadAtual.descricao ?? "");
  const compraMatch = descricao.match(/compra\s+de\s+n(?:[º°o.]*)\s*(\d+)/i);
  if (!compraMatch) return null;

  const compraCodigo = compraMatch[1];
  try {
    const res = await gcFetch(
      `${GC_BASE_URL}/api/compras?codigo=${encodeURIComponent(compraCodigo)}`,
      { headers: gcHeaders },
    );
    if (!res.ok) return null;
    const body = await res.json().catch(() => null) as any;
    const compras = Array.isArray(body?.data) ? body.data : [];
    if (compras.length === 0) {
      return `Pagamento órfão no GestãoClick: a compra nº ${compraCodigo} não existe mais; a API do GC impede a baixa deste título`;
    }
  } catch (error) {
    console.warn("[diagnosticarPagamentoOrfao] Falha no diagnóstico:", error);
  }
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
): Promise<{ ok: boolean; erro?: string; dataLiquidacaoConfirmada?: string; jaLiquidado?: boolean; retryable?: boolean }> {
  // No financeiro do GC, a situação "Confirmado" é derivada de liquidado="1".
  // Não envie id_situacao: esse campo é rejeitado pelo PUT de pagamentos/recebimentos.
  // O endpoint financeiro não aceita o campo observacao; a rastreabilidade fica no banco.
  // Recarrega o financeiro antes do PUT. O payload salvo localmente é um snapshot e pode
  // estar defasado; o GC rejeita a gravação quando campos obrigatórios ou vínculos mudaram.
  const freshResult = await buscarRegistroGC(endpoint, gcId);
  if (!freshResult.ok || !freshResult.registro) {
    return { ok: false, erro: `Não foi possível validar o financeiro no GC: ${freshResult.erro ?? "resposta inválida"}` };
  }
  const payloadAtual = freshResult.registro ?? payloadRaw;
  const liquidadoAntes = [
    payloadAtual.liquidado,
    payloadAtual.status,
    payloadAtual.situacao,
    payloadAtual.nome_situacao,
  ].some(isLiquidadoGC);
  if (liquidadoAntes) {
    const dataConfirmada = String(payloadAtual.data_liquidacao ?? "").substring(0, 10) || dataLiquidacao;
    return { ok: true, dataLiquidacaoConfirmada: dataConfirmada, jaLiquidado: true };
  }

  // Mantém a montagem do contexto para os logs locais. O endpoint financeiro do GC
  // não aceita observação no PUT.
  montarObservacaoArgus(extratos, dataLiquidacao);

  const payload: Record<string, unknown> = {
    descricao: payloadAtual.descricao ?? "",
    data_vencimento: payloadAtual.data_vencimento,
    valor: payloadAtual.valor ?? payloadAtual.valor_total,
    data_competencia: payloadAtual.data_competencia ?? payloadAtual.data_vencimento,
    plano_contas_id: payloadAtual.plano_contas_id,
    forma_pagamento_id: payloadAtual.forma_pagamento_id,
    conta_bancaria_id: payloadAtual.conta_bancaria_id,
    liquidado: 1,
    data_liquidacao: dataLiquidacao,
    usuario_id: GC_API_USER_ID,
  };

  // O GC exige a entidade vinculada no PUT financeiro.
  if (payloadAtual.cliente_id) payload.cliente_id = payloadAtual.cliente_id;
  if (payloadAtual.fornecedor_id) payload.fornecedor_id = payloadAtual.fornecedor_id;
  if (payloadAtual.entidade) payload.entidade = payloadAtual.entidade;

  // Parcelas geradas por compras podem carregar rateio e ajustes obrigatórios.
  // O GC rejeita a baixa com "Erro ao salvar dados" quando esses vínculos somem do PUT.
  const camposFinanceirosOpcionais = [
    "centro_custo_id",
    "juros",
    "multa",
    "desconto",
    "taxa_banco",
    "taxa_operadora",
    "funcionario_id",
    "transportadora_id",
    "rateios",
    "atributos",
  ] as const;
  for (const campo of camposFinanceirosOpcionais) {
    const valor = payloadAtual[campo];
    if (valor === undefined || valor === null || valor === "") continue;
    if (Array.isArray(valor) && valor.length === 0) continue;
    payload[campo] = valor;
  }

  try {
    const res = await gcFetch(`${GC_BASE_URL}/api/${endpoint}/${gcId}`, {
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

    if (res.status >= 400 || (embeddedCode && Number(embeddedCode) >= 400) || embeddedStatus === "error") {
      let erro = embeddedMsg || `HTTP ${res.status}: ${text.substring(0, 200)}`;
      let retryable = true;
      if (endpoint === "pagamentos" && /erro ao salvar dados/i.test(erro)) {
        const diagnostico = await diagnosticarPagamentoOrfao(payloadAtual);
        if (diagnostico) {
          erro = diagnostico;
          retryable = false;
        }
      }
      return { ok: false, erro, retryable };
    }

    // O GC pode responder HTTP 200 mesmo sem persistir a baixa. Reconsulta e só
    // confirma o sucesso quando o próprio GC devolver o título liquidado.
    const confirmacao = await buscarRegistroGC(endpoint, gcId);
    if (!confirmacao.ok || !confirmacao.registro) {
      return { ok: false, erro: `PUT aceito, mas a confirmação no GC falhou: ${confirmacao.erro ?? "resposta inválida"}` };
    }
    const registroConfirmado = confirmacao.registro;
    const liquidadoDepois = [
      registroConfirmado.liquidado,
      registroConfirmado.status,
      registroConfirmado.situacao,
      registroConfirmado.nome_situacao,
    ].some(isLiquidadoGC);
    if (!liquidadoDepois) {
      return { ok: false, erro: "O GC respondeu ao PUT, mas o título continuou em aberto" };
    }

    const dataConfirmada = String(registroConfirmado.data_liquidacao ?? "").substring(0, 10);
    if (dataConfirmada && dataConfirmada !== dataLiquidacao) {
      return {
        ok: false,
        erro: `GC liquidou com data ${dataConfirmada}, diferente do extrato ${dataLiquidacao}`,
      };
    }
    return { ok: true, dataLiquidacaoConfirmada: dataConfirmada || dataLiquidacao };
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
      status: result.retryable === false ? "blocked" : "error",
      erro: result.erro,
      payload: {
        tabela,
        lancamento_id: link.lancamento_id,
        data_liquidacao: dataLiq,
        retryable: result.retryable !== false,
        error_class: result.retryable === false ? "external_data_integrity" : "gc_write_error",
      },
    });
    return { ...link, ok: false, erro: result.erro, gc_id: lanc.gc_id, retryable: result.retryable !== false };
  }

  const dataLiquidacaoConfirmada = result.dataLiquidacaoConfirmada ?? dataLiq;

  // Atualizar o banco local somente depois da confirmação do próprio GC.
  const { error: updateError } = await supabase
    .from(tabela)
    .update({
      liquidado: true,
      gc_baixado: true,
      gc_baixado_em: new Date().toISOString(),
      data_liquidacao: dataLiquidacaoConfirmada,
      status: "pago",
    })
    .eq("id", link.lancamento_id);

  if (updateError) {
    const erro = `GC confirmou a baixa, mas o banco local não atualizou: ${updateError.message}`;
    await supabase.from("fin_sync_log").insert({
      tipo: "argus_baixa_confirmada",
      referencia_id: lanc.gc_id,
      status: "error",
      erro,
      payload: { tabela, lancamento_id: link.lancamento_id, data_liquidacao: dataLiquidacaoConfirmada },
    });
    return { ...link, ok: false, erro, gc_id: lanc.gc_id };
  }

  await supabase.from("fin_sync_log").insert({
    tipo: "argus_baixa_confirmada",
    referencia_id: lanc.gc_id,
    status: "success",
    payload: {
      tabela,
      lancamento_id: link.lancamento_id,
      data_liquidacao: dataLiquidacaoConfirmada,
      ja_liquidado_gc: result.jaLiquidado === true,
      confirmado_por_get: true,
    },
  });

  return { ...link, ok: true, gc_id: lanc.gc_id };
}

function brDateStartUtc(date: string): string {
  return `${date}T03:00:00+00:00`;
}

function brDateEndExclusiveUtc(date: string): string {
  const day = new Date(`${date}T00:00:00.000Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return `${day.toISOString().substring(0, 10)}T03:00:00+00:00`;
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
        .gte("data_hora", brDateStartUtc(inicio));
      if (dataFim) q = q.lt("data_hora", brDateEndExclusiveUtc(dataFim));
      const { data: extratos, error: extratosErr } = await q;
      if (extratosErr) {
        console.warn(`[buscarPendentes] Falha ao buscar extratos ${table}:`, extratosErr.message);
        continue;
      }
      for (const e of (extratos || []) as any[]) validExtratos.add(e.id);
    }
    console.log(`[buscarPendentes] ${table}: extratosValidos=${validExtratos.size}`);

    const linkedLancamentoIds = Array.from(new Set(
      links.filter((link) => validExtratos.has(link.extrato_id)).map((link) => link.lancamento_id).filter(Boolean),
    ));
    const pendentes = new Set<string>();
    for (let i = 0; i < linkedLancamentoIds.length; i += 100) {
      const { data: lancamentos, error: lancErr } = await supabase
        .from(table)
        .select("id, gc_baixado, liquidado, status")
        .in("id", linkedLancamentoIds.slice(i, i + 100));
      if (lancErr) {
        console.warn(`[buscarPendentes] Falha ao verificar pendências ${table}:`, lancErr.message);
        continue;
      }
      for (const lanc of (lancamentos || []) as any[]) {
        const status = String(lanc.status || "").toLowerCase();
        if (status === "cancelado") continue;
        if (lanc.gc_baixado !== true) pendentes.add(lanc.id);
      }
    }
    console.log(`[buscarPendentes] ${table}: pendentesGC=${pendentes.size}`);

    let adicionados = 0;
    for (const link of links) {
      if (!validExtratos.has(link.extrato_id)) continue;
      if (!pendentes.has(link.lancamento_id)) continue;
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
  // A API do GC bloqueia rajadas paralelas com 403. Uma fila serial com rate limit
  // é mais rápida no resultado final porque evita centenas de rejeições e retries.
  const CONCURRENCY = 1;
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

function progressPayload(progress: JobProgress) {
  return {
    job_id: progress.jobId,
    total: progress.total,
    processados: progress.processados,
    sucesso: progress.sucesso,
    falha: progress.falha,
    erros: progress.erros.slice(-50),
    parent_run_id: progress.parentRunId ?? null,
  };
}

async function atualizarParentRun(progress: JobProgress, status: "success" | "partial" | "error", erro?: string) {
  if (!progress.parentRunId) return;
  const { data: parent } = await supabase
    .from("fin_sync_log")
    .select("status, resposta, payload")
    .eq("id", progress.parentRunId)
    .maybeSingle();
  if (!parent) return;

  const baixaFinal = { ...progressPayload(progress), status };
  const resposta = { ...(parent.resposta ?? {}), baixa_gc_auto: baixaFinal };
  const payload = { ...(parent.payload ?? {}), baixa_gc_auto: baixaFinal };
  const parentStatus = parent.status === "partial" || parent.status === "error"
    ? parent.status
    : status;
  await supabase.from("fin_sync_log").update({
    status: parentStatus,
    erro: parentStatus === "success" ? null : (erro ?? `${progress.falha} baixa(s) não confirmada(s) no GC`),
    resposta,
    payload,
  }).eq("id", progress.parentRunId);
}

async function atualizarJob(
  progress: JobProgress,
  status: "running" | "success" | "partial" | "error",
  erro?: string,
) {
  const snapshot = progressPayload(progress);
  await supabase.from("fin_sync_log").update({
    status,
    erro: erro ?? null,
    payload: snapshot,
    resposta: snapshot,
  }).eq("id", progress.jobId);

  if (status !== "running") await atualizarParentRun(progress, status, erro);
}

async function criarOuReusarJob(
  total: number,
  parentRunId?: string,
): Promise<{ progress: JobProgress; reused: boolean }> {
  // Barreira contra múltiplos cliques/rotinas concorrentes. O fluxo antigo chegou a
  // baixar os mesmos títulos milhares de vezes em paralelo.
  const activeSince = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const { data: active } = await supabase
    .from("fin_sync_log")
    .select("id, payload, resposta")
    .eq("tipo", "argus_baixa_job")
    .eq("status", "running")
    .gte("created_at", activeSince)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (active?.id) {
    const saved = active.resposta ?? active.payload ?? {};
    return {
      reused: true,
      progress: {
        jobId: active.id,
        total: Number(saved.total ?? total),
        processados: Number(saved.processados ?? 0),
        sucesso: Number(saved.sucesso ?? 0),
        falha: Number(saved.falha ?? 0),
        erros: Array.isArray(saved.erros) ? saved.erros.slice(-50) : [],
        parentRunId: typeof saved.parent_run_id === "string" ? saved.parent_run_id : parentRunId,
      },
    };
  }

  const progress: JobProgress = {
    jobId: crypto.randomUUID(),
    total,
    processados: 0,
    sucesso: 0,
    falha: 0,
    erros: [],
    parentRunId,
  };
  const snapshot = progressPayload(progress);
  const { error } = await supabase.from("fin_sync_log").insert({
    id: progress.jobId,
    tipo: "argus_baixa_job",
    referencia_id: parentRunId ?? null,
    status: "running",
    payload: snapshot,
    resposta: snapshot,
  });
  if (error) throw new Error(`Não foi possível iniciar o acompanhamento da baixa: ${error.message}`);
  return { progress, reused: false };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const mode: "auto" | "links" = body.mode === "auto" ? "auto" : "links";
    const background = body.background === true;
    const options: BaixaOptions = {
      forceConfirmSituacao: body.forceConfirmSituacao === true,
    };
    const parentRunId = typeof body.parent_run_id === "string" ? body.parent_run_id : undefined;

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

    // Processa em lotes encadeados para cada execução ficar abaixo do timeout do runtime.
    // O próximo lote recebe IDs explícitos, portanto não repete falhas do lote anterior.
    if (background) {
      const BATCH_SIZE = 25;
      const lote = alvos.slice(0, BATCH_SIZE);
      const restantes = alvos.slice(BATCH_SIZE);
      let progress: JobProgress;
      let reused = false;

      if (typeof body.job_id === "string") {
        progress = {
          jobId: body.job_id,
          total: Number(body.job_total ?? alvos.length),
          processados: Number(body.job_processados ?? 0),
          sucesso: Number(body.job_sucesso ?? 0),
          falha: Number(body.job_falha ?? 0),
          erros: Array.isArray(body.job_erros) ? body.job_erros.slice(-50) : [],
          parentRunId,
        };
      } else {
        const claimed = await criarOuReusarJob(alvos.length, parentRunId);
        progress = claimed.progress;
        reused = claimed.reused;
      }

      if (reused) {
        return new Response(
          JSON.stringify({ ok: true, status: "running", reused: true, ...progressPayload(progress) }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } },
        );
      }

      const task = (async () => {
        try {
          const r = await runBaixaBatch(lote, options);
          const ok = r.filter((x) => x.ok).length;
          const falhaLote = r.length - ok;
          progress.processados += r.length;
          progress.sucesso += ok;
          progress.falha += falhaLote;
          progress.erros = [
            ...progress.erros,
            ...r.filter((x) => !x.ok).map((x) => ({
              lancamento_id: x.lancamento_id,
              tabela: x.tabela,
              gc_id: x.gc_id,
              erro: x.erro ?? "Falha sem detalhe",
              retryable: x.retryable,
            })),
          ].slice(-50);
          console.log(`[argus-baixa-confirmada/bg] lote concluído: ${ok}/${r.length}; restantes=${restantes.length}`);
          if (restantes.length > 0) {
            await atualizarJob(progress, "running");
            const nextResponse = await fetch(`${SUPABASE_URL}/functions/v1/argus-baixa-confirmada`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
              },
              body: JSON.stringify({
                mode: "links",
                links: restantes,
                forceConfirmSituacao: options.forceConfirmSituacao === true,
                background: true,
                job_id: progress.jobId,
                job_total: progress.total,
                job_processados: progress.processados,
                job_sucesso: progress.sucesso,
                job_falha: progress.falha,
                job_erros: progress.erros,
                parent_run_id: progress.parentRunId,
              }),
            });
            if (!nextResponse.ok) {
              const nextText = await nextResponse.text();
              const erro = `Falha ao encadear lote: HTTP ${nextResponse.status} ${nextText.substring(0, 300)}`;
              console.error(`[argus-baixa-confirmada/bg] ${erro}`);
              await atualizarJob(progress, "error", erro);
            }
          } else {
            const finalStatus = progress.falha === 0 ? "success" : "partial";
            await atualizarJob(progress, finalStatus, progress.falha > 0 ? `${progress.falha} baixa(s) não confirmada(s) no GC` : undefined);
          }
        } catch (e) {
          console.error("[argus-baixa-confirmada/bg] erro:", e);
          await atualizarJob(progress, "error", e instanceof Error ? e.message : String(e));
        }
      })();
      // @ts-ignore EdgeRuntime existe no runtime da Supabase
      if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
        // @ts-ignore
        EdgeRuntime.waitUntil(task);
      }
      return new Response(
        JSON.stringify({
          ok: true,
          status: "running",
          background: true,
          lote: lote.length,
          ...progressPayload(progress),
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const resultados = await runBaixaBatch(alvos, options);
    const sucesso = resultados.filter((r) => r.ok).length;
    const falha = resultados.length - sucesso;
    return new Response(
      JSON.stringify({ ok: falha === 0, status: falha === 0 ? "success" : "partial", processados: resultados.length, sucesso, falha, resultados }),
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

