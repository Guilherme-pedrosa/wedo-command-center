import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY");
    if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY não configurada");

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const { command, extratoIds } = await req.json();

    // 1. Buscar extratos não reconciliados (filtrados ou todos)
    let extratoQuery = supabase
      .from("fin_extrato_inter")
      .select("*")
      .eq("reconciliado", false)
      .or("reconciliation_rule.is.null,reconciliation_rule.not.in.(SEM_PAR_GC,TRANSFERENCIA_INTERNA,PIX_DEVOLVIDO_MANUAL)")
      .order("data_hora", { ascending: true });

    if (extratoIds?.length) {
      extratoQuery = supabase
        .from("fin_extrato_inter")
        .select("*")
        .in("id", extratoIds);
    }

    const { data: extratos } = await extratoQuery.limit(100);

    // 2. Buscar recebimentos e pagamentos pendentes
    const [{ data: recebimentos }, { data: pagamentos }, { data: fornecedores }, { data: clientes }, { data: formasPag }] = await Promise.all([
      supabase.from("fin_recebimentos")
        .select("id, descricao, valor, nome_cliente, data_vencimento, status, os_codigo, gc_codigo, gc_id, forma_pagamento_id, cliente_gc_id, recipient_document, liquidado, pago_sistema")
        .not("status", "in", '("cancelado","liquidado")')
        .eq("pago_sistema", false)
        .order("data_vencimento", { ascending: false })
        .limit(1000),
      supabase.from("fin_pagamentos")
        .select("id, descricao, valor, nome_fornecedor, data_vencimento, status, os_codigo, gc_codigo, gc_id, forma_pagamento_id, fornecedor_gc_id, recipient_document, liquidado, pago_sistema")
        .not("status", "in", '("cancelado","liquidado")')
        .eq("pago_sistema", false)
        .order("data_vencimento", { ascending: false })
        .limit(1000),
      supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj, chave_pix, nome"),
      supabase.from("fin_clientes").select("gc_id, cpf_cnpj, nome"),
      supabase.from("fin_formas_pagamento").select("id, nome, tipo"),
    ]);

    // Build lookup maps
    const fpMap: Record<string, string> = {};
    for (const fp of (formasPag ?? [])) fpMap[fp.id] = fp.nome;
    
    const fornMap: Record<string, any> = {};
    for (const f of (fornecedores ?? [])) fornMap[f.gc_id] = f;
    const cliMap: Record<string, any> = {};
    for (const c of (clientes ?? [])) cliMap[c.gc_id] = c;

    // 3. Preparar contexto compacto para a IA
    const extratoCtx = (extratos ?? []).map(e => ({
      id: e.id,
      tipo: e.tipo,
      valor: Number(e.valor),
      data: e.data_hora?.substring(0, 10),
      contraparte: e.nome_contraparte ?? e.contrapartida ?? e.descricao,
      cpf_cnpj: e.cpf_cnpj,
      chave_pix: e.chave_pix,
      tipo_transacao: e.tipo_transacao,
      descricao: e.descricao,
      end_to_end: e.end_to_end_id,
    }));

    const recCtx = (recebimentos ?? []).map(r => ({
      id: r.id,
      tipo: "recebimento",
      valor: Number(r.valor),
      descricao: r.descricao,
      cliente: r.nome_cliente,
      vencimento: r.data_vencimento,
      status: r.status,
      os_codigo: r.os_codigo,
      gc_codigo: r.gc_codigo,
      forma_pagamento: r.forma_pagamento_id ? fpMap[r.forma_pagamento_id] : null,
      cpf_cnpj: r.recipient_document || (r.cliente_gc_id ? cliMap[r.cliente_gc_id]?.cpf_cnpj : null),
    }));

    const pagCtx = (pagamentos ?? []).map(p => ({
      id: p.id,
      tipo: "pagamento",
      valor: Number(p.valor),
      descricao: p.descricao,
      fornecedor: p.nome_fornecedor,
      vencimento: p.data_vencimento,
      status: p.status,
      os_codigo: p.os_codigo,
      gc_codigo: p.gc_codigo,
      forma_pagamento: p.forma_pagamento_id ? fpMap[p.forma_pagamento_id] : null,
      cpf_cnpj: p.recipient_document || (p.fornecedor_gc_id ? fornMap[p.fornecedor_gc_id]?.cpf_cnpj : null),
    }));

    const systemPrompt = `Você é um assistente financeiro especialista em conciliação bancária para a empresa WeDo (assistência técnica).

CONTEXTO:
- Você recebe transações do EXTRATO BANCÁRIO (Banco Inter) que ainda não foram conciliadas.
- Também recebe RECEBIMENTOS e PAGAMENTOS pendentes do ERP (GestãoClick).
- Seu objetivo é encontrar correspondências (matches) entre extrato e lançamentos.

REGRAS DE ANÁLISE:
1. CRÉDITOS no extrato → correspondem a RECEBIMENTOS no ERP
2. DÉBITOS no extrato → correspondem a PAGAMENTOS no ERP
3. Analise profundamente: valor, CPF/CNPJ, nome da contraparte vs nome do cliente/fornecedor, data, forma de pagamento, código OS
4. Considere variações de nome (razão social vs nome fantasia, abreviações)
5. Considere que um PIX pode ter sido pago por pessoa diferente do titular
6. Valores podem ter pequenas diferenças (descontos, juros, taxas)
7. Múltiplos lançamentos podem corresponder a um único extrato (soma de parcelas)

NÍVEIS DE CONFIANÇA:
- ALTA (>85%): Match quase certo — CNPJ bate, valor exato ou muito próximo, data compatível
- MÉDIA (55-85%): Provável match — nome similar, valor próximo, contexto sugere relação
- BAIXA (<55%): Possível match — apenas um critério bate, precisa verificação humana

IMPORTANTE: 
- NUNCA execute ações automaticamente. Sempre apresente sugestões para o usuário confirmar.
- Seja específico sobre POR QUE você acha que é um match (qual evidência).
- Se o usuário der um comando específico (ex: "quita Mercado Pago"), filtre e analise apenas o relevante.

FORMATO DE RESPOSTA (JSON):
{
  "analise": "texto explicativo da análise geral",
  "sugestoes": [
    {
      "extrato_id": "uuid do extrato",
      "extrato_resumo": "descrição resumida do extrato",
      "lancamento_id": "uuid do lançamento match",
      "lancamento_tipo": "recebimento" | "pagamento",
      "lancamento_resumo": "descrição resumida do lançamento",
      "confianca": "ALTA" | "MEDIA" | "BAIXA",
      "confianca_pct": 90,
      "evidencias": ["CNPJ bate: 12.345.678/0001-90", "Valor exato: R$1.500,00", "Data ±2 dias"],
      "valor_extrato": 1500.00,
      "valor_lancamento": 1500.00,
      "diferenca": 0.00
    }
  ],
  "sem_match": ["breve explicação de extratos que não tiveram match"]
}`;

    const userMessage = command 
      ? `COMANDO DO USUÁRIO: "${command}"\n\nEXTRATO BANCÁRIO:\n${JSON.stringify(extratoCtx, null, 1)}\n\nRECEBIMENTOS PENDENTES:\n${JSON.stringify(recCtx, null, 1)}\n\nPAGAMENTOS PENDENTES:\n${JSON.stringify(pagCtx, null, 1)}`
      : `Analise TODAS as transações do extrato abaixo e encontre matches nos lançamentos.\n\nEXTRATO BANCÁRIO:\n${JSON.stringify(extratoCtx, null, 1)}\n\nRECEBIMENTOS PENDENTES:\n${JSON.stringify(recCtx, null, 1)}\n\nPAGAMENTOS PENDENTES:\n${JSON.stringify(pagCtx, null, 1)}`;

    // 4. Chamar OpenAI GPT-5
    const openaiResp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        temperature: 0.1,
        response_format: { type: "json_object" },
      }),
    });

    if (!openaiResp.ok) {
      const errText = await openaiResp.text();
      console.error("OpenAI error:", openaiResp.status, errText);
      throw new Error(`OpenAI API error (${openaiResp.status}): ${errText.substring(0, 200)}`);
    }

    const openaiData = await openaiResp.json();
    const aiContent = openaiData.choices?.[0]?.message?.content;
    
    let result;
    try {
      result = JSON.parse(aiContent);
    } catch {
      result = { analise: aiContent, sugestoes: [], sem_match: [] };
    }

    // 5. Validar que os IDs sugeridos existem
    const validSugestoes = (result.sugestoes ?? []).filter((s: any) => {
      const extratoExists = extratoCtx.some(e => e.id === s.extrato_id);
      const lancExists = s.lancamento_tipo === "recebimento" 
        ? recCtx.some(r => r.id === s.lancamento_id)
        : pagCtx.some(p => p.id === s.lancamento_id);
      return extratoExists && lancExists;
    });

    return new Response(JSON.stringify({
      success: true,
      analise: result.analise,
      sugestoes: validSugestoes,
      sem_match: result.sem_match ?? [],
      stats: {
        extratos_analisados: extratoCtx.length,
        recebimentos_pool: recCtx.length,
        pagamentos_pool: pagCtx.length,
        sugestoes_total: validSugestoes.length,
        alta_confianca: validSugestoes.filter((s: any) => s.confianca === "ALTA").length,
        media_confianca: validSugestoes.filter((s: any) => s.confianca === "MEDIA").length,
        baixa_confianca: validSugestoes.filter((s: any) => s.confianca === "BAIXA").length,
      },
    }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err: any) {
    console.error("ai-reconciliation error:", err);
    return new Response(JSON.stringify({ success: false, error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
