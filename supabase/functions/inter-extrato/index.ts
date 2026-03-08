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

  const now = new Date();
  const dataFim = body.dataFim ?? body.dataFim ?? now.toISOString().substring(0, 10);
  const dataInicio = body.dataInicio ?? (() => {
    const days = body.days ?? 7;
    const d = new Date(now.getTime() - days * 86400000);
    return d.toISOString().substring(0, 10);
  })();

  const startMs = Date.now();

  try {
    // Call inter-proxy to fetch enriched statement (v3)
    const proxyUrl = `${supabaseUrl}/functions/v1/inter-proxy`;
    const path = `/banking/v3/extrato/enriquecido?dataInicio=${dataInicio}&dataFim=${dataFim}`;

    console.log(`[inter-extrato] Buscando extrato enriquecido v3 ${dataInicio} → ${dataFim}`);

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

    // The Inter API v3 returns { transacoes: [...] } or directly an array
    const transacoes: any[] = proxyData.transacoes ?? proxyData.resultado ?? proxyData ?? [];

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
        // v3 enriched fields
        const detalhe = tx.detalhe ?? tx.detalhes ?? {};
        const tipoOp = tx.tipoOperacao ?? "";
        const tipoTx = tx.tipoTransacao ?? tx.tipo ?? "";

        const isCredito =
          tipoOp === "C" ||
          tipoTx.includes("CREDITO") ||
          tipoTx.includes("C");
        const tipo = isCredito ? "CREDITO" : "DEBITO";

        // Extract CPF/CNPJ from enriched detalhe
        const cpfCnpjRaw = isCredito
          ? (detalhe.cpfCnpjPagador ?? detalhe.cpfCnpjRemetente ?? detalhe.cpfCnpj ?? tx.cpfCnpjContraparte)
          : (detalhe.cpfCnpjBeneficiario ?? detalhe.cpfCnpjRecebedor ?? detalhe.cpfCnpjDestinatario ?? detalhe.cpfCnpj ?? tx.cpfCnpjContraparte);
        const cpfCnpj = cpfCnpjRaw ? String(cpfCnpjRaw).replace(/\D/g, "") : null;

        // Extract counterparty name from enriched detalhe
        const nomeContraparte = isCredito
          ? (detalhe.nomePagador ?? detalhe.nomeRemetente ?? detalhe.nome ?? tx.nomeContraparte)
          : (detalhe.nomeBeneficiario ?? detalhe.nomeRecebedor ?? detalhe.nomeDestinatario ?? detalhe.nome ?? tx.nomeContraparte);

        const chavePix = detalhe.chavePixRecebedor ?? detalhe.chavePixBeneficiario ?? detalhe.chavePixPagador ?? detalhe.chave ?? null;
        const codigoBarras = detalhe.codigoBarras ?? null;

        // Real unique ID (endToEndId for PIX, codigoBarras for boleto)
        const realEndToEndId =
          detalhe.endToEndId ?? tx.endToEndId ?? tx.codigoTransacao ?? codigoBarras ?? null;

        const valor = Math.abs(parseFloat(String(tx.valor ?? "0").replace(",", ".")));
        const dataHora = tx.dataHora ?? tx.dataInclusao ?? tx.dataEntrada ?? tx.dataMovimento ?? now.toISOString();

        // Dedup: if no real ID, skip if same valor+tipo+date already exists
        if (!realEndToEndId) {
          const dateOnly = String(dataHora).substring(0, 10);
          const { data: existing } = await supabase
            .from("fin_extrato_inter")
            .select("id")
            .eq("valor", valor)
            .eq("tipo", tipo)
            .gte("data_hora", `${dateOnly}T00:00:00`)
            .lte("data_hora", `${dateOnly}T23:59:59`)
            .limit(1);

          if (existing && existing.length > 0) {
            skipped++;
            continue;
          }
        }

        // Dedup: if we HAVE a real ID, delete any fallback duplicate for same valor+tipo+date
        if (realEndToEndId) {
          const dateOnly = String(dataHora).substring(0, 10);
          const fallbackPattern = `${dateOnly}-${valor}`;
          const { data: phantoms } = await supabase
            .from("fin_extrato_inter")
            .select("id, end_to_end_id")
            .eq("valor", valor)
            .eq("tipo", tipo)
            .gte("data_hora", `${dateOnly}T00:00:00`)
            .lte("data_hora", `${dateOnly}T23:59:59`)
            .neq("end_to_end_id", realEndToEndId);

          if (phantoms && phantoms.length > 0) {
            const fallbackIds = phantoms
              .filter((p: any) => /^\d{4}-\d{2}-\d{2}-/.test(p.end_to_end_id))
              .map((p: any) => p.id);
            if (fallbackIds.length > 0) {
              await supabase.from("fin_extrato_inter").delete().in("id", fallbackIds);
              console.log(`[inter-extrato] Removidos ${fallbackIds.length} fantasmas para ${realEndToEndId}`);
            }
          }
        }

        const endToEndId = realEndToEndId ?? `${String(dataHora).substring(0, 10)}-${valor}-${tipo}`;

        const record = {
          end_to_end_id: endToEndId,
          tipo,
          tipo_transacao: tx.tipoTransacao ?? null,
          valor,
          data_hora: dataHora,
          descricao: tx.titulo ?? tx.descricao ?? tx.historico ?? null,
          contrapartida: nomeContraparte ?? tx.titulo ?? null,
          nome_contraparte: nomeContraparte ?? null,
          cpf_cnpj: cpfCnpj,
          chave_pix: chavePix,
          codigo_barras: codigoBarras,
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
      payload: { dataInicio, dataFim },
      resposta: { total: transacoes.length, inserted, skipped, errors },
    });

    // Trigger reconciliation engine
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
