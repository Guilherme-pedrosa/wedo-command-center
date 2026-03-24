import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// redeploy: 2026-03-17-v17-liquidacao-priority-nn-search

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ═══════════════════════════════════════════════════════════
// UTILITÁRIOS
// ═══════════════════════════════════════════════════════════

function cleanDoc(d: string | null | undefined): string {
  return (d ?? "").replace(/\D/g, "");
}

function docMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const ca = cleanDoc(a);
  const cb = cleanDoc(b);
  if (ca.length < 8 || cb.length < 8) return false;
  // Exact ou prefix-match (CNPJ raiz vs CNPJ completo)
  return ca === cb || ca.startsWith(cb.substring(0, 8)) || cb.startsWith(ca.substring(0, 8));
}

function valorExato(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01;
}

function valorTolerancia(a: number, b: number, pct = 2): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= pct / 100;
}

function dataProxima(a: string, b: string, dias = 3): boolean {
  if (!a || !b) return false;
  return Math.abs(new Date(a).getTime() - new Date(b).getTime()) <= dias * 86400000;
}

function isFinSettled(fin: any): boolean {
  return fin?.liquidado === true
    || fin?.pago_sistema === true
    || fin?.status === "pago"
    || fin?.status === "liquidado"
    || fin?.status === "baixado";
}

function getFinMatchDate(fin: any): string {
  if (!fin) return "";

  if (isFinSettled(fin)) {
    return fin.data_liquidacao ?? fin.data_vencimento ?? fin.data_emissao ?? fin.data_competencia ?? "";
  }

  return fin.data_vencimento ?? fin.data_emissao ?? fin.data_competencia ?? fin.data_liquidacao ?? "";
}

// Similaridade de nome por palavras em comum (Jaccard simplificado + containment fallback)
const GENERIC_NAME_TOKENS = new Set([
  "ltda", "eireli", "me", "epp", "sa",
  "comercio", "comercial", "servicos", "servico", "industria", "industrial",
  "empresa", "grupo", "sistemas", "solucoes", "equipamentos", "tecnologia",
  "refrigeracao", "engenharia", "logistica", "transportes",
]);

const NAME_CONNECTOR_TOKENS = new Set(["da", "de", "do", "das", "dos", "e"]);

const COMMON_PERSON_NAME_TOKENS = new Set([
  "silva", "santos", "souza", "oliveira", "pereira", "almeida", "costa", "rodrigues",
  "ferreira", "lima", "gomes", "ribeiro", "carvalho", "alves", "araujo", "martins",
  "melo", "moreira", "barbosa", "rocha", "dias", "teixeira", "fernandes", "freitas",
]);

function nomeTokens(a: string | null): string[] {
  if (!a) return [];
  return a.toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 1 && !/^\d+$/.test(w));
}

function nomeTokensSignificativos(a: string | null): string[] {
  return nomeTokens(a).filter((w) => !GENERIC_NAME_TOKENS.has(w) && !NAME_CONNECTOR_TOKENS.has(w));
}

function nomeSimilarScore(a: string | null, b: string | null): number {
  const wa = nomeTokens(a);
  const wb = nomeTokens(b);
  if (!wa.length || !wb.length) return 0;
  const inter = wa.filter(w => wb.includes(w)).length;
  const union = new Set([...wa, ...wb]).size;
  const jaccard = inter / union;
  const smaller = wa.length <= wb.length ? wa : wb;
  const larger = wa.length > wb.length ? wa : wb;
  const containment = smaller.filter(w => larger.includes(w)).length / smaller.length;
  return Math.max(jaccard, containment);
}

function nomeForteMatch(a: string | null, b: string | null): boolean {
  const wa = nomeTokensSignificativos(a);
  const wb = nomeTokensSignificativos(b);
  if (!wa.length || !wb.length) return false;

  const shared = [...new Set(wa.filter((w) => wb.includes(w)))];
  if (shared.length >= 2) return true;
  if (shared.length === 0) return false;

  const [token] = shared;
  const singleSide = wa.length === 1 || wb.length === 1;
  if (!singleSide) return false;

  return token.length >= 6 && !COMMON_PERSON_NAME_TOKENS.has(token);
}

function nomeSimilar(a: string | null, b: string | null, threshold = 0.35): boolean {
  return nomeSimilarScore(a, b) >= threshold;
}

// CNPJs raiz de clientes com prazo de pagamento longo (60-90 dias)
// Sapore S.A. e Sodexo — janela estendida de ±90 dias
const CNPJ_PRAZO_ESTENDIDO = [
  "67945071", // Sapore S.A.
  "49930514", // Sodexo Do Brasil Comercial S.A. (CNPJ raiz correto)
];

function isClientePrazoEstendido(doc: string | null | undefined): boolean {
  const clean = cleanDoc(doc);
  if (clean.length < 8) return false;
  const raiz = clean.substring(0, 8);
  return CNPJ_PRAZO_ESTENDIDO.includes(raiz);
}

type MatchRule =
  | "CNPJ_VALOR_DATA_EXATO"
  | "CNPJ_VALOR_EXATO"
  | "PIX_CHAVE_VALOR"
  | "CNPJ_VALOR_TOLERANCIA"
  | "NOME_VALOR_EXATO"
  | "VALOR_DATA_EXATO"
  | "VALOR_DATA_7DIAS"
  | "VALOR_DATA_7DIAS_NOME"
  | "VALOR_UNICO"
  | "SOMA_PARCELAS";

interface Candidato {
  fin: any;
  tipo: "pagar" | "receber";
  doc: string;
  chavePix: string;
  nome: string;
  jaPago: boolean; // true = already paid in GC, use rastreabilidade
}

// ═══════════════════════════════════════════════════════════
// MOTOR DE REGRAS DETERMINÍSTICO EM CASCATA
// ═══════════════════════════════════════════════════════════

