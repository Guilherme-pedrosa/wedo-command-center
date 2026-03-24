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

    // Search GC for receivables with "PASSIVO" in description
    // We search recent months
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
    }> = [];

    while (page <= totalPages) {
      const params = new URLSearchParams({
        limite: "100",
        pagina: String(page),
        data_inicio: dataInicio,
        data_fim: dataFim,
      });

      const resp = await rateLimitedFetch(
        `${GC_BASE_URL}/api/recebimentos?${params.toString()}`,
        { headers: gcHeaders }
      );

      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 2000));
        continue;
      }

      if (!resp.ok) {
        console.error(`[scan-passivos] GC error: ${resp.status}`);
        break;
      }

      const data = await resp.json();
      const records = Array.isArray(data?.data) ? data.data : [];
      const meta = data?.meta || {};
      totalPages = meta?.total_paginas || 1;

      for (const item of records) {
        const rec = item?.Recebimento || item?.recebimento || item;
        const descricao = String(rec?.descricao || "").trim();
        const descUpper = descricao.toUpperCase();

        // Only process PASSIVO receivables
        if (!descUpper.includes("PASSIVO")) continue;

        const recId = String(rec?.id || "").trim();
        if (!recId) continue;

        const valor = parseFloat(String(rec?.valor || rec?.valor_total || "0").replace(",", ".")) || 0;
        if (valor <= 0) continue;

        const dataVencimento = String(rec?.data_vencimento || "").slice(0, 10);
        const clienteId = String(rec?.cliente_id || "").trim();
        const nomeCliente = String(rec?.nome_cliente || "").trim();
        const codigo = rec?.codigo ? String(rec.codigo) : null;

        // Extract NEG number from description (supports both formats)
        let negNumero: number | null = null;
        const negMatch = descricao.match(/NEG\s*(\d+)/i)
          || descricao.match(/negocia[çc][ãa]o\s+(\d+)/i);
        if (negMatch) negNumero = parseInt(negMatch[1], 10);

        // Extract OS codes from description
        const osCodigos: string[] = [];
        const osMatches = descricao.matchAll(/OS\s+(\d+)/gi);
        for (const m of osMatches) {
          if (m[1] && !osCodigos.includes(m[1])) osCodigos.push(m[1]);
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
        });
      }

      console.log(`[scan-passivos] page ${page}/${totalPages} — ${records.length} recs, ${found.length} passivos`);
      page++;
    }

    // Upsert into fin_residuos_negociacao
    let inserted = 0;
    let skipped = 0;
    let removidos = 0;

    for (const p of found) {
      // Check if already exists
      const { data: existing } = await supabase
        .from("fin_residuos_negociacao")
        .select("id")
        .eq("gc_recebimento_id", p.gc_recebimento_id)
        .maybeSingle();

      if (existing?.id) {
        skipped++;
        continue;
      }

      const { error } = await supabase.from("fin_residuos_negociacao").insert({
        cliente_gc_id: p.cliente_id,
        nome_cliente: p.nome_cliente,
        valor_residual: p.valor,
        negociacao_origem_numero: p.negociacao_numero,
        gc_recebimento_id: p.gc_recebimento_id,
        gc_codigo: p.gc_codigo,
        os_codigos: p.os_codigos,
        observacao: `Importado via scan — ${p.descricao}\nVencimento: ${p.data_vencimento}`,
        utilizado: false,
      });

      if (error) {
        console.error(`[scan-passivos] Insert error: ${error.message}`);
      } else {
        inserted++;
      }
    }

    // ── Validar resíduos existentes: remover os que não existem mais no GC ──
    const gcIdsFound = new Set(found.map(p => p.gc_recebimento_id));

    const { data: allResiduos } = await supabase
      .from("fin_residuos_negociacao")
      .select("id, gc_recebimento_id, utilizado")
      .eq("utilizado", false);

    const residuosComGcId = (allResiduos ?? []).filter(
      (r: any) => r.gc_recebimento_id && r.gc_recebimento_id.trim() !== ""
    );

    // Check each existing residual against GC individually
    for (const residuo of residuosComGcId as any[]) {
      if (gcIdsFound.has(residuo.gc_recebimento_id)) continue; // Still exists in GC scan

      // Double-check with a direct GC GET to avoid false positives from date range limits
      try {
        const checkResp = await rateLimitedFetch(
          `${GC_BASE_URL}/api/recebimentos/${residuo.gc_recebimento_id}`,
          { headers: gcHeaders }
        );

        if (checkResp.ok) {
          const checkData = await checkResp.json();
          const rec = checkData?.data?.[0] || checkData?.data || checkData?.Recebimento || checkData;

          if (rec?.id) {
            // Verificar se está cancelado (único motivo para remover)
            // IMPORTANTE: NÃO remover por estar liquidado — passivos negociados ficam liquidados no GC
            const situacao = String(rec.situacao_nome || rec.situacao || '').toLowerCase();
            const cancelado = situacao.includes('cancelad') || situacao.includes('cancel');

            if (!cancelado) {
              continue; // Ainda existe no GC (mesmo que liquidado) — manter residual
            }
            console.log(`[scan-passivos] Residual gc_id=${residuo.gc_recebimento_id} está cancelado no GC — removendo`);
          }
          // rec sem id — não existe mais, cai no delete
        }
        // checkResp não ok (404 etc.) — não existe mais, cai no delete
      } catch {
        continue; // erro de rede — manter por segurança
      }

      // Remove do Supabase
      await supabase.from("fin_residuos_negociacao").delete().eq("id", residuo.id);
      removidos++;
      console.log(`[scan-passivos] Removido resíduo órfão: gc_recebimento_id=${residuo.gc_recebimento_id}`);
    }

    // Also clean up residuals that have no gc_recebimento_id (orphans from broken creation)
    const { data: orphanResiduos } = await supabase
      .from("fin_residuos_negociacao")
      .select("id, gc_recebimento_id")
      .eq("utilizado", false)
      .is("gc_recebimento_id", null);

    if (orphanResiduos && orphanResiduos.length > 0) {
      const orphanIds = orphanResiduos.map((r: any) => r.id);
      await supabase.from("fin_residuos_negociacao").delete().in("id", orphanIds);
      removidos += orphanIds.length;
      console.log(`[scan-passivos] Removidos ${orphanIds.length} resíduos sem gc_recebimento_id`);
    }

    console.log(`[scan-passivos] Done: ${found.length} found, ${inserted} inserted, ${skipped} skipped, ${removidos} removidos`);

    return new Response(JSON.stringify({
      success: true,
      total_found: found.length,
      inserted,
      skipped,
      removidos,
      passivos: found.map(p => ({
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
