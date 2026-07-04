// ══════════════════════════════════════════════════════════════
//  ratear-frete-compras
//  Detecta pedidos de FRETE em compras de produto ou serviço (campo customizado com
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

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
let lastGcCallTime = 0;

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

function compraPayload(raw: any): any {
  return raw?.Compra ?? raw?.compra ?? raw ?? {};
}

function compraNomeSituacao(raw: any): string {
  const c = compraPayload(raw);
  return String(c?.nome_situacao ?? c?.situacao_nome ?? c?.status ?? c?.situacao ?? "").trim();
}

function compraEstaCancelada(raw: any): boolean {
  return normDesc(compraNomeSituacao(raw)).includes("CANCEL");
}

async function rateLimitedGcFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastGcCallTime;
  if (elapsed < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  lastGcCallTime = Date.now();
  return fetch(url, options);
}

async function buscarCompraAtualNoGc(
  compraGcId: string,
  gcHeaders: Record<string, string>,
): Promise<{ ok: boolean; encontrada: boolean; cancelada: boolean; nome_situacao: string; erro?: string }> {
  try {
    const resp = await rateLimitedGcFetch(`${GC_BASE_URL}/api/compras/${compraGcId}`, { headers: gcHeaders });
    if (resp.status === 404) return { ok: true, encontrada: false, cancelada: true, nome_situacao: "não encontrada" };
    if (!resp.ok) return { ok: false, encontrada: false, cancelada: false, nome_situacao: "", erro: `HTTP ${resp.status}` };
    const json = await resp.json();
    const rawData = json?.data?.data ?? json?.data ?? null;
    const compra = compraPayload(rawData);
    const nomeSituacao = compraNomeSituacao(compra);
    return {
      ok: true,
      encontrada: !!compra && typeof compra === "object" && Object.keys(compra).length > 0,
      cancelada: compraEstaCancelada(compra),
      nome_situacao: nomeSituacao,
    };
  } catch (err) {
    return { ok: false, encontrada: false, cancelada: false, nome_situacao: "", erro: err instanceof Error ? err.message : String(err) };
  }
}