function aplicarRegras(
  ext: any,
  candidatos: Candidato[]
): { rule: MatchRule | null; candidato: Candidato | null; auto: boolean } {

  const extValor = Math.abs(Number(ext.valor));
  const extDoc   = cleanDoc(ext.cpf_cnpj);
  const extPix   = (ext.chave_pix ?? "").trim().toLowerCase();
  const extDate  = ext.data_hora?.substring(0, 10) ?? "";
  const extNome  = ext.nome_contraparte ?? ext.contrapartida ?? "";

  // Regra 0: CNPJ/CPF + valor exato + data ±3 dias → auto-baixa máxima confiança
  if (extDoc && extDate) {
    const matches0 = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      return (
        docMatches(extDoc, c.doc) &&
        valorExato(extValor, Number(c.fin.valor)) &&
        finDate &&
        dataProxima(extDate, finDate, 3)
      );
    });
    if (matches0.length === 1)
      return { rule: "CNPJ_VALOR_DATA_EXATO", candidato: matches0[0], auto: true };
    if (matches0.length > 1) {
      if (extNome) {
        const byNome = matches0.filter(c => nomeForteMatch(extNome, c.nome));
        if (byNome.length === 1)
          return { rule: "CNPJ_VALOR_DATA_EXATO", candidato: byNome[0], auto: true };
      }
      const sorted = [...matches0].sort((a, b) => {
        const da = Math.abs(new Date(getFinMatchDate(a.fin)).getTime() - new Date(extDate).getTime());
        const db = Math.abs(new Date(getFinMatchDate(b.fin)).getTime() - new Date(extDate).getTime());
        return da - db;
      });
      return { rule: "CNPJ_VALOR_DATA_EXATO", candidato: sorted[0], auto: true };
    }
  }

  // Regra 1: CNPJ/CPF match + valor exato + data guard → auto-baixa imediata
  // Clientes com prazo estendido (Sapore, Sodexo): ±90 dias; demais: ±30 dias
  if (extDoc && extDate) {
    const janelaBase = isClientePrazoEstendido(extDoc) ? 90 : 30;
    const matches = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      return docMatches(extDoc, c.doc) && valorExato(extValor, Number(c.fin.valor))
        && finDate && dataProxima(extDate, finDate, janelaBase);
    });
    if (matches.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: matches[0], auto: true };
    if (matches.length > 1) {
      const byDate = matches.filter(c => {
        const finDate = getFinMatchDate(c.fin);
        return finDate && dataProxima(extDate, finDate, 5);
      });
      if (byDate.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: byDate[0], auto: true };
      if (extNome) {
        const byNome = matches.filter(c => nomeForteMatch(extNome, c.nome));
        if (byNome.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: byNome[0], auto: true };
      }
    }
  }

  // Regra 2: Chave PIX exata + valor exato + data ±30d → auto-baixa
  if (extPix && extDate) {
    const matches = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      if (!finDate || !dataProxima(extDate, finDate, 30)) return false;
      if (c.chavePix && c.chavePix.toLowerCase() === extPix)
        return valorExato(extValor, Number(c.fin.valor));
      const pixClean = extPix.replace(/\D/g, "");
      if (pixClean.length >= 8 && docMatches(pixClean, c.doc))
        return valorExato(extValor, Number(c.fin.valor));
      return false;
    });
    if (matches.length === 1) return { rule: "PIX_CHAVE_VALOR", candidato: matches[0], auto: true };
  }

  // Regra 3: CNPJ/CPF match + valor com tolerância ±2% + data ±15d
  if (extDoc && extDate) {
    const matches = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      return docMatches(extDoc, c.doc) && valorTolerancia(extValor, Number(c.fin.valor), 2)
        && finDate && dataProxima(extDate, finDate, 15);
    });
    if (matches.length === 1) return { rule: "CNPJ_VALOR_TOLERANCIA", candidato: matches[0], auto: false };
  }

  // Regra 4: Nome forte + valor exato + data ±30d → auto-baixa
  if (extNome && extDate) {
    const matches = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      return nomeForteMatch(extNome, c.nome) && valorExato(extValor, Number(c.fin.valor))
        && finDate && dataProxima(extDate, finDate, 30);
    });
    if (matches.length === 1) return { rule: "NOME_VALOR_EXATO", candidato: matches[0], auto: true };
  }

  // Regra 5: Valor exato + data ±3 dias → auto ONLY if name confirms (CNPJ, PIX or nome similar)
  if (extDate) {
    const matches = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      return valorExato(extValor, Number(c.fin.valor)) && finDate && dataProxima(extDate, finDate, 3);
    });
    if (matches.length === 1) {
      const candNome = matches[0].nome;
      const candDoc = matches[0].doc;
      const hasDocMatch = extDoc && candDoc && docMatches(extDoc, candDoc);
      const hasPixMatch = extPix && matches[0].chavePix && matches[0].chavePix.toLowerCase() === extPix;
      const hasNameMatch = extNome && candNome && nomeForteMatch(extNome, candNome);
      if (hasDocMatch || hasPixMatch || hasNameMatch) {
        return { rule: "VALOR_DATA_EXATO", candidato: matches[0], auto: true };
      }
      // Sem identidade forte (texto/documento) → não sugerir
    }
    if (matches.length > 1) {
      // TIEBREAKER 1: CNPJ/CPF match
      if (extDoc) {
        const byDoc = matches.filter(c => docMatches(extDoc, c.doc));
        if (byDoc.length === 1) return { rule: "CNPJ_VALOR_DATA_EXATO", candidato: byDoc[0], auto: true };
      }
      // TIEBREAKER 2: PIX key match
      if (extPix) {
        const byPix = matches.filter(c => {
          if (c.chavePix && c.chavePix.toLowerCase() === extPix) return true;
          const pixClean = extPix.replace(/\D/g, "");
          return pixClean.length >= 8 && docMatches(pixClean, c.doc);
        });
        if (byPix.length === 1) return { rule: "PIX_CHAVE_VALOR", candidato: byPix[0], auto: true };
      }
      // TIEBREAKER 3: Strong name match only
      if (extNome) {
        const scored = matches
          .map(c => ({ c, score: nomeSimilarScore(extNome, c.nome), strong: nomeForteMatch(extNome, c.nome) }))
          .filter(x => x.strong)
          .sort((a, b) => b.score - a.score);
        if (scored.length === 1) return { rule: "NOME_VALOR_EXATO", candidato: scored[0].c, auto: true };
        if (scored.length > 1 && scored[0].score - scored[1].score >= 0.2) {
          return { rule: "NOME_VALOR_EXATO", candidato: scored[0].c, auto: true };
        }
      }
      // TIEBREAKER 4: Closest date
      const sorted = [...matches].sort((a, b) => {
        const da = Math.abs(new Date(getFinMatchDate(a.fin)).getTime() - new Date(extDate).getTime());
        const db = Math.abs(new Date(getFinMatchDate(b.fin)).getTime() - new Date(extDate).getTime());
        return da - db;
      });
      const gap = sorted.length >= 2
        ? Math.abs(new Date(getFinMatchDate(sorted[1].fin)).getTime() - new Date(extDate).getTime())
          - Math.abs(new Date(getFinMatchDate(sorted[0].fin)).getTime() - new Date(extDate).getTime())
        : 0;
      const bestNome = sorted[0].nome;
      const bestDoc = sorted[0].doc;
      const hasIdentity = (extDoc && bestDoc && docMatches(extDoc, bestDoc))
        || (extPix && sorted[0].chavePix && sorted[0].chavePix.toLowerCase() === extPix)
        || (extNome && bestNome && nomeForteMatch(extNome, bestNome));
      if (gap >= 86400000 && hasIdentity) {
        return { rule: "VALOR_DATA_EXATO", candidato: sorted[0], auto: true };
      }
      if (hasIdentity) {
        return { rule: "VALOR_DATA_EXATO", candidato: sorted[0], auto: false };
      }
    }
  }

  // Regra 6: Valor exato + data ±7 dias → REQUER identidade forte
  if (extDate) {
    const fallback7 = candidatos.filter(c => {
      const finDate = getFinMatchDate(c.fin);
      return valorExato(extValor, Number(c.fin.valor)) && finDate && dataProxima(extDate, finDate, 7);
    });
    if (fallback7.length === 1) {
      const c = fallback7[0];
      const hasIdentity = (extDoc && c.doc && docMatches(extDoc, c.doc))
        || (extPix && c.chavePix && c.chavePix.toLowerCase() === extPix)
        || (extNome && c.nome && nomeForteMatch(extNome, c.nome));
      if (hasIdentity) {
        return { rule: "VALOR_DATA_7DIAS", candidato: c, auto: true };
      }
    }
    if (fallback7.length > 1) {
      if (extNome) {
        const comNome = fallback7.filter(c => nomeForteMatch(extNome, c.nome));
        if (comNome.length === 1)
          return { rule: "VALOR_DATA_7DIAS_NOME", candidato: comNome[0], auto: true };
        if (comNome.length > 1)
          return { rule: "VALOR_DATA_7DIAS" as MatchRule, candidato: comNome[0], auto: false };
      }
      if (extDoc) {
        const comDoc = fallback7.filter(c => docMatches(extDoc, c.doc));
        if (comDoc.length === 1)
          return { rule: "VALOR_DATA_7DIAS", candidato: comDoc[0], auto: true };
        if (comDoc.length > 1)
          return { rule: "VALOR_DATA_7DIAS" as MatchRule, candidato: comDoc[0], auto: false };
      }
    }
  }

  return { rule: null, candidato: null, auto: false };
}

