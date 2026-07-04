// ══════════════════════════════════════════════════════════════
//  ratear-frete-compras
//  Detecta pedidos de compra de FRETE (campo customizado com
//  descrição contendo "FRETE" e "PEDIDO") e rateia o valor total
//  do frete entre os itens dos pedidos referenciados,
//  proporcionalmente ao valor_total de cada item.
//
//  Efeitos:
//   1) Cria/atualiza fin_frete_rateios (idempotente por frete_compra_gc_id)
//   2) Persiste detalhamento em fin_frete_rateio_itens
//   3) Aplica valor_frete_unit em fin_produto_tributos (delta seguro)
//   4) Enfileira fin_gc_write_jobs para atualizar custo médio no GC
// ══════════════════════════════════════════════════════════════
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

function stripAccents(s: string): string {
  return (s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function normDesc(s: string | null | undefined): string {
  return stripAccents(String(s || "")).toUpperCase().trim();
}

/** Detecta se um pedido é de FRETE olhando campos_extras[].extras.descricao */
function extrairConteudoFrete(payload: any): { descricao: string; conteudo: string } | null {
  const extras = payload?.Compra?.campos_extras;
  if (!Array.isArray(extras)) return null;
  for (const w of extras) {
    const e = w?.extras || w;
    const desc = normDesc(e?.descricao);
    if (desc.includes("FRETE") && desc.includes("PEDIDO")) {
      const conteudo = String(e?.conteudo || "").trim();
      if (conteudo) return { descricao: e.descricao, conteudo };
    }
  }
  return null;
}

/** Extrai códigos separados por vírgula, ponto-e-vírgula, espaço, barra */
function parseCodigos(raw: string): string[] {
  return raw
    .split(/[,;\s\/|]+/)
    .map((s) => s.replace(/[^0-9A-Za-z\-]/g, "").trim())
    .filter((s) => s.length > 0);
}

interface FreteItem {
  compra_gc_id: string;
  compra_codigo: string;
  produto_gc_id: string | null;
  nome_produto: string;
  quantidade: number;
  item_valor_total: number;
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const inicio = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    const body = await req.json().catch(() => ({}));
    const dataInicio: string | undefined = body.data_inicio;
    const dataFim: string | undefined = body.data_fim;
    const compraCodigosFilter: string[] = Array.isArray(body.compra_codigos)
      ? body.compra_codigos.map(String)
      : [];
    const forceReapply: boolean = body.force === true;
    const dryRun: boolean = body.dry_run === true;
    const enqueueGcCost: boolean = body.enqueue_gc_cost !== false; // default true

    // ── 1) Carrega candidatos de frete ──
    let q = supabase
      .from("gc_compras")
      .select("gc_id, codigo, data, valor_total, valor_produtos, gc_payload_raw");
    if (dataInicio) q = q.gte("data", dataInicio);
    if (dataFim) q = q.lte("data", dataFim);
    if (compraCodigosFilter.length > 0) q = q.in("codigo", compraCodigosFilter);

    // paginação
    const candidatas: any[] = [];
    const pageSize = 500;
    let from = 0;
    while (true) {
      const { data, error } = await q.range(from, from + pageSize - 1);
      if (error) throw new Error(`select gc_compras: ${error.message}`);
      if (!data || data.length === 0) break;
      candidatas.push(...data);
      if (data.length < pageSize) break;
      from += pageSize;
    }

    // Filtra apenas as que possuem campo FRETE preenchido
    const fretesDetectados = candidatas
      .map((c) => {
        const info = extrairConteudoFrete(c.gc_payload_raw);
        return info ? { compra: c, info } : null;
      })
      .filter(Boolean) as { compra: any; info: { descricao: string; conteudo: string } }[];

    if (fretesDetectados.length === 0) {
      return new Response(
        JSON.stringify({
          ok: true,
          fretes_detectados: 0,
          fretes_processados: 0,
          message: "Nenhum pedido de frete no período (campo com 'FRETE' + 'PEDIDO')",
          tempo_ms: Date.now() - inicio,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    // ── 2) Idempotência: pega rateios já aplicados ──
    const freteIds = fretesDetectados.map((f) => String(f.compra.gc_id));
    const { data: jaAplicados } = await supabase
      .from("fin_frete_rateios")
      .select("frete_compra_gc_id, status, applied_at")
      .in("frete_compra_gc_id", freteIds);
    const setAplicados = new Set(
      (jaAplicados || [])
        .filter((r: any) => r.status === "aplicado")
        .map((r: any) => String(r.frete_compra_gc_id)),
    );

    const resultados: any[] = [];
    let totalRateado = 0;
    let processados = 0;
    let ignoradosJa = 0;

    for (const { compra, info } of fretesDetectados) {
      const freteGcId = String(compra.gc_id);
      const freteCodigo = String(compra.codigo || "");
      const freteValor = Number(compra.valor_total) || Number(compra.valor_produtos) || 0;

      if (freteValor <= 0) {
        resultados.push({
          frete_codigo: freteCodigo,
          status: "ignorado_valor_zero",
          detalhe: "valor_total do frete é 0",
        });
        continue;
      }

      if (setAplicados.has(freteGcId) && !forceReapply) {
        ignoradosJa++;
        resultados.push({
          frete_codigo: freteCodigo,
          status: "ja_aplicado",
          detalhe: "use force=true para reaplicar",
        });
        continue;
      }

      const refsCodigos = parseCodigos(info.conteudo);
      if (refsCodigos.length === 0) {
        resultados.push({
          frete_codigo: freteCodigo,
          status: "sem_referencias",
          detalhe: `campo "${info.descricao}" sem códigos válidos`,
        });
        continue;
      }

      // Busca as compras referenciadas
      const { data: refCompras } = await supabase
        .from("gc_compras")
        .select("gc_id, codigo")
        .in("codigo", refsCodigos);
      const encontrados = new Map<string, string>(); // codigo -> gc_id
      for (const r of refCompras || []) encontrados.set(String(r.codigo), String(r.gc_id));
      const faltantes = refsCodigos.filter((c) => !encontrados.has(c));
      const refsGcIds = [...encontrados.values()];

      if (refsGcIds.length === 0) {
        resultados.push({
          frete_codigo: freteCodigo,
          status: "refs_nao_encontradas",
          detalhe: `códigos não encontrados: ${refsCodigos.join(", ")}`,
        });
        continue;
      }

      // Carrega itens de todas as compras referenciadas
      const { data: itensRaw } = await supabase
        .from("gc_compras_itens")
        .select("compra_gc_id, produto_gc_id, nome_produto, quantidade, valor_total")
        .in("compra_gc_id", refsGcIds);

      const codigoPorGcId = new Map<string, string>();
      for (const [codigo, gcId] of encontrados) codigoPorGcId.set(gcId, codigo);

      const itens: FreteItem[] = (itensRaw || []).map((it: any) => ({
        compra_gc_id: String(it.compra_gc_id),
        compra_codigo: codigoPorGcId.get(String(it.compra_gc_id)) || "",
        produto_gc_id: it.produto_gc_id ? String(it.produto_gc_id) : null,
        nome_produto: it.nome_produto || "",
        quantidade: Number(it.quantidade) || 0,
        item_valor_total: Number(it.valor_total) || 0,
      }));

      const pool = itens.reduce((s, i) => s + i.item_valor_total, 0);
      if (pool <= 0) {
        resultados.push({
          frete_codigo: freteCodigo,
          status: "pool_zero",
          detalhe: "soma dos valores dos itens referenciados é 0",
        });
        continue;
      }

      // Rateio proporcional ao valor_total do item
      // usa centavos para minimizar drift e joga o resto no último item
      const freteCentavos = Math.round(freteValor * 100);
      const alocados: number[] = new Array(itens.length).fill(0);
      let somaAlocada = 0;
      for (let i = 0; i < itens.length; i++) {
        const share = Math.floor((itens[i].item_valor_total / pool) * freteCentavos);
        alocados[i] = share;
        somaAlocada += share;
      }
      const resto = freteCentavos - somaAlocada;
      if (itens.length > 0) alocados[alocados.length - 1] += resto;

      const itensRateio = itens.map((it, i) => {
        const rateioValor = alocados[i] / 100;
        const rateioUnit = it.quantidade > 0 ? rateioValor / it.quantidade : 0;
        return {
          ...it,
          rateio_valor: Math.round(rateioValor * 10000) / 10000,
          rateio_unit: Math.round(rateioUnit * 1000000) / 1000000,
        };
      });

      if (dryRun) {
        resultados.push({
          frete_codigo: freteCodigo,
          status: "dry_run",
          frete_valor: freteValor,
          pool_valor: pool,
          itens: itensRateio.length,
          faltantes,
        });
        processados++;
        totalRateado += freteValor;
        continue;
      }

      // ── Reverter aplicação anterior se force ──
      if (setAplicados.has(freteGcId) && forceReapply) {
        const { data: rateioAntigo } = await supabase
          .from("fin_frete_rateios")
          .select("id")
          .eq("frete_compra_gc_id", freteGcId)
          .maybeSingle();
        if (rateioAntigo?.id) {
          const { data: itensAntigos } = await supabase
            .from("fin_frete_rateio_itens")
            .select("compra_gc_id, produto_gc_id, rateio_unit, aplicado_em_tributos")
            .eq("rateio_id", rateioAntigo.id);
          for (const ia of itensAntigos || []) {
            if (!ia.aplicado_em_tributos || !ia.produto_gc_id) continue;
            // subtrai delta anterior
            const { data: trib } = await supabase
              .from("fin_produto_tributos")
              .select("id, valor_frete_unit, custo_efetivo_unit, excecao_manual")
              .eq("compra_gc_id", ia.compra_gc_id)
              .eq("gc_produto_id", ia.produto_gc_id)
              .maybeSingle();
            if (trib && !trib.excecao_manual) {
              const novoFrete = Math.max(0, Number(trib.valor_frete_unit || 0) - Number(ia.rateio_unit || 0));
              const novoCusto = Math.max(0, Number(trib.custo_efetivo_unit || 0) - Number(ia.rateio_unit || 0));
              await supabase
                .from("fin_produto_tributos")
                .update({ valor_frete_unit: novoFrete, custo_efetivo_unit: novoCusto })
                .eq("id", trib.id);
            }
          }
          await supabase.from("fin_frete_rateio_itens").delete().eq("rateio_id", rateioAntigo.id);
          await supabase.from("fin_frete_rateios").delete().eq("id", rateioAntigo.id);
        }
      }

      // ── Persiste cabeçalho ──
      const { data: cab, error: cabErr } = await supabase
        .from("fin_frete_rateios")
        .insert({
          frete_compra_gc_id: freteGcId,
          frete_compra_codigo: freteCodigo,
          frete_valor_total: freteValor,
          frete_data: compra.data,
          refs_codigos: refsCodigos,
          refs_gc_ids: refsGcIds,
          refs_encontrados: refsGcIds.length,
          refs_faltantes: faltantes,
          pool_valor: Math.round(pool * 100) / 100,
          itens_impactados: itensRateio.length,
          status: "aplicado",
          observacao: info.descricao,
        })
        .select("id")
        .single();
      if (cabErr) {
        resultados.push({ frete_codigo: freteCodigo, status: "erro_insert_cab", detalhe: cabErr.message });
        continue;
      }

      // ── Insere itens ──
      const rowsItens = itensRateio.map((r) => ({
        rateio_id: cab.id,
        compra_gc_id: r.compra_gc_id,
        compra_codigo: r.compra_codigo,
        produto_gc_id: r.produto_gc_id,
        nome_produto: r.nome_produto,
        quantidade: r.quantidade,
        item_valor_total: r.item_valor_total,
        rateio_valor: r.rateio_valor,
        rateio_unit: r.rateio_unit,
        aplicado_em_tributos: false,
      }));
      if (rowsItens.length > 0) {
        const { error: itErr } = await supabase.from("fin_frete_rateio_itens").insert(rowsItens);
        if (itErr) {
          resultados.push({ frete_codigo: freteCodigo, status: "erro_insert_itens", detalhe: itErr.message });
          continue;
        }
      }

      // ── Aplica em fin_produto_tributos (delta) ──
      let aplicadosTrib = 0;
      let semTrib = 0;
      let excecaoBloqueou = 0;
      for (const r of itensRateio) {
        if (!r.produto_gc_id || r.rateio_unit <= 0) continue;
        const { data: trib } = await supabase
          .from("fin_produto_tributos")
          .select("id, valor_frete_unit, custo_efetivo_unit, excecao_manual")
          .eq("compra_gc_id", r.compra_gc_id)
          .eq("gc_produto_id", r.produto_gc_id)
          .maybeSingle();
        if (!trib) {
          semTrib++;
          continue;
        }
        if (trib.excecao_manual) {
          excecaoBloqueou++;
          continue;
        }
        const novoFrete = Number(trib.valor_frete_unit || 0) + r.rateio_unit;
        const novoCusto = Number(trib.custo_efetivo_unit || 0) + r.rateio_unit;
        await supabase
          .from("fin_produto_tributos")
          .update({ valor_frete_unit: novoFrete, custo_efetivo_unit: novoCusto, ultima_atualizacao: new Date().toISOString() })
          .eq("id", trib.id);
        await supabase
          .from("fin_frete_rateio_itens")
          .update({ aplicado_em_tributos: true })
          .eq("rateio_id", cab.id)
          .eq("compra_gc_id", r.compra_gc_id)
          .eq("produto_gc_id", r.produto_gc_id);
        aplicadosTrib++;
      }

      // ── Enfileira atualização de custo médio no GC ──
      let enqueuedGc = 0;
      if (enqueueGcCost) {
        // Agrupa por produto_gc_id somando rateio_valor e quantidade para custo médio simples
        const acc = new Map<string, { rateio_total: number; qtd_total: number; nome: string }>();
        for (const r of itensRateio) {
          if (!r.produto_gc_id) continue;
          const cur = acc.get(r.produto_gc_id) || { rateio_total: 0, qtd_total: 0, nome: r.nome_produto };
          cur.rateio_total += r.rateio_valor;
          cur.qtd_total += r.quantidade;
          acc.set(r.produto_gc_id, cur);
        }
        for (const [produtoId, agg] of acc) {
          if (agg.qtd_total <= 0) continue;
          const incUnit = agg.rateio_total / agg.qtd_total;
          const payload = {
            produto_gc_id: produtoId,
            nome_produto: agg.nome,
            incremento_custo_unit: Math.round(incUnit * 10000) / 10000,
            origem: "rateio_frete",
            frete_compra_codigo: freteCodigo,
            frete_compra_gc_id: freteGcId,
          };
          const payloadHash = `frete:${freteGcId}:${produtoId}`;
          await supabase
            .from("fin_gc_write_jobs")
            .upsert(
              {
                recurso: "produto_custo_incremento",
                recurso_id: produtoId,
                payload,
                payload_hash: payloadHash,
                status: "pending",
              },
              { onConflict: "payload_hash" },
            );
          enqueuedGc++;
        }
      }

      processados++;
      totalRateado += freteValor;
      resultados.push({
        frete_codigo: freteCodigo,
        frete_valor: freteValor,
        pool_valor: Math.round(pool * 100) / 100,
        refs_encontradas: refsGcIds.length,
        refs_faltantes: faltantes,
        itens: itensRateio.length,
        aplicados_em_tributos: aplicadosTrib,
        sem_tributo_ainda: semTrib,
        bloqueados_excecao: excecaoBloqueou,
        gc_jobs_enfileirados: enqueuedGc,
        status: "aplicado",
      });
    }

    return new Response(
      JSON.stringify({
        ok: true,
        fretes_detectados: fretesDetectados.length,
        fretes_processados: processados,
        ja_aplicados_ignorados: ignoradosJa,
        total_rateado: Math.round(totalRateado * 100) / 100,
        resultados,
        tempo_ms: Date.now() - inicio,
      }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (err) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        tempo_ms: Date.now() - inicio,
      }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
