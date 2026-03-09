import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// redeploy: 2026-03-09-v6

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

// Similaridade de nome por palavras em comum (Jaccard simplificado)
function nomeSimilarScore(a: string | null, b: string | null): number {
  if (!a || !b) return 0;
  const normalize = (s: string) =>
    s.toLowerCase()
     .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
     .replace(/[^a-z0-9\s]/g, "")
     .split(/\s+/).filter(w => w.length > 2);
  const wa = normalize(a);
  const wb = normalize(b);
  if (!wa.length || !wb.length) return 0;
  const inter = wa.filter(w => wb.includes(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return inter / union;
}

function nomeSimilar(a: string | null, b: string | null, threshold = 0.35): boolean {
  if (!a || !b) return false;
  const normalize = (s: string) =>
    s.toLowerCase()
     .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
     .replace(/[^a-z0-9\s]/g, "")
     .split(/\s+/).filter(w => w.length > 2);
  const wa = normalize(a);
  const wb = normalize(b);
  if (!wa.length || !wb.length) return false;
  const inter = wa.filter(w => wb.includes(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return inter / union >= threshold;
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
      const finDate = c.fin.data_vencimento ?? c.fin.data_emissao ?? "";
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
        const byNome = matches0.filter(c => nomeSimilar(extNome, c.nome));
        if (byNome.length === 1)
          return { rule: "CNPJ_VALOR_DATA_EXATO", candidato: byNome[0], auto: true };
      }
      const sorted = [...matches0].sort((a, b) => {
        const da = Math.abs(new Date(a.fin.data_vencimento ?? a.fin.data_emissao).getTime() - new Date(extDate).getTime());
        const db = Math.abs(new Date(b.fin.data_vencimento ?? b.fin.data_emissao).getTime() - new Date(extDate).getTime());
        return da - db;
      });
      return { rule: "CNPJ_VALOR_DATA_EXATO", candidato: sorted[0], auto: true };
    }
  }

  // Regra 1: CNPJ/CPF match + valor exato → auto-baixa imediata
  if (extDoc) {
    const matches = candidatos.filter(c =>
      docMatches(extDoc, c.doc) && valorExato(extValor, Number(c.fin.valor))
    );
    if (matches.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: matches[0], auto: true };
    if (matches.length > 1) {
      // Desempate por data mais próxima
      const byDate = matches.filter(c => {
        const finDate = c.fin.data_vencimento ?? c.fin.data_emissao;
        return finDate && dataProxima(extDate, finDate, 5);
      });
      if (byDate.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: byDate[0], auto: true };
      // Desempate por nome similar
      if (extNome) {
        const byNome = matches.filter(c => nomeSimilar(extNome, c.nome));
        if (byNome.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: byNome[0], auto: true };
      }
    }
  }

  // Regra 2: Chave PIX exata + valor exato → auto-baixa
  if (extPix) {
    const matches = candidatos.filter(c => {
      if (c.chavePix && c.chavePix.toLowerCase() === extPix)
        return valorExato(extValor, Number(c.fin.valor));
      const pixClean = extPix.replace(/\D/g, "");
      if (pixClean.length >= 8 && docMatches(pixClean, c.doc))
        return valorExato(extValor, Number(c.fin.valor));
      return false;
    });
    if (matches.length === 1) return { rule: "PIX_CHAVE_VALOR", candidato: matches[0], auto: true };
  }

  // Regra 3: CNPJ/CPF match + valor com tolerância ±2%
  if (extDoc) {
    const matches = candidatos.filter(c =>
      docMatches(extDoc, c.doc) && valorTolerancia(extValor, Number(c.fin.valor), 2)
    );
    if (matches.length === 1) return { rule: "CNPJ_VALOR_TOLERANCIA", candidato: matches[0], auto: true };
  }

  // Regra 4: Nome similar + valor exato → auto-baixa
  if (extNome) {
    const matches = candidatos.filter(c =>
      nomeSimilar(extNome, c.nome) && valorExato(extValor, Number(c.fin.valor))
    );
    if (matches.length === 1) return { rule: "NOME_VALOR_EXATO", candidato: matches[0], auto: true };
  }

  // Regra 5: Valor exato + data ±3 dias → auto ONLY if unambiguous after tiebreakers
  if (extDate) {
    const matches = candidatos.filter(c => {
      const finDate = c.fin.data_vencimento ?? c.fin.data_emissao;
      return valorExato(extValor, Number(c.fin.valor)) && finDate && dataProxima(extDate, finDate, 3);
    });
    if (matches.length === 1) {
      return { rule: "VALOR_DATA_EXATO", candidato: matches[0], auto: true };
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
      // TIEBREAKER 3: Name similarity (pick best score)
      if (extNome) {
        const scored = matches
          .map(c => ({ c, score: nomeSimilarScore(extNome, c.nome) }))
          .filter(x => x.score >= 0.35)
          .sort((a, b) => b.score - a.score);
        if (scored.length === 1) return { rule: "NOME_VALOR_EXATO", candidato: scored[0].c, auto: true };
        if (scored.length > 1 && scored[0].score - scored[1].score >= 0.2) {
          return { rule: "NOME_VALOR_EXATO", candidato: scored[0].c, auto: true };
        }
      }
      // TIEBREAKER 4: Closest date
      const sorted = [...matches].sort((a, b) => {
        const da = Math.abs(new Date(a.fin.data_vencimento ?? a.fin.data_emissao).getTime() - new Date(extDate).getTime());
        const db = Math.abs(new Date(b.fin.data_vencimento ?? b.fin.data_emissao).getTime() - new Date(extDate).getTime());
        return da - db;
      });
      const gap = sorted.length >= 2
        ? Math.abs(new Date(sorted[1].fin.data_vencimento ?? sorted[1].fin.data_emissao).getTime() - new Date(extDate).getTime())
          - Math.abs(new Date(sorted[0].fin.data_vencimento ?? sorted[0].fin.data_emissao).getTime() - new Date(extDate).getTime())
        : 0;
      // Only auto-link if there's a clear date gap (>= 1 day difference between best and second)
      if (gap >= 86400000) {
        return { rule: "VALOR_DATA_EXATO", candidato: sorted[0], auto: true };
      }
      // BLOCKED: ambiguity unresolved → send to review
      return { rule: "VALOR_DATA_EXATO", candidato: sorted[0], auto: false };
    }
  }

  // Regra 6: Valor exato + data ±7 dias → fallback ampliado
  if (extDate) {
    const fallback7 = candidatos.filter(c => {
      const finDate = c.fin.data_vencimento ?? c.fin.data_emissao;
      return valorExato(extValor, Number(c.fin.valor)) && finDate && dataProxima(extDate, finDate, 7);
    });
    if (fallback7.length === 1) return { rule: "VALOR_DATA_7DIAS", candidato: fallback7[0], auto: true };
    if (fallback7.length > 1) {
      // Desempate por nome
      if (extNome) {
        const comNome = fallback7.filter(c => nomeSimilar(extNome, c.nome, 0.6));
        if (comNome.length === 1)
          return { rule: "VALOR_DATA_7DIAS_NOME", candidato: comNome[0], auto: true };
      }
      return { rule: "VALOR_DATA_7DIAS" as MatchRule, candidato: fallback7[0], auto: false };
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
  // Filtrar candidatos pelo mesmo nome (ILIKE-like) ou CNPJ raiz
  const candidatos = pool.filter((fin: any) => {
    if (usedIds.has(fin.id) || alreadyLinked.has(fin.id)) return false;
    const gcId = isDebito ? fin.fornecedor_gc_id : fin.cliente_gc_id;
    const lkp = isDebito ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
    const finDoc = cleanDoc(fin.recipient_document) || lkp?.cpf_cnpj || "";
    const finNome = (isDebito ? fin.nome_fornecedor : fin.nome_cliente) ?? lkp?.nome ?? "";
    const finDate = fin.data_vencimento ?? fin.data_emissao ?? "";

    // Must match by CNPJ root or name similarity (higher threshold to avoid false positives like "Casa da Madeira" ≠ "Casa das Resistências")
    const docOk = extDoc && finDoc && docMatches(extDoc, finDoc);
    const nomeOk = extNome && nomeSimilar(extNome, finNome, 0.5);
    if (!docOk && !nomeOk) return false;

    // Must be within ±30 days
    if (!finDate || !extDate) return true;
    return dataProxima(extDate, finDate, 30);
  });

  if (candidatos.length < 2 || candidatos.length > 15) return null;

  // Sort by valor desc for greedy subset-sum
  const sorted = [...candidatos].sort((a, b) => Number(b.valor) - Number(a.valor));
  const tabela: "pagamentos" | "recebimentos" = isDebito ? "pagamentos" : "recebimentos";

  // Try exact sum (tolerance 0.01)
  const result = findSubsetSum(sorted, extValor, 0.01);
  if (result) {
    return {
      parcelas: result.map(fin => ({ id: fin.id, valor: Number(fin.valor), tabela })),
      rule: "SOMA_PARCELAS",
    };
  }

  return null;
}

// Greedy subset-sum with backtracking (max 15 items)
function findSubsetSum(items: any[], target: number, tolerance: number): any[] | null {
  const n = items.length;
  if (n > 15) return null;

  // Try all subsets of size 2..min(n, 10)
  const maxSize = Math.min(n, 10);

  function search(idx: number, remaining: number, selected: any[]): any[] | null {
    if (Math.abs(remaining) <= tolerance && selected.length >= 2) return selected;
    if (remaining < -tolerance || idx >= n || selected.length >= maxSize) return null;

    const val = Number(items[idx].valor);
    // Include items[idx]
    const withItem = search(idx + 1, remaining - val, [...selected, items[idx]]);
    if (withItem) return withItem;
    // Skip
    return search(idx + 1, remaining, selected);
  }

  return search(0, target, []);
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

    // 1. Extrato não reconciliado (excluindo exceções manuais)
    const MANUAL_EXCEPTIONS = ['SEM_PAR_GC', 'TRANSFERENCIA_INTERNA', 'PIX_DEVOLVIDO_MANUAL'];
    const { data: extratos, error: errE } = await supabase
      .from("fin_extrato_inter")
      .select("*")
      .eq("reconciliado", false)
      .or(`reconciliation_rule.is.null,reconciliation_rule.not.in.(${MANUAL_EXCEPTIONS.join(",")})`)
      .order("data_hora", { ascending: true })
      .limit(1000);

    if (errE) throw new Error(`fin_extrato_inter: ${errE.message}`);

    // 2. Lançamentos candidatos + lookup tables
    const [{ data: pagamentos }, { data: recebimentos }, { data: fornecedores }, { data: clientes }] = await Promise.all([
      supabase.from("fin_pagamentos").select("*")
        .not("status", "in", '("cancelado")')
        .order("data_vencimento", { ascending: false })
        .limit(2000),
      supabase.from("fin_recebimentos").select("*")
        .not("status", "in", '("cancelado")')
        .order("data_vencimento", { ascending: false })
        .limit(2000),
      supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj, chave_pix, nome"),
      supabase.from("fin_clientes").select("gc_id, cpf_cnpj, nome"),
    ]);

    // Pool secundário: lançamentos já pagos (para rastreabilidade retroativa)
    const cutoff90 = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
    const [{ data: pagamentosJaPagos }, { data: recebimentosJaPagos }] = await Promise.all([
      supabase.from("fin_pagamentos").select("id, valor, recipient_document, fornecedor_gc_id, nome_fornecedor, descricao, data_vencimento, data_liquidacao, gc_codigo")
        .eq("status", "pago")
        .gte("data_vencimento", cutoff90)
        .limit(2000),
      supabase.from("fin_recebimentos").select("id, valor, recipient_document, cliente_gc_id, nome_cliente, descricao, data_vencimento, data_liquidacao, gc_codigo")
        .eq("status", "pago")
        .gte("data_vencimento", cutoff90)
        .limit(2000),
    ]);

    // IDs já vinculados para evitar duplicatas
    const { data: linkedLancs } = await supabase
      .from("fin_extrato_inter")
      .select("lancamento_id")
      .eq("reconciliado", true)
      .not("lancamento_id", "is", null);

    const alreadyLinked = new Set(
      (linkedLancs ?? []).map((l: any) => l.lancamento_id).filter(Boolean)
    );

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

      // Build candidate list with enriched doc/pix from lookup tables
      const candidatos: Candidato[] = pool
        .filter((fin: any) => !usedIds.has(fin.id) && !alreadyLinked.has(fin.id))
        .map((fin: any) => {
          const gcId = isDebito ? fin.fornecedor_gc_id : fin.cliente_gc_id;
          const lookup = isDebito ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
          const doc = cleanDoc(fin.recipient_document) || lookup?.cpf_cnpj || "";
          const chavePix = (isDebito && lookup) ? (lookup as any).chave_pix ?? "" : "";
          const nome = (isDebito ? fin.nome_fornecedor : fin.nome_cliente) ?? lookup?.nome ?? "";
          return { fin, tipo: (isDebito ? "pagar" : "receber") as "pagar" | "receber", doc, chavePix, nome };
        });

      const { rule, candidato, auto } = aplicarRegras(ext, candidatos);

      if (candidato && auto) {
        try {
          await vincular(supabase, ext, candidato, rule!);
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

        // When extract has a name, filter out candidates with no name similarity
        let candidatosEfetivos = mesmoValor;
        if (extNomeCheck && mesmoValor.length > 1) {
          const comNome = mesmoValor.filter(c => nomeSimilar(extNomeCheck, c.nome, 0.3));
          if (comNome.length < mesmoValor.length) {
            candidatosEfetivos = comNome;
          }
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
                await vincular(supabase, ext, withDoc[0], "CNPJ_VALOR_EXATO");
                usedIds.add(withDoc[0].fin.id);
                stats.auto++;
                continue;
              } catch { stats.errors++; continue; }
            }
          }

          // Try to resolve collision by nome similar (stricter threshold)
          if (extNomeCheck) {
            const withNome = candidatosEfetivos.filter(c => nomeSimilar(extNomeCheck, c.nome));
            if (withNome.length === 1) {
              try {
                await vincular(supabase, ext, withNome[0], "NOME_VALOR_EXATO");
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
            motivo: `Colisão real: ${candidatosEfetivos.length} lançamentos com mesmo valor e nome similar`,
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
          const finDate = candidatoUnico.fin.data_vencimento ?? candidatoUnico.fin.data_emissao;
          const extDate = ext.data_hora?.substring(0, 10) ?? "";
          const nomeMatch = extNomeCheck && nomeSimilar(extNomeCheck, candidatoUnico.nome);
          const dateWindow = nomeMatch ? 10 : 5;

          // If extract has a name and it doesn't match the candidate at all, skip to já-pagos
          if (extNomeCheck && !nomeSimilar(extNomeCheck, candidatoUnico.nome, 0.2)) {
            // Name mismatch — don't link to this candidate, fall through to já-pagos
          } else if (finDate && extDate && dataProxima(extDate, finDate, dateWindow)) {
            try {
              await vincular(supabase, ext, candidatoUnico, nomeMatch ? "NOME_VALOR_EXATO" : "VALOR_UNICO");
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
              motivo: "Valor exato, aguardando confirmação de data",
              melhor: {
                id: candidatoUnico.fin.id,
                valor: candidatoUnico.fin.valor,
                descricao: candidatoUnico.fin.descricao,
                nome: candidatoUnico.fin.nome_fornecedor ?? candidatoUnico.fin.nome_cliente ?? "—",
                rule: "VALOR_UNICO",
              },
            });
            stats.review++;
            handledByPendentes = true;
          }
        }
        // candidatosEfetivos === 0 → handledByPendentes stays false → fall to já-pagos

        if (!handledByPendentes) {
          // Segundo passo: tentar rastreabilidade em lançamentos já pagos
          const isDebitoExt = ext.tipo === "DEBITO";
          const poolJaPago = isDebitoExt ? (pagamentosJaPagos ?? []) : (recebimentosJaPagos ?? []);
          const extDoc   = cleanDoc(ext.cpf_cnpj);
          const extValor = Math.abs(Number(ext.valor));

          const extNomeRast = ext.nome_contraparte ?? ext.contrapartida ?? "";

          const extDateRast = ext.data_hora?.substring(0, 10) ?? "";

          // Filter out already-linked IDs
          const poolDisponivel = poolJaPago.filter((fin: any) => !alreadyLinked.has(fin.id));

          // Tentar por CNPJ + valor exato
          const matchJaPago = poolDisponivel.find((fin: any) => {
            const gcId  = isDebitoExt ? fin.fornecedor_gc_id : fin.cliente_gc_id;
            const lkp   = isDebitoExt ? fornMap[gcId ?? ""] : cliMap[gcId ?? ""];
            const finDoc = cleanDoc(fin.recipient_document) || lkp?.cpf_cnpj || "";
            return docMatches(extDoc, finDoc) && valorExato(extValor, Number(fin.valor));
          })
          // Fallback 2: nome similar + valor exato (para TEDs/boletos sem CNPJ)
          ?? (extNomeRast ? poolDisponivel.find((fin: any) => {
            const finNome = isDebitoExt ? fin.nome_fornecedor : fin.nome_cliente;
            return nomeSimilar(extNomeRast, finNome) && valorExato(extValor, Number(fin.valor));
          }) : null)
          // Fallback 3: valor exato único no pool (TEDs sem CNPJ e nome genérico)
          // Seguro para rastreabilidade: não altera o lançamento, apenas vincula
          ?? (() => {
            if (extDoc) return null; // Se tem CNPJ e não matchou, não arriscar
            const valorMatches = poolDisponivel.filter((fin: any) =>
              valorExato(extValor, Number(fin.valor))
            );
            return valorMatches.length === 1 ? valorMatches[0] : null;
          })();

          if (matchJaPago) {
            try {
              await vincularRastreabilidade(supabase, ext, matchJaPago.id, "LINK_JA_PAGO_GC");
              stats.auto++;
            } catch (e) {
              console.error("Erro rastreabilidade:", (e as Error).message);
              stats.errors++;
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
            // Terceiro passo: tentar SOMA_PARCELAS em ambos os pools (pendentes + já pagos)
            const extNomeSoma = ext.nome_contraparte ?? ext.contrapartida ?? "";
            const extDocSoma = cleanDoc(ext.cpf_cnpj);
            const extDateSoma = ext.data_hora?.substring(0, 10) ?? "";
            const isDebitoSoma = ext.tipo === "DEBITO";
            
            // DEDUPLICAR por ID para evitar que o mesmo registro apareça 2x
            const rawPool = [
              ...(isDebitoSoma ? (pagamentos ?? []) : (recebimentos ?? [])),
              ...(isDebitoSoma ? (pagamentosJaPagos ?? []) : (recebimentosJaPagos ?? [])),
            ];
            const seenPoolIds = new Set<string>();
            const allPool = rawPool.filter((fin: any) => {
              if (seenPoolIds.has(fin.id)) return false;
              seenPoolIds.add(fin.id);
              return true;
            });

            const somaResult = tentarSomaParcelas(
              extValor, extDocSoma, extNomeSoma, extDateSoma,
              allPool, isDebitoSoma, fornMap, cliMap, alreadyLinked, usedIds
            );

            if (somaResult) {
              try {
                await saveSomaParcelas(supabase, ext.id, extValor, somaResult.parcelas, somaResult.rule);
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