// ═══════════════════════════════════════════════════════════
// VINCULAR (auto-baixa atômica com rollback)
// ═══════════════════════════════════════════════════════════

async function vincular(supabase: any, ext: any, match: Candidato, rule: string) {
  const table = match.tipo === "pagar" ? "fin_pagamentos" : "fin_recebimentos";
  const tabela = match.tipo === "pagar" ? "pagamentos" : "recebimentos";
  const now = new Date().toISOString();

  // 1. Marcar extrato como reconciliado
  const { error: extErr } = await supabase.from("fin_extrato_inter").update({
    reconciliado: true,
    lancamento_id: match.fin.id,
    reconciliado_em: now,
    reconciliation_rule: rule,
  }).eq("id", ext.id);

  if (extErr) throw new Error(`Erro ao atualizar extrato: ${extErr.message}`);

  // 2. Marcar lançamento como pago pelo sistema (NÃO faz baixa no GC)
  const { error: finErr } = await supabase.from(table).update({
    pago_sistema: true,
    pago_sistema_em: now,
    status: "pago",
  }).eq("id", match.fin.id);

  if (finErr) {
    // Rollback extrato
    await supabase.from("fin_extrato_inter").update({
      reconciliado: false,
      lancamento_id: null,
      reconciliado_em: null,
      reconciliation_rule: null,
    }).eq("id", ext.id);
    throw new Error(`Erro ao atualizar lançamento: ${finErr.message}`);
  }

  // 2.5 — Registrar em fin_extrato_lancamentos (valor_alocado = valor do extrato)
  await supabase.from("fin_extrato_lancamentos").upsert({
    extrato_id: ext.id,
    lancamento_id: match.fin.id,
    tabela,
    valor_alocado: Math.abs(Number(ext.valor)),
    reconciliation_rule: rule,
  }, { onConflict: "extrato_id,lancamento_id,tabela" });

  // 3. Log
  await supabase.from("fin_sync_log").insert({
    tipo: "conciliacao_auto",
    referencia_id: ext.id,
    status: "success",
    payload: { extrato_id: ext.id, lancamento_id: match.fin.id, rule },
  });
}

// Vincula extrato a lançamento JÁ PAGO — apenas rastreabilidade, sem alterar o lançamento
async function vincularRastreabilidade(supabase: any, ext: any, lancamentoId: string, rule: string) {
  const now = new Date().toISOString();
  const isDebito = ext.tipo === "DEBITO";
  const tabela = isDebito ? "pagamentos" : "recebimentos";

  const { error } = await supabase.from("fin_extrato_inter").update({
    reconciliado: true,
    lancamento_id: lancamentoId,
    reconciliado_em: now,
    reconciliation_rule: rule,
  }).eq("id", ext.id);

  if (error) throw new Error(`Erro rastreabilidade: ${error.message}`);

  // Registrar em fin_extrato_lancamentos
  await supabase.from("fin_extrato_lancamentos").upsert({
    extrato_id: ext.id,
    lancamento_id: lancamentoId,
    tabela,
    valor_alocado: Math.abs(Number(ext.valor)),
    reconciliation_rule: rule,
  }, { onConflict: "extrato_id,lancamento_id,tabela" });

  await supabase.from("fin_sync_log").insert({
    tipo: "conciliacao_rastreabilidade",
    referencia_id: ext.id,
    status: "success",
    payload: { extrato_id: ext.id, lancamento_id: lancamentoId, rule },
  });
}

// ═══════════════════════════════════════════════════════════
// SOMA PARCELAS — N:N (tabela fin_extrato_lancamentos)
// ═══════════════════════════════════════════════════════════

interface ParcelaSoma {
  id: string;
  valor: number;
  tabela: "pagamentos" | "recebimentos";
}

