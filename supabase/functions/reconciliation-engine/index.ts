import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// ─── Utilitários ────────────────────────────────────────────

function cleanDoc(d: string | null | undefined): string {
  return (d ?? "").replace(/\D/g, "");
}

function docMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const cleanA = cleanDoc(a);
  const cleanB = cleanDoc(b);
  if (cleanA.length < 8 || cleanB.length < 8) return false;
  return cleanA === cleanB || cleanA.startsWith(cleanB) || cleanB.startsWith(cleanA);
}

function valorExato(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.01;
}

function valorTolerancia(a: number, b: number, pct = 2): boolean {
  if (a === 0 || b === 0) return false;
  return Math.abs(a - b) / Math.max(a, b) <= pct / 100;
}

function dataProxima(a: string, b: string, dias = 3): boolean {
  const da = new Date(a).getTime();
  const db = new Date(b).getTime();
  return Math.abs(da - db) <= dias * 86400000;
}

type MatchRule = "CNPJ_VALOR_EXATO" | "PIX_CHAVE_VALOR" | "CNPJ_VALOR_TOLERANCIA" | "VALOR_DATA_EXATO" | "SCORE_ALTO";

interface Candidato {
  fin: any;
  tipo: "pagar" | "receber";
  doc: string; // cleaned CPF/CNPJ from fornecedor/cliente lookup
  chavePix: string;
}

// ─── Regras Determinísticas em Cascata ──────────────────────

function aplicarRegras(ext: any, candidatos: Candidato[]): { rule: MatchRule | null; candidato: Candidato | null; auto: boolean } {
  const extValor = Math.abs(Number(ext.valor));
  const extDoc = cleanDoc(ext.cpf_cnpj);
  const extPix = (ext.chave_pix ?? "").trim().toLowerCase();
  const extDate = ext.data_hora?.substring(0, 10) ?? "";

  // Regra 1: CNPJ/CPF match + valor exato → auto-baixa imediata
  if (extDoc) {
    const matches = candidatos.filter(c => docMatches(extDoc, c.doc) && valorExato(extValor, Number(c.fin.valor)));
    if (matches.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: matches[0], auto: true };
    // If multiple match by doc+valor, try narrowing by date
    if (matches.length > 1) {
      const byDate = matches.filter(c => {
        const finDate = c.fin.data_vencimento ?? c.fin.data_emissao;
        return finDate && dataProxima(extDate, finDate, 5);
      });
      if (byDate.length === 1) return { rule: "CNPJ_VALOR_EXATO", candidato: byDate[0], auto: true };
    }
  }

  // Regra 2: Chave PIX exata + valor exato → auto-baixa
  if (extPix) {
    const matches = candidatos.filter(c => {
      if (c.chavePix && c.chavePix.toLowerCase() === extPix) return valorExato(extValor, Number(c.fin.valor));
      // Also check if pix key IS the doc
      const pixClean = extPix.replace(/\D/g, "");
      if (pixClean.length >= 8 && docMatches(pixClean, c.doc)) return valorExato(extValor, Number(c.fin.valor));
      return false;
    });
    if (matches.length === 1) return { rule: "PIX_CHAVE_VALOR", candidato: matches[0], auto: true };
  }

  // Regra 3: CNPJ/CPF match + valor com tolerância ±2% → auto-baixa (boleto com juros/desconto)
  if (extDoc) {
    const matches = candidatos.filter(c => docMatches(extDoc, c.doc) && valorTolerancia(extValor, Number(c.fin.valor), 2));
    if (matches.length === 1) return { rule: "CNPJ_VALOR_TOLERANCIA", candidato: matches[0], auto: true };
  }

  // Regra 4: Valor exato + data ±3 dias → sugestão ao usuário (não auto)
  if (extDate) {
    const matches = candidatos.filter(c => {
      const finDate = c.fin.data_vencimento ?? c.fin.data_emissao;
      return valorExato(extValor, Number(c.fin.valor)) && finDate && dataProxima(extDate, finDate, 3);
    });
    if (matches.length === 1) return { rule: "VALOR_DATA_EXATO", candidato: matches[0], auto: false };
  }

  return { rule: null, candidato: null, auto: false };
}

