import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

function fmt(v: number) { return v.toFixed(2); }

function groupBy<T>(arr: T[], keyFn: (item: T) => string): Record<string, T[]> {
  const map: Record<string, T[]> = {};
  for (const item of arr) {
    const k = keyFn(item);
    (map[k] ||= []).push(item);
  }
  return map;
}

function topN(map: Record<string, number>, n = 10): string {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, n)
    .map(([k, v], i) => `${i + 1}. ${k}: R$ ${fmt(v)}`)
    .join("\n") || "Nenhum";
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { message, page, history } = await req.json();
    if (!message) throw new Error("Mensagem vazia");

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const apiKey = Deno.env.get("LOVABLE_API_KEY");
    if (!apiKey) throw new Error("LOVABLE_API_KEY não configurada");

    const supabase = createClient(supabaseUrl, serviceKey);

    const today = new Date().toISOString().slice(0, 10);
    const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";
    const monthEnd = new Date(new Date(monthStart).getFullYear(), new Date(monthStart).getMonth() + 1, 0).toISOString().slice(0, 10);

    // ── Parallel queries ──────────────────────────────────────────────
    const [
      { data: recebPendentes },
      { data: pagPendentes },
      { data: recebVencidos },
      { data: pagVencidos },
      { data: extratoMes },
      { data: contas },
      { data: recebMes },
      { data: pagMes },
      { data: osMes },
      { data: vendasMes },
      { data: metas },
    ] = await Promise.all([
      // Recebimentos pendentes próx 7 dias
      supabase.from("fin_recebimentos")
        .select("id, valor, data_vencimento, nome_cliente, status, descricao, os_codigo")
        .in("status", ["aberto", "vencido", "pendente"])
        .gte("data_vencimento", today)
        .lte("data_vencimento", weekFromNow)
        .order("data_vencimento").limit(30),
      // Pagamentos pendentes próx 7 dias
      supabase.from("fin_pagamentos")
        .select("id, valor, data_vencimento, nome_fornecedor, status, descricao")
        .in("status", ["aberto", "vencido", "pendente"])
        .gte("data_vencimento", today)
        .lte("data_vencimento", weekFromNow)
        .order("data_vencimento").limit(30),
      // Inadimplência
      supabase.from("fin_recebimentos")
        .select("id, valor, data_vencimento, nome_cliente, descricao, os_codigo")
        .eq("status", "vencido")
        .lt("data_vencimento", today)
        .order("data_vencimento", { ascending: false }).limit(30),
      // Pagamentos vencidos
      supabase.from("fin_pagamentos")
        .select("id, valor, data_vencimento, nome_fornecedor, descricao")
        .eq("status", "vencido")
        .lt("data_vencimento", today)
        .order("data_vencimento", { ascending: false }).limit(15),
      // Extrato Inter do mês (com detalhes de contraparte)
      supabase.from("fin_extrato_inter")
        .select("id, reconciliado, tipo, valor, nome_contraparte, cpf_cnpj, descricao, data_hora, reconciliation_rule")
        .gte("data_hora", monthStart + "T00:00:00")
        .order("data_hora", { ascending: false }).limit(500),
      // Contas bancárias
      supabase.from("fin_contas_bancarias")
        .select("nome, saldo_atual, banco")
        .eq("ativa", true).limit(10),
      // Todos recebimentos do mês (para ranking por cliente)
      supabase.from("fin_recebimentos")
        .select("id, valor, nome_cliente, status, data_vencimento, descricao, os_codigo, liquidado, pago_sistema")
        .gte("data_vencimento", monthStart)
        .lte("data_vencimento", monthEnd)
        .not("status", "eq", "cancelado")
        .order("valor", { ascending: false }).limit(200),
      // Todos pagamentos do mês
      supabase.from("fin_pagamentos")
        .select("id, valor, nome_fornecedor, status, data_vencimento, descricao, liquidado, pago_sistema")
        .gte("data_vencimento", monthStart)
        .lte("data_vencimento", monthEnd)
        .not("status", "eq", "cancelado")
        .order("valor", { ascending: false }).limit(200),
      // OS do mês
      supabase.from("os_index")
        .select("os_codigo, nome_cliente, nome_vendedor, valor_total, valor_servicos, valor_pecas, nome_situacao, data_saida")
        .gte("data_saida", monthStart)
        .lte("data_saida", monthEnd)
        .order("valor_total", { ascending: false }).limit(100),
      // Vendas do mês
      supabase.from("gc_vendas")
        .select("codigo, nome_cliente, valor_total, nome_situacao, data")
        .gte("data", monthStart)
        .lte("data", monthEnd)
        .in("nome_situacao", ["Concretizado", "Concretizada", "Venda Futura"])
        .limit(50),
      // Metas
      supabase.from("fin_metas")
        .select("nome, categoria, tipo_meta, meta_valor, meta_percentual")
        .eq("ativo", true).limit(20),
    ]);

    // ── Derived analytics ─────────────────────────────────────────────
    const totalRecebPend = (recebPendentes || []).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
    const totalPagPend = (pagPendentes || []).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
    const totalRecebVenc = (recebVencidos || []).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
    const totalPagVenc = (pagVencidos || []).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);

    // Extrato stats
    const ext = extratoMes || [];
    const extTotal = ext.length;
    const extReconc = ext.filter((e: any) => e.reconciliado).length;
    const extCredito = ext.filter((e: any) => e.tipo === "CREDITO").reduce((s: number, e: any) => s + Number(e.valor || 0), 0);
    const extDebito = ext.filter((e: any) => e.tipo === "DEBITO").reduce((s: number, e: any) => s + Number(e.valor || 0), 0);

    // Extrato top contrapartes crédito
    const creditoByNome: Record<string, number> = {};
    ext.filter((e: any) => e.tipo === "CREDITO").forEach((e: any) => {
      const nome = e.nome_contraparte || e.descricao || "Desconhecido";
      creditoByNome[nome] = (creditoByNome[nome] || 0) + Number(e.valor || 0);
    });

    // Extrato top contrapartes débito
    const debitoByNome: Record<string, number> = {};
    ext.filter((e: any) => e.tipo === "DEBITO").forEach((e: any) => {
      const nome = e.nome_contraparte || e.descricao || "Desconhecido";
      debitoByNome[nome] = (debitoByNome[nome] || 0) + Number(e.valor || 0);
    });

    // Ranking recebimentos por cliente (mês)
    const recebByCliente: Record<string, number> = {};
    (recebMes || []).forEach((r: any) => {
      const nome = r.nome_cliente || "Sem cliente";
      recebByCliente[nome] = (recebByCliente[nome] || 0) + Number(r.valor || 0);
    });
    const totalRecebMes = (recebMes || []).reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
    const recebPagosMes = (recebMes || []).filter((r: any) => r.status === "pago" || r.liquidado || r.pago_sistema);
    const totalRecebPagoMes = recebPagosMes.reduce((s: number, r: any) => s + Number(r.valor || 0), 0);

    // Ranking pagamentos por fornecedor (mês)
    const pagByForn: Record<string, number> = {};
    (pagMes || []).forEach((p: any) => {
      const nome = p.nome_fornecedor || "Sem fornecedor";
      pagByForn[nome] = (pagByForn[nome] || 0) + Number(p.valor || 0);
    });
    const totalPagMes = (pagMes || []).reduce((s: number, p: any) => s + Number(p.valor || 0), 0);

    // OS stats
    const osItems = osMes || [];
    const totalOS = osItems.reduce((s: number, o: any) => s + Number(o.valor_total || 0), 0);
    const osByTecnico: Record<string, number> = {};
    osItems.forEach((o: any) => {
      const t = o.nome_vendedor || "Sem técnico";
      osByTecnico[t] = (osByTecnico[t] || 0) + Number(o.valor_total || 0);
    });

    // Vendas stats
    const totalVendas = (vendasMes || []).reduce((s: number, v: any) => s + Number(v.valor_total || 0), 0);

    const saldos = (contas || []).map((c: any) => `- ${c.nome} (${c.banco}): R$ ${fmt(Number(c.saldo_atual || 0))}`).join("\n");

    // Metas formatted
    const metasStr = (metas || []).map((m: any) => {
      const target = m.tipo_meta === "percentual" ? `${m.meta_percentual}%` : `R$ ${fmt(Number(m.meta_valor || 0))}`;
      return `- ${m.nome} (${m.categoria}): ${target}`;
    }).join("\n") || "Nenhuma meta configurada";

    // ── Build context block ───────────────────────────────────────────
    const contextBlock = `
## Dados Financeiros em Tempo Real — ${today}

### 💰 Saldos Bancários
${saldos || "Sem contas cadastradas"}

### 📊 Resumo do Mês (${monthStart} a ${monthEnd})
- **Faturamento OS**: R$ ${fmt(totalOS)} (${osItems.length} OS)
- **Vendas Concretizadas**: R$ ${fmt(totalVendas)} (${(vendasMes || []).length} vendas)
- **Total a Receber no mês**: R$ ${fmt(totalRecebMes)} (${(recebMes || []).length} títulos)
- **Total já Recebido**: R$ ${fmt(totalRecebPagoMes)} (${recebPagosMes.length} títulos pagos)
- **Total a Pagar no mês**: R$ ${fmt(totalPagMes)} (${(pagMes || []).length} títulos)

### 🏆 Ranking Recebimentos por Cliente (mês)
${topN(recebByCliente)}

### 🏭 Ranking Pagamentos por Fornecedor (mês)
${topN(pagByForn)}

### 🔧 Ranking OS por Técnico (mês)
${topN(osByTecnico)}

### 🏦 Extrato Bancário Inter (mês)
- ${extTotal} transações | ${extReconc} conciliados (${extTotal > 0 ? Math.round(extReconc / extTotal * 100) : 0}%)
- Créditos: R$ ${fmt(extCredito)} | Débitos: R$ ${fmt(extDebito)}

**Top Créditos por Contraparte:**
${topN(creditoByNome)}

**Top Débitos por Contraparte:**
${topN(debitoByNome)}

### 📅 Vencimentos próximos 7 dias
**A Receber (${(recebPendentes || []).length} títulos = R$ ${fmt(totalRecebPend)}):**
${(recebPendentes || []).slice(0, 15).map((r: any) => `- ${r.data_vencimento} | ${r.nome_cliente || "N/I"} | R$ ${fmt(Number(r.valor))} | ${r.descricao}${r.os_codigo ? ` (OS ${r.os_codigo})` : ""}`).join("\n") || "Nenhum"}

**A Pagar (${(pagPendentes || []).length} títulos = R$ ${fmt(totalPagPend)}):**
${(pagPendentes || []).slice(0, 15).map((p: any) => `- ${p.data_vencimento} | ${p.nome_fornecedor || "N/I"} | R$ ${fmt(Number(p.valor))} | ${p.descricao}`).join("\n") || "Nenhum"}

### 🔴 Inadimplência (recebimentos vencidos)
${(recebVencidos || []).length} títulos — Total: R$ ${fmt(totalRecebVenc)}
${(recebVencidos || []).slice(0, 15).map((r: any) => `- ${r.data_vencimento} | ${r.nome_cliente || "N/I"} | R$ ${fmt(Number(r.valor))} | ${r.descricao}`).join("\n") || "Nenhum"}

### Pagamentos vencidos: ${(pagVencidos || []).length} — R$ ${fmt(totalPagVenc)}

### 🎯 Metas Configuradas
${metasStr}

### 📍 Página atual: ${page || "/"}
`;

    const systemPrompt = `Você é o ARGUS, assistente financeiro inteligente do ARGUS, plataforma de gestão empresarial.
Você tem acesso COMPLETO aos dados financeiros em tempo real. Responda SEMPRE em português do Brasil.
Seja direto, objetivo e use dados numéricos sempre que possível.
Formatação: **negrito**, listas com -, emojis (🔴 crítico, 🟡 atenção, 🟢 ok).
NUNCA invente dados — use SOMENTE os dados fornecidos abaixo.
Se algum dado não estiver disponível, diga qual dado falta — não diga que "não tem acesso".
Quando o usuário perguntar sobre ranking de clientes, use os dados de "Ranking Recebimentos por Cliente".
Quando perguntar sobre fornecedores, use "Ranking Pagamentos por Fornecedor".
Quando perguntar sobre faturamento, combine OS + Vendas + Recebimentos conforme aplicável.
Quando perguntar sobre extrato/banco, use os dados do Extrato Inter com detalhes de contrapartes.

${contextBlock}`;

    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...(history || []).slice(-10),
      { role: "user", content: message },
    ];

    const aiResponse = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "google/gemini-3-flash-preview",
        messages: aiMessages,
        max_tokens: 2000,
      }),
    });

    if (!aiResponse.ok) {
      if (aiResponse.status === 429) {
        return new Response(JSON.stringify({ error: "Rate limit — tente novamente em alguns segundos." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResponse.status === 402) {
        return new Response(JSON.stringify({ error: "Créditos insuficientes para IA." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      const errText = await aiResponse.text();
      console.error("AI error:", aiResponse.status, errText);
      throw new Error("Erro ao consultar IA");
    }

    const result = await aiResponse.json();
    const reply = result.choices?.[0]?.message?.content ?? "Sem resposta da IA.";

    return new Response(JSON.stringify({ reply }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("argus-chat error:", err);
    return new Response(JSON.stringify({ error: err instanceof Error ? err.message : "Erro interno" }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