async function saveSomaParcelas(
  supabase: any,
  extratoId: string,
  extValor: number,
  parcelas: ParcelaSoma[],
  rule: string
) {
  // VALIDAÇÃO: IDs devem ser únicos (evitar duplicatas no subset-sum)
  const uniqueIds = new Set(parcelas.map(p => p.id));
  if (uniqueIds.size !== parcelas.length) {
    throw new Error(`SOMA_PARCELAS rejeitada: IDs duplicados (${parcelas.length} parcelas, ${uniqueIds.size} únicos)`);
  }

  // VALIDAÇÃO: soma das parcelas deve bater com valor do extrato (tolerância R$0,01)
  const somaTotal = parcelas.reduce((s, p) => s + p.valor, 0);
  if (Math.abs(somaTotal - extValor) > 0.01) {
    throw new Error(`SOMA_PARCELAS rejeitada: soma R$${somaTotal.toFixed(2)} ≠ extrato R$${extValor.toFixed(2)}`);
  }

  const now = new Date().toISOString();
  const maior = parcelas.reduce((a, b) => (a.valor > b.valor ? a : b));

  // 1. Marcar extrato como reconciliado (representante = maior parcela)
  const { error: extErr } = await supabase.from("fin_extrato_inter").update({
    reconciliado: true,
    reconciliado_em: now,
    reconciliation_rule: rule,
    lancamento_id: maior.id,
  }).eq("id", extratoId);
  if (extErr) throw new Error(`Erro atualizar extrato: ${extErr.message}`);

  // 2. Inserir todas as parcelas na tabela N:N
  const rows = parcelas.map(p => ({
    extrato_id: extratoId,
    lancamento_id: p.id,
    tabela: p.tabela,
    valor_alocado: p.valor,
    reconciliation_rule: rule,
  }));
  const { error: linkErr } = await supabase.from("fin_extrato_lancamentos")
    .upsert(rows, { onConflict: "extrato_id,lancamento_id,tabela" });
  if (linkErr) {
    // Rollback extrato
    await supabase.from("fin_extrato_inter").update({
      reconciliado: false, reconciliado_em: null, reconciliation_rule: null, lancamento_id: null,
    }).eq("id", extratoId);
    throw new Error(`Erro inserir links: ${linkErr.message}`);
  }

  // 3. Verificar que os links foram criados
  const { data: created } = await supabase.from("fin_extrato_lancamentos")
    .select("id").eq("extrato_id", extratoId);
  if (!created || created.length !== parcelas.length) {
    // Rollback
    await supabase.from("fin_extrato_inter").update({
      reconciliado: false, reconciliado_em: null, reconciliation_rule: null, lancamento_id: null,
    }).eq("id", extratoId);
    await supabase.from("fin_extrato_lancamentos").delete().eq("extrato_id", extratoId);
    throw new Error(`SOMA_PARCELAS: esperava ${parcelas.length} links, criou ${created?.length ?? 0}`);
  }

  // 4. Log
  await supabase.from("fin_sync_log").insert({
    tipo: "conciliacao_soma_parcelas",
    referencia_id: extratoId,
    status: "success",
    payload: { extrato_id: extratoId, parcelas: parcelas.map(p => ({ id: p.id, valor: p.valor })), rule },
  });
}

// Tenta encontrar N parcelas do mesmo fornecedor/cliente que somem ao valor do extrato
function tentarSomaParcelas(
  extValor: number,
  extDoc: string,
  extNome: string,
  extDate: string,
  pool: any[],
  isDebito: boolean,
  fornMap: Record<string, any>,
  cliMap: Record<string, any>,
  alreadyLinked: Set<string>,
  usedIds: Set<string>,
): { parcelas: ParcelaSoma[]; rule: string } | null {
  const janelaDias = isClientePrazoEstendido(extDoc) ? 90 : 30;
  const tabela: "pagamentos" | "recebimentos" = isDebito ? "pagamentos" : "recebimentos";

  const candidatos = pool
    .filter((fin: any) => !usedIds.has(fin.id) && !alreadyLinked.has(fin.id) && Number(fin.valor) > 0)
    .map((fin: any) => {
      const gcId = isDebito ? fin.fornecedor_gc_id : fin.cliente_gc_id;
      const lkp = isDebito ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
      const finDoc = cleanDoc(fin.recipient_document) || lkp?.cpf_cnpj || "";
      const finNome = (isDebito ? fin.nome_fornecedor : fin.nome_cliente) ?? lkp?.nome ?? "";
      const finDate = getFinMatchDate(fin);
      const docOk = Boolean(extDoc && finDoc && docMatches(extDoc, finDoc));
      const nomeScore = extNome && finNome ? nomeSimilarScore(extNome, finNome) : 0;
      const nomeOk = extNome && finNome ? nomeForteMatch(extNome, finNome) : false;
      const dateDiff = finDate && extDate
        ? Math.abs(new Date(finDate).getTime() - new Date(extDate).getTime())
        : 0;

      return { fin, docOk, nomeOk, nomeScore, dateDiff, finDate };
    })
    .filter(({ docOk, nomeOk, finDate }) => {
      if (!docOk && !nomeOk) return false;
      if (!finDate || !extDate) return true;
      return dataProxima(extDate, finDate, janelaDias);
    });

  if (candidatos.length < 2) return null;

  const sortByRelevancia = (a: any, b: any) => {
    if (a.docOk !== b.docOk) return Number(b.docOk) - Number(a.docOk);
    if (a.dateDiff !== b.dateDiff) return a.dateDiff - b.dateDiff;
    if (a.nomeScore !== b.nomeScore) return b.nomeScore - a.nomeScore;
    return Number(b.fin.valor) - Number(a.fin.valor);
  };

  const sortByValor = (a: any, b: any) => {
    if (a.docOk !== b.docOk) return Number(b.docOk) - Number(a.docOk);
    if (Number(b.fin.valor) !== Number(a.fin.valor)) return Number(b.fin.valor) - Number(a.fin.valor);
    return a.dateDiff - b.dateDiff;
  };

  const buildAttemptPool = (items: any[], sorter: (a: any, b: any) => number, limit = 24) => {
    const seen = new Set<string>();
    return items
      .slice()
      .sort(sorter)
      .filter((item: any) => {
        if (seen.has(item.fin.id)) return false;
        seen.add(item.fin.id);
        return true;
      })
      .slice(0, limit)
      .map((item: any) => item.fin);
  };

  const candidatosDoc = candidatos.filter((c: any) => c.docOk);
  const attemptPools = [
    buildAttemptPool(candidatosDoc.length >= 2 ? candidatosDoc : candidatos, sortByRelevancia, 24),
    buildAttemptPool(candidatos, sortByRelevancia, 24),
    buildAttemptPool(candidatosDoc.length >= 2 ? candidatosDoc : candidatos, sortByValor, 24),
    buildAttemptPool(candidatos, sortByValor, 24),
  ];

  for (const attempt of attemptPools) {
    if (attempt.length < 2) continue;
    const result = findSubsetSum(attempt, extValor, 0.01);
    if (result) {
      return {
        parcelas: result.map((fin: any) => ({ id: fin.id, valor: Number(fin.valor), tabela })),
        rule: "SOMA_PARCELAS",
      };
    }
  }

  return null;
}

