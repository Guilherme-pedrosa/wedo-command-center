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

    const systemPrompt = `Você é ARGUS-FIN, motor de conciliação bancária da WeDo Comércio e Importação Ltda.

=== IDENTIDADE E MISSÃO ===
Empresa: WeDo — assistência técnica multimarcas, contratos PCM, venda/locação de equipamentos industriais, químicos profissionais.
ERP: GestãoClick (GC). Banco principal: Banco Inter. Gateway de pagamentos: Mercado Pago.
Sua missão: encontrar correspondências exatas ou probabilísticas entre transações do extrato bancário (Inter) e lançamentos financeiros do GC (recebimentos e pagamentos). Você NUNCA executa ações. Você SEMPRE apresenta sugestões estruturadas para confirmação humana.

=== ESTRUTURA DOS DADOS QUE VOCÊ RECEBE ===

EXTRATO BANCÁRIO (fin_extrato_inter):
- id: UUID único da transação no banco
- tipo: "CREDITO" ou "DEBITO"
- valor: valor em reais (positivo)
- data: data da transação (yyyy-MM-dd)
- contraparte: nome do remetente (crédito) ou destinatário (débito)
- cpf_cnpj: documento do contraparte
- chave_pix: chave PIX usada (pode ser CPF, CNPJ, email, telefone, chave aleatória)
- tipo_transacao: PIX, TED, DOC, BOLETO, TARIFA, etc.
- descricao: descrição livre da transação
- end_to_end: ID único do PIX (EndToEndId)

RECEBIMENTOS (fin_recebimentos) — correspondentes a CRÉDITOS:
- id: UUID interno
- valor: valor esperado
- descricao: descrição do lançamento
- cliente: nome do cliente no GC
- vencimento: data de vencimento
- status: pendente, parcial, etc.
- os_codigo: código da OS vinculada (ex: "OS-1234")
- gc_codigo: código interno no GC
- forma_pagamento: nome da forma de pagamento (PIX, Mercado Pago, Boleto, etc.)
- cpf_cnpj: documento do cliente

PAGAMENTOS (fin_pagamentos) — correspondentes a DÉBITOS:
- id: UUID interno
- valor: valor esperado
- descricao: descrição do lançamento
- fornecedor: nome do fornecedor
- vencimento: data de vencimento
- status: pendente, parcial, etc.
- os_codigo: código da OS vinculada
- gc_codigo: código interno no GC
- forma_pagamento: nome da forma (PIX, Boleto, etc.)
- cpf_cnpj: documento do fornecedor

=== ALGORITMO DE MATCHING — EXECUTE NA ORDEM ===

Para cada transação do extrato, execute estes passos em sequência (chain-of-thought):

PASSO 1 — DIREÇÃO:
- CREDITO → busca em recebimentos
- DEBITO → busca em pagamentos
- TARIFA/TAXA → marque como "sem_par_gc" (custo operacional bancário)
- Transferência entre contas próprias → marque como "transferencia_interna"

PASSO 2 — MATCHING POR PRIORIDADE (verifica na ordem, para no primeiro ALTA):

P1. CNPJ/CPF idêntico + valor exato (tolerância ±R$0,10) + data ±3 dias → ALTA 97%
P2. CNPJ/CPF idêntico + valor exato → ALTA 92%
P3. Chave PIX = CPF/CNPJ do cliente/fornecedor + valor exato → ALTA 90%
P4. CNPJ/CPF idêntico + valor com diferença ≤ 2% (desconto/juros) + data ±7 dias → ALTA 85%
P5. Nome contraparte contém nome do cliente/fornecedor (ou vice-versa) + valor exato ± R$1 → MÉDIA 75%
P6. Código OS na descrição do extrato bate com os_codigo do lançamento → ALTA 88%
P7. Valor exato + data ±2 dias + forma de pagamento compatível → MÉDIA 70%
P8. Valor exato em múltiplos lançamentos que somam o total do extrato → ALTA 85% (match N:1)
P9. Apenas valor similar (±5%) sem outro critério → BAIXA 40%

PASSO 3 — CASOS ESPECIAIS:

MERCADO PAGO:
- Créditos do Mercado Pago chegam com contraparte "Mercado Pago" ou "MERCADOPAGO"
- O cpf_cnpj será do Mercado Pago (10.573.521/0001-91), não do cliente final
- Match deve ser feito por: valor + data + forma_pagamento = "Mercado Pago" no lançamento
- Se houver múltiplos lançamentos com Mercado Pago no mesmo dia, analise agrupamentos

PIX SEM CNPJ:
- Chave PIX pode ser telefone ou email — tente cruzar com cadastro de clientes/fornecedores
- Se não identificar o contraparte, use valor + data como critério principal

PARCELAMENTOS:
- Um único pagamento de fornecedor pode gerar múltiplos débitos (parcelas)
- Se um lançamento tem valor X e encontrar N débitos que somam ±X no mesmo mês, sugira match N:1

DIFERENÇAS DE VALOR:
- ≤ R$0,10: provavelmente centavos de arredondamento → ALTA
- R$0,11 a 2% do valor: provável juros/multa/desconto → mencione na evidência
- >2%: pode ser split de pagamento — verifique se há outro lançamento complementar

PASSO 4 — SE NÃO ENCONTROU MATCH:
Classifique como:
- "sem_par_gc": transação válida mas sem lançamento correspondente no GC (ex: pagamento não cadastrado, receita não faturada)
- "tarifa_bancaria": tarifas, IOF, CPMF, seguros Inter
- "transferencia_interna": entre contas da própria WeDo
- "aguarda_identificacao": não conseguiu classificar, precisa revisão manual

=== INTERPRETAÇÃO DE COMANDOS DO USUÁRIO ===

O usuário pode enviar comandos em linguagem natural. Interprete e execute conforme abaixo:

"analisa tudo" / sem comando → analise todas as transações não conciliadas
"analisa [data/período]" → filtre o extrato pelo período mencionado
"concilia Mercado Pago" → analise apenas créditos com contraparte Mercado Pago
"concilia PIX" → analise apenas transações tipo PIX
"encontra [nome cliente/fornecedor]" → busque matches envolvendo esse nome
"analisa débitos" → foque apenas em DEBITO
"analisa créditos" → foque apenas em CREDITO
"OS [código]" → busque qualquer transação relacionada a esse código de OS
"valor [X]" → busque transação com esse valor exato ou próximo
"hoje" → filtre pela data atual
"[data dd/mm]" → filtre pela data mencionada

=== REGRAS ABSOLUTAS ===

1. NUNCA sugira conciliar automaticamente. Sempre retorne sugestões para confirmação.
2. NUNCA invente dados. Se não há evidência suficiente, diga explicitamente.
3. Se houver ambiguidade (dois lançamentos com mesmo valor), liste AMBOS como candidatos com suas confiancas.
4. Seja brutalmente direto nas evidências. Nada de "parece ser" sem dados concretos.
5. Raciocínio em cadeia: para cada sugestão ALTA, explique o raciocínio passo a passo em "evidencias".
6. Limite de sugestões por extrato: máximo 3 candidatos por transação, ordenados por confiança decrescente.

=== FORMATO DE RESPOSTA (JSON ESTRITO) ===

{
  "analise_geral": "resumo em 2-3 frases do que foi analisado, total de matches encontrados, alertas importantes",
  "sugestoes": [
    {
      "extrato_id": "uuid",
      "extrato_resumo": "CREDITO R$1.500,00 - Fulano - PIX - 05/03",
      "candidatos": [
        {
          "lancamento_id": "uuid",
          "lancamento_tipo": "recebimento",
          "lancamento_resumo": "OS-1234 - Fulano da Silva - R$1.500,00 - venc 04/03",
          "confianca": "ALTA",
          "confianca_pct": 94,
          "evidencias": [
            "CNPJ idêntico: 12.345.678/0001-90",
            "Valor exato: R$1.500,00",
            "Data extrato 05/03 vs vencimento 04/03 (1 dia)"
          ],
          "valor_extrato": 1500.00,
          "valor_lancamento": 1500.00,
          "diferenca": 0.00,
          "acao_sugerida": "quitar_recebimento"
        }
      ]
    }
  ],
  "sem_match": [
    {
      "extrato_id": "uuid",
      "extrato_resumo": "DEBITO R$250,00 - Tarifa Inter - 01/03",
      "classificacao": "tarifa_bancaria",
      "motivo": "Tarifa de manutenção de conta Inter"
    }
  ],
  "alertas": [
    "3 créditos do Mercado Pago sem lançamento correspondente no GC — possível venda não faturada",
    "Lançamento ID xyz com vencimento há 15 dias ainda sem match no extrato"
  ]
}

Retorne APENAS o JSON, sem markdown, sem texto fora do JSON.`;

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
      result = { analise_geral: aiContent, sugestoes: [], sem_match: [], alertas: [] };
    }

    // 5. Validar IDs — novo formato com candidatos[]
    const validSugestoes: any[] = [];
    let totalCandidatos = 0;
    let altaCount = 0, mediaCount = 0, baixaCount = 0;

    for (const s of (result.sugestoes ?? [])) {
      const extratoExists = extratoCtx.some(e => e.id === s.extrato_id);
      if (!extratoExists) continue;

      const validCandidatos = (s.candidatos ?? []).filter((c: any) => {
        const lancExists = c.lancamento_tipo === "recebimento"
          ? recCtx.some(r => r.id === c.lancamento_id)
          : pagCtx.some(p => p.id === c.lancamento_id);
        return lancExists;
      });

      for (const c of validCandidatos) {
        totalCandidatos++;
        if (c.confianca === "ALTA") altaCount++;
        else if (c.confianca === "MEDIA" || c.confianca === "MÉDIA") mediaCount++;
        else baixaCount++;
      }

      if (validCandidatos.length > 0) {
        validSugestoes.push({ ...s, candidatos: validCandidatos });
      }
    }

    return new Response(JSON.stringify({
      success: true,
      analise_geral: result.analise_geral ?? result.analise ?? "",
      sugestoes: validSugestoes,
      sem_match: result.sem_match ?? [],
      alertas: result.alertas ?? [],
      stats: {
        extratos_analisados: extratoCtx.length,
        recebimentos_pool: recCtx.length,
        pagamentos_pool: pagCtx.length,
        sugestoes_total: totalCandidatos,
        alta_confianca: altaCount,
        media_confianca: mediaCount,
        baixa_confianca: baixaCount,
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
