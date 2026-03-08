import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);

  const body = await req.json().catch(() => ({}));
  const days = body.days ?? 7;

  const now = new Date();
  const from = new Date(now.getTime() - days * 86400000);
  const dataInicio = from.toISOString().substring(0, 10);
  const dataFim = now.toISOString().substring(0, 10);

  const startMs = Date.now();

  try {
    // 1. Call inter-proxy to fetch enriched statement
    const proxyUrl = `${supabaseUrl}/functions/v1/inter-proxy`;
    const path = `/banking/v2/extrato/completo?dataInicio=${dataInicio}&dataFim=${dataFim}`;

    console.log(`[inter-extrato] Buscando extrato ${dataInicio} → ${dataFim}`);

    const proxyRes = await fetch(proxyUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({ path, method: "GET" }),
    });

    const proxyData = await proxyRes.json();

    if (proxyData.error) {
      throw new Error(`inter-proxy error: ${proxyData.error}`);
    }

    // The Inter API returns { transacoes: [...] } or directly an array
    const transacoes: any[] = proxyData.transacoes ?? proxyData ?? [];

    if (!Array.isArray(transacoes)) {
      console.log("[inter-extrato] Resposta inesperada:", JSON.stringify(proxyData).substring(0, 500));
      throw new Error("Resposta do Inter não contém array de transações");
    }

    console.log(`[inter-extrato] ${transacoes.length} transações recebidas`);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const tx of transacoes) {
      try {
        // Determine transaction type
        const tipoTx = tx.tipoTransacao ?? tx.tipo ?? "";
        const isCredito =
          tipoTx.includes("CREDITO") ||
          tipoTx.includes("C") ||
          (tx.tipoOperacao ?? "").includes("C");
        const tipo = isCredito ? "CREDITO" : "DEBITO";

        // Extract counterpart info from detalhes (enriched data)
        const det = tx.detalhes ?? tx.detalhe ?? {};
        const cpfCnpj = isCredito
          ? det.cpfCnpjPagador ?? det.cpfCnpjRemetente ?? tx.cpfCnpjContraparte ?? null
          : det.cpfCnpjRecebedor ?? det.cpfCnpjBeneficiario ?? det.cpfCnpjDestinatario ?? tx.cpfCnpjContraparte ?? null;

        const nomeContraparte = isCredito
          ? det.nomePagador ?? det.nomeRemetente ?? tx.nomeContraparte ?? null
          : det.nomeRecebedor ?? det.nomeBeneficiario ?? det.nomeDestinatario ?? tx.nomeContraparte ?? null;

        const chavePix = det.chavePixRecebedor ?? det.chavePixBeneficiario ?? det.chavePixPagador ?? det.chave ?? null;

        // Build unique ID for upsert dedup
        const endToEndId =
          det.endToEndId ?? tx.endToEndId ?? tx.codigoTransacao ?? `${tx.dataEntrada}-${tx.valor}-${tipo}`;

        const valor = Math.abs(parseFloat(String(tx.valor ?? "0").replace(",", ".")));
        const dataHora = tx.dataInclusao ?? tx.dataEntrada ?? tx.dataMovimento ?? now.toISOString();

        const record = {
          end_to_end_id: endToEndId,
          tipo,
          valor,
          data_hora: dataHora,
          descricao: tx.titulo ?? tx.descricao ?? tx.historico ?? null,
          contrapartida: nomeContraparte ?? tx.titulo ?? null,
          cpf_cnpj: cpfCnpj ? String(cpfCnpj).replace(/\D/g, "") : null,
          chave_pix: chavePix,
          payload_raw: tx,
        };

        const { error: upsertErr } = await supabase
          .from("fin_extrato_inter")
          .upsert(record, { onConflict: "end_to_end_id", ignoreDuplicates: true });

        if (upsertErr) {
          console.error(`[inter-extrato] Upsert error:`, upsertErr.message);
          errors++;
        } else {
          inserted++;
        }
      } catch (txErr) {
        console.error(`[inter-extrato] Tx error:`, (txErr as Error).message);
        errors++;
      }
    }

    const duracao = Date.now() - startMs;

    // Log to fin_sync_log
    await supabase.from("fin_sync_log").insert({
      tipo: "inter_extrato_sync",
      status: errors > 0 ? "partial" : "success",
      duracao_ms: duracao,
      payload: { days, dataInicio, dataFim },
      resposta: { total: transacoes.length, inserted, skipped, errors },
    });

    // 2. Trigger reconciliation engine
    console.log("[inter-extrato] Disparando reconciliation-engine...");
    const reconRes = await fetch(`${supabaseUrl}/functions/v1/reconciliation-engine`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serviceKey}`,
      },
      body: JSON.stringify({}),
    });
    const reconData = await reconRes.json();

    return new Response(
      JSON.stringify({
        success: true,
        extrato: { total: transacoes.length, inserted, skipped, errors, duracao_ms: duracao },
        reconciliacao: reconData,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (err) {
    const msg = (err as Error).message;
    console.error("[inter-extrato] ERRO:", msg);

    await supabase.from("fin_sync_log").insert({
      tipo: "inter_extrato_sync",
      status: "error",
      duracao_ms: Date.now() - startMs,
      erro: msg,
    }).catch(() => {});

    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
