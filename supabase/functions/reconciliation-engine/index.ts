import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const AUTO_THRESHOLD = 70;
const REVIEW_THRESHOLD = 40;

function normalizeText(t: string): string {
  return t.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "").trim();
}

function cleanDoc(d: string | null | undefined): string {
  return (d ?? "").replace(/\D/g, "");
}

function docMatches(a: string | null | undefined, b: string | null | undefined): boolean {
  const cleanA = cleanDoc(a);
  const cleanB = cleanDoc(b);
  if (!cleanA || !cleanB) return false;
  if (cleanA === cleanB) return true;
  if (cleanA.length >= 8 && cleanB.startsWith(cleanA)) return true;
  if (cleanB.length >= 8 && cleanA.startsWith(cleanB)) return true;
  return false;
}

function dateDiffDays(a: string, b: string): number {
  return Math.abs((new Date(a).getTime() - new Date(b).getTime()) / 86400000);
}

function extrairNomeDaDescricao(descricao: string | null): string {
  if (!descricao) return "";
  const patterns = [
    /(?:PAGAMENTO|RECEBIMENTO)\s+(?:DE\s+)?TITULO\s*-\s*(.+)$/i,
    /Cp\s*:\d+-(.+)$/i,
    /-\s+(?:[\d\s]+?\s)([A-Za-z][A-Za-z\s.&]+[A-Za-z.])$/,
    /\d{2}\s*\.?\d{3}\s*\.?\d{3}\s+([A-Za-z][A-Za-z\s.]+)$/,
    /\d\s+([A-Za-z][A-Za-z\s.&]{2,})\s*$/,
  ];
  for (const p of patterns) {
    const m = descricao.match(p);
    if (m?.[1]) return m[1].trim();
  }
  return "";
}

interface ScoredMatch {
  fin: any;
  tipo: "receber" | "pagar";
  score: number;
  reasons: string[];
}

