// Repricing engine fired by trigger when gc_produtos_cache.valor_custo changes.
// For each price table in valores[], compares current margin to policy minimum
// and either auto-adjusts (sugerir + !exige_aprov_ceo) or queues CEO approval.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface Body {
  gc_produto_id: string;
  nome_produto?: string;
  custo_anterior?: number | null;
  custo_novo: number;
}

interface ValorEntry {
  tipo_id: string | number;
  nome_tipo?: string;
  valor_venda?: number | string;
  valor_custo?: number | string;
  lucro_utilizado?: number | string;
}

interface Politica {
  tipo_id: string;
  nome_tabela: string;
  margem_minima: number;
  modo_sugestao: "sugerir" | "manual";
  exige_aprovacao_ceo: boolean;
  ativo: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "invalid json" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const { gc_produto_id, custo_novo } = body;
  if (!gc_produto_id || !custo_novo || custo_novo <= 0) {
    return new Response(JSON.stringify({ error: "gc_produto_id e custo_novo>0 obrigatórios" }), {
      status: 400,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Load product
  const { data: prod, error: errProd } = await supabase
    .from("gc_produtos_cache")
    .select("produto_gc_id, nome, valor_custo, valores")
    .eq("produto_gc_id", gc_produto_id)
    .maybeSingle();

  if (errProd || !prod) {
    return new Response(JSON.stringify({ error: "produto não encontrado", details: errProd?.message }), {
      status: 404,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const valores = (prod.valores as ValorEntry[] | null) ?? [];
  if (valores.length === 0) {
    return new Response(JSON.stringify({ ok: true, produto: gc_produto_id, motivo: "sem tabelas" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Load active policies
  const { data: politicas, error: errPol } = await supabase
    .from("fin_politica_markup_tabela")
    .select("tipo_id, nome_tabela, margem_minima, modo_sugestao, exige_aprovacao_ceo, ativo")
    .eq("ativo", true);

  if (errPol) {
    return new Response(JSON.stringify({ error: errPol.message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  const polByTipo = new Map<string, Politica>(
    (politicas ?? []).map((p) => [String(p.tipo_id), p as Politica]),
  );

  const auto: unknown[] = [];
  const pendentes: unknown[] = [];
  const skipped: unknown[] = [];
  const novosValores: ValorEntry[] = [];

  for (const entry of valores) {
    const tipoId = String(entry.tipo_id);
    const precoAtual = Number(entry.valor_venda ?? 0);
    const pol = polByTipo.get(tipoId);

    if (!pol) {
      novosValores.push(entry);
      skipped.push({ tipo_id: tipoId, motivo: "sem política" });
      continue;
    }

    if (precoAtual <= 0) {
      // Preço inicial ausente — sempre exige aprovação CEO (nunca auto-publica preço novo)
      novosValores.push(entry);
      const margemMinZ = Number(pol.margem_minima);
      const precoSugeridoZ = round2(custo_novo / (1 - margemMinZ));
      const margemResZ = (precoSugeridoZ - custo_novo) / precoSugeridoZ;

      const { data: aprovZ, error: errApZ } = await supabase
        .from("fin_gc_price_aprovacoes")
        .insert({
          gc_produto_id,
          nome_produto: prod.nome,
          tipo_id: tipoId,
          modo_calculo: "completo",
          custo_referencia: custo_novo,
          preco_atual: 0,
          preco_solicitado: precoSugeridoZ,
          margem_resultante: margemResZ,
          margem_minima_politica: margemMinZ,
          justificativa: `Preço inicial ausente em ${pol.nome_tabela}. Custo R$ ${custo_novo.toFixed(2)}. Sugerido R$ ${precoSugeridoZ.toFixed(2)} (margem mín ${(margemMinZ * 100).toFixed(2)}%).`,
          status: "pendente",
          payload: { source: "repricing-on-cost-change", motivo: "preco_inicial_ausente", custo_anterior: body.custo_anterior },
        })
        .select("id")
        .single();

      if (!errApZ && aprovZ) {
        await supabase.from("fin_acoes_pendentes").insert({
          tipo: "aprovacao_preco_inicial",
          destinatario_role: "ceo",
          titulo: `Definir preço inicial: ${prod.nome ?? gc_produto_id} - ${pol.nome_tabela}`,
          descricao: `Tabela sem preço cadastrado. Custo R$ ${custo_novo.toFixed(2)} → sugerido R$ ${precoSugeridoZ.toFixed(2)} (margem mín ${(margemMinZ * 100).toFixed(2)}%).`,
          entidade_tipo: "fin_gc_price_aprovacoes",
          entidade_id: aprovZ.id,
          payload: { gc_produto_id, tipo_id: tipoId, nome_tabela: pol.nome_tabela, custo_novo, preco_sugerido: precoSugeridoZ, margem_minima: margemMinZ, aprovacao_id: aprovZ.id, motivo: "preco_inicial_ausente" },
        });
        pendentes.push({ tipo_id: tipoId, nome_tabela: pol.nome_tabela, preco_atual: 0, preco_sugerido: precoSugeridoZ, aprovacao_id: aprovZ.id, motivo: "preco_inicial_ausente" });
      } else {
        skipped.push({ tipo_id: tipoId, motivo: "erro_aprovacao_preco_zero", erro: errApZ?.message });
      }
      continue;
    }

    const margemMin = Number(pol.margem_minima); // ex 0.30
    const margemAtual = (precoAtual - custo_novo) / precoAtual;

    if (margemAtual >= margemMin) {
      // Custo subiu mas margem ainda OK — só atualizar valor_custo do snapshot
      novosValores.push({ ...entry, valor_custo: custo_novo });
      skipped.push({ tipo_id: tipoId, motivo: "margem ok", margem_atual: round2(margemAtual * 100) });
      continue;
    }

    // Preço precisa subir
    const precoSugerido = round2(custo_novo / (1 - margemMin));
    const margemResultante = (precoSugerido - custo_novo) / precoSugerido;

    const requerAprov = pol.modo_sugestao === "manual" || pol.exige_aprovacao_ceo;

    if (!requerAprov) {
      // Auto-aprovado
      const { data: aprov, error: errAp } = await supabase
        .from("fin_gc_price_aprovacoes")
        .insert({
          gc_produto_id,
          nome_produto: prod.nome,
          tipo_id: tipoId,
          modo_calculo: "completo",
          custo_referencia: custo_novo,
          preco_atual: precoAtual,
          preco_solicitado: precoSugerido,
          margem_resultante: margemResultante,
          margem_minima_politica: margemMin,
          justificativa: `Auto: custo subiu de ${body.custo_anterior ?? "?"} → ${custo_novo}, margem caiu para ${(margemAtual * 100).toFixed(2)}%`,
          status: "aprovado",
          decidido_em: new Date().toISOString(),
          decisao_observacao: "Auto-aprovado por política sugerir + !exige_aprov_ceo",
          payload: { source: "repricing-on-cost-change", custo_anterior: body.custo_anterior },
        })
        .select("id")
        .single();

      if (errAp) {
        skipped.push({ tipo_id: tipoId, motivo: "erro_aprovacao", erro: errAp.message });
        novosValores.push(entry);
        continue;
      }

      // History
      await supabase.from("fin_gc_price_history").insert({
        gc_produto_id,
        tipo_id: tipoId,
        preco_anterior: precoAtual,
        preco_novo: precoSugerido,
        margem_aplicada: margemResultante,
        source: "repricing-on-cost-change",
        motivo: "auto-ajuste por mudança de custo",
        aprovacao_id: aprov.id,
      });

      // Enqueue PUT to GC (rebuild full valores array)
      novosValores.push({ ...entry, valor_custo: custo_novo, valor_venda: precoSugerido });

      auto.push({
        tipo_id: tipoId,
        nome_tabela: pol.nome_tabela,
        preco_anterior: precoAtual,
        preco_novo: precoSugerido,
        margem_atual: round2(margemAtual * 100),
        margem_min: round2(margemMin * 100),
        aprovacao_id: aprov.id,
      });
    } else {
      // Aguardando aprovação CEO — preço NÃO muda
      novosValores.push(entry);

      const { data: aprov, error: errAp } = await supabase
        .from("fin_gc_price_aprovacoes")
        .insert({
          gc_produto_id,
          nome_produto: prod.nome,
          tipo_id: tipoId,
          modo_calculo: "completo",
          custo_referencia: custo_novo,
          preco_atual: precoAtual,
          preco_solicitado: precoSugerido,
          margem_resultante: margemResultante,
          margem_minima_politica: margemMin,
          justificativa: `Custo subiu para ${custo_novo}. Margem atual ${(margemAtual * 100).toFixed(2)}% < mínima ${(margemMin * 100).toFixed(2)}%. Aprovação CEO requerida.`,
          status: "pendente",
          payload: { source: "repricing-on-cost-change", custo_anterior: body.custo_anterior },
        })
        .select("id")
        .single();

      if (errAp) {
        skipped.push({ tipo_id: tipoId, motivo: "erro_aprovacao_pendente", erro: errAp.message });
        continue;
      }

      await supabase.from("fin_acoes_pendentes").insert({
        tipo: "aprovacao_preco",
        destinatario_role: "ceo",
        titulo: `Aprovar preço: ${prod.nome ?? gc_produto_id} - ${pol.nome_tabela}`,
        descricao: `Custo novo R$ ${custo_novo.toFixed(2)} | Preço atual R$ ${precoAtual.toFixed(2)} (margem ${(margemAtual * 100).toFixed(2)}%) | Preço sugerido R$ ${precoSugerido.toFixed(2)} (margem ${(margemResultante * 100).toFixed(2)}%, mínima ${(margemMin * 100).toFixed(2)}%)`,
        entidade_tipo: "fin_gc_price_aprovacoes",
        entidade_id: aprov.id,
        payload: {
          gc_produto_id,
          tipo_id: tipoId,
          nome_tabela: pol.nome_tabela,
          custo_novo,
          custo_anterior: body.custo_anterior,
          preco_atual: precoAtual,
          preco_sugerido: precoSugerido,
          margem_atual: margemAtual,
          margem_minima: margemMin,
          margem_resultante: margemResultante,
          aprovacao_id: aprov.id,
        },
      });

      pendentes.push({
        tipo_id: tipoId,
        nome_tabela: pol.nome_tabela,
        preco_atual: precoAtual,
        preco_sugerido: precoSugerido,
        aprovacao_id: aprov.id,
      });
    }
  }

  // If we made any auto changes, persist updated valores locally AND enqueue PUT to GC
  if (auto.length > 0) {
    // Update local snapshot (this UPDATE will re-fire the trigger? valor_custo unchanged → safe)
    await supabase
      .from("gc_produtos_cache")
      .update({ valores: novosValores, updated_at: new Date().toISOString() })
      .eq("produto_gc_id", gc_produto_id);

    // Enqueue write job to push to GC
    await supabase.from("fin_gc_write_jobs").insert({
      recurso: "produtos",
      recurso_id: gc_produto_id,
      payload: { valores: novosValores },
      payload_hash: `repricing-${gc_produto_id}-${Date.now()}`,
      status: "pendente",
    });

    // Informative action for CEO (does not block)
    await supabase.from("fin_acoes_pendentes").insert({
      tipo: "informativo_reprecificacao_auto",
      destinatario_role: "ceo",
      titulo: `Reprecificação automática: ${prod.nome ?? gc_produto_id}`,
      descricao: `${auto.length} tabela(s) ajustada(s) automaticamente após mudança de custo (${body.custo_anterior ?? "?"} → ${custo_novo}).`,
      entidade_tipo: "gc_produtos_cache",
      entidade_id: gc_produto_id,
      payload: { auto, custo_anterior: body.custo_anterior, custo_novo },
      status: "pendente",
    });
  }

  return new Response(
    JSON.stringify({
      ok: true,
      gc_produto_id,
      custo_anterior: body.custo_anterior,
      custo_novo,
      tabelas_avaliadas: valores.length,
      auto_ajustadas: auto.length,
      aguardando_ceo: pendentes.length,
      sem_acao: skipped.length,
      auto,
      pendentes,
      skipped,
    }),
    { headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
