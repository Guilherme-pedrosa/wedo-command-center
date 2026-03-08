import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
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
  const dataFim = body.dataFim ?? now.toISOString().substring(0, 10);
  const dataInicio = body.dataInicio ?? (() => {
    const days = body.days ?? 7;
    const d = new Date(now.getTime() - days * 86400000);
    return d.toISOString().substring(0, 10);
  })();

  const startMs = Date.now();

  try {
    const proxyUrl = `${supabaseUrl}/functions/v1/inter-proxy`;
    const proxyHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    };

    // Try multiple endpoints — v2/extrato is the most widely supported
    const endpoints = [
      `/banking/v2/extrato?dataInicio=${dataInicio}&dataFim=${dataFim}`,
      `/banking/v3/extrato/enriquecido?dataInicio=${dataInicio}&dataFim=${dataFim}`,
      `/banking/v2/extrato/completo?dataInicio=${dataInicio}&dataFim=${dataFim}`,
    ];

    let proxyData: any = null;
    let usedEndpoint = "";

    for (const ep of endpoints) {
      console.log(`[inter-extrato] Tentando ${ep}`);
      const res = await fetch(proxyUrl, {
        method: "POST",
        headers: proxyHeaders,
        body: JSON.stringify({ path: ep, method: "GET" }),
      });

      const data = await res.json();

      // Check for 404 or error — try next endpoint
      const is404 = (data.raw && typeof data.raw === "string" && data.raw.includes("404")) ||
                     (typeof data === "string" && data.includes("404"));
      if (is404) {
        console.log(`[inter-extrato] ${ep} → 404, tentando próximo...`);
        continue;
      }
      if (data.error) {
        console.log(`[inter-extrato] ${ep} → erro: ${data.error}, tentando próximo...`);
        continue;
      }

      proxyData = data;
      usedEndpoint = ep;
      break;
    }

    if (!proxyData) {
      throw new Error("Nenhum endpoint do Inter retornou dados válidos. Verifique se o escopo 'extrato.read' está configurado no certificado Inter.");
    }

    console.log(`[inter-extrato] Sucesso via ${usedEndpoint}`);

    // v2 returns { transacoes: [...] } or direct array
    const transacoes: any[] = proxyData.transacoes ?? proxyData.resultado ?? (Array.isArray(proxyData) ? proxyData : []);

    if (!Array.isArray(transacoes) || transacoes.length === 0) {
      console.log("[inter-extrato] Resposta:", JSON.stringify(proxyData).substring(0, 500));
      if (Array.isArray(transacoes) && transacoes.length === 0) {
        return new Response(
          JSON.stringify({ success: true, extrato: { total: 0, inserted: 0, skipped: 0, errors: 0, duracao_ms: Date.now() - startMs } }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      throw new Error("Resposta do Inter não contém array de transações");
    }

    console.log(`[inter-extrato] ${transacoes.length} transações recebidas`);

    let inserted = 0;
    let skipped = 0;
    let errors = 0;

    for (const tx of transacoes) {
      try {
        // Works for both v2 and v3 — v2 has fewer fields, v3 has detalhe object
        const detalhe = tx.detalhe ?? tx.detalhes ?? {};
        const tipoOp = tx.tipoOperacao ?? "";
        const tipoTx = tx.tipoTransacao ?? tx.tipo ?? "";

        // BUG E3 FIX: tipoOperacao do Inter: "C" = Crédito, "D" = Débito
        const isCredito =
          tipoOp === "C" ||
          (tipoOp !== "D" && tipoTx.toUpperCase() === "CREDITO");
        const tipo = isCredito ? "CREDITO" : "DEBITO";

        // Extract CPF/CNPJ — try enriched detalhe first, then top-level
        const cpfCnpjRaw = isCredito
          ? (detalhe.cpfCnpjPagador ?? detalhe.cpfCnpjRemetente ?? detalhe.cpfCnpj ?? tx.cpfCnpjContraparte)
          : (detalhe.cpfCnpjBeneficiario ?? detalhe.cpfCnpjRecebedor ?? detalhe.cpfCnpjDestinatario ?? detalhe.cpfCnpj ?? tx.cpfCnpjContraparte);
        const cpfCnpj = cpfCnpjRaw ? String(cpfCnpjRaw).replace(/\D/g, "") : null;

        // Extract counterparty name
        const nomeContraparte = isCredito
          ? (detalhe.nomePagador ?? detalhe.nomeRemetente ?? detalhe.nome ?? tx.nomeContraparte ?? tx.titulo)
          : (detalhe.nomeBeneficiario ?? detalhe.nomeRecebedor ?? detalhe.nomeDestinatario ?? detalhe.nome ?? tx.nomeContraparte ?? tx.titulo);

        const chavePix = detalhe.chavePixRecebedor ?? detalhe.chavePixBeneficiario ?? detalhe.chavePixPagador ?? detalhe.chave ?? null;
        const codigoBarras = detalhe.codigoBarras ?? null;

        // Real unique ID
        const realEndToEndId =
          detalhe.endToEndId ?? tx.endToEndId ?? tx.codigoTransacao ?? codigoBarras ?? null;

        const valor = Math.abs(parseFloat(String(tx.valor ?? "0").replace(",", ".")));
        const dataHora = tx.dataHora ?? tx.dataInclusao ?? tx.dataEntrada ?? tx.dataMovimento ?? now.toISOString();

        // BUG E2 FIX: Dedup sem endToEndId usa janela ±2 dias
        if (!realEndToEndId) {
          const baseDate = new Date(dataHora);
          const dateFrom = new Date(baseDate.getTime() - 2 * 86400000).toISOString().substring(0, 10);
          const dateTo = new Date(baseDate.getTime() + 2 * 86400000).toISOString().substring(0, 10);

          const { data: existing } = await supabase
            .from("fin_extrato_inter")
            .select("id, nome_contraparte, cpf_cnpj")
            .eq("valor", valor)
            .eq("tipo", tipo)
            .gte("data_hora", `${dateFrom}T00:00:00`)
            .lte("data_hora", `${dateTo}T23:59:59`)
            .limit(1);

          if (existing && existing.length > 0) {
            // BUG E4 FIX: enriquecer o registro existente se nome/cpf estão vazios
            const ex = existing[0] as any;
            const precisaEnriquecer = (!ex.nome_contraparte && nomeContraparte) || (!ex.cpf_cnpj && cpfCnpj);
            if (precisaEnriquecer) {
              await supabase
                .from("fin_extrato_inter")
                .update({
                  nome_contraparte: nomeContraparte ?? ex.nome_contraparte,
                  contrapartida: nomeContraparte ?? ex.nome_contraparte,
                  cpf_cnpj: cpfCnpj ?? ex.cpf_cnpj,
                  tipo_transacao: tx.tipoTransacao ?? null,
                  chave_pix: chavePix ?? null,
                  payload_raw: tx,
                })
                .eq("id", ex.id);
            }
            skipped++;
            continue;
          }
        }

        // Dedup: if we HAVE a real ID, delete any fallback duplicate
        if (realEndToEndId) {
          const dateOnly = String(dataHora).substring(0, 10);
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
              .filter((p: any) => /^\d{4}-\d{2}-\d{2}-/.test(p.end_to_end_id) || /^webhook-/.test(p.end_to_end_id))
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

        // BUG E1 FIX: ignoreDuplicates: false → atualiza dados enriquecidos
        const { error: upsertErr } = await supabase
          .from("fin_extrato_inter")
          .upsert(record, { onConflict: "end_to_end_id", ignoreDuplicates: false });

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
    try {
      await supabase.from("fin_sync_log").insert({
        tipo: "inter_extrato_sync",
        status: errors > 0 ? "partial" : "success",
        duracao_ms: duracao,
        payload: { dataInicio, dataFim, endpoint: usedEndpoint },
        resposta: { total: transacoes.length, inserted, skipped, errors },
      });
    } catch (logErr) {
      console.error("[inter-extrato] Log error:", (logErr as Error).message);
    }

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
    const reconData = await reconRes.json().catch(() => ({ error: "parse error" }));

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

    try {
      await supabase.from("fin_sync_log").insert({
        tipo: "inter_extrato_sync",
        status: "error",
        duracao_ms: Date.now() - startMs,
        erro: msg,
      });
    } catch (logErr) {
      console.error("[inter-extrato] Log error:", (logErr as Error).message);
    }

    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
