import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

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

    // ── Gather financial context (lightweight queries) ──────────────
    const today = new Date().toISOString().slice(0, 10);
    const weekFromNow = new Date(Date.now() + 7 * 86400000).toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + "01";

    const [
      { data: recebPendentes },
      { data: pagPendentes },
      { data: recebVencidos },
      { data: pagVencidos },
      { data: extratoStats },
      { data: contas },
    ] = await Promise.all([
      supabase.from("fin_recebimentos")
        .select("id, valor, data_vencimento, nome_cliente, status, descricao")
        .in("status", ["aberto", "vencido"])
        .gte("data_vencimento", today)
        .lte("data_vencimento", weekFromNow)
        .order("data_vencimento")
        .limit(20),
      supabase.from("fin_pagamentos")
        .select("id, valor, data_vencimento, nome_fornecedor, status, descricao")
        .in("status", ["aberto", "vencido"])
        .gte("data_vencimento", today)
        .lte("data_vencimento", weekFromNow)
        .order("data_vencimento")
        .limit(20),
      supabase.from("fin_recebimentos")
        .select("id, valor, data_vencimento, nome_cliente, descricao")
        .eq("status", "vencido")
        .lt("data_vencimento", today)
        .order("data_vencimento", { ascending: false })
        .limit(15),
      supabase.from("fin_pagamentos")
        .select("id, valor, data_vencimento, nome_fornecedor, descricao")
        .eq("status", "vencido")
        .lt("data_vencimento", today)
        .order("data_vencimento", { ascending: false })
        .limit(15),
      supabase.from("fin_extrato_inter")
        .select("id, reconciliado, tipo, valor")
        .gte("data_hora", monthStart + "T00:00:00")
        .limit(500),
      supabase.from("fin_contas_bancarias")
        .select("nome, saldo_atual, banco")
        .eq("ativa", true)
        .limit(10),
    ]);

    // Summaries
    const totalRecebPend = (recebPendentes || []).reduce((s, r) => s + Number(r.valor || 0), 0);
    const totalPagPend = (pagPendentes || []).reduce((s, r) => s + Number(r.valor || 0), 0);
    const totalRecebVenc = (recebVencidos || []).reduce((s, r) => s + Number(r.valor || 0), 0);
    const totalPagVenc = (pagVencidos || []).reduce((s, r) => s + Number(r.valor || 0), 0);

    const extItems = extratoStats || [];
    const extTotal = extItems.length;
    const extReconc = extItems.filter((e: any) => e.reconciliado).length;
    const extCredito = extItems.filter((e: any) => e.tipo === "CREDITO").reduce((s: number, e: any) => s + Number(e.valor || 0), 0);
    const extDebito = extItems.filter((e: any) => e.tipo === "DEBITO").reduce((s: number, e: any) => s + Number(e.valor || 0), 0);

    const saldos = (contas || []).map((c: any) => `${c.nome} (${c.banco}): R$ ${Number(c.saldo_atual || 0).toFixed(2)}`).join("\n");

    const contextBlock = `
## Dados Financeiros em Tempo Real (${today})

### Saldos Bancários
${saldos || "Sem contas cadastradas"}

### Recebimentos pendentes (próx. 7 dias): ${(recebPendentes || []).length} títulos — R$ ${totalRecebPend.toFixed(2)}
${(recebPendentes || []).slice(0, 10).map((r: any) => `- ${r.data_vencimento} | ${r.nome_cliente || "N/I"} | R$ ${Number(r.valor).toFixed(2)} | ${r.descricao}`).join("\n") || "Nenhum"}

### Pagamentos pendentes (próx. 7 dias): ${(pagPendentes || []).length} títulos — R$ ${totalPagPend.toFixed(2)}
${(pagPendentes || []).slice(0, 10).map((p: any) => `- ${p.data_vencimento} | ${p.nome_fornecedor || "N/I"} | R$ ${Number(p.valor).toFixed(2)} | ${p.descricao}`).join("\n") || "Nenhum"}

### Inadimplência (recebimentos vencidos): ${(recebVencidos || []).length} títulos — R$ ${totalRecebVenc.toFixed(2)}
${(recebVencidos || []).slice(0, 8).map((r: any) => `- ${r.data_vencimento} | ${r.nome_cliente || "N/I"} | R$ ${Number(r.valor).toFixed(2)} | ${r.descricao}`).join("\n") || "Nenhum"}

### Pagamentos vencidos: ${(pagVencidos || []).length} — R$ ${totalPagVenc.toFixed(2)}

### Conciliação bancária (mês atual)
- Extrato Inter: ${extTotal} transações (${extReconc} conciliados = ${extTotal > 0 ? Math.round(extReconc / extTotal * 100) : 0}%)
- Créditos: R$ ${extCredito.toFixed(2)} | Débitos: R$ ${extDebito.toFixed(2)}

### Página atual do usuário: ${page || "/"}
`;

    const systemPrompt = `Você é o ARGUS, assistente financeiro de um Command Center empresarial.
Responda SEMPRE em português do Brasil, de forma direta e com dados numéricos quando possível.
Use formatação markdown: **negrito**, listas com -, emojis para alertas (🔴 crítico, 🟡 atenção, 🟢 ok).
Nunca invente dados — use SOMENTE os dados fornecidos abaixo.
Se não tiver dado suficiente, diga claramente.

${contextBlock}`;

    // Build messages for AI
    const aiMessages = [
      { role: "system", content: systemPrompt },
      ...(history || []).slice(-10), // last 10 messages for context
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
        max_tokens: 1500,
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