async function cancelarRateiosDoFrete(
  supabase: any,
  freteCompraGcId: string,
  motivo: string,
): Promise<number> {
  const { data: rateios } = await supabase
    .from("fin_frete_rateios")
    .select("id, observacao")
    .eq("frete_compra_gc_id", freteCompraGcId)
    .is("reverted_at", null);

  let revertidos = 0;
  for (const rateio of rateios || []) {
    const { data: itensAntigos } = await supabase
      .from("fin_frete_rateio_itens")
      .select("compra_gc_id, produto_gc_id, rateio_unit, aplicado_em_tributos")
      .eq("rateio_id", rateio.id);

    for (const ia of itensAntigos || []) {
      if (!ia.aplicado_em_tributos || !ia.produto_gc_id) continue;
      const { data: trib } = await supabase
        .from("fin_produto_tributos")
        .select("id, valor_frete_unit, custo_efetivo_unit, excecao_manual")
        .eq("compra_gc_id", ia.compra_gc_id)
        .eq("gc_produto_id", ia.produto_gc_id)
        .maybeSingle();
      if (!trib || trib.excecao_manual) continue;

      const novoFrete = Math.max(0, Number(trib.valor_frete_unit || 0) - Number(ia.rateio_unit || 0));
      const novoCusto = Math.max(0, Number(trib.custo_efetivo_unit || 0) - Number(ia.rateio_unit || 0));
      await supabase
        .from("fin_produto_tributos")
        .update({ valor_frete_unit: novoFrete, custo_efetivo_unit: novoCusto, ultima_atualizacao: new Date().toISOString() })
        .eq("id", trib.id);
    }

    await supabase
      .from("fin_frete_rateios")
      .update({
        status: "revertido_cancelado",
        reverted_at: new Date().toISOString(),
        observacao: `${rateio.observacao || ""} | ${motivo}`.trim(),
      })
      .eq("id", rateio.id);
    revertidos++;
  }

  const { data: jobs } = await supabase
    .from("fin_gc_write_jobs")
    .select("id")
    .contains("payload", { frete_compra_gc_id: freteCompraGcId })
    .in("status", ["pendente", "erro_retentavel"]);
  const jobIds = (jobs || []).map((j: any) => j.id).filter(Boolean);
  if (jobIds.length > 0) await supabase.from("fin_gc_write_jobs").delete().in("id", jobIds);

  return revertidos;
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
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const gcHeaders: Record<string, string> | null = gcAccessToken && gcSecretToken
      ? {
        "access-token": gcAccessToken,
        "secret-access-token": gcSecretToken,
        "Content-Type": "application/json",
      }
      : null;

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
    // Usa gc_compras já sincronizada; essa base precisa conter tanto pedidos de
    // produto quanto pedidos de serviço, pois o frete pode estar lançado como serviço.
    let q = supabase
      .from("gc_compras")
      .select("gc_id, codigo, data, valor_total, valor_produtos, valor_frete, gc_payload_raw");
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
    // Conjunto global de compras referenciadas por algum pedido de frete externo.
    // Usado no Pass 2 para NÃO ratear novamente o valor_frete embutido dessas compras
    // (frete deve vir de uma fonte única).
    const refsCobertasPorExterno = new Set<string>();
    const conflitosFreteGlobal: any[] = [];

    // Limpeza preventiva: rateios já aplicados cujo pedido de frete foi cancelado/removido no GC
    // não podem continuar aparecendo nem compondo custo.
    if (gcHeaders) {
      let rq = supabase
        .from("fin_frete_rateios")
        .select("frete_compra_gc_id, frete_compra_codigo, frete_data")
        .is("reverted_at", null)
        .eq("status", "aplicado");
      if (dataInicio) rq = rq.gte("frete_data", dataInicio);
      if (dataFim) rq = rq.lte("frete_data", dataFim);
      const { data: rateiosAtivos } = await rq.limit(300);
      const vistos = new Set<string>();
      for (const r of rateiosAtivos || []) {
        const freteId = String(r.frete_compra_gc_id || "");
        if (!freteId || vistos.has(freteId)) continue;
        vistos.add(freteId);
        const atual = await buscarCompraAtualNoGc(freteId, gcHeaders);
        if (atual.ok && (!atual.encontrada || atual.cancelada)) {
          const revertidos = await cancelarRateiosDoFrete(
            supabase,
            freteId,
            `pedido de frete cancelado/removido no GC (${atual.nome_situacao || "sem situação"})`,
          );
          resultados.push({
            frete_codigo: String(r.frete_compra_codigo || freteId),
            status: "revertido_frete_cancelado",
            rateios_revertidos: revertidos,
            situacao_gc: atual.nome_situacao,
          });
        }
      }
    }


    for (const { compra, info } of fretesDetectados) {
      const freteGcId = String(compra.gc_id);
      const freteCodigo = String(compra.codigo || "");
      const freteValor = Number(compra.valor_total) || Number(compra.valor_produtos) || 0;

      if (compraEstaCancelada(compra.gc_payload_raw)) {
        const revertidos = await cancelarRateiosDoFrete(supabase, freteGcId, "pedido de frete cancelado na base local");
        resultados.push({ frete_codigo: freteCodigo, status: "ignorado_frete_cancelado", rateios_revertidos: revertidos });
        continue;
      }

      if (gcHeaders) {
        const atual = await buscarCompraAtualNoGc(freteGcId, gcHeaders);
        if (!atual.ok) {
          resultados.push({ frete_codigo: freteCodigo, status: "ignorado_validacao_gc_falhou", detalhe: atual.erro });
          continue;
        }
        if (!atual.encontrada || atual.cancelada) {
          const revertidos = await cancelarRateiosDoFrete(
            supabase,
            freteGcId,
            `pedido de frete cancelado/removido no GC (${atual.nome_situacao || "sem situação"})`,
          );
          resultados.push({
            frete_codigo: freteCodigo,
            status: "ignorado_frete_cancelado_gc",
            situacao_gc: atual.nome_situacao,
            rateios_revertidos: revertidos,
          });
          continue;
        }
      }

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

      // Busca as compras referenciadas (inclui valor_frete p/ detectar conflito)
      const { data: refCompras } = await supabase
        .from("gc_compras")
        .select("gc_id, codigo, valor_frete, nome_situacao, gc_payload_raw")
        .in("codigo", refsCodigos);
      const encontrados = new Map<string, string>(); // codigo -> gc_id
      const refValorFrete = new Map<string, number>(); // gc_id -> valor_frete embutido
      const refsCanceladas: string[] = [];
      for (const r of refCompras || []) {
        if (compraEstaCancelada(r) || compraEstaCancelada(r.gc_payload_raw)) {
          refsCanceladas.push(String(r.codigo));
          continue;
        }
        encontrados.set(String(r.codigo), String(r.gc_id));
        refValorFrete.set(String(r.gc_id), Number(r.valor_frete || 0));
      }
      const faltantes = refsCodigos.filter((c) => !encontrados.has(c));
      const refsGcIds = [...encontrados.values()];

      if (refsGcIds.length === 0) {
        resultados.push({
          frete_codigo: freteCodigo,
          status: "refs_nao_encontradas",
          detalhe: `códigos não encontrados/cancelados: ${refsCodigos.join(", ")}`,
          refs_canceladas: refsCanceladas,
        });
        continue;
      }

      // Marca refs como cobertas por frete externo (bloqueia pass 2 embutido)
      for (const rid of refsGcIds) refsCobertasPorExterno.add(rid);

      // Detecta conflito: refs que já possuem valor_frete embutido no próprio pedido
      const conflitosLocais: { compra_codigo: string; gc_id: string; valor_frete_embutido: number }[] = [];
      for (const [codigo, gcId] of encontrados) {
        const vf = refValorFrete.get(gcId) || 0;
        if (vf > 0) {
          conflitosLocais.push({ compra_codigo: codigo, gc_id: gcId, valor_frete_embutido: vf });
          conflitosFreteGlobal.push({
            frete_externo_codigo: freteCodigo,
            compra_com_frete_embutido: codigo,
            valor_frete_embutido: vf,
          });
        }
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
          conflitos_frete_embutido: conflitosLocais,
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
                status: "pendente",
              },
              { onConflict: "recurso,recurso_id,payload_hash" },
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
        conflitos_frete_embutido: conflitosLocais,
        aviso: conflitosLocais.length > 0
          ? `ATENÇÃO: ${conflitosLocais.length} pedido(s) referenciado(s) já possuem valor_frete embutido no próprio pedido. O frete embutido foi IGNORADO — mantida apenas a fonte externa (${freteCodigo}). Corrija no GC removendo o frete duplicado.`
          : undefined,
        status: "aplicado",
      });
    }

    // ══════════════════════════════════════════════════════════════
    // ── Pass 2: FRETE EMBUTIDO no próprio pedido de compra ──
    // gc_compras.valor_frete > 0 → rateia esse valor entre os itens
    // da própria compra, proporcional ao valor_total de cada item.
    // Idempotência: usa frete_compra_gc_id = gc_id da compra e
    // observacao = "VALOR_FRETE_EMBUTIDO" para distinguir do pass 1.
    //
    // REGRA: se a compra já é coberta por um pedido de frete externo
    // (está em refsCobertasPorExterno), NÃO rateia o embutido — evita
    // duplicidade. Frete deve vir de uma fonte apenas.
    // ══════════════════════════════════════════════════════════════
    const setFreteExterno = new Set(fretesDetectados.map((f) => String(f.compra.gc_id)));
    const embutidasBrutas = candidatas.filter(
      (c) => Number(c.valor_frete || 0) > 0 && !setFreteExterno.has(String(c.gc_id)),
    );
    const embutidasBloqueadasPorExterno: any[] = [];
    const embutidas = embutidasBrutas.filter((c) => {
      if (refsCobertasPorExterno.has(String(c.gc_id))) {
        embutidasBloqueadasPorExterno.push({
          frete_codigo: String(c.codigo || ""),
          gc_id: String(c.gc_id),
          valor_frete_embutido: Number(c.valor_frete || 0),
          status: "bloqueado_frete_ja_coberto_por_pedido_externo",
          aviso: "Este pedido já recebe rateio de um pedido de frete externo; o valor_frete embutido foi ignorado para evitar duplicidade.",
        });
        return false;
      }
      return true;
    });
    resultados.push(...embutidasBloqueadasPorExterno);


    let embutidasProcessadas = 0;
    let embutidasIgnoradas = 0;

    if (embutidas.length > 0) {
      const embIds = embutidas.map((c) => String(c.gc_id));
      const { data: jaAplEmb } = await supabase
        .from("fin_frete_rateios")
        .select("frete_compra_gc_id, observacao")
        .in("frete_compra_gc_id", embIds)
        .eq("observacao", "VALOR_FRETE_EMBUTIDO");
      const setEmbAplicados = new Set(
        (jaAplEmb || []).map((r: any) => String(r.frete_compra_gc_id)),
      );

      for (const compra of embutidas) {
        const compraGcId = String(compra.gc_id);
        const compraCodigo = String(compra.codigo || "");
        const freteValor = Number(compra.valor_frete) || 0;

        if (setEmbAplicados.has(compraGcId) && !forceReapply) {
          embutidasIgnoradas++;
          resultados.push({
            frete_codigo: compraCodigo,
            status: "ja_aplicado_embutido",
            detalhe: "valor_frete embutido; use force=true para reaplicar",
          });
          continue;
        }

        const { data: itensRaw } = await supabase
          .from("gc_compras_itens")
          .select("compra_gc_id, produto_gc_id, nome_produto, quantidade, valor_total")
          .eq("compra_gc_id", compraGcId);

        const itens: FreteItem[] = (itensRaw || []).map((it: any) => ({
          compra_gc_id: String(it.compra_gc_id),
          compra_codigo: compraCodigo,
          produto_gc_id: it.produto_gc_id ? String(it.produto_gc_id) : null,
          nome_produto: it.nome_produto || "",
          quantidade: Number(it.quantidade) || 0,
          item_valor_total: Number(it.valor_total) || 0,
        }));

        const pool = itens.reduce((s, i) => s + i.item_valor_total, 0);
        if (pool <= 0 || itens.length === 0) {
          resultados.push({
            frete_codigo: compraCodigo,
            status: "pool_zero_embutido",
            detalhe: "sem itens ou pool zero",
          });
          continue;
        }

        const freteCentavos = Math.round(freteValor * 100);
        const alocados: number[] = new Array(itens.length).fill(0);
        let somaAlocada = 0;
        for (let i = 0; i < itens.length; i++) {
          const share = Math.floor((itens[i].item_valor_total / pool) * freteCentavos);
          alocados[i] = share;
          somaAlocada += share;
        }
        alocados[alocados.length - 1] += freteCentavos - somaAlocada;

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
            frete_codigo: compraCodigo,
            status: "dry_run_embutido",
            frete_valor: freteValor,
            pool_valor: pool,
            itens: itensRateio.length,
          });
          embutidasProcessadas++;
          totalRateado += freteValor;
          continue;
        }

        // Reverter aplicação anterior se force
        if (setEmbAplicados.has(compraGcId) && forceReapply) {
          const { data: rateioAntigo } = await supabase
            .from("fin_frete_rateios")
            .select("id")
            .eq("frete_compra_gc_id", compraGcId)
            .eq("observacao", "VALOR_FRETE_EMBUTIDO")
            .maybeSingle();
          if (rateioAntigo?.id) {
            const { data: itensAntigos } = await supabase
              .from("fin_frete_rateio_itens")
              .select("compra_gc_id, produto_gc_id, rateio_unit, aplicado_em_tributos")
              .eq("rateio_id", rateioAntigo.id);
            for (const ia of itensAntigos || []) {
              if (!ia.aplicado_em_tributos || !ia.produto_gc_id) continue;
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

        const { data: cab, error: cabErr } = await supabase
          .from("fin_frete_rateios")
          .insert({
            frete_compra_gc_id: compraGcId,
            frete_compra_codigo: compraCodigo,
            frete_valor_total: freteValor,
            frete_data: compra.data,
            refs_codigos: [compraCodigo],
            refs_gc_ids: [compraGcId],
            refs_encontrados: 1,
            refs_faltantes: [],
            pool_valor: Math.round(pool * 100) / 100,
            itens_impactados: itensRateio.length,
            status: "aplicado",
            observacao: "VALOR_FRETE_EMBUTIDO",
          })
          .select("id")
          .single();
        if (cabErr) {
          resultados.push({ frete_codigo: compraCodigo, status: "erro_insert_cab_embutido", detalhe: cabErr.message });
          continue;
        }

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
            resultados.push({ frete_codigo: compraCodigo, status: "erro_insert_itens_embutido", detalhe: itErr.message });
            continue;
          }
        }

        let aplicadosTrib = 0;
        for (const r of itensRateio) {
          if (!r.produto_gc_id || r.rateio_unit <= 0) continue;
          const { data: trib } = await supabase
            .from("fin_produto_tributos")
            .select("id, valor_frete_unit, custo_efetivo_unit, excecao_manual")
            .eq("compra_gc_id", r.compra_gc_id)
            .eq("gc_produto_id", r.produto_gc_id)
            .maybeSingle();
          if (!trib || trib.excecao_manual) continue;
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

        let enqueuedGc = 0;
        if (enqueueGcCost) {
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
              origem: "rateio_frete_embutido",
              frete_compra_codigo: compraCodigo,
              frete_compra_gc_id: compraGcId,
            };
            const payloadHash = `frete_emb:${compraGcId}:${produtoId}`;
            await supabase
              .from("fin_gc_write_jobs")
              .upsert(
                {
                  recurso: "produto_custo_incremento",
                  recurso_id: produtoId,
                  payload,
                  payload_hash: payloadHash,
                  status: "pendente",
                },
                { onConflict: "recurso,recurso_id,payload_hash" },
              );
            enqueuedGc++;
          }
        }

        embutidasProcessadas++;
        totalRateado += freteValor;
        resultados.push({
          frete_codigo: compraCodigo,
          frete_valor: freteValor,
          pool_valor: Math.round(pool * 100) / 100,
          itens: itensRateio.length,
          aplicados_em_tributos: aplicadosTrib,
          gc_jobs_enfileirados: enqueuedGc,
          status: "aplicado_embutido",
        });
      }
    }

    return new Response(
      JSON.stringify({
        ok: true,
        fretes_detectados: fretesDetectados.length,
        fretes_processados: processados,
        ja_aplicados_ignorados: ignoradosJa,
        frete_embutido_detectado: embutidas.length,
        frete_embutido_processado: embutidasProcessadas,
        frete_embutido_ignorado: embutidasIgnoradas,
        frete_embutido_bloqueado_por_externo: embutidasBloqueadasPorExterno.length,
        conflitos_frete_duplicado: conflitosFreteGlobal,
        aviso_geral: conflitosFreteGlobal.length > 0 || embutidasBloqueadasPorExterno.length > 0
          ? `⚠️ Detectados ${conflitosFreteGlobal.length + embutidasBloqueadasPorExterno.length} caso(s) de frete duplicado (pedido tem frete embutido E está amarrado por outro pedido de frete). O frete embutido foi ignorado — corrija no GC removendo a duplicidade.`
          : undefined,
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
