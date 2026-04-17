// Auditor IA — detecta duplicações, misclassificações e anomalias em fin_pagamentos
// Usa Lovable AI Gateway (Gemini) para análise semântica + heurísticas SQL
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface Pagamento {
  id: string;
  descricao: string;
  valor: number;
  data_vencimento: string | null;
  data_competencia: string | null;
  nome_fornecedor: string | null;
  fornecedor_gc_id: string | null;
  os_codigo: string | null;
  nf_numero: string | null;
  plano_nome: string | null;
  plano_gc_id: string | null;
  centro_nome: string | null;
  origem: string | null;
}

interface Achado {
  tipo: "duplicata_exata" | "duplicata_provavel" | "misclassificacao" | "outlier" | "valor_redondo_suspeito";
  severidade: "alta" | "media" | "baixa";
  titulo: string;
  descricao: string;
  ids_afetados: string[];
  valor_impacto: number;
  evidencias: string[];
  acao_sugerida: string;
}

const PLANOS_AUVO = new Set([
  "27942292", // Combustível
  "27942301", // Hospedagem
  "27942281", // Alimentação
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { dataInicio, dataFim, plano_filter } = await req.json();
    if (!dataInicio || !dataFim) {
      return new Response(JSON.stringify({ error: "dataInicio e dataFim obrigatórios" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(supabaseUrl, serviceKey);

    // 1. Buscar pagamentos do período com join no plano
    let q = supabase
      .from("fin_pagamentos")
      .select(`
        id, descricao, valor, data_vencimento, data_competencia,
        nome_fornecedor, fornecedor_gc_id, os_codigo, nf_numero, origem,
        plano_contas_id, centro_custo_id,
        fin_plano_contas!inner(nome, gc_id),
        fin_centros_custo(nome)
      `)
      .gte("data_vencimento", dataInicio)
      .lte("data_vencimento", dataFim)
      .neq("status", "cancelado")
      .limit(2000);

    const { data: rows, error } = await q;
    if (error) throw error;

    const pagamentos: Pagamento[] = (rows || []).map((r: any) => ({
      id: r.id,
      descricao: r.descricao || "",
      valor: Number(r.valor) || 0,
      data_vencimento: r.data_vencimento,
      data_competencia: r.data_competencia,
      nome_fornecedor: r.nome_fornecedor,
      fornecedor_gc_id: r.fornecedor_gc_id,
      os_codigo: r.os_codigo,
      nf_numero: r.nf_numero,
      origem: r.origem,
      plano_nome: r.fin_plano_contas?.nome || null,
      plano_gc_id: r.fin_plano_contas?.gc_id || null,
      centro_nome: r.fin_centros_custo?.nome || null,
    }));

    // 2. Heurísticas locais (rápidas, determinísticas)
    const achados: Achado[] = [];

    // 2.1 Duplicatas exatas: mesmo fornecedor + valor + data ±2 dias
    const grupos = new Map<string, Pagamento[]>();
    for (const p of pagamentos) {
      const k = `${p.fornecedor_gc_id || p.nome_fornecedor || "?"}|${p.valor.toFixed(2)}`;
      if (!grupos.has(k)) grupos.set(k, []);
      grupos.get(k)!.push(p);
    }
    for (const [, lista] of grupos) {
      if (lista.length < 2) continue;
      // ordena por data
      lista.sort((a, b) => (a.data_vencimento || "").localeCompare(b.data_vencimento || ""));
      for (let i = 0; i < lista.length - 1; i++) {
        const a = lista[i], b = lista[i + 1];
        const dA = new Date(a.data_vencimento || 0).getTime();
        const dB = new Date(b.data_vencimento || 0).getTime();
        const diffDias = Math.abs((dB - dA) / 86400000);
        if (diffDias <= 7) {
          // verifica se descrição é similar (não NF diferente)
          const nfDif = a.nf_numero && b.nf_numero && a.nf_numero !== b.nf_numero;
          if (!nfDif) {
            achados.push({
              tipo: diffDias === 0 ? "duplicata_exata" : "duplicata_provavel",
              severidade: diffDias === 0 ? "alta" : "media",
              titulo: `Possível duplicata: ${a.nome_fornecedor || "Sem fornecedor"} — R$ ${a.valor.toFixed(2)}`,
              descricao: `Dois lançamentos idênticos em ${diffDias === 0 ? "mesma data" : `${diffDias} dias de diferença`}: "${a.descricao}" e "${b.descricao}"`,
              ids_afetados: [a.id, b.id],
              valor_impacto: a.valor,
              evidencias: [
                `Fornecedor: ${a.nome_fornecedor}`,
                `Valor: R$ ${a.valor.toFixed(2)}`,
                `Datas: ${a.data_vencimento} ↔ ${b.data_vencimento}`,
                `Origem: ${a.origem} / ${b.origem}`,
              ],
              acao_sugerida: "Revisar no GC e cancelar o duplicado, mantendo o lançamento original.",
            });
          }
        }
      }
    }

    // 2.2 Valores redondos suspeitos (R$ 100,00 / R$ 500,00 etc.) acima de R$ 500
    for (const p of pagamentos) {
      if (p.valor >= 500 && p.valor % 100 === 0 && !p.nf_numero && !p.os_codigo) {
        achados.push({
          tipo: "valor_redondo_suspeito",
          severidade: "baixa",
          titulo: `Valor redondo sem NF: ${p.nome_fornecedor || p.descricao} — R$ ${p.valor.toFixed(2)}`,
          descricao: `Lançamento com valor exato (múltiplo de R$ 100) sem nota fiscal nem OS vinculada.`,
          ids_afetados: [p.id],
          valor_impacto: p.valor,
          evidencias: [`Valor: R$ ${p.valor.toFixed(2)}`, `Sem NF`, `Sem OS`, `Origem: ${p.origem}`],
          acao_sugerida: "Confirmar se há nota fiscal ou contrato lastreando o pagamento.",
        });
      }
    }

    // 3. IA: misclassificações e anomalias semânticas (Gemini Flash)
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    let analiseIA = "";
    let achadosIA: Achado[] = [];

    if (LOVABLE_API_KEY && pagamentos.length > 0) {
      // Amostra: até 250 pagamentos pra Gemini Pro (contexto longo permite)
      const amostra = pagamentos
        .filter(p => !plano_filter || p.plano_nome?.toLowerCase().includes(plano_filter.toLowerCase()))
        .slice(0, 250)
        .map(p => ({
          id: p.id,
          desc: p.descricao,
          valor: p.valor,
          venc: p.data_vencimento,
          forn: p.nome_fornecedor,
          plano: p.plano_nome,
          centro: p.centro_nome,
          origem: p.origem,
          nf: p.nf_numero,
          os: p.os_codigo,
        }));

      const systemPrompt = `Você é um auditor financeiro sênior especializado em ERP brasileiro. 
Analise lançamentos de contas a pagar e identifique:
1. **Misclassificações**: descrição incompatível com o plano de contas (ex: "hotel" classificado em "Combustível")
2. **Despesas suspeitas**: valores ou descrições atípicas pra categoria
3. **Categorias indevidas**: itens que deveriam vir do Auvo (combustível, hospedagem, alimentação) mas estão no GC

Retorne APENAS JSON válido no formato:
{
  "analise": "texto curto resumindo o que encontrou",
  "achados": [
    {
      "tipo": "misclassificacao" | "outlier",
      "severidade": "alta" | "media" | "baixa",
      "titulo": "...",
      "descricao": "...",
      "ids_afetados": ["uuid1", "uuid2"],
      "valor_impacto": 0.0,
      "evidencias": ["..."],
      "acao_sugerida": "..."
    }
  ]
}`;

      const userPrompt = `Audite estes lançamentos do período ${dataInicio} a ${dataFim}:\n\n${JSON.stringify(amostra, null, 2)}\n\nFoque em: planos Auvo (${[...PLANOS_AUVO].join(",")}) que devem vir só do Auvo, descrições incompatíveis com plano, e valores atípicos. Seja conservador — só aponte o que tem evidência clara.`;

      try {
        const aiResp = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${LOVABLE_API_KEY}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            model: "google/gemini-2.5-pro",
            messages: [
              { role: "system", content: systemPrompt },
              { role: "user", content: userPrompt },
            ],
            response_format: { type: "json_object" },
          }),
        });

        if (aiResp.status === 429) {
          analiseIA = "⚠️ Rate limit da IA. Tente novamente em alguns segundos.";
        } else if (aiResp.status === 402) {
          analiseIA = "⚠️ Créditos da IA esgotados. Adicione créditos no workspace.";
        } else if (aiResp.ok) {
          const aiData = await aiResp.json();
          const raw = aiData.choices?.[0]?.message?.content || "{}";
          try {
            const parsed = JSON.parse(raw);
            analiseIA = parsed.analise || "";
            achadosIA = (parsed.achados || []).map((a: any) => ({
              tipo: a.tipo || "outlier",
              severidade: a.severidade || "media",
              titulo: a.titulo || "Achado IA",
              descricao: a.descricao || "",
              ids_afetados: a.ids_afetados || [],
              valor_impacto: Number(a.valor_impacto) || 0,
              evidencias: a.evidencias || [],
              acao_sugerida: a.acao_sugerida || "Revisar manualmente.",
            }));
          } catch (e) {
            analiseIA = "Resposta da IA em formato inesperado.";
          }
        } else {
          analiseIA = `Erro na IA: HTTP ${aiResp.status}`;
        }
      } catch (e: any) {
        analiseIA = `Falha ao consultar IA: ${e.message}`;
      }
    }

    const todosAchados = [...achados, ...achadosIA];
    const stats = {
      total_pagamentos: pagamentos.length,
      valor_total: pagamentos.reduce((s, p) => s + p.valor, 0),
      achados_total: todosAchados.length,
      alta: todosAchados.filter(a => a.severidade === "alta").length,
      media: todosAchados.filter(a => a.severidade === "media").length,
      baixa: todosAchados.filter(a => a.severidade === "baixa").length,
      valor_em_risco: todosAchados.reduce((s, a) => s + a.valor_impacto, 0),
    };

    return new Response(
      JSON.stringify({ success: true, analise: analiseIA, achados: todosAchados, stats }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e: any) {
    console.error("fin-audit-duplicates error:", e);
    return new Response(
      JSON.stringify({ success: false, error: e.message || "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
