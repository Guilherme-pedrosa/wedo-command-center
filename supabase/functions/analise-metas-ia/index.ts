// Analise IA de Metas & Orçamento - usa Lovable AI Gateway (Gemini 2.5 Pro)
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

interface MetaSnapshot {
  nome: string;
  categoria: string;
  meta_calculada: number;
  realizado: number;
  delta: number;
  pct_faturamento: number;
  status: string;
}

interface RequestBody {
  ano: number;
  mes: number;
  execTotal: number;
  margemLiquida: number;
  totalCustos: number;
  metas: MetaSnapshot[];
}

const fmtBRL = (v: number) =>
  `R$ ${v.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtPct = (v: number) => `${(v * 100).toFixed(1)}%`;

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const LOVABLE_API_KEY = Deno.env.get("LOVABLE_API_KEY");
    if (!LOVABLE_API_KEY) throw new Error("LOVABLE_API_KEY not configured");

    const body = (await req.json()) as RequestBody;
    const { ano, mes, execTotal, margemLiquida, totalCustos, metas } = body;

    if (!metas || metas.length === 0) {
      return new Response(JSON.stringify({ error: "Sem metas para analisar" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const meses = [
      "Janeiro", "Fevereiro", "Março", "Abril", "Maio", "Junho",
      "Julho", "Agosto", "Setembro", "Outubro", "Novembro", "Dezembro",
    ];

    // Monta tabela compacta para o modelo
    const linhas = metas
      .map((m) => {
        const sinal = m.delta >= 0 ? "+" : "";
        return `- [${m.categoria.toUpperCase()}] ${m.nome} | Meta: ${fmtBRL(
          m.meta_calculada
        )} | Real: ${fmtBRL(m.realizado)} | Δ: ${sinal}${fmtBRL(m.delta)} | %Fat: ${fmtPct(
          m.pct_faturamento
        )} | Status: ${m.status}`;
      })
      .join("\n");

    const systemPrompt = `Você é um CFO sênior especialista em gestão financeira de empresas de manutenção/serviços técnicos no Brasil (regime Lucro Real, ~24% IRPJ/CSLL). Sua função é analisar metas vs realizado de forma OBJETIVA, DIRETA e ACIONÁVEL. Use português brasileiro coloquial mas profissional. Seja específico: cite números, percentuais e nomes de categorias. NUNCA dê conselhos genéricos do tipo "monitorar de perto" - sempre proponha ação concreta com responsável implícito.`;

    const userPrompt = `Analise o fechamento de **${meses[mes - 1]}/${ano}**:

**Resumo**:
- Faturamento Executado: ${fmtBRL(execTotal)}
- Total Custos: ${fmtBRL(totalCustos)} (${execTotal > 0 ? fmtPct(totalCustos / execTotal) : "—"})
- Margem Líquida: ${fmtPct(margemLiquida)} (meta ≥ 30%)

**Indicadores**:
${linhas}

Retorne JSON estrito com a estrutura:
{
  "diagnostico": "Resumo executivo em 2-3 frases sobre a saúde do mês. Cite o número que MAIS importa.",
  "destaques_positivos": [
    { "titulo": "...", "descricao": "Análise breve com números" }
  ],
  "alertas_criticos": [
    { "titulo": "...", "descricao": "O que está furando, em quanto, e provável causa" }
  ],
  "recomendacoes": [
    { "acao": "Verbo no infinitivo + objeto específico", "justificativa": "Por quê", "impacto_estimado": "Quanto economiza/gera em R$ ou %" }
  ]
}

Regras:
- Máximo 3 itens por lista
- Recomendações devem ser EXECUTÁVEIS esta semana (ex: "Renegociar contrato X", "Cortar despesa Y", não "melhorar processos")
- Se margem < 15%, marque como crise e priorize corte de custo
- Se receita > meta mas margem ruim, foque em custo variável`;

    const response = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
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
        tools: [
          {
            type: "function",
            function: {
              name: "retornar_analise",
              description: "Retorna análise estruturada das metas",
              parameters: {
                type: "object",
                properties: {
                  diagnostico: { type: "string" },
                  destaques_positivos: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        titulo: { type: "string" },
                        descricao: { type: "string" },
                      },
                      required: ["titulo", "descricao"],
                    },
                  },
                  alertas_criticos: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        titulo: { type: "string" },
                        descricao: { type: "string" },
                      },
                      required: ["titulo", "descricao"],
                    },
                  },
                  recomendacoes: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        acao: { type: "string" },
                        justificativa: { type: "string" },
                        impacto_estimado: { type: "string" },
                      },
                      required: ["acao", "justificativa", "impacto_estimado"],
                    },
                  },
                },
                required: ["diagnostico", "destaques_positivos", "alertas_criticos", "recomendacoes"],
              },
            },
          },
        ],
        tool_choice: { type: "function", function: { name: "retornar_analise" } },
      }),
    });

    if (!response.ok) {
      const t = await response.text();
      console.error("Gateway error:", response.status, t);
      if (response.status === 429) {
        return new Response(
          JSON.stringify({ error: "Limite de requisições IA atingido. Tente novamente em alguns segundos." }),
          { status: 429, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      if (response.status === 402) {
        return new Response(
          JSON.stringify({ error: "Créditos de IA esgotados. Adicione créditos na workspace." }),
          { status: 402, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ error: "Erro no gateway de IA" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const data = await response.json();
    const toolCall = data.choices?.[0]?.message?.tool_calls?.[0];
    if (!toolCall) {
      return new Response(JSON.stringify({ error: "IA não retornou análise estruturada" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const analise = JSON.parse(toolCall.function.arguments);

    return new Response(JSON.stringify({ analise, gerado_em: new Date().toISOString() }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (e) {
    console.error("analise-metas-ia error:", e);
    return new Response(
      JSON.stringify({ error: e instanceof Error ? e.message : "Erro desconhecido" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