function findSubsetSum(items: any[], target: number, tolerance: number): any[] | null {
  const sorted = [...items]
    .filter((item) => Number(item.valor) > 0)
    .sort((a, b) => Number(b.valor) - Number(a.valor));

  const n = sorted.length;
  if (n < 2) return null;

  const values = sorted.map((item) => Math.round(Number(item.valor) * 100));
  const targetCents = Math.round(target * 100);
  const toleranceCents = Math.max(1, Math.round(tolerance * 100));
  const maxSize = Math.min(n, 8);
  const suffixSum = new Array(n + 1).fill(0);
  const memo = new Set<string>();

  for (let i = n - 1; i >= 0; i--) {
    suffixSum[i] = suffixSum[i + 1] + values[i];
  }

  function search(idx: number, remaining: number, selected: number[]): number[] | null {
    if (Math.abs(remaining) <= toleranceCents && selected.length >= 2) return selected;
    if (idx >= n || selected.length >= maxSize || remaining < -toleranceCents) return null;
    if (remaining > suffixSum[idx] + toleranceCents) return null;

    const key = `${idx}:${remaining}:${selected.length}`;
    if (memo.has(key)) return null;

    const withItem = search(idx + 1, remaining - values[idx], [...selected, idx]);
    if (withItem) return withItem;

    const withoutItem = search(idx + 1, remaining, selected);
    if (withoutItem) return withoutItem;

    memo.add(key);
    return null;
  }

  const indexes = search(0, targetCents, []);
  return indexes ? indexes.map((index) => sorted[index]) : null;
}

