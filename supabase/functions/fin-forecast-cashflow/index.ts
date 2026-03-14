import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  const today = new Date();
  const weeks: { semana: string; inicio: string; fim: string; entradas: number; saidas: number; saldo_projetado: number; itens_entrada: any[]; itens_saida: any[] }[] = [];

  // Get current bank balance
  const { data: contas } = await supabase
    .from("fin_contas_bancarias")
    .select("saldo_atual")
    .eq("ativa", true);
  
  let saldoAtual = (contas || []).reduce((s, c) => s + Number(c.saldo_atual || 0), 0);

  // Build 13 weeks
  for (let w = 0; w < 13; w++) {
    const weekStart = new Date(today);
    weekStart.setDate(today.getDate() + w * 7);
    const weekEnd = new Date(weekStart);
    weekEnd.setDate(weekStart.getDate() + 6);

    const startStr = weekStart.toISOString().split("T")[0];
    const endStr = weekEnd.toISOString().split("T")[0];

    // Fetch AR pending in this week
    const { data: arSemana } = await supabase
      .from("fin_recebimentos")
      .select("id, descricao, valor, data_vencimento, nome_cliente")
      .eq("status", "pendente")
      .gte("data_vencimento", startStr)
      .lte("data_vencimento", endStr);

    // Fetch AP pending in this week
    const { data: apSemana } = await supabase
      .from("fin_pagamentos")
      .select("id, descricao, valor, data_vencimento, nome_fornecedor")
      .eq("status", "pendente")
      .gte("data_vencimento", startStr)
      .lte("data_vencimento", endStr);

    // Fetch agenda payments in this week
    const { data: agendaSemana } = await supabase
      .from("fin_agenda_pagamentos")
      .select("id, descricao, valor, data_vencimento, nome_fornecedor")
      .eq("status", "pendente")
      .gte("data_vencimento", startStr)
      .lte("data_vencimento", endStr);

    const entradas = (arSemana || []).reduce((s, r) => s + Number(r.valor), 0);
    const saidasAP = (apSemana || []).reduce((s, p) => s + Number(p.valor), 0);
    const saidasAgenda = (agendaSemana || []).reduce((s, a) => s + Number(a.valor), 0);
    const saidas = saidasAP + saidasAgenda;

    saldoAtual = saldoAtual + entradas - saidas;

    weeks.push({
      semana: `S${w + 1}`,
      inicio: startStr,
      fim: endStr,
      entradas,
      saidas,
      saldo_projetado: saldoAtual,
      itens_entrada: (arSemana || []).map(r => ({
        id: r.id, descricao: r.descricao, valor: Number(r.valor),
        vencimento: r.data_vencimento, cliente: r.nome_cliente,
      })),
      itens_saida: [
        ...(apSemana || []).map(p => ({
          id: p.id, descricao: p.descricao, valor: Number(p.valor),
          vencimento: p.data_vencimento, fornecedor: p.nome_fornecedor, tipo: "ap",
        })),
        ...(agendaSemana || []).map(a => ({
          id: a.id, descricao: a.descricao, valor: Number(a.valor),
          vencimento: a.data_vencimento, fornecedor: a.nome_fornecedor, tipo: "agenda",
        })),
      ],
    });
  }

  // Detect risk weeks (negative balance or big drops)
  const semanasRisco = weeks
    .filter(w => w.saldo_projetado < 0 || (w.saidas > w.entradas * 2 && w.saidas > 5000))
    .map(w => ({
      semana: w.semana,
      inicio: w.inicio,
      fim: w.fim,
      saldo: w.saldo_projetado,
      deficit: w.saidas - w.entradas,
    }));

  // Create alerts for risk weeks
  for (const risco of semanasRisco) {
    const { data: existing } = await supabase
      .from("fin_alertas")
      .select("id")
      .eq("tipo", "caixa_risco")
      .eq("entidade_id", `semana-${risco.inicio}`)
      .in("status", ["aberto", "em_analise"])
      .limit(1);

    if (!existing || existing.length === 0) {
      await supabase.from("fin_alertas").insert({
        tipo: "caixa_risco",
        severidade: risco.saldo < 0 ? "critica" : "alta",
        titulo: `Risco de caixa — ${risco.semana} (${risco.inicio})`,
        descricao: `Saldo projetado: R$ ${risco.saldo.toFixed(2)}. Déficit: R$ ${risco.deficit.toFixed(2)}`,
        entidade_tipo: "forecast",
        entidade_id: `semana-${risco.inicio}`,
        valor_impacto: Math.abs(risco.deficit),
        status: "aberto",
      });
    }
  }

  // Log execution
  await supabase.from("fin_agent_runs").insert({
    tipo: "forecast-cashflow",
    status: "success",
    resumo: `13 semanas projetadas. ${semanasRisco.length} semanas com risco.`,
    alertas_criados: semanasRisco.length,
    inicio: new Date().toISOString(),
    fim: new Date().toISOString(),
    duracao_ms: 0,
  });

  return new Response(
    JSON.stringify({
      ok: true,
      saldo_inicial: (contas || []).reduce((s, c) => s + Number(c.saldo_atual || 0), 0),
      semanas: weeks,
      semanas_risco: semanasRisco,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
