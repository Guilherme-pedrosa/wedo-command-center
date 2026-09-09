import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
let lastCallTime = 0;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(supabaseUrl, supabaseKey);
    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    // ── Modo degradado: qualquer falha de leitura do GC (429/500/503/timeout/
    // JSON inesperado) NUNCA pode mudar o estado dos passivos locais. ──
    let degradado = false;
    const falhas: string[] = [];
    const marcarDegradado = (motivo: string) => {
      degradado = true;
      if (falhas.length < 20) falhas.push(motivo);
      console.error(`[scan-passivos] DEGRADADO: ${motivo}`);
    };

    const now = new Date();
    const dataInicio = new Date(now.getFullYear(), now.getMonth() - 6, 1)
      .toISOString().slice(0, 10);
    const dataFim = new Date(now.getFullYear(), now.getMonth() + 12, 0)
      .toISOString().slice(0, 10);

    let page = 1;
    let totalPages = 1;
    const found: Array<{
      gc_recebimento_id: string;
      gc_codigo: string | null;
      descricao: string;
      valor: number;
      data_vencimento: string;
      cliente_id: string;
      nome_cliente: string;
      negociacao_numero: number | null;
      os_codigos: string[];
      aberto: boolean;
      liquidado: boolean;
      cancelado: boolean;
    }> = [];

    while (page <= totalPages) {
      const params = new URLSearchParams({
        limite: "100",
        pagina: String(page),
        data_inicio: dataInicio,
        data_fim: dataFim,
      });

      let resp: Response;
      try {
        resp = await rateLimitedFetch(
          `${GC_BASE_URL}/api/recebimentos?${params.toString()}`,
          { headers: gcHeaders }
        );
      } catch (err) {
        marcarDegradado(`falha de rede na página ${page}: ${(err as Error).message}`);
        break;
      }

      if (resp.status === 429 || resp.status === 500 || resp.status === 503) {
        // Uma tentativa de backoff; persistindo, entra em modo degradado.
        await new Promise((r) => setTimeout(r, 3000));
        let retry: Response | null = null;
        try {
          retry = await rateLimitedFetch(
            `${GC_BASE_URL}/api/recebimentos?${params.toString()}`,
            { headers: gcHeaders }
          );
        } catch { retry = null; }
        if (!retry || !retry.ok) {
          marcarDegradado(`GC ${resp.status} na página ${page} (retry falhou)`);
          break;
        }
        resp = retry;
      }

      if (!resp.ok) {
        marcarDegradado(`GC ${resp.status} na página ${page}`);
        break;
      }

      let data: any;
      try {
        data = await resp.json();
      } catch (err) {
        marcarDegradado(`JSON inesperado na página ${page}: ${(err as Error).message}`);
        break;
      }

      if (!data || !Array.isArray(data?.data)) {
        marcarDegradado(`resposta sem lista de dados na página ${page}`);
        break;
      }

      const records = data.data;
      totalPages = data?.meta?.total_paginas || 1;

      for (const item of records) {
        const rec = item?.Recebimento || item?.recebimento || item;
        const descricao = String(rec?.descricao || "").trim();
        const descUpper = descricao.toUpperCase();

        const recId = String(rec?.id || "").trim();
        if (!recId) continue;

        const valor = parseFloat(String(rec?.valor || rec?.valor_total || "0").replace(",", ".")) || 0;
        if (valor <= 0) continue;

        const dataVencimento = String(rec?.data_vencimento || "").slice(0, 10);
        const clienteId = String(rec?.cliente_id || "").trim();
        const nomeCliente = String(rec?.nome_cliente || "").trim();
        const codigo = rec?.codigo ? String(rec.codigo) : null;

        const parcelMatch = descricao.match(/\((\d+)\/(\d+)\)/);
        const isLegacyPassive = !!parcelMatch && Number(parcelMatch[2]) > 1 && Number(parcelMatch[1]) === Number(parcelMatch[2]);
        const isExNegPassive = /ex[-\s]?neg\.?\s*\d+/i.test(descricao);
        const isPassive = descUpper.includes("PASSIVO") || isLegacyPassive || isExNegPassive;
        if (!isPassive) continue;

        const situacao = String(rec?.situacao_nome || rec?.situacao || "").toLowerCase();
        const liquidadoGc = String(rec?.liquidado ?? "0") === "1" || situacao.includes("recebid") || situacao.includes("liquidad");
        const canceladoGc = situacao.includes("cancel");
        const aberto = !liquidadoGc && !canceladoGc;

        if (isExNegPassive && !descUpper.includes("PASSIVO") && !aberto) continue;

        let negNumero: number | null = null;
        const negMatch = descricao.match(/NEG\s*(\d+)/i)
          || descricao.match(/negocia[çc][ãa]o\s+(\d+)/i);
        if (negMatch) negNumero = parseInt(negMatch[1], 10);

        const osCodigos: string[] = [];
        const osMatches = descricao.matchAll(/OS\s+(\d+)/gi);
        for (const m of osMatches) {
          if (m[1] && !osCodigos.includes(m[1])) osCodigos.push(m[1]);
        }
        if (osCodigos.length === 0) {
          const legacyOsMatch = descricao.match(/ordem\s+de\s+servi[cç]o\s+de\s+n[ºo]\s*(\d+)/i);
          if (legacyOsMatch?.[1]) osCodigos.push(legacyOsMatch[1]);
        }

        found.push({
          gc_recebimento_id: recId,
          gc_codigo: codigo,
          descricao,
          valor,
          data_vencimento: dataVencimento,
          cliente_id: clienteId,
          nome_cliente: nomeCliente,
          negociacao_numero: negNumero,
          os_codigos: osCodigos,
          aberto,
          liquidado: liquidadoGc,
          cancelado: canceladoGc,
        });
      }

      console.log(`[scan-passivos] page ${page}/${totalPages} — ${records.length} recs, ${found.length} passivos`);
      page++;
    }

    // ── Acordo ativo? Um passivo com alocação/reserva/acordo vivo não volta
    // para "disponível" só porque o título está aberto no GC. ──
    async function temAcordoAtivo(gcRecebimentoId: string | null): Promise<boolean> {
      if (!gcRecebimentoId) return false;
      const { data: local } = await supabase
        .from("fin_recebimentos")
        .select("id")
        .eq("gc_id", gcRecebimentoId)
        .maybeSingle();
      if (!local?.id) return false;

      const { data: itens } = await supabase
        .from("fin_grupo_receber_itens")
        .select("grupo_id, gc_baixado")
        .eq("recebimento_id", local.id);

      if (!itens || itens.length === 0) return false;
      if (itens.some((i: any) => i.gc_baixado)) return true;

      const grupoIds = itens.map((i: any) => i.grupo_id).filter(Boolean);
      if (grupoIds.length === 0) return false;
      const { data: grupos } = await supabase
        .from("fin_grupos_receber")
        .select("id, status")
        .in("id", grupoIds);
      return (grupos || []).some((g: any) => g.status !== "cancelado");
    }

    let inserted = 0;
    let skipped = 0;
    let reabertos = 0;
    let baixados = 0;
    let pendentes = 0;
    let bloqueadosPorAcordo = 0;

    for (const p of found) {
      const { data: existing } = await supabase
        .from("fin_residuos_negociacao")
        .select("id, utilizado, valor_residual, estado, reservado_job_id")
        .eq("gc_recebimento_id", p.gc_recebimento_id)
        .maybeSingle();

      if (existing?.id) {
        const estado = String(existing.estado || (existing.utilizado ? "alocado" : "disponivel"));

        if (p.liquidado || p.cancelado) {
          // Quitado/cancelado no GC → sai da seleção, histórico preservado.
          if (estado !== "liquidado") {
            const { error } = await supabase
              .from("fin_residuos_negociacao")
              .update({
                estado: "liquidado",
                utilizado: true,
                estado_motivo: p.cancelado ? "Cancelado no GC" : "Quitado no GC",
              })
              .eq("id", existing.id);
            if (!error) baixados++;
          }
          skipped++;
          continue;
        }

        if (p.aberto && (existing.utilizado || estado !== "disponivel")) {
          const travado = estado === "reservado" || estado === "alocado" || !!existing.reservado_job_id;
          const acordoAtivo = travado ? true : await temAcordoAtivo(p.gc_recebimento_id);
          if (travado || acordoAtivo) {
            bloqueadosPorAcordo++;
            skipped++;
            continue;
          }
          const { error } = await supabase
            .from("fin_residuos_negociacao")
            .update({
              estado: "disponivel",
              utilizado: false,
              valor_residual: p.valor,
              estado_motivo: "Título reaberto no GC sem acordo ativo",
            })
            .eq("id", existing.id);
          if (!error) reabertos++;
          skipped++;
          continue;
        }

        if (p.aberto && Number(existing.valor_residual) !== p.valor) {
          await supabase
            .from("fin_residuos_negociacao")
            .update({ valor_residual: p.valor })
            .eq("id", existing.id);
        }
        skipped++;
        continue;
      }

      if (!p.aberto) { skipped++; continue; }

      const descricaoNormalizada = p.descricao.toUpperCase().includes("PASSIVO")
        ? p.descricao
        : `Passivo ${p.descricao}`;

      const { error } = await supabase.from("fin_residuos_negociacao").insert({
        cliente_gc_id: p.cliente_id,
        nome_cliente: p.nome_cliente,
        valor_residual: p.valor,
        negociacao_origem_numero: p.negociacao_numero,
        gc_recebimento_id: p.gc_recebimento_id,
        gc_codigo: p.gc_codigo,
        os_codigos: p.os_codigos,
        estado: "disponivel",
        observacao: `Importado via scan — ${descricaoNormalizada}\nVencimento: ${p.data_vencimento}`,
        utilizado: false,
      });

      if (error) {
        console.error(`[scan-passivos] Insert error: ${error.message}`);
      } else {
        inserted++;
      }
    }

    // ── Revalidação dos resíduos que não apareceram na varredura ──
    // Regra: NADA é apagado. 404 confirmado marca em_revisao + pendência.
    if (degradado) {
      console.warn("[scan-passivos] Varredura degradada — revalidação individual ignorada para preservar linhas");
    } else {
      const gcIdsFound = new Set(found.map((p) => p.gc_recebimento_id));

      const { data: allResiduos } = await supabase
        .from("fin_residuos_negociacao")
        .select("id, gc_recebimento_id, utilizado, estado, nome_cliente, valor_residual")
        .in("estado", ["disponivel", "pendente_vinculo"]);

      for (const residuo of (allResiduos ?? []) as any[]) {
        const gcId = residuo.gc_recebimento_id ? String(residuo.gc_recebimento_id).trim() : "";

        if (!gcId) {
          if (residuo.estado !== "pendente_vinculo") {
            await supabase
              .from("fin_residuos_negociacao")
              .update({ estado: "pendente_vinculo", estado_motivo: "Sem ID do título no GC" })
              .eq("id", residuo.id);
            pendentes++;
          }
          continue;
        }

        if (gcIdsFound.has(gcId)) continue;

        let checkResp: Response | null = null;
        try {
          checkResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/recebimentos/${gcId}`,
            { headers: gcHeaders }
          );
        } catch (err) {
          marcarDegradado(`falha de rede ao revalidar ${gcId}: ${(err as Error).message}`);
          continue; // preserva a linha
        }

        if (checkResp.status === 404) {
          await supabase
            .from("fin_residuos_negociacao")
            .update({
              estado: "em_revisao",
              estado_motivo: "Título não existe mais no GC (404 confirmado) — histórico preservado",
            })
            .eq("id", residuo.id);
          await supabase.from("fin_acoes_pendentes").insert({
            tipo: "passivo_titulo_ausente_gc",
            titulo: `Passivo sem título no GC (${gcId})`,
            descricao: `Passivo de ${residuo.nome_cliente ?? "cliente"} no valor de R$ ${Number(residuo.valor_residual || 0).toFixed(2)} teve 404 confirmado no GC. Nada foi apagado; precisa de reassociação comprovada ou baixa auditável.`,
            payload: { residuo_id: residuo.id, gc_recebimento_id: gcId, snapshot: residuo },
            entidade_tipo: "fin_residuos_negociacao",
            entidade_id: String(residuo.id),
            status: "pendente",
          });
          pendentes++;
          continue;
        }

        if (!checkResp.ok) {
          marcarDegradado(`GC ${checkResp.status} ao revalidar ${gcId}`);
          continue; // preserva a linha
        }

        let checkData: any;
        try {
          checkData = await checkResp.json();
        } catch (err) {
          marcarDegradado(`JSON inesperado ao revalidar ${gcId}: ${(err as Error).message}`);
          continue;
        }

        const rec = checkData?.data?.[0] || checkData?.data || checkData?.Recebimento || checkData;
        if (!rec?.id) {
          marcarDegradado(`resposta sem título ao revalidar ${gcId}`);
          continue;
        }

        const situacao = String(rec.situacao_nome || rec.situacao || "").toLowerCase();
        const cancelado = situacao.includes("cancel");
        const liquidado = String(rec.liquidado ?? "0") === "1"
          || situacao.includes("recebid") || situacao.includes("liquidad");

        if (liquidado || cancelado) {
          const { error } = await supabase
            .from("fin_residuos_negociacao")
            .update({
              estado: "liquidado",
              utilizado: true,
              estado_motivo: cancelado ? "Cancelado no GC" : "Quitado no GC",
            })
            .eq("id", residuo.id);
          if (!error) baixados++;
        }
      }
    }

    console.log(
      `[scan-passivos] Done: ${found.length} found, ${inserted} inserted, ${reabertos} reabertos, ${baixados} baixados, ${pendentes} pendentes, ${bloqueadosPorAcordo} bloqueados por acordo, ${skipped} skipped, degradado=${degradado}`
    );

    return new Response(JSON.stringify({
      success: !degradado,
      degradado,
      falhas,
      total_found: found.length,
      inserted,
      reabertos,
      baixados,
      pendentes,
      bloqueados_por_acordo: bloqueadosPorAcordo,
      skipped,
      removidos: 0,
      passivos: found.map((p) => ({
        gc_codigo: p.gc_codigo,
        descricao: p.descricao,
        valor: p.valor,
        nome_cliente: p.nome_cliente,
        os_codigos: p.os_codigos,
        negociacao_numero: p.negociacao_numero,
      })),
    }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[scan-passivos] Fatal:", (error as Error).message);
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
