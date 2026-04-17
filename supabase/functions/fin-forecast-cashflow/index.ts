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

  // ═══════════════════════════════════════════
  // ANÁLISE IA (Gemini Pro) — Insights estratégicos sobre as 13 semanas
  // ═══════════════════════════════════════════
  let analiseIA = "";
  const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
  if (LOVABLE_API_KEY) {
    try {
      const resumoSemanas = weeks.map(w =>
        `${w.semana} (${w.inicio}): in R$ ${w.entradas.toFixed(2)} | out R$ ${w.saidas.toFixed(2)} | saldo R$ ${w.saldo_projetado.toFixed(2)}`
      ).join("\n");

      const saldoInicial = (contas || []).reduce((s, c) => s + Number(c.saldo_atual || 0), 0);

      const prompt = `Você é o ARGUS, CFO virtual da WeDo. Analise esta projeção de fluxo de caixa de 13 semanas:

Saldo inicial: R$ ${saldoInicial.toFixed(2)}

${resumoSemanas}

Semanas de risco detectadas: ${semanasRisco.length}
${semanasRisco.map(r => `- ${r.semana}: saldo R$ ${r.saldo.toFixed(2)}, déficit R$ ${r.deficit.toFixed(2)}`).join("\n")}

Tarefa: em até 8 linhas escreva análise estratégica:
1. 🔴 RISCO PRINCIPAL (qual semana e por quê)
2. 📊 PADRÃO (concentração de saídas? sazonalidade? hiato de entrada?)
3. 🎯 3 AÇÕES preventivas específicas (antecipar recebíveis? renegociar AP? captar capital de giro?)
4. 💡 OPORTUNIDADE (semana com sobra → onde investir/amortizar)
Use R$ e %. Tom de sócio, direto.`;

      const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${LOVABLE_API_KEY}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "google/gemini-2.5-pro",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000,
        }),
      });

      if (aiResp.ok) {
        const data = await aiResp.json();
        analiseIA = data.choices?.[0]?.message?.content || "";

        if (analiseIA) {
          await supabase.from("fin_model_signals").insert({
            tipo: "forecast_ia_briefing",
            entidade_tipo: "forecast",
            entidade_id: new Date().toISOString().slice(0, 10),
            metadata: { briefing: analiseIA, semanas_risco: semanasRisco.length },
            confianca: 0.9,
            periodo: new Date().toISOString().slice(0, 10),
          });
        }
      }
    } catch (e) {
      console.error("Erro IA forecast:", e);
    }
  }

  // Log execution
  await supabase.from("fin_agent_runs").insert({
    tipo: "forecast-cashflow",
    status: "success",
    resumo: analiseIA
      ? `13 semanas projetadas. ${semanasRisco.length} risco | IA: ${analiseIA.slice(0, 150)}...`
      : `13 semanas projetadas. ${semanasRisco.length} semanas com risco.`,
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
      briefing_ia: analiseIA || null,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
