import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const jsonResponse = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...corsHeaders, "Content-Type": "application/json" },
});

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase = createClient(supabaseUrl, serviceKey);
  const body = await req.json().catch(() => ({}));
  const today = new Date().toISOString().slice(0, 10);
  const inferredStart = new Date(Date.now() - 89 * 86400000).toISOString().slice(0, 10);
  const dataInicio = String(body.dataInicio ?? inferredStart);
  const dataFim = String(body.dataFim ?? today);
  const rootDataInicio = String(body.root_data_inicio ?? dataInicio);
  const existingJobId = typeof body.job_id === "string" ? body.job_id : null;
  const jobId = existingJobId ?? crypto.randomUUID();
  const force = body.force === true;
  const accumulated = {
    total: Number(body?.accumulated?.total ?? 0),
    inserted: Number(body?.accumulated?.inserted ?? 0),
    skipped: Number(body?.accumulated?.skipped ?? 0),
    chunks: Number(body?.accumulated?.chunks ?? 0),
    runs: Number(body?.accumulated?.runs ?? 0),
  };

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataInicio) || !/^\d{4}-\d{2}-\d{2}$/.test(dataFim) || dataInicio > dataFim) {
    return jsonResponse({ success: false, error: "Período inválido; use YYYY-MM-DD" }, 400);
  }

  if (!existingJobId && !force) {
    const recentFloor = new Date(Date.now() - 25 * 60 * 1000).toISOString();
    const { data: recent } = await supabase.from("fin_sync_log")
      .select("id,status,created_at")
      .eq("tipo", "financial_reconciliation_pipeline")
      .in("status", ["running", "success"])
      .gte("created_at", recentFloor)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recent) {
      return jsonResponse({
        success: true,
        skipped: true,
        reason: "pipeline recente já executado ou em andamento",
        job_id: recent.id,
        status: recent.status,
      });
    }
  }

  if (!existingJobId) {
    const { error } = await supabase.from("fin_sync_log").insert({
      id: jobId,
      tipo: "financial_reconciliation_pipeline",
      status: "running",
      payload: { dataInicio: rootDataInicio, dataFim, stage: "queued", source: body.source ?? "unknown" },
    });
    if (error) return jsonResponse({ success: false, error: error.message }, 500);
  }

  const run = async () => {
    const startedAt = Date.now();
    try {
      await supabase.from("fin_sync_log").update({
        status: "running",
        payload: { dataInicio: rootDataInicio, dataFim, cursor: dataInicio, stage: "inter_extrato", accumulated },
      }).eq("id", jobId);

      const interResponse = await fetch(`${supabaseUrl}/functions/v1/inter-extrato`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({ dataInicio, dataFim }),
      });
      const interText = await interResponse.text();
      let inter: any = null;
      try { inter = JSON.parse(interText); } catch { inter = { raw: interText }; }
      if (!interResponse.ok || inter?.success === false) {
        throw new Error(inter?.error ?? `inter-extrato HTTP ${interResponse.status}: ${interText.slice(0, 300)}`);
      }

      const ext = inter?.extrato ?? {};
      const nextAccumulated = {
        total: accumulated.total + Number(ext.total ?? 0),
        inserted: accumulated.inserted + Number(ext.inserted ?? 0),
        skipped: accumulated.skipped + Number(ext.skipped ?? 0),
        chunks: accumulated.chunks + Number(ext.chunks_processados ?? ext.chunks ?? 0),
        runs: accumulated.runs + 1,
      };

      if (ext.truncado === true) {
        const nextStart = String(ext?.proximo_periodo?.dataInicio ?? "");
        if (!nextStart || nextStart <= dataInicio || nextStart > dataFim) {
          throw new Error(`Importação parcial sem continuação válida após ${dataInicio}`);
        }

        await supabase.from("fin_sync_log").update({
          status: "running",
          resposta: { stage: "inter_partial", next_start: nextStart, accumulated: nextAccumulated },
          payload: { dataInicio: rootDataInicio, dataFim, cursor: nextStart, stage: "inter_continuation" },
          duracao_ms: Date.now() - startedAt,
        }).eq("id", jobId);

        const continuation = await fetch(`${supabaseUrl}/functions/v1/financial-reconciliation-pipeline`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
          body: JSON.stringify({
            dataInicio: nextStart,
            dataFim,
            root_data_inicio: rootDataInicio,
            job_id: jobId,
            accumulated: nextAccumulated,
            source: "continuation",
          }),
        });
        if (!continuation.ok) {
          throw new Error(`Falha ao encadear continuação do Inter: HTTP ${continuation.status}`);
        }
        return;
      }

      await supabase.from("fin_sync_log").update({
        status: "running",
        payload: { dataInicio: rootDataInicio, dataFim, stage: "reconciliation", accumulated: nextAccumulated },
      }).eq("id", jobId);

      const reconResponse = await fetch(`${supabaseUrl}/functions/v1/reconciliation-engine`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          dateFrom: `${rootDataInicio}T00:00:00-03:00`,
          dateTo: `${dataFim}T23:59:59-03:00`,
          limit: 2000,
        }),
      });
      const reconText = await reconResponse.text();
      let reconciliation: any = null;
      try { reconciliation = JSON.parse(reconText); } catch { reconciliation = { raw: reconText }; }
      if (!reconResponse.ok || (reconciliation?.success === false && reconciliation?.partial !== true)) {
        throw new Error(reconciliation?.error ?? `reconciliation-engine HTTP ${reconResponse.status}: ${reconText.slice(0, 300)}`);
      }

      const baixaResponse = await fetch(`${supabaseUrl}/functions/v1/argus-baixa-confirmada`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
        body: JSON.stringify({
          mode: "auto",
          scope: "ambos",
          dataInicio: rootDataInicio,
          dataFim,
          forceConfirmSituacao: true,
          background: true,
          parent_run_id: jobId,
        }),
      });
      const baixaText = await baixaResponse.text();
      let baixa: any = null;
      try { baixa = JSON.parse(baixaText); } catch { baixa = { raw: baixaText }; }
      if (!baixaResponse.ok || baixa?.ok === false) {
        throw new Error(baixa?.error ?? `argus-baixa-confirmada HTTP ${baixaResponse.status}`);
      }

      const finalStatus = reconciliation?.partial === true ? "partial" : "success";
      await supabase.from("fin_sync_log").update({
        status: finalStatus,
        erro: finalStatus === "partial" ? `${reconciliation?.stats?.errors ?? 0} erro(s) na conciliação` : null,
        resposta: {
          extrato: nextAccumulated,
          reconciliacao: reconciliation?.stats ?? null,
          baixa_gc: { status: baixa?.status, job_id: baixa?.job_id, total: baixa?.total },
        },
        payload: { dataInicio: rootDataInicio, dataFim, stage: "complete" },
        duracao_ms: Date.now() - startedAt,
      }).eq("id", jobId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await supabase.from("fin_sync_log").update({
        status: "error",
        erro: message,
        payload: { dataInicio: rootDataInicio, dataFim, cursor: dataInicio, stage: "failed" },
        duracao_ms: Date.now() - startedAt,
      }).eq("id", jobId);
    }
  };

  const task = run();
  // @ts-ignore EdgeRuntime é fornecido pelo runtime da Supabase.
  if (typeof EdgeRuntime !== "undefined" && typeof EdgeRuntime.waitUntil === "function") {
    // @ts-ignore
    EdgeRuntime.waitUntil(task);
  } else {
    await task;
  }

  return jsonResponse({ success: true, status: "running", job_id: jobId, dataInicio, dataFim }, 202);
});
