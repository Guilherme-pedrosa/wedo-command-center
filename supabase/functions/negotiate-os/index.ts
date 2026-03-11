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
  // For execute:
  os_ids?: string[];
  parcelas?: number;
  dia_vencimento?: number;
  mes_inicio?: string; // YYYY-MM
  forma_pagamento_id?: string;
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

    if (body.action === "list") {
      // Fetch all OS with situacao Ag Negociação
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

    if (body.action === "execute") {
      const { os_ids, parcelas, dia_vencimento, mes_inicio, forma_pagamento_id } = body;

      if (!os_ids?.length || !parcelas || !dia_vencimento || !mes_inicio) {
        return new Response(
          JSON.stringify({ error: "Missing required fields: os_ids, parcelas, dia_vencimento, mes_inicio" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Generate due dates
      const [startYear, startMonth] = mes_inicio.split("-").map(Number);
      const duesDates: string[] = [];
      for (let i = 0; i < parcelas; i++) {
        const d = new Date(startYear, startMonth - 1 + i, dia_vencimento);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        duesDates.push(`${yyyy}-${mm}-${dd}`);
      }

      const results: { os_id: string; status: string; error?: string }[] = [];

      for (const osId of os_ids) {
        try {
          // 1. Fetch OS details to get required fields
          const osResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${osId}`,
            { headers: gcHeaders }
          );

          if (!osResp.ok) {
            results.push({ os_id: osId, status: "error", error: `Fetch failed: ${osResp.status}` });
            continue;
          }

          const osData = await osResp.json();
          const os = osData?.data || osData;

          const valorTotal = parseFloat(String(os.valor_total || "0")) || 0;
          if (valorTotal <= 0) {
            results.push({ os_id: osId, status: "error", error: "Valor total = 0" });
            continue;
          }

          // Split value equally
          const valorParcela = Math.floor((valorTotal / parcelas) * 100) / 100;
          const valorUltima = Math.round((valorTotal - valorParcela * (parcelas - 1)) * 100) / 100;

          // Build pagamentos array
          const pagamentos = duesDates.map((dt, idx) => ({
            pagamento: {
              data_vencimento: dt,
              valor: String(idx === parcelas - 1 ? valorUltima : valorParcela),
              ...(forma_pagamento_id ? { forma_pagamento_id } : {}),
            },
          }));

          // 2. PUT to update OS: change situacao + add pagamentos
          const updatePayload: Record<string, unknown> = {
            tipo: String(os.tipo || "servico"),
            codigo: String(os.codigo || ""),
            cliente_id: String(os.cliente_id || ""),
            situacao_id: SITUACAO_DESTINO,
            data: String(os.data || new Date().toISOString().slice(0, 10)),
            condicao_pagamento: parcelas > 1 ? "parcelado" : "a_vista",
            pagamentos,
          };

          const putResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${osId}`,
            {
              method: "PUT",
              headers: gcHeaders,
              body: JSON.stringify(updatePayload),
            }
          );

          const putData = await putResp.json();

          if (putResp.ok && putData?.code === 200) {
            results.push({ os_id: osId, status: "ok" });
          } else {
            results.push({
              os_id: osId,
              status: "error",
              error: putData?.message || putData?.status || `HTTP ${putResp.status}`,
            });
          }
        } catch (err) {
          results.push({ os_id: osId, status: "error", error: (err as Error).message });
        }
      }

      const successCount = results.filter((r) => r.status === "ok").length;
      const errorCount = results.filter((r) => r.status === "error").length;

      // Log
      await supabase.from("fin_sync_log").insert({
        tipo: "negotiate-os",
        status: errorCount > 0 ? (successCount > 0 ? "partial" : "erro") : "ok",
        payload: { os_ids, parcelas, dia_vencimento, mes_inicio, forma_pagamento_id },
        resposta: { results },
        duracao_ms: Date.now() - startTime,
      });

      return new Response(
        JSON.stringify({
          success: true,
          results,
          summary: { total: os_ids.length, ok: successCount, errors: errorCount },
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