function scoreMatch(
  extrato: any,
  fin: any,
  finCpfCnpj: string | null,
  extractedName: string
): { score: number; reasons: string[] } {
  let score = 0;
  const reasons: string[] = [];

  const txAmt = Math.abs(Number(extrato.valor));
  const finAmt = Number(fin.valor);

  // VALOR (40 pts)
  if (Math.abs(txAmt - finAmt) <= 0.01) { score += 40; reasons.push("Valor exato"); }
  else if (finAmt > 0 && Math.abs(txAmt - finAmt) / finAmt <= 0.02) { score += 22; reasons.push("Valor ±2%"); }
  else if (finAmt > 0 && Math.abs(txAmt - finAmt) / finAmt <= 0.05) { score += 10; reasons.push("Valor ±5%"); }

  // DATA (30 pts)
  const finDate = fin.data_vencimento ?? fin.data_emissao;
  if (extrato.data_hora && finDate) {
    const txDate = extrato.data_hora.substring(0, 10);
    const diff = dateDiffDays(txDate, finDate);
    if (diff === 0) { score += 30; reasons.push("Data exata"); }
    else if (diff <= 1) { score += 25; reasons.push("Data ±1d"); }
    else if (diff <= 3) { score += 18; reasons.push("Data ±3d"); }
    else if (diff <= 5) { score += 10; reasons.push("Data ±5d"); }
    else if (diff <= 10) { score += 4; reasons.push("Data ±10d"); }
  }

  // CPF/CNPJ (20 pts)
  const txDoc = cleanDoc(extrato.cpf_cnpj);
  const fDoc = cleanDoc(finCpfCnpj);
  if (txDoc && fDoc && txDoc === fDoc) { score += 20; reasons.push("CPF/CNPJ idêntico"); }

  // NOME (15 pts)
  const txName = normalizeText(extrato.contrapartida ?? extractedName ?? "");
  const finName = normalizeText(fin.nome_fornecedor ?? fin.nome_cliente ?? "");
  if (txName && finName) {
    if (txName === finName) { score += 15; reasons.push("Nome exato"); }
    else if (txName.includes(finName) || finName.includes(txName)) { score += 8; reasons.push("Nome parcial"); }
  }

  return { score: Math.min(score, 100), reasons };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body = await req.json().catch(() => ({}));
    const { date_from, date_to } = body;

    // 1. Extrato não reconciliado
    let q = supabase.from("fin_extrato_inter").select("*")
      .eq("reconciliado", false)
      .order("data_hora", { ascending: false })
      .limit(200);
    if (date_from) q = q.gte("data_hora", date_from);
    if (date_to) q = q.lte("data_hora", date_to);
    const { data: extratos } = await q;

    // 2. Lançamentos não liquidados + CPF dos fornecedores/clientes
    const [{ data: pagamentos }, { data: recebimentos }, { data: fornecedores }, { data: clientes }] = await Promise.all([
      supabase.from("fin_pagamentos").select("*").eq("liquidado", false).limit(500),
      supabase.from("fin_recebimentos").select("*").eq("liquidado", false).limit(500),
      supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj"),
      supabase.from("fin_clientes").select("gc_id, cpf_cnpj"),
    ]);

    // Index fornecedor/cliente CPF por gc_id
    const fornCpf: Record<string, string> = {};
    for (const f of (fornecedores ?? [])) { if (f.cpf_cnpj) fornCpf[f.gc_id] = f.cpf_cnpj; }
    const cliCpf: Record<string, string> = {};
    for (const c of (clientes ?? [])) { if (c.cpf_cnpj) cliCpf[c.gc_id] = c.cpf_cnpj; }

    const usedIds = new Set<string>();
    const stats = { auto: 0, review: 0, unmatched: 0, errors: 0 };
    const reviewItems: any[] = [];
    const unmatchedItems: any[] = [];

    for (const ext of (extratos ?? [])) {
      const isDebito = ext.tipo === "DEBITO";
      const pool = isDebito ? (pagamentos ?? []) : (recebimentos ?? []);
      const extractedName = extrairNomeDaDescricao(ext.descricao);

      const candidates: ScoredMatch[] = pool
        .filter((fin: any) => !usedIds.has(fin.id))
        .filter((fin: any) => {
          const finDate = fin.data_vencimento ?? fin.data_emissao;
          if (!finDate || !ext.data_hora) return false;
          const dayDiff = dateDiffDays(ext.data_hora.substring(0, 10), finDate);
          const amtDiff = Number(fin.valor) > 0 ? Math.abs(Math.abs(Number(ext.valor)) - Number(fin.valor)) / Number(fin.valor) : 1;
          return dayDiff <= 10 && amtDiff <= 0.10;
        })
        .map((fin: any) => {
          const cpf = isDebito
            ? (fin.fornecedor_gc_id ? fornCpf[fin.fornecedor_gc_id] : null)
            : (fin.cliente_gc_id ? cliCpf[fin.cliente_gc_id] : null);
          const { score, reasons } = scoreMatch(ext, fin, cpf ?? null, extractedName);
          return { fin, tipo: (isDebito ? "pagar" : "receber") as "pagar" | "receber", score, reasons };
        })
        .filter(c => c.score >= REVIEW_THRESHOLD)
        .sort((a, b) => b.score - a.score);

      if (candidates.length === 0) {
        stats.unmatched++;
        unmatchedItems.push({
          extrato_id: ext.id,
          descricao_extrato: ext.descricao ?? ext.contrapartida ?? "—",
          contrapartida: ext.contrapartida ?? "",
          cpf_cnpj: ext.cpf_cnpj ?? "",
          valor: ext.valor,
          tipo: ext.tipo,
          data_hora: ext.data_hora,
        });
        continue;
      }

      const best = candidates[0];

      // Collision detection: multiple with same value & score >= auto threshold
      const colliding = candidates.filter(
        c => c.score >= AUTO_THRESHOLD && Math.abs(Number(c.fin.valor) - Number(best.fin.valor)) <= 0.01
      );

      if (colliding.length > 1) {
        // Try CPF/CNPJ tiebreaker
        const withCpf = colliding.filter(c => c.reasons.includes("CPF/CNPJ idêntico"));

        if (withCpf.length === 1) {
          // Clean tiebreak
          try {
            await vincular(supabase, ext, withCpf[0], [...withCpf[0].reasons, "Desempate CPF/CNPJ"]);
            usedIds.add(withCpf[0].fin.id);
            stats.auto++;
          } catch { stats.errors++; }
        } else {
          // Unresolved collision → review
          reviewItems.push({
            extrato_id: ext.id,
            descricao_extrato: ext.descricao,
            valor: ext.valor,
            candidatos: colliding.map(c => ({
              id: c.fin.id, valor: c.fin.valor, descricao: c.fin.descricao,
              nome: c.fin.nome_fornecedor ?? c.fin.nome_cliente ?? "—",
              score: c.score, reasons: c.reasons,
            })),
            motivo: `Colisão: ${colliding.length} lançamentos mesmo valor`,
          });
          stats.review++;
        }
        continue;
      }

      // No collision
      if (best.score >= AUTO_THRESHOLD) {
        try {
          await vincular(supabase, ext, best, best.reasons);
          usedIds.add(best.fin.id);
          stats.auto++;
        } catch (e) {
          stats.errors++;
          console.error(`Erro vincular ext ${ext.id}:`, (e as Error).message);
        }
      } else {
        reviewItems.push({
          extrato_id: ext.id,
          descricao_extrato: ext.descricao,
          valor: ext.valor,
          melhor: {
            id: best.fin.id, valor: best.fin.valor, descricao: best.fin.descricao,
            nome: best.fin.nome_fornecedor ?? best.fin.nome_cliente ?? "—",
            score: best.score, reasons: best.reasons,
          },
          motivo: `Score ${best.score} < ${AUTO_THRESHOLD}`,
        });
        stats.review++;
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

async function vincular(supabase: any, ext: any, match: ScoredMatch, reasons: string[]) {
  const table = match.tipo === "pagar" ? "fin_pagamentos" : "fin_recebimentos";
  const now = new Date().toISOString();

  await Promise.all([
    supabase.from("fin_extrato_inter").update({
      reconciliado: true,
      lancamento_id: match.fin.id,
      reconciliado_em: now,
    }).eq("id", ext.id),
    supabase.from(table).update({
      pago_sistema: true,
      pago_sistema_em: now,
    }).eq("id", match.fin.id),
  ]);

  await supabase.from("fin_sync_log").insert({
    tipo: "conciliacao_auto",
    referencia_id: ext.id,
    status: "success",
    payload: { extrato_id: ext.id, lancamento_id: match.fin.id, score: match.score, reasons },
  });
}
