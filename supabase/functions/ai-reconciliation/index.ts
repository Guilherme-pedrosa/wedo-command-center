import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

// Lovable AI Gateway — modelo de raciocínio top-tier (multimodal, contexto longo, reasoning)
const AI_MODEL = "google/gemini-2.5-pro";

function parseDateOnly(value: string | null | undefined): Date | null {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
}

function withinMaxGapDays(a: string | null | undefined, b: string | null | undefined, maxDays = 60): boolean {
  const da = parseDateOnly(a);
  const db = parseDateOnly(b);
  if (!da || !db) return false;
  return Math.abs(da.getTime() - db.getTime()) <= maxDays * 86400000;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY não configurada");

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

    const { data: extratos } = await extratoQuery.limit(150);

    // 2. ACESSO TOTAL E IRRESTRITO — buscar todos os pools de dados relevantes em paralelo
    const [
      { data: recebimentos },
      { data: pagamentos },
      { data: fornecedores },
      { data: clientes },
      { data: formasPag },
      { data: gruposReceber },
      { data: gruposPagar },
      { data: residuos },
      { data: agendaPag },
      { data: nfeIndex },
      { data: extratosReconciliados },
    ] = await Promise.all([
      supabase.from("fin_recebimentos")
        .select("id, descricao, valor, nome_cliente, data_vencimento, data_emissao, status, os_codigo, gc_codigo, gc_id, forma_pagamento_id, cliente_gc_id, recipient_document, liquidado, pago_sistema, grupo_id, nfe_chave, nfe_numero, observacao")
        .not("status", "in", '("cancelado","liquidado")')
        .eq("pago_sistema", false)
        .order("data_vencimento", { ascending: false })
        .limit(1500),
      supabase.from("fin_pagamentos")
        .select("id, descricao, valor, nome_fornecedor, data_vencimento, data_emissao, status, os_codigo, gc_codigo, gc_id, forma_pagamento_id, fornecedor_gc_id, recipient_document, liquidado, pago_sistema, grupo_id, nfe_chave, nf_numero, observacao, tipo")
        .not("status", "in", '("cancelado","liquidado")')
        .eq("pago_sistema", false)
        .order("data_vencimento", { ascending: false })
        .limit(1500),
      supabase.from("fin_fornecedores").select("gc_id, cpf_cnpj, chave_pix, nome, nome_fantasia, razao_social"),
      supabase.from("fin_clientes").select("gc_id, cpf_cnpj, nome, nome_fantasia, razao_social"),
      supabase.from("fin_formas_pagamento").select("id, nome, tipo"),
      supabase.from("fin_grupos_receber")
        .select("id, nome, nome_cliente, cliente_gc_id, valor_total, data_vencimento, status, os_codigos, negociacao_numero, inter_txid")
        .not("status", "in", '("pago","cancelado")')
        .order("data_vencimento", { ascending: false })
        .limit(500),
      supabase.from("fin_grupos_pagar")
        .select("id, nome, nome_fornecedor, fornecedor_gc_id, valor_total, data_vencimento, status")
        .not("status", "in", '("pago","cancelado")')
        .order("data_vencimento", { ascending: false })
        .limit(500),
      supabase.from("fin_residuos_negociacao")
        .select("id, nome_cliente, cliente_gc_id, valor_residual, os_codigos, negociacao_origem_numero, utilizado")
        .eq("utilizado", false)
        .limit(300),
      supabase.from("fin_agenda_pagamentos")
        .select("id, descricao, valor, data_vencimento, status, fornecedor_gc_id, nome_fornecedor, chave_pix_destino")
        .not("status", "in", '("executado","cancelado")')
        .order("data_vencimento", { ascending: false })
        .limit(300),
      supabase.from("fin_nfe_xml_index")
        .select("chave, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos")
        .order("data_emissao", { ascending: false })
        .limit(500),
      // Histórico de matches já feitos — para a IA aprender padrões
      supabase.from("fin_extrato_inter")
        .select("nome_contraparte, cpf_cnpj, valor, reconciliation_rule, lancamento_id")
        .eq("reconciliado", true)
        .not("reconciliation_rule", "is", null)
        .order("reconciliado_em", { ascending: false })
        .limit(200),
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
      codigo_barras: e.codigo_barras,
    }));

    const recCtxBase = (recebimentos ?? []).map(r => ({
      id: r.id,
      tipo: "recebimento",
      valor: Number(r.valor),
      descricao: r.descricao,
      cliente: r.nome_cliente,
      vencimento: r.data_vencimento,
      emissao: r.data_emissao,
      status: r.status,
      os_codigo: r.os_codigo,
      gc_codigo: r.gc_codigo,
      grupo_id: r.grupo_id,
      forma_pagamento: r.forma_pagamento_id ? fpMap[r.forma_pagamento_id] : null,
      cpf_cnpj: r.recipient_document || (r.cliente_gc_id ? cliMap[r.cliente_gc_id]?.cpf_cnpj : null),
      nfe_chave: r.nfe_chave,
      nfe_numero: r.nfe_numero,
    }));

    const pagCtxBase = (pagamentos ?? []).map(p => ({
      id: p.id,
      tipo: "pagamento",
      valor: Number(p.valor),
      descricao: p.descricao,
      fornecedor: p.nome_fornecedor,
      vencimento: p.data_vencimento,
      emissao: p.data_emissao,
      status: p.status,
      os_codigo: p.os_codigo,
      gc_codigo: p.gc_codigo,
      grupo_id: p.grupo_id,
      forma_pagamento: p.forma_pagamento_id ? fpMap[p.forma_pagamento_id] : null,
      cpf_cnpj: p.recipient_document || (p.fornecedor_gc_id ? fornMap[p.fornecedor_gc_id]?.cpf_cnpj : null),
      chave_pix_forn: p.fornecedor_gc_id ? fornMap[p.fornecedor_gc_id]?.chave_pix : null,
      nfe_chave: p.nfe_chave,
      nf_numero: p.nf_numero,
      tipo_lanc: p.tipo,
    }));

    const extratoDates = extratoCtx.map((e) => e.data).filter(Boolean) as string[];
    const recCtx = recCtxBase.filter((r) => extratoDates.some((d) => withinMaxGapDays(d, r.vencimento || r.emissao)));
    const pagCtx = pagCtxBase.filter((p) => extratoDates.some((d) => withinMaxGapDays(d, p.vencimento || p.emissao)));

    const grRecCtx = (gruposReceber ?? []).map(g => ({
      id: g.id, tipo: "grupo_receber", nome: g.nome, cliente: g.nome_cliente, cpf_cnpj: g.cliente_gc_id ? cliMap[g.cliente_gc_id]?.cpf_cnpj : null,
      valor: Number(g.valor_total), vencimento: g.data_vencimento, status: g.status, os_codigos: g.os_codigos, negociacao: g.negociacao_numero, inter_txid: g.inter_txid,
    }));

    const grPagCtx = (gruposPagar ?? []).map(g => ({
      id: g.id, tipo: "grupo_pagar", nome: g.nome, fornecedor: g.nome_fornecedor, cpf_cnpj: g.fornecedor_gc_id ? fornMap[g.fornecedor_gc_id]?.cpf_cnpj : null,
      valor: Number(g.valor_total), vencimento: g.data_vencimento, status: g.status,
    }));

    const residuosCtx = (residuos ?? []).map(r => ({
      id: r.id, cliente: r.nome_cliente, cpf_cnpj: r.cliente_gc_id ? cliMap[r.cliente_gc_id]?.cpf_cnpj : null,
      valor: Number(r.valor_residual), os_codigos: r.os_codigos, negociacao_origem: r.negociacao_origem_numero,
    }));

    const agendaCtx = (agendaPag ?? []).map(a => ({
      id: a.id, descricao: a.descricao, valor: Number(a.valor), vencimento: a.data_vencimento,
      fornecedor: a.nome_fornecedor, chave_pix: a.chave_pix_destino, status: a.status,
    }));

    const nfeCtx = (nfeIndex ?? []).map(n => ({
      chave: n.chave, cnpj: n.cnpj_emitente, emitente: n.nome_emitente, data: n.data_emissao, valor: Number(n.valor_total),
    }));

    const historicoCtx = (extratosReconciliados ?? []).map(h => ({
      contraparte: h.nome_contraparte, cpf_cnpj: h.cpf_cnpj, valor: Number(h.valor), regra: h.reconciliation_rule,
    }));

    const systemPrompt = `Você é ARGUS-FIN PRO — motor de conciliação bancária da WeDo Comércio e Importação Ltda, alimentado por Gemini 2.5 Pro com raciocínio profundo.

=== IDENTIDADE E MISSÃO ===
Empresa: WeDo — assistência técnica multimarcas, contratos PCM, venda/locação de equipamentos industriais, químicos profissionais. Regime: Lucro Real.
ERP: GestãoClick (GC). Banco principal: Banco Inter. Gateway de pagamentos: Mercado Pago.
Sua missão: encontrar correspondências exatas ou probabilísticas entre transações do extrato bancário e lançamentos financeiros do GC (recebimentos, pagamentos, GRUPOS, RESÍDUOS, AGENDA e NFs). Você NUNCA executa ações; SEMPRE apresenta sugestões estruturadas para confirmação humana.

=== ACESSO TOTAL — DADOS DISPONÍVEIS ===
Você recebe pools COMPLETOS para correlação cruzada:
1. EXTRATO BANCÁRIO (não reconciliado): id, tipo (CREDITO/DEBITO), valor, data, contraparte, cpf_cnpj, chave_pix, tipo_transacao (PIX/TED/BOLETO/TARIFA), descricao, end_to_end, codigo_barras
2. RECEBIMENTOS pendentes (fin_recebimentos)
3. PAGAMENTOS pendentes (fin_pagamentos) — incluindo tipo_lanc para distinguir juros/operacionais
4. GRUPOS A RECEBER (fin_grupos_receber) — faturamentos consolidados de múltiplas OS, podem casar com PIX único
5. GRUPOS A PAGAR (fin_grupos_pagar) — pagamentos em lote
6. RESÍDUOS (fin_residuos_negociacao) — saldos remanescentes utilizáveis em novas negociações
7. AGENDA DE PAGAMENTOS (fin_agenda_pagamentos) — pagamentos programados no Inter
8. NF-e INDEXADAS (fin_nfe_xml_index) — para correlacionar débitos a fornecedores via NF
9. HISTÓRICO de matches anteriores — padrões aprendidos (mesma contraparte/valor já reconciliados)

=== ALGORITMO DE MATCHING — CHAIN-OF-THOUGHT PROFUNDO ===

Para CADA extrato, execute em sequência:

PASSO 1 — DIREÇÃO:
- CREDITO → priorize: (a) grupos_receber, (b) recebimentos, (c) resíduos
- DEBITO → priorize: (a) agenda (já programado), (b) grupos_pagar, (c) pagamentos, (d) NF-e indexada se não houver lançamento
- TARIFA/IOF/JUROS bancários → "tarifa_bancaria"
- Transferência entre contas próprias WeDo → "transferencia_interna"

PASSO 2 — MATCHING POR PRIORIDADE (verifica na ordem; pare no primeiro ALTA):

P0. End-to-End ID exato (PIX) → ALTA 99%
P1. CNPJ/CPF idêntico + valor exato (±R$0,10) + data ±3 dias → ALTA 97%
P2. CNPJ/CPF idêntico + valor exato → ALTA 92%
P3. inter_txid no grupo_receber bate com end_to_end ou descricao do extrato → ALTA 96%
P4. Chave PIX = CPF/CNPJ do cliente/fornecedor + valor exato → ALTA 90%
P5. CNPJ/CPF idêntico + valor com diferença ≤2% (desconto/juros) + data ±7 dias → ALTA 85%
P6. Soma de N lançamentos do mesmo cliente/fornecedor = valor extrato (±R$1) → ALTA 87% (match N:1)
P7. Grupo_receber valor_total = extrato + cliente bate → ALTA 90%
P8. Código de OS na descrição do extrato bate com os_codigo de lançamento ou os_codigos de grupo → ALTA 88%
P9. Histórico: mesma contraparte+valor já casou antes com regra X → MÉDIA 80% + cite "padrão histórico"
P10. Nome contraparte contém nome do cliente/fornecedor + valor exato ±R$1 → MÉDIA 75%
P11. Valor exato + data ±2 dias + forma_pagamento compatível → MÉDIA 70%
P12. NF-e: valor extrato bate com valor_total de NF do mesmo CNPJ → MÉDIA 72% (sugira criar pagamento)
P13. Apenas valor similar (±5%) sem outro critério → BAIXA 40%

PASSO 3 — CASOS ESPECIAIS:

MERCADO PAGO: contraparte "Mercado Pago" / cpf_cnpj 10.573.521/0001-91. Match por valor+data+forma_pagamento="Mercado Pago".
PIX SEM CNPJ: chave pode ser telefone/email — cruze com cadastros.
ADIANTAMENTO/ANTECIPAÇÃO: extrato menor que soma de lançamentos = taxa de adiantamento; sugira manual_reconcile_batch com taxa_adiantamento_pct.
PARCELAMENTOS: 1 lançamento → N débitos (parcelas). Match N:1 quando soma bate no mês.
RESÍDUO: se cliente tem resíduo não utilizado, mencione na evidência (pode compensar diferenças).
NF-e ÓRFÃ: débito sem pagamento mas com NF-e do mesmo CNPJ no índice → sugira "criar_pagamento_a_partir_de_nf".

PASSO 4 — SE NÃO ENCONTROU MATCH, classifique:
"sem_par_gc" | "tarifa_bancaria" | "transferencia_interna" | "aguarda_identificacao" | "nf_orfa" (tem NF mas falta lançamento)

=== INTERPRETAÇÃO DE COMANDOS ===

"analisa tudo" / vazio → análise completa
"analisa [data]" → filtre por período
"concilia Mercado Pago" / "concilia PIX" → filtre por tipo
"encontra [nome]" → busca por contraparte
"OS [código]" → busca por código OS
"valor [X]" → busca por valor
"grupos" → priorize matches contra grupos_receber/pagar
"resíduos" → analise resíduos disponíveis para uso
"nf órfãs" → liste débitos com NF mas sem pagamento

=== REGRAS ABSOLUTAS ===
1. NUNCA execute. Sempre sugira para confirmação.
2. NUNCA invente. Se não há evidência, declare.
3. Liste até 3 candidatos por extrato, ordenados por confiança.
4. Para ALTA, explique chain-of-thought passo a passo.
5. Use o histórico para reforçar/contradizer matches.
6. Sinalize resíduos disponíveis quando relevante.

=== FORMATO DE RESPOSTA (JSON ESTRITO) ===
{
  "analise_geral": "resumo 2-4 frases: total analisado, matches encontrados, alertas críticos, padrões observados",
  "sugestoes": [
    {
      "extrato_id": "uuid",
      "extrato_resumo": "CREDITO R$1.500,00 - Fulano - PIX - 05/03",
      "candidatos": [
        {
          "lancamento_id": "uuid",
          "lancamento_tipo": "recebimento" | "pagamento" | "grupo_receber" | "grupo_pagar" | "agenda" | "residuo",
          "lancamento_resumo": "OS-1234 - Fulano - R$1.500,00 - venc 04/03",
          "confianca": "ALTA" | "MEDIA" | "BAIXA",
          "confianca_pct": 94,
          "evidencias": ["CNPJ idêntico: 12.345.678/0001-90", "Valor exato", "Data 1 dia"],
          "valor_extrato": 1500.00,
          "valor_lancamento": 1500.00,
          "diferenca": 0.00,
          "acao_sugerida": "quitar_recebimento" | "quitar_pagamento" | "vincular_grupo" | "executar_agenda" | "usar_residuo" | "criar_pagamento_de_nf"
        }
      ]
    }
  ],
  "sem_match": [{"extrato_id":"uuid","extrato_resumo":"...","classificacao":"tarifa_bancaria","motivo":"..."}],
  "alertas": ["3 NFs órfãs do CNPJ X - criar pagamentos", "Cliente Y tem R$500 de resíduo não utilizado"],
  "insights": ["Padrão recorrente: Mercado Pago crédito sem fatura no GC", "Adiantamento detectado: 7 títulos somam R$X mas extrato R$Y (taxa ~2%)"]
}

Retorne APENAS o JSON, sem markdown.`;

    const userMessage = `${command ? `COMANDO DO USUÁRIO: "${command}"\n\n` : "ANÁLISE COMPLETA\n\n"}=== EXTRATO (não conciliado) ===\n${JSON.stringify(extratoCtx)}\n\n=== RECEBIMENTOS PENDENTES ===\n${JSON.stringify(recCtx)}\n\n=== PAGAMENTOS PENDENTES ===\n${JSON.stringify(pagCtx)}\n\n=== GRUPOS A RECEBER ===\n${JSON.stringify(grRecCtx)}\n\n=== GRUPOS A PAGAR ===\n${JSON.stringify(grPagCtx)}\n\n=== RESÍDUOS DISPONÍVEIS ===\n${JSON.stringify(residuosCtx)}\n\n=== AGENDA INTER ===\n${JSON.stringify(agendaCtx)}\n\n=== NF-e INDEXADAS (últimas 500) ===\n${JSON.stringify(nfeCtx)}\n\n=== HISTÓRICO DE MATCHES (padrões) ===\n${JSON.stringify(historicoCtx)}`;

    // 4. Chamar Lovable AI Gateway (Gemini 2.5 Pro com raciocínio profundo)
    const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${LOVABLE_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userMessage },
        ],
        response_format: { type: "json_object" },
      }),
    });

    if (!aiResp.ok) {
      const errText = await aiResp.text();
      console.error("Lovable AI error:", aiResp.status, errText);
      if (aiResp.status === 429) {
        return new Response(JSON.stringify({ success: false, error: "Limite de requisições atingido. Aguarde alguns segundos." }), {
          status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      if (aiResp.status === 402) {
        return new Response(JSON.stringify({ success: false, error: "Créditos Lovable AI esgotados. Adicione créditos em Settings > Workspace > Usage." }), {
          status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" },
        });
      }
      throw new Error(`Lovable AI error (${aiResp.status}): ${errText.substring(0, 300)}`);
    }

    const aiData = await aiResp.json();
    const aiContent = aiData.choices?.[0]?.message?.content;

    let result: any;
    try {
      result = JSON.parse(aiContent);
    } catch {
      // tenta extrair bloco JSON de markdown se vier com cerca
      const m = String(aiContent || "").match(/```(?:json)?\s*([\s\S]*?)```/);
      if (m) {
        try { result = JSON.parse(m[1]); } catch { result = null; }
      }
      if (!result) result = { analise_geral: aiContent, sugestoes: [], sem_match: [], alertas: [], insights: [] };
    }

    // 5. Validar IDs (aceita novos tipos: grupo_receber, grupo_pagar, agenda, residuo)
    const grRecIds = new Set(grRecCtx.map(g => g.id));
    const grPagIds = new Set(grPagCtx.map(g => g.id));
    const agendaIds = new Set(agendaCtx.map(a => a.id));
    const residuoIds = new Set(residuosCtx.map(r => r.id));
    const recIds = new Set(recCtx.map(r => r.id));
    const pagIds = new Set(pagCtx.map(p => p.id));

    const validSugestoes: any[] = [];
    let totalCandidatos = 0;
    let altaCount = 0, mediaCount = 0, baixaCount = 0;

    for (const s of (result.sugestoes ?? [])) {
      const extratoExists = extratoCtx.some(e => e.id === s.extrato_id);
      if (!extratoExists) continue;

      const validCandidatos = (s.candidatos ?? []).filter((c: any) => {
        switch (c.lancamento_tipo) {
          case "recebimento": return recIds.has(c.lancamento_id);
          case "pagamento": return pagIds.has(c.lancamento_id);
          case "grupo_receber": return grRecIds.has(c.lancamento_id);
          case "grupo_pagar": return grPagIds.has(c.lancamento_id);
          case "agenda": return agendaIds.has(c.lancamento_id);
          case "residuo": return residuoIds.has(c.lancamento_id);
          default: return false;
        }
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
      model: AI_MODEL,
      analise_geral: result.analise_geral ?? result.analise ?? "",
      sugestoes: validSugestoes,
      sem_match: result.sem_match ?? [],
      alertas: result.alertas ?? [],
      insights: result.insights ?? [],
      stats: {
        extratos_analisados: extratoCtx.length,
        recebimentos_pool: recCtx.length,
        pagamentos_pool: pagCtx.length,
        grupos_receber_pool: grRecCtx.length,
        grupos_pagar_pool: grPagCtx.length,
        residuos_pool: residuosCtx.length,
        agenda_pool: agendaCtx.length,
        nfe_pool: nfeCtx.length,
        historico_pool: historicoCtx.length,
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
