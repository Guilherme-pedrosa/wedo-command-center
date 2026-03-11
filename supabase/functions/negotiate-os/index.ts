import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
const SITUACAO_ORIGEM = "7116099"; // Executado - Ag Negociação
const SITUACAO_DESTINO = "7063724"; // Executado - Ag Pagamento
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

interface NegotiateRequest {
  action: "list" | "execute";
  os_ids?: string[];
  parcelas?: number;
  dia_vencimento?: number;
  mes_inicio?: string; // YYYY-MM
  forma_pagamento_id?: string;
  nome_cliente?: string;
  cliente_gc_id?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(
        JSON.stringify({ error: "GC credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body: NegotiateRequest = await req.json();

    // ─── LIST ──────────────────────────────────────────────
    if (body.action === "list") {
      const allOS: Record<string, unknown>[] = [];
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const params = new URLSearchParams({
          limite: "100",
          pagina: String(page),
          situacao_id: SITUACAO_ORIGEM,
        });

        const response = await rateLimitedFetch(
          `${GC_BASE_URL}/api/ordens_servicos?${params.toString()}`,
          { headers: gcHeaders }
        );

        if (response.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        if (!response.ok) {
          throw new Error(`GC API error: ${response.status}`);
        }

        const data = await response.json();
        const records = Array.isArray(data?.data) ? data.data : [];
        totalPages = data?.meta?.total_paginas || 1;

        allOS.push(...records);
        page++;
      }

      // Group by client
      const byClient: Record<string, { cliente_id: string; nome_cliente: string; os_list: any[]; valor_total: number }> = {};

      for (const os of allOS) {
        const clienteId = String(os.cliente_id || "sem_cliente");
        const nomeCliente = String(os.nome_cliente || "Sem cliente");

        if (!byClient[clienteId]) {
          byClient[clienteId] = {
            cliente_id: clienteId,
            nome_cliente: nomeCliente,
            os_list: [],
            valor_total: 0,
          };
        }

        const valor = parseFloat(String(os.valor_total || "0")) || 0;
        byClient[clienteId].os_list.push({
          id: String(os.id),
          codigo: String(os.codigo || ""),
          descricao: String(os.descricao || os.observacoes || ""),
          valor_total: valor,
          nome_cliente: nomeCliente,
          data: String(os.data || ""),
          nome_situacao: String(os.nome_situacao || ""),
        });
        byClient[clienteId].valor_total += valor;
      }

      const clients = Object.values(byClient).sort((a, b) => b.valor_total - a.valor_total);

      return new Response(
        JSON.stringify({
          success: true,
          total_os: allOS.length,
          clients,
          duration_ms: Date.now() - startTime,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── EXECUTE ───────────────────────────────────────────
    if (body.action === "execute") {
      const { os_ids, parcelas, dia_vencimento, mes_inicio, nome_cliente, cliente_gc_id } = body;

      if (!os_ids?.length || !parcelas || !dia_vencimento || !mes_inicio) {
        return new Response(
          JSON.stringify({ error: "Missing required fields: os_ids, parcelas, dia_vencimento, mes_inicio" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Generate due dates
      const [startYear, startMonth] = mes_inicio.split("-").map(Number);
      const dueDates: string[] = [];
      for (let i = 0; i < parcelas; i++) {
        const d = new Date(startYear, startMonth - 1 + i, dia_vencimento);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        dueDates.push(`${yyyy}-${mm}-${dd}`);
      }

      // 1. Fetch all OS details first (to get required PUT fields + values)
      const osDetails: { id: string; codigo: string; tipo: string; cliente_id: string; data: string; valor_total: number; nome_cliente: string }[] = [];
      const gcUpdateResults: { os_id: string; status: string; error?: string }[] = [];

      for (const osId of os_ids) {
        try {
          const osResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${osId}`,
            { headers: gcHeaders }
          );

          if (!osResp.ok) {
            gcUpdateResults.push({ os_id: osId, status: "error", error: `Fetch failed: ${osResp.status}` });
            continue;
          }

          const osData = await osResp.json();
          const os = osData?.data || osData;
          const valorTotal = parseFloat(String(os.valor_total || "0")) || 0;

          if (valorTotal <= 0) {
            gcUpdateResults.push({ os_id: osId, status: "error", error: "Valor total = 0" });
            continue;
          }

          osDetails.push({
            id: osId,
            codigo: String(os.codigo || ""),
            tipo: String(os.tipo || "servico"),
            cliente_id: String(os.cliente_id || ""),
            data: String(os.data || new Date().toISOString().slice(0, 10)),
            valor_total: valorTotal,
            nome_cliente: String(os.nome_cliente || nome_cliente || ""),
          });
        } catch (err) {
          gcUpdateResults.push({ os_id: osId, status: "error", error: (err as Error).message });
        }
      }

      // 2. Update each OS in GC — ONLY change situacao_id (preserve value)
      for (const os of osDetails) {
        try {
          const updatePayload = {
            tipo: os.tipo,
            codigo: os.codigo,
            cliente_id: os.cliente_id,
            situacao_id: SITUACAO_DESTINO,
            data: os.data,
          };

          console.log(`[negotiate-os] PUT OS ${os.id} (codigo=${os.codigo}) — only situacao change`);

          const putResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            {
              method: "PUT",
              headers: gcHeaders,
              body: JSON.stringify(updatePayload),
            }
          );

          const putData = await putResp.json();

          if (putResp.ok && (putData?.code === 200 || putData?.status === "success")) {
            gcUpdateResults.push({ os_id: os.id, status: "ok" });
          } else {
            gcUpdateResults.push({
              os_id: os.id,
              status: "error",
              error: putData?.message || putData?.status || `HTTP ${putResp.status}`,
            });
          }
        } catch (err) {
          gcUpdateResults.push({ os_id: os.id, status: "error", error: (err as Error).message });
        }
      }

      // 3. Create fin_grupos_receber — one group per installment
      const successOS = osDetails.filter((os) =>
        gcUpdateResults.find((r) => r.os_id === os.id && r.status === "ok")
      );

      const totalValor = successOS.reduce((sum, os) => sum + os.valor_total, 0);
      const grupoIds: string[] = [];

      if (successOS.length > 0 && totalValor > 0) {
        const valorParcela = Math.floor((totalValor / parcelas) * 100) / 100;
        const valorUltima = Math.round((totalValor - valorParcela * (parcelas - 1)) * 100) / 100;
        const clienteNome = successOS[0].nome_cliente || nome_cliente || "Cliente";

        for (let i = 0; i < parcelas; i++) {
          const valor = i === parcelas - 1 ? valorUltima : valorParcela;
          const vencimento = dueDates[i];
          const nomeGrupo = `${clienteNome} — Negociação ${i + 1}/${parcelas}`;

          // Insert grupo
          const { data: grupo, error: grupoErr } = await supabase
            .from("fin_grupos_receber")
            .insert({
              nome: nomeGrupo,
              cliente_gc_id: cliente_gc_id || successOS[0].cliente_id || null,
              nome_cliente: clienteNome,
              valor_total: valor,
              data_vencimento: vencimento,
              status: "aberto",
              itens_total: successOS.length,
              observacao: `Negociação: ${parcelas}x de ${valor.toFixed(2)} — dia ${dia_vencimento} a partir de ${mes_inicio}`,
            })
            .select("id")
            .single();

          if (grupoErr) {
            console.error(`[negotiate-os] Error creating grupo ${i + 1}:`, grupoErr.message);
            continue;
          }

          grupoIds.push(grupo.id);

          // Insert grupo items — each OS is linked proportionally
          const itens = successOS.map((os) => {
            const proporcao = os.valor_total / totalValor;
            return {
              grupo_id: grupo.id,
              recebimento_id: null as unknown as string, // We'll create recebimentos below
              gc_os_id: os.id,
              os_codigo_original: os.codigo,
              valor: Math.round(valor * proporcao * 100) / 100,
              snapshot_valor: os.valor_total,
              snapshot_data: vencimento,
            };
          });

          // Create corresponding fin_recebimentos for each OS in this installment
          for (const item of itens) {
            const osDetail = successOS.find((o) => o.id === item.gc_os_id);
            if (!osDetail) continue;

            const { data: receb, error: recebErr } = await supabase
              .from("fin_recebimentos")
              .insert({
                descricao: `OS ${osDetail.codigo} — Parcela ${i + 1}/${parcelas}`,
                valor: item.valor,
                data_vencimento: vencimento,
                nome_cliente: clienteNome,
                cliente_gc_id: cliente_gc_id || osDetail.cliente_id || null,
                os_codigo: osDetail.codigo,
                origem: "manual",
                status: "pendente",
                grupo_id: grupo.id,
              })
              .select("id")
              .single();

            if (recebErr) {
              console.error(`[negotiate-os] Error creating recebimento for OS ${osDetail.codigo}:`, recebErr.message);
              continue;
            }

            // Insert grupo item with recebimento_id
            await supabase.from("fin_grupo_receber_itens").insert({
              grupo_id: grupo.id,
              recebimento_id: receb.id,
              gc_os_id: osDetail.id,
              os_codigo_original: osDetail.codigo,
              valor: item.valor,
              snapshot_valor: osDetail.valor_total,
              snapshot_data: vencimento,
            });
          }
        }
      }

      const okCount = gcUpdateResults.filter((r) => r.status === "ok").length;
      const errCount = gcUpdateResults.filter((r) => r.status === "error").length;

      // Log
      await supabase.from("fin_sync_log").insert({
        tipo: "negotiate-os",
        status: errCount > 0 ? (okCount > 0 ? "partial" : "erro") : "ok",
        payload: { os_ids, parcelas, dia_vencimento, mes_inicio, cliente_gc_id },
        resposta: { gcUpdateResults, grupoIds, totalValor },
        duracao_ms: Date.now() - startTime,
      });

      return new Response(
        JSON.stringify({
          success: true,
          results: gcUpdateResults,
          grupos_criados: grupoIds.length,
          grupo_ids: grupoIds,
          summary: { total: os_ids.length, ok: okCount, errors: errCount },
          duration_ms: Date.now() - startTime,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'list' or 'execute'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[negotiate-os] Fatal:", (error as Error).message);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
