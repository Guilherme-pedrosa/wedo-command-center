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

  const body = await req.json();
  const { aprovacao_id, decisao, aprovado_por } = body;

  if (!aprovacao_id || !decisao || !["aprovado", "recusado"].includes(decisao)) {
    return new Response(
      JSON.stringify({ error: "aprovacao_id e decisao (aprovado|recusado) são obrigatórios" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Fetch approval
  const { data: aprovacao, error: errAprov } = await supabase
    .from("fin_aprovacoes")
    .select("*")
    .eq("id", aprovacao_id)
    .single();

  if (errAprov || !aprovacao) {
    return new Response(
      JSON.stringify({ error: "Aprovação não encontrada" }),
      { status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  if (aprovacao.status !== "pendente") {
    return new Response(
      JSON.stringify({ error: "Aprovação já decidida", status: aprovacao.status }),
      { status: 409, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Update approval status
  const { error: errUpdate } = await supabase
    .from("fin_aprovacoes")
    .update({
      status: decisao,
      decidido_em: new Date().toISOString(),
      aprovado_por: aprovado_por || "admin",
    })
    .eq("id", aprovacao_id);

  if (errUpdate) {
    return new Response(
      JSON.stringify({ error: errUpdate.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  let resultado: Record<string, unknown> = { decisao };

  // If approved, execute the proposed action
  if (decisao === "aprovado" && aprovacao.payload_proposto) {
    const payload = aprovacao.payload_proposto as Record<string, unknown>;
    const tipoAcao = aprovacao.tipo_acao;

    try {
      // Execute based on action type
      switch (tipoAcao) {
        case "baixa_ap": {
          // Mark AP as paid
          const { error } = await supabase
            .from("fin_pagamentos")
            .update({
              status: "pago",
              liquidado: true,
              data_liquidacao: new Date().toISOString().split("T")[0],
              pago_sistema: true,
              pago_sistema_em: new Date().toISOString(),
            })
            .eq("id", payload.lancamento_id);
          if (error) throw error;
          resultado.executado = true;
          break;
        }
        case "baixa_ar": {
          // Mark AR as received
          const { error } = await supabase
            .from("fin_recebimentos")
            .update({
              status: "pago",
              liquidado: true,
              data_liquidacao: new Date().toISOString().split("T")[0],
              pago_sistema: true,
              pago_sistema_em: new Date().toISOString(),
            })
            .eq("id", payload.lancamento_id);
          if (error) throw error;
          resultado.executado = true;
          break;
        }
        case "vincular_extrato": {
          // Reconcile extrato entry
          const { error } = await supabase
            .from("fin_extrato_inter")
            .update({
              reconciliado: true,
              reconciliado_em: new Date().toISOString(),
              lancamento_id: payload.lancamento_id as string,
              reconciliation_rule: "argus-aprovado",
            })
            .eq("id", payload.extrato_id);
          if (error) throw error;
          resultado.executado = true;
          break;
        }
        default: {
          resultado.executado = false;
          resultado.motivo = `Tipo de ação '${tipoAcao}' não suportado para execução automática`;
        }
      }
    } catch (e) {
      resultado.executado = false;
      resultado.erro = e.message;
    }
  }

  // Update linked tarefa
  if (aprovacao.tarefa_id) {
    const novaColuna = decisao === "aprovado" ? "concluido" : "bloqueado";
    await supabase
      .from("fin_tarefas")
      .update({ coluna: novaColuna })
      .eq("id", aprovacao.tarefa_id);
  }

  // Audit log
  await supabase.from("fin_audit_log").insert({
    acao: `aprovacao_${decisao}`,
    ator: aprovado_por || "admin",
    entidade_tipo: "fin_aprovacoes",
    entidade_id: aprovacao_id,
    tarefa_id: aprovacao.tarefa_id,
    aprovacao_id,
    antes: aprovacao.estado_anterior,
    depois: aprovacao.payload_proposto,
    justificativa: `Aprovação ${decisao} por ${aprovado_por || "admin"}`,
    evidencias: resultado,
  });

  // Log agent run
  await supabase.from("fin_agent_runs").insert({
    tipo: "execute-action",
    status: resultado.executado ? "success" : "error",
    resumo: `${aprovacao.tipo_acao}: ${decisao}`,
    acoes_executadas: resultado.executado ? 1 : 0,
    inicio: new Date().toISOString(),
    fim: new Date().toISOString(),
  });

  // Auto-resolve linked alert
  if (decisao === "aprovado" && aprovacao.tarefa_id) {
    await supabase
      .from("fin_alertas")
      .update({ status: "resolvido", resolvido_em: new Date().toISOString(), resolvido_por: aprovado_por || "admin" })
      .eq("tarefa_id", aprovacao.tarefa_id);
  }

  return new Response(
    JSON.stringify({ ok: true, ...resultado }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } }
  );
});