// ─── Handler principal ───────────────────────────────────────

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    // 1. Extrato não reconciliado
    const { data: extratos, error: errE } = await supabase
      .from("fin_extrato_inter")
      .select("*")
      .eq("reconciliado", false)
      .order("data_hora", { ascending: false })
      .limit(200);

    if (errE) throw new Error(`fin_extrato_inter: ${errE.message}`);

    // 2. Lançamentos candidatos
    const [{ data: pagamentos }, { data: recebimentos }, { data: fornecedores }, { data: clientes }] = await Promise.all([
      supabase.from("fin_pagamentos").select("*")
        .eq("liquidado", false)
        .eq("pago_sistema", false)
        .not("status", "eq", "cancelado")
        .limit(500),
      supabase.from("fin_recebimentos").select("*")
        .eq("liquidado", false)
        .eq("pago_sistema", false)
        .not("status", "eq", "cancelado")
        .limit(500),
      supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj, chave_pix, nome"),
      supabase.from("fin_clientes").select("gc_id, cpf_cnpj, nome"),
    ]);

    // Exclude lançamentos already linked by another extrato
    const { data: linkedLancs } = await supabase
      .from("fin_extrato_inter")
      .select("lancamento_id")
      .eq("reconciliado", true)
      .not("lancamento_id", "is", null);
    const alreadyLinked = new Set((linkedLancs ?? []).map((l: any) => l.lancamento_id));

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
          // Also use recipient_document directly if available
          const doc = cleanDoc(fin.recipient_document) || lookup?.cpf_cnpj || "";
          const chavePix = (isDebito && lookup) ? (lookup as any).chave_pix ?? "" : "";
          return { fin, tipo: (isDebito ? "pagar" : "receber") as "pagar" | "receber", doc, chavePix };
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
        // Sugestão: valor+data match, needs user confirmation
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
        const mesmoValor = candidatos.filter(c => valorExato(extValor, Number(c.fin.valor)));

        if (mesmoValor.length > 1) {
          // Try to resolve collision by document
          const extDoc = cleanDoc(ext.cpf_cnpj);
          if (extDoc) {
            const withDoc = mesmoValor.filter(c => docMatches(extDoc, c.doc));
            if (withDoc.length === 1) {
              try {
                await vincular(supabase, ext, withDoc[0], "CNPJ_VALOR_EXATO");
                usedIds.add(withDoc[0].fin.id);
                stats.auto++;
                continue;
              } catch { stats.errors++; continue; }
            }
          }

          // Unresolved collision → review
          reviewItems.push({
            extrato_id: ext.id,
            descricao_extrato: ext.descricao ?? "—",
            contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
            cpf_cnpj: ext.cpf_cnpj ?? "",
            valor: ext.valor,
            tipo: ext.tipo,
            data_hora: ext.data_hora,
            motivo: `Colisão: ${mesmoValor.length} lançamentos com mesmo valor`,
            candidatos: mesmoValor.map(c => ({
              id: c.fin.id,
              valor: c.fin.valor,
              descricao: c.fin.descricao,
              nome: c.fin.nome_fornecedor ?? c.fin.nome_cliente ?? "—",
              doc: c.doc,
            })),
          });
          stats.review++;
        } else if (mesmoValor.length === 1) {
          // Single valor match but no date/doc → sugestão
          reviewItems.push({
            extrato_id: ext.id,
            descricao_extrato: ext.descricao ?? "—",
            contrapartida: ext.nome_contraparte ?? ext.contrapartida ?? "",
            cpf_cnpj: ext.cpf_cnpj ?? "",
            valor: ext.valor,
            tipo: ext.tipo,
            data_hora: ext.data_hora,
            motivo: "Valor exato, sem confirmação de data/documento",
            melhor: {
              id: mesmoValor[0].fin.id,
              valor: mesmoValor[0].fin.valor,
              descricao: mesmoValor[0].fin.descricao,
              nome: mesmoValor[0].fin.nome_fornecedor ?? mesmoValor[0].fin.nome_cliente ?? "—",
              rule: "VALOR_UNICO",
            },
          });
          stats.review++;
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

// ─── Vincular (auto-baixa atômica) ──────────────────────────

async function vincular(supabase: any, ext: any, match: Candidato, rule: string) {
  const table = match.tipo === "pagar" ? "fin_pagamentos" : "fin_recebimentos";
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

  // 3. Log
  await supabase.from("fin_sync_log").insert({
    tipo: "conciliacao_auto",
    referencia_id: ext.id,
    status: "success",
    payload: { extrato_id: ext.id, lancamento_id: match.fin.id, rule },
  });
}
