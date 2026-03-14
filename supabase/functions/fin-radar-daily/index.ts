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

  const startTime = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  );

  let alertasCriados = 0;
  let tarefasCriadas = 0;
  const erros: string[] = [];
  const today = new Date().toISOString().split("T")[0];

  // Helper: create alert + tarefa if not already open
  async function criarAlerta(params: {
    tipo: string;
    severidade: string;
    titulo: string;
    descricao: string;
    entidade_tipo: string;
    entidade_id: string;
    valor_impacto: number;
    evidencias?: Record<string, unknown>;
  }) {
    // Check for existing open alert on same entity
    const { data: existing } = await supabase
      .from("fin_alertas")
      .select("id")
      .eq("tipo", params.tipo)
      .eq("entidade_id", params.entidade_id)
      .in("status", ["aberto", "em_analise"])
      .limit(1);

    if (existing && existing.length > 0) return; // already open

    const { data: alerta, error: errAlerta } = await supabase
      .from("fin_alertas")
      .insert({
        tipo: params.tipo,
        severidade: params.severidade,
        titulo: params.titulo,
        descricao: params.descricao,
        entidade_tipo: params.entidade_tipo,
        entidade_id: params.entidade_id,
        valor_impacto: params.valor_impacto,
        evidencias: params.evidencias || {},
        status: "aberto",
      })
      .select("id")
      .single();

    if (errAlerta) {
      erros.push(`Alerta: ${errAlerta.message}`);
      return;
    }
    alertasCriados++;

    // Create kanban card
    const coluna = params.severidade === "critica" ? "a_fazer" : "em_analise";
    const tipoTarefa =
      params.entidade_tipo === "fin_pagamentos" ? "ap" : 
      params.entidade_tipo === "fin_recebimentos" ? "ar" : 
      params.entidade_tipo === "fin_extrato_inter" ? "conciliacao" : "compliance";

    const { error: errTarefa } = await supabase.from("fin_tarefas").insert({
      titulo: params.titulo,
      descricao: params.descricao,
      tipo: tipoTarefa,
      coluna,
      severidade: params.severidade,
      valor_impacto: params.valor_impacto,
      entidade_tipo: params.entidade_tipo,
      entidade_id: params.entidade_id,
      alerta_id: alerta.id,
      evidencias: params.evidencias || {},
      created_by: "argus",
    });

    if (errTarefa) {
      erros.push(`Tarefa: ${errTarefa.message}`);
    } else {
      tarefasCriadas++;
    }
  }

  try {
    // ═══════════════════════════════════════════
    // 1) AP VENCIDAS (contas a pagar vencidas)
    //    Exclui itens já baixados no GC, liquidados ou pagos pelo sistema
    // ═══════════════════════════════════════════
    const { data: apVencidas } = await supabase
      .from("fin_pagamentos")
      .select("id, descricao, valor, data_vencimento, nome_fornecedor, os_codigo")
      .eq("status", "pendente")
      .eq("liquidado", false)
      .eq("gc_baixado", false)
      .eq("pago_sistema", false)
      .lt("data_vencimento", today)
      .limit(200);

    if (apVencidas) {
      for (const ap of apVencidas) {
        const diasAtraso = Math.floor(
          (Date.now() - new Date(ap.data_vencimento).getTime()) / 86400000
        );
        const severidade = diasAtraso > 30 ? "critica" : diasAtraso > 7 ? "alta" : "media";

        await criarAlerta({
          tipo: "ap_vencida",
          severidade,
          titulo: `AP vencida — ${ap.nome_fornecedor || ap.descricao}`,
          descricao: `Vencimento: ${ap.data_vencimento} (${diasAtraso}d atrás). Valor: R$ ${Number(ap.valor).toFixed(2)}`,
          entidade_tipo: "fin_pagamentos",
          entidade_id: ap.id,
          valor_impacto: Number(ap.valor),
          evidencias: { dias_atraso: diasAtraso, os_codigo: ap.os_codigo },
        });
      }
    }

    // ═══════════════════════════════════════════
    // 2) AR VENCIDAS (contas a receber vencidas)
    //    Exclui itens já baixados no GC, liquidados ou pagos pelo sistema
    // ═══════════════════════════════════════════
    const { data: arVencidas } = await supabase
      .from("fin_recebimentos")
      .select("id, descricao, valor, data_vencimento, nome_cliente, os_codigo")
      .eq("status", "pendente")
      .eq("liquidado", false)
      .eq("gc_baixado", false)
      .eq("pago_sistema", false)
      .lt("data_vencimento", today)
      .limit(200);

    if (arVencidas) {
      for (const ar of arVencidas) {
        const diasAtraso = Math.floor(
          (Date.now() - new Date(ar.data_vencimento).getTime()) / 86400000
        );
        const severidade = diasAtraso > 30 ? "critica" : diasAtraso > 7 ? "alta" : "media";

        await criarAlerta({
          tipo: "ar_vencida",
          severidade,
          titulo: `AR vencida — ${ar.nome_cliente || ar.descricao}`,
          descricao: `Vencimento: ${ar.data_vencimento} (${diasAtraso}d atrás). Valor: R$ ${Number(ar.valor).toFixed(2)}`,
          entidade_tipo: "fin_recebimentos",
          entidade_id: ar.id,
          valor_impacto: Number(ar.valor),
          evidencias: { dias_atraso: diasAtraso, os_codigo: ar.os_codigo },
        });
      }
    }

    // ═══════════════════════════════════════════
    // 3) AP A VENCER em 7 dias (alerta preventivo)
    // ═══════════════════════════════════════════
    const in7days = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
    const { data: apProximas } = await supabase
      .from("fin_pagamentos")
      .select("id, descricao, valor, data_vencimento, nome_fornecedor")
      .eq("status", "pendente")
      .gte("data_vencimento", today)
      .lte("data_vencimento", in7days)
      .limit(200);

    if (apProximas) {
      for (const ap of apProximas) {
        const diasRestantes = Math.floor(
          (new Date(ap.data_vencimento).getTime() - Date.now()) / 86400000
        );
        await criarAlerta({
          tipo: "ap_proxima",
          severidade: diasRestantes <= 2 ? "alta" : "media",
          titulo: `AP vence em ${diasRestantes}d — ${ap.nome_fornecedor || ap.descricao}`,
          descricao: `Vencimento: ${ap.data_vencimento}. Valor: R$ ${Number(ap.valor).toFixed(2)}`,
          entidade_tipo: "fin_pagamentos",
          entidade_id: ap.id,
          valor_impacto: Number(ap.valor),
          evidencias: { dias_restantes: diasRestantes },
        });
      }
    }

    // ═══════════════════════════════════════════
    // 4) LANÇAMENTOS SEM PLANO DE CONTAS
    // ═══════════════════════════════════════════
    const { data: apSemPlano } = await supabase
      .from("fin_pagamentos")
      .select("id, descricao, valor, nome_fornecedor")
      .is("plano_contas_id", null)
      .in("status", ["pendente", "pago"])
      .limit(100);

    if (apSemPlano) {
      for (const ap of apSemPlano) {
        await criarAlerta({
          tipo: "sem_plano_contas",
          severidade: "baixa",
          titulo: `Sem plano de contas — ${ap.nome_fornecedor || ap.descricao}`,
          descricao: `Lançamento AP sem classificação. Valor: R$ ${Number(ap.valor).toFixed(2)}`,
          entidade_tipo: "fin_pagamentos",
          entidade_id: ap.id,
          valor_impacto: 0,
        });
      }
    }

    const { data: arSemPlano } = await supabase
      .from("fin_recebimentos")
      .select("id, descricao, valor, nome_cliente")
      .is("plano_contas_id", null)
      .in("status", ["pendente", "pago"])
      .limit(100);

    if (arSemPlano) {
      for (const ar of arSemPlano) {
        await criarAlerta({
          tipo: "sem_plano_contas",
          severidade: "baixa",
          titulo: `Sem plano de contas — ${ar.nome_cliente || ar.descricao}`,
          descricao: `Lançamento AR sem classificação. Valor: R$ ${Number(ar.valor).toFixed(2)}`,
          entidade_tipo: "fin_recebimentos",
          entidade_id: ar.id,
          valor_impacto: 0,
        });
      }
    }

    // ═══════════════════════════════════════════
    // 5) EXTRATO NÃO RECONCILIADO (> 7 dias)
    // ═══════════════════════════════════════════
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString();
    const { data: extratoOrfao } = await supabase
      .from("fin_extrato_inter")
      .select("id, descricao, valor, data_hora, nome_contraparte, tipo")
      .eq("reconciliado", false)
      .lt("data_hora", sevenDaysAgo)
      .limit(100);

    if (extratoOrfao) {
      for (const ext of extratoOrfao) {
        const diasSemMatch = Math.floor(
          (Date.now() - new Date(ext.data_hora!).getTime()) / 86400000
        );
        await criarAlerta({
          tipo: "extrato_nao_reconciliado",
          severidade: diasSemMatch > 30 ? "alta" : "media",
          titulo: `Extrato sem match (${diasSemMatch}d) — ${ext.nome_contraparte || ext.descricao || "?"}`,
          descricao: `${ext.tipo === "CREDITO" ? "Crédito" : "Débito"} de R$ ${Math.abs(Number(ext.valor)).toFixed(2)} em ${ext.data_hora?.split("T")[0]}`,
          entidade_tipo: "fin_extrato_inter",
          entidade_id: ext.id,
          valor_impacto: Math.abs(Number(ext.valor)),
          evidencias: { dias_sem_match: diasSemMatch },
        });
      }
    }

    // ═══════════════════════════════════════════
    // 6) AUTO-RESOLVER alertas antigos cujo item já foi pago
    // ═══════════════════════════════════════════
    const { data: alertasAbertos } = await supabase
      .from("fin_alertas")
      .select("id, tipo, entidade_tipo, entidade_id")
      .in("status", ["aberto", "em_analise"])
      .in("tipo", ["ap_vencida", "ap_proxima", "ar_vencida"])
      .limit(500);

    if (alertasAbertos) {
      for (const alerta of alertasAbertos) {
        const tabela = alerta.entidade_tipo === "fin_pagamentos" ? "fin_pagamentos" : "fin_recebimentos";
        const { data: lancamento } = await supabase
          .from(tabela)
          .select("status")
          .eq("id", alerta.entidade_id)
          .single();

        if (lancamento && lancamento.status !== "pendente") {
          await supabase
            .from("fin_alertas")
            .update({ status: "resolvido", resolvido_em: new Date().toISOString(), resolvido_por: "argus-auto" })
            .eq("id", alerta.id);

          // Also close linked tarefa
          await supabase
            .from("fin_tarefas")
            .update({ coluna: "concluido" })
            .eq("alerta_id", alerta.id);
        }
      }
    }

  } catch (e) {
    erros.push(`Global: ${e.message}`);
  }

  // ═══════════════════════════════════════════
  // LOG DA EXECUÇÃO
  // ═══════════════════════════════════════════
  const duracao = Date.now() - startTime;
  const status = erros.length === 0 ? "success" : alertasCriados > 0 ? "partial" : "error";

  await supabase.from("fin_agent_runs").insert({
    tipo: "radar-daily",
    status,
    resumo: `${alertasCriados} alertas, ${tarefasCriadas} tarefas criadas`,
    duracao_ms: duracao,
    alertas_criados: alertasCriados,
    tarefas_criadas: tarefasCriadas,
    erros: erros.length > 0 ? erros : null,
    inicio: new Date(startTime).toISOString(),
    fim: new Date().toISOString(),
  });

  return new Response(
    JSON.stringify({
      ok: true,
      alertas_criados: alertasCriados,
      tarefas_criadas: tarefasCriadas,
      duracao_ms: duracao,
      erros,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