// ═══════════════════════════════════════════════════════════
// HANDLER PRINCIPAL
// ═══════════════════════════════════════════════════════════

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = req.method === "POST" ? await req.json().catch(() => ({})) : {};
    const dateFrom = typeof body?.dateFrom === "string" ? body.dateFrom : null;
    const dateTo = typeof body?.dateTo === "string" ? body.dateTo : null;
    const extratoIds = Array.isArray(body?.extratoIds)
      ? body.extratoIds.filter((id: unknown): id is string => typeof id === "string" && id.length > 0)
      : [];
    const requestedLimit = Number(body?.limit);
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(requestedLimit, 500))
      : (extratoIds.length > 0 || dateFrom || dateTo ? 200 : 50);

    // 1. Extrato não reconciliado (excluindo exceções manuais)
    const MANUAL_EXCEPTIONS = ['SEM_PAR_GC', 'TRANSFERENCIA_INTERNA', 'PIX_DEVOLVIDO_MANUAL'];
    let extratosQuery = supabase
      .from("fin_extrato_inter")
      .select("*")
      .eq("reconciliado", false)
      .or(`reconciliation_rule.is.null,reconciliation_rule.not.in.(${MANUAL_EXCEPTIONS.join(",")})`);

    if (extratoIds.length > 0) {
      extratosQuery = extratosQuery.in("id", extratoIds);
    } else {
      // Default: only process last 90 days to avoid wasting cycles on ancient records
      const defaultFloor = dateFrom ?? new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
      extratosQuery = extratosQuery.gte("data_hora", defaultFloor);
      if (dateTo) extratosQuery = extratosQuery.lte("data_hora", dateTo);
    }

    const { data: extratos, error: errE } = await extratosQuery
      .order("data_hora", { ascending: false })
      .limit(limit);

    if (errE) throw new Error(`fin_extrato_inter: ${errE.message}`);

    // Select only needed columns (avoid gc_payload_raw which is huge)
    const finSelectPag = "id, valor, descricao, data_vencimento, data_emissao, data_competencia, data_liquidacao, status, fornecedor_gc_id, nome_fornecedor, recipient_document, gc_codigo, gc_id, os_codigo, pago_sistema, liquidado, grupo_id";
    const finSelectRec = "id, valor, descricao, data_vencimento, data_emissao, data_competencia, data_liquidacao, status, cliente_gc_id, nome_cliente, recipient_document, gc_codigo, gc_id, os_codigo, pago_sistema, liquidado, grupo_id";

    // 2. Lançamentos candidatos: TODOS exceto cancelados (status no GC é irrelevante,
    //    o que importa é se já foi vinculado ao extrato — checado via alreadyLinked)
    const cutoff180 = new Date(Date.now() - 180 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const [{ data: pagamentos }, { data: recebimentos }, { data: fornecedores }, { data: clientes }] = await Promise.all([
      supabase.from("fin_pagamentos").select(finSelectPag)
        .not("status", "in", '("cancelado")')
        .gte("data_vencimento", cutoff180)
        .order("data_vencimento", { ascending: false })
        .limit(3000),
      supabase.from("fin_recebimentos").select(finSelectRec)
        .not("status", "in", '("cancelado")')
        .gte("data_vencimento", cutoff180)
        .order("data_vencimento", { ascending: false })
        .limit(3000),
      supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj, chave_pix, nome"),
      supabase.from("fin_clientes").select("gc_id, cpf_cnpj, nome"),
    ]);

    // IDs já vinculados — from N:N table AND from legacy 1:1 lancamento_id on fin_extrato_inter
    const [{ data: linkedLancs }, { data: linkedExtrato }] = await Promise.all([
      supabase.from("fin_extrato_lancamentos").select("lancamento_id"),
      supabase.from("fin_extrato_inter").select("lancamento_id").eq("reconciliado", true).not("lancamento_id", "is", null),
    ]);

    const alreadyLinked = new Set([
      ...(linkedLancs ?? []).map((l: any) => l.lancamento_id).filter(Boolean),
      ...(linkedExtrato ?? []).map((l: any) => l.lancamento_id).filter(Boolean),
    ]);

    // Index fornecedor/cliente por gc_id
    const fornMap: Record<string, { cpf_cnpj: string; chave_pix: string; nome: string }> = {};
    for (const f of (fornecedores ?? [])) {
      fornMap[f.gc_id] = {
        cpf_cnpj: cleanDoc(f.cpf_cnpj),
        chave_pix: (f.chave_pix ?? "").trim(),
        nome: f.nome ?? "",
      };
    }
    const cliMap: Record<string, { cpf_cnpj: string; nome: string }> = {};
    for (const c of (clientes ?? [])) {
      cliMap[c.gc_id] = { cpf_cnpj: cleanDoc(c.cpf_cnpj), nome: c.nome ?? "" };
    }

    const usedIds = new Set<string>();
    const stats = { auto: 0, review: 0, unmatched: 0, errors: 0 };
    const reviewItems: any[] = [];
    const unmatchedItems: any[] = [];

    for (const ext of (extratos ?? [])) {
      const isDebito = ext.tipo === "DEBITO";
      const pool = isDebito ? (pagamentos ?? []) : (recebimentos ?? []);

      // Build candidate list: ALL non-cancelled, filtered only by alreadyLinked (extrato binding)
      const candidatos: Candidato[] = pool
        .filter((fin: any) => !usedIds.has(fin.id) && !alreadyLinked.has(fin.id))
        .map((fin: any) => {
          const gcId = isDebito ? fin.fornecedor_gc_id : fin.cliente_gc_id;
          const lookup = isDebito ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
          const doc = cleanDoc(fin.recipient_document) || lookup?.cpf_cnpj || "";
          const chavePix = (isDebito && lookup) ? (lookup as any).chave_pix ?? "" : "";
          const finNome = (isDebito ? fin.nome_fornecedor : fin.nome_cliente) ?? "";
          const lookupNome = lookup?.nome ?? "";
          const nome = (finNome.split(/\s+/).filter((w: string) => w.length > 2).length >= 2) ? finNome : (lookupNome || finNome);
          const jaPago = isFinSettled(fin);
          return { fin, tipo: (isDebito ? "pagar" : "receber") as "pagar" | "receber", doc, chavePix, nome, jaPago };
        });

      const { rule, candidato, auto } = aplicarRegras(ext, candidatos);

      if (candidato && auto) {
        try {
          if (candidato.jaPago) {
            await vincularRastreabilidade(supabase, ext, candidato.fin.id, rule! + "_JA_PAGO");
          } else {
            await vincular(supabase, ext, candidato, rule!);
          }
          usedIds.add(candidato.fin.id);
          stats.auto++;
        } catch (e) {
          console.error(`Erro vincular ext ${ext.id}:`, (e as Error).message);
          stats.errors++;
        }
      } else if (candidato && !auto) {
        reviewItems.push({
          extrato_id: ext.id,
          descricao_extrato: ext.descricao ?? ext.contrapartida ?? "—",
          contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
          cpf_cnpj: ext.cpf_cnpj ?? "",
          valor: ext.valor,
          tipo: ext.tipo,
          data_hora: ext.data_hora,
          motivo: `Sugestão: ${rule} (valor+data ±3d)`,
          melhor: {
            id: candidato.fin.id,
            valor: candidato.fin.valor,
            descricao: candidato.fin.descricao,
            data_vencimento: candidato.fin.data_vencimento ?? null,
            nome: candidato.fin.nome_fornecedor ?? candidato.fin.nome_cliente ?? "—",
            rule,
          },
        });
        stats.review++;
      } else {
        // Check for collisions (multiple with same valor)
        const extValor = Math.abs(Number(ext.valor));
        const extNomeCheck = ext.nome_contraparte ?? ext.contrapartida ?? "";
        const mesmoValor = candidatos.filter(c => valorExato(extValor, Number(c.fin.valor)));

        // When extract has a name, REQUIRE identidade forte — never show unrelated names
        let candidatosEfetivos = mesmoValor;
        if (extNomeCheck) {
          const extDoc = cleanDoc(ext.cpf_cnpj);
          const extPix = (ext.chave_pix ?? "").trim().toLowerCase();
          // Keep only candidates with strong identity (doc, PIX, or nome forte)
          const comIdentidade = mesmoValor.filter(c => {
            if (extDoc && c.doc && docMatches(extDoc, c.doc)) return true;
            if (extPix && c.chavePix && c.chavePix.toLowerCase() === extPix) return true;
            if (nomeForteMatch(extNomeCheck, c.nome)) return true;
            return false;
          });
          candidatosEfetivos = comIdentidade; // may be empty → will go to unmatched
        }

        let handledByPendentes = false;

        if (candidatosEfetivos.length > 1) {
          // Try to resolve collision by document
          const extDoc = cleanDoc(ext.cpf_cnpj);
          if (extDoc) {
            const withDoc = candidatosEfetivos.filter(c => {
              const fDocDirect = cleanDoc(c.fin.recipient_document);
              if (fDocDirect && docMatches(extDoc, fDocDirect)) return true;
              return c.doc && docMatches(extDoc, c.doc);
            });
            if (withDoc.length === 1) {
              try {
                if (withDoc[0].jaPago) {
                  await vincularRastreabilidade(supabase, ext, withDoc[0].fin.id, "CNPJ_VALOR_EXATO_JA_PAGO");
                } else {
                  await vincular(supabase, ext, withDoc[0], "CNPJ_VALOR_EXATO");
                }
                usedIds.add(withDoc[0].fin.id);
                stats.auto++;
                continue;
              } catch { stats.errors++; continue; }
            }
          }

          // Try to resolve collision by nome forte
          if (extNomeCheck) {
            const withNome = candidatosEfetivos.filter(c => nomeForteMatch(extNomeCheck, c.nome));
            if (withNome.length === 1) {
              try {
                if (withNome[0].jaPago) {
                  await vincularRastreabilidade(supabase, ext, withNome[0].fin.id, "NOME_VALOR_EXATO_JA_PAGO");
                } else {
                  await vincular(supabase, ext, withNome[0], "NOME_VALOR_EXATO");
                }
                usedIds.add(withNome[0].fin.id);
                stats.auto++;
                continue;
              } catch { stats.errors++; continue; }
            }
          }

          // Unresolved real collision → review
          reviewItems.push({
            extrato_id: ext.id,
            descricao_extrato: ext.descricao ?? "—",
            contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
            cpf_cnpj: ext.cpf_cnpj ?? "",
            valor: ext.valor,
            tipo: ext.tipo,
            data_hora: ext.data_hora,
            motivo: `Colisão real: ${candidatosEfetivos.length} lançamentos com mesmo valor e identidade ambígua`,
            candidatos: candidatosEfetivos.map(c => ({
              id: c.fin.id,
              valor: c.fin.valor,
              descricao: c.fin.descricao,
              nome: c.fin.nome_fornecedor ?? c.fin.nome_cliente ?? "—",
              doc: c.doc,
            })),
          });
          stats.review++;
          handledByPendentes = true;
        } else if (candidatosEfetivos.length === 1) {
          const candidatoUnico = candidatosEfetivos[0];
          const finDate = getFinMatchDate(candidatoUnico.fin);
          const extDate = ext.data_hora?.substring(0, 10) ?? "";
          const extDoc = cleanDoc(ext.cpf_cnpj);
          const extPix = (ext.chave_pix ?? "").trim().toLowerCase();
          const pixClean = extPix.replace(/\D/g, "");
          const nomeMatch = Boolean(extNomeCheck && nomeForteMatch(extNomeCheck, candidatoUnico.nome));
          const docMatch = Boolean(extDoc && candidatoUnico.doc && docMatches(extDoc, candidatoUnico.doc));
          const pixMatch = Boolean(
            extPix && (
              (candidatoUnico.chavePix && candidatoUnico.chavePix.toLowerCase() === extPix)
              || (pixClean.length >= 8 && candidatoUnico.doc && docMatches(pixClean, candidatoUnico.doc))
            )
          );
          const identidadeForte = docMatch || pixMatch || nomeMatch;
          const dateWindow = nomeMatch ? 10 : 5;
          const ruleLabel = docMatch ? "CNPJ_VALOR_EXATO" : pixMatch ? "PIX_CHAVE_VALOR" : nomeMatch ? "NOME_VALOR_EXATO" : "VALOR_UNICO";

          if (!identidadeForte) {
            // Mesmo valor sozinho não basta: sem documento, PIX ou nome forte não sugerimos.
          } else if (finDate && extDate && dataProxima(extDate, finDate, dateWindow)) {
            try {
              if (candidatoUnico.jaPago) {
                await vincularRastreabilidade(supabase, ext, candidatoUnico.fin.id, ruleLabel + "_JA_PAGO");
              } else {
                await vincular(supabase, ext, candidatoUnico, ruleLabel);
              }
              usedIds.add(candidatoUnico.fin.id);
              stats.auto++;
            } catch (e) {
              console.error(`Erro vincular valor único:`, (e as Error).message);
              stats.errors++;
            }
            handledByPendentes = true;
          } else {
            reviewItems.push({
              extrato_id: ext.id,
              descricao_extrato: ext.descricao ?? "—",
              contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
              cpf_cnpj: ext.cpf_cnpj ?? "",
              valor: ext.valor,
              tipo: ext.tipo,
              data_hora: ext.data_hora,
              motivo: "Identidade confirmada, aguardando confirmação de data",
              melhor: {
                id: candidatoUnico.fin.id,
                valor: candidatoUnico.fin.valor,
                descricao: candidatoUnico.fin.descricao,
                nome: candidatoUnico.fin.nome_fornecedor ?? candidatoUnico.fin.nome_cliente ?? "—",
                rule: ruleLabel,
              },
            });
            stats.review++;
            handledByPendentes = true;
          }
        }
        // candidatosEfetivos === 0 → handledByPendentes stays false → fall to já-pagos

        if (!handledByPendentes) {
          // Pool is already unified (pendentes + já pagos), just try SOMA_PARCELAS
          const extValorSoma = Math.abs(Number(ext.valor));
          const extNomeSoma = ext.nome_contraparte ?? ext.contrapartida ?? "";
          const extDocSoma = cleanDoc(ext.cpf_cnpj);
          const extDateSoma = ext.data_hora?.substring(0, 10) ?? "";
          const isDebitoSoma = ext.tipo === "DEBITO";

          const somaResult = tentarSomaParcelas(
            extValorSoma, extDocSoma, extNomeSoma, extDateSoma,
            pool, isDebitoSoma, fornMap, cliMap, alreadyLinked, usedIds
          );

          if (somaResult) {
            try {
              await saveSomaParcelas(supabase, ext.id, extValorSoma, somaResult.parcelas, somaResult.rule);
              somaResult.parcelas.forEach(p => usedIds.add(p.id));
              stats.auto++;
            } catch (e) {
              console.error("Erro soma parcelas:", (e as Error).message);
              stats.errors++;
              unmatchedItems.push({
                extrato_id: ext.id, descricao_extrato: ext.descricao ?? "—",
                contrapartida: extNomeSoma, cpf_cnpj: ext.cpf_cnpj ?? "",
                valor: ext.valor, tipo: ext.tipo, data_hora: ext.data_hora,
              });
            }
          } else {
              stats.unmatched++;
              const extValorApprox = Math.abs(Number(ext.valor));
              const extDocApprox = cleanDoc(ext.cpf_cnpj);
              const extNomeApprox = ext.nome_contraparte ?? ext.contrapartida ?? "";
              const isDebitoApprox = ext.tipo === "DEBITO";
              const extDateApprox = ext.data_hora?.substring(0, 10) ?? "";
              
              // Pool is already unified — just filter out used/linked
              const poolApprox = pool.filter((fin: any) =>
                !alreadyLinked.has(fin.id) && !usedIds.has(fin.id)
              );

              // ── N:N SUGGESTION ──
              // If we have CNPJ-matching candidates whose individual values are smaller than extrato,
              // suggest them as a group for manual N:N reconciliation
              const janelaNn = isClientePrazoEstendido(extDocApprox) ? 120 : 90;
              const candidatosNn = poolApprox
                .map((fin: any) => {
                  const gcId = isDebitoApprox ? fin.fornecedor_gc_id : fin.cliente_gc_id;
                  const lookup = isDebitoApprox ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
                  const finDoc = cleanDoc(fin.recipient_document) || lookup?.cpf_cnpj || "";
                  const finNome = (isDebitoApprox ? fin.nome_fornecedor : fin.nome_cliente) ?? lookup?.nome ?? "";
                  const finDate = getFinMatchDate(fin);
                  const finValor = Math.abs(Number(fin.valor));
                  const docOk = Boolean(extDocApprox && finDoc && docMatches(extDocApprox, finDoc));
                  const nScore = extNomeApprox ? nomeSimilarScore(extNomeApprox, finNome) : 0;
                  const nomeOk = extNomeApprox ? nomeForteMatch(extNomeApprox, finNome) : false;
                  if (!docOk && !nomeOk) return null;
                  if (finDate && extDateApprox && !dataProxima(extDateApprox, finDate, janelaNn)) return null;
                  if (finValor <= 0) return null;
                  return { fin, finValor, finNome, finDate, finDoc, docOk, nomeOk, nScore, status: fin.status };
                })
                .filter(Boolean) as any[];

              if (candidatosNn.length >= 2) {
                // Sort: CNPJ match first, then by date proximity, then value desc
                candidatosNn.sort((a: any, b: any) => {
                  if (a.docOk !== b.docOk) return Number(b.docOk) - Number(a.docOk);
                  const da = a.finDate ? Math.abs(new Date(a.finDate).getTime() - new Date(extDateApprox).getTime()) : 999e9;
                  const db = b.finDate ? Math.abs(new Date(b.finDate).getTime() - new Date(extDateApprox).getTime()) : 999e9;
                  if (da !== db) return da - db;
                  return b.finValor - a.finValor;
                });

                // CAP: only include candidates up to 105% of extrato value (avoid R$499k suggestion for R$16k extrato)
                const teto = extValorApprox * 1.05;
                let somaAcumulada = 0;
                const candidatosCapped: any[] = [];
                for (const c of candidatosNn) {
                  if (somaAcumulada + c.finValor <= teto || candidatosCapped.length === 0) {
                    candidatosCapped.push(c);
                    somaAcumulada += c.finValor;
                  }
                  if (somaAcumulada >= teto) break;
                }

                const somaTotal = candidatosCapped.reduce((s: number, c: any) => s + c.finValor, 0);
                const difPct = Math.abs(somaTotal - extValorApprox) / extValorApprox;

                // Only suggest if difference is within 5%
                if (candidatosCapped.length >= 2 && difPct <= 0.05) {
                  unmatchedItems.push({
                    extrato_id: ext.id,
                    descricao_extrato: ext.descricao ?? "—",
                    contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
                    cpf_cnpj: ext.cpf_cnpj ?? "",
                    valor: ext.valor,
                    tipo: ext.tipo,
                    data_hora: ext.data_hora,
                    sugestao_nn: true,
                    soma_candidatos: somaTotal,
                    diferenca_nn: Math.abs(extValorApprox - somaTotal),
                    candidatos_nn: candidatosCapped.slice(0, 30).map((c: any) => ({
                      lancamento_id: c.fin.id,
                      lancamento_tipo: isDebitoApprox ? "pagamento" : "recebimento",
                      descricao: c.fin.descricao,
                      nome: c.finNome,
                      valor: c.finValor,
                      data_vencimento: c.finDate,
                      status: c.status,
                      gc_codigo: c.fin.gc_codigo,
                      os_codigo: c.fin.os_codigo,
                      doc_match: c.docOk,
                      nome_match: c.nomeOk,
                    })),
                  });
                } else {
                  // Difference too large — just mark as unmatched without suggestion
                  unmatchedItems.push({
                    extrato_id: ext.id,
                    descricao_extrato: ext.descricao ?? "—",
                    contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
                    cpf_cnpj: ext.cpf_cnpj ?? "",
                    valor: ext.valor,
                    tipo: ext.tipo,
                    data_hora: ext.data_hora,
                  });
                }
              } else {
                // Fallback: 1:1 approximate suggestions
                const scored = poolApprox.map((fin: any) => {
                  const gcId = isDebitoApprox ? fin.fornecedor_gc_id : fin.cliente_gc_id;
                  const lookup = isDebitoApprox ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
                  const finDoc = cleanDoc(fin.recipient_document) || lookup?.cpf_cnpj || "";
                  const finNome = (isDebitoApprox ? fin.nome_fornecedor : fin.nome_cliente) ?? lookup?.nome ?? "";
                  const finDate = getFinMatchDate(fin);
                  const docMatch = Boolean(extDocApprox && finDoc && docMatches(extDocApprox, finDoc));
                  const nomeMatch = Boolean(extNomeApprox && finNome && nomeForteMatch(extNomeApprox, finNome));
                  if (!docMatch && !nomeMatch) return null;

                  let score = 0;
                  const evidencias: string[] = [];
                  const finValor = Math.abs(Number(fin.valor));
                  
                  if (valorExato(extValorApprox, finValor)) { score += 40; evidencias.push("Valor exato"); }
                  else if (valorTolerancia(extValorApprox, finValor, 5)) { score += 20; evidencias.push(`Valor ~${((1 - Math.abs(extValorApprox - finValor) / Math.max(extValorApprox, finValor)) * 100).toFixed(0)}%`); }
                  else if (valorTolerancia(extValorApprox, finValor, 15)) { score += 10; evidencias.push(`Valor aprox.`); }
                  else return null;
                  
                  if (docMatch) { score += 30; evidencias.push("CNPJ match"); }
                  if (nomeMatch) { score += 20; evidencias.push("Nome forte"); }
                  
                  if (finDate && extDateApprox) {
                    const daysDiff = Math.abs(new Date(extDateApprox).getTime() - new Date(finDate).getTime()) / 86400000;
                    if (daysDiff <= 5) { score += 10; evidencias.push(`Data ±${Math.round(daysDiff)}d`); }
                    else if (daysDiff <= 30) { score += 5; evidencias.push(`Data ±${Math.round(daysDiff)}d`); }
                  }
                  
                  if (fin.status === "pago" || fin.pago_sistema) evidencias.push("Já pago");
                  
                  return { fin, score, evidencias, finValor, finNome, finDate, finDoc, status: fin.status };
                }).filter(Boolean) as any[];
                
                scored.sort((a: any, b: any) => b.score - a.score);
                const topSugestoes = scored.slice(0, 3).filter((s: any) => s.score >= 20);

                unmatchedItems.push({
                  extrato_id: ext.id,
                  descricao_extrato: ext.descricao ?? "—",
                  contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
                  cpf_cnpj: ext.cpf_cnpj ?? "",
                  valor: ext.valor,
                  tipo: ext.tipo,
                  data_hora: ext.data_hora,
                  sugestoes: topSugestoes.map((s: any) => ({
                    lancamento_id: s.fin.id,
                    lancamento_tipo: isDebitoApprox ? "pagamento" : "recebimento",
                    descricao: s.fin.descricao,
                    nome: s.finNome,
                    valor: s.finValor,
                    data_vencimento: s.finDate,
                    status: s.status,
                    gc_codigo: s.fin.gc_codigo,
                    os_codigo: s.fin.os_codigo,
                    score: s.score,
                    evidencias: s.evidencias,
                    diferenca: Math.abs(extValorApprox - s.finValor),
                  })),
                });
              }
            }
          }
      }
    }

    return new Response(
      JSON.stringify({ success: true, stats, review: reviewItems, unmatched: unmatchedItems }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ success: false, error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
