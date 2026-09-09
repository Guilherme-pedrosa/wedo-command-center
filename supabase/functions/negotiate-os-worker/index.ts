// Worker que processa jobs da tabela fin_negociacao_jobs.
// Pode ser chamado via cron (sem body) ou diretamente com { job_id } para processar 1 job específico.
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

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

  // ── Autenticação: só serviço (cron/server-to-server) ou usuário autenticado
  // com permissão financeira podem acionar o worker. Nunca anônimo. ──
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  const isService = !!bearer && bearer === SERVICE_KEY;

  if (!isService) {
    if (!bearer || bearer === ANON_KEY) {
      return new Response(JSON.stringify({ error: "Não autenticado." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const authClient = createClient(SUPABASE_URL, ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${bearer}` } },
    });
    const { data: userData } = await authClient.auth.getUser();
    const userId = userData?.user?.id;
    if (!userId) {
      return new Response(JSON.stringify({ error: "Sessão inválida." }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const { data: permitido } = await authClient.rpc("has_financeiro_write", { _user_id: userId });
    if (!permitido) {
      return new Response(JSON.stringify({ error: "Sem permissão financeira." }), {
        status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_KEY);

  let requestedJobId: string | null = null;
  try {
    const body = await req.json().catch(() => ({}));
    if (body && typeof body === "object" && body.job_id) {
      requestedJobId = String(body.job_id);
    }
  } catch { /* sem body */ }


  // Reagenda jobs travados em "processando" há mais de 5 min como erro de timeout
  await supabase
    .from("fin_negociacao_jobs")
    .update({
      status: "erro",
      erro_msg: "Worker expirou (>5min em processamento). Verifique se a negociação foi parcialmente aplicada antes de tentar novamente.",
      finalizado_em: new Date().toISOString(),
    })
    .eq("status", "processando")
    .lt("iniciado_em", new Date(Date.now() - 5 * 60 * 1000).toISOString());

  // Pega o job alvo (específico se passado, senão o mais antigo pendente)
  let query = supabase
    .from("fin_negociacao_jobs")
    .select("id, payload, tentativas")
    .eq("status", "pendente")
    .order("created_at", { ascending: true })
    .limit(1);

  if (requestedJobId) {
    query = supabase
      .from("fin_negociacao_jobs")
      .select("id, payload, tentativas")
      .eq("id", requestedJobId)
      .eq("status", "pendente")
      .limit(1);
  }

  const { data: jobs, error: fetchErr } = await query;
  if (fetchErr) {
    return new Response(
      JSON.stringify({ error: fetchErr.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  const job = jobs?.[0];
  if (!job) {
    return new Response(
      JSON.stringify({ ok: true, message: "Nenhum job pendente" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  // Marca como processando (atomic-ish: confirma que ainda está pendente)
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabase
    .from("fin_negociacao_jobs")
    .update({
      status: "processando",
      iniciado_em: nowIso,
      tentativas: (job.tentativas || 0) + 1,
      progresso: "Executando negociação no GestãoClick...",
    })
    .eq("id", job.id)
    .eq("status", "pendente")
    .select("id")
    .maybeSingle();

  if (claimErr || !claimed) {
    return new Response(
      JSON.stringify({ ok: true, message: "Job já capturado por outro worker" }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }

  console.log(`[worker] Processando job ${job.id}`);

  try {
    // Invoca a action "execute" original do negotiate-os (server-to-server)
    // Pode demorar até 150s; o worker tem o mesmo limite mas o cliente não espera
    const execResp = await fetch(`${SUPABASE_URL}/functions/v1/negotiate-os`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ ...job.payload, action: "execute" }),
    });

    const respText = await execResp.text();
    let respJson: any;
    try { respJson = JSON.parse(respText); } catch { respJson = { raw: respText.slice(0, 500) }; }

    if (!execResp.ok) {
      const errMsg = respJson?.error || `HTTP ${execResp.status}`;
      await supabase
        .from("fin_negociacao_jobs")
        .update({
          status: "erro",
          erro_msg: String(errMsg).slice(0, 1000),
          resultado: respJson,
          finalizado_em: new Date().toISOString(),
          progresso: "Falhou",
        })
        .eq("id", job.id);
      console.error(`[worker] Job ${job.id} falhou: ${errMsg}`);
      return new Response(
        JSON.stringify({ ok: false, job_id: job.id, error: errMsg }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const okCount = respJson?.summary?.ok || 0;
    const errCount = respJson?.summary?.errors || 0;
    const pendencias = Array.isArray(respJson?.pendencias) ? respJson.pendencias : [];
    const sucesso = respJson?.success !== false;
    const composicaoCompleta = respJson?.composicao_incompleta !== true;

    // Nunca declarar "concluido" com erros, success=false, pendências de
    // vínculo ou composição incompleta — isso mascara negociação parcial.
    const concluiu = errCount === 0 && sucesso && composicaoCompleta && pendencias.length === 0;

    const motivo = !sucesso
      ? "A função de negociação retornou success=false"
      : errCount > 0
        ? `${errCount} erro(s) na execução`
        : !composicaoCompleta
          ? "Composição da negociação incompleta"
          : pendencias.length > 0
            ? `${pendencias.length} pendência(s) de vínculo`
            : "";

    await supabase
      .from("fin_negociacao_jobs")
      .update({
        status: concluiu ? "concluido" : "erro",
        resultado: respJson,
        ok_count: okCount,
        erro_count: errCount,
        erro_msg: concluiu ? null : `Negociação parcial: ${motivo}. Revise antes de tentar novamente.`.slice(0, 1000),
        finalizado_em: new Date().toISOString(),
        progresso: concluiu
          ? `✅ ${okCount} OS negociada(s) com sucesso`
          : `⚠️ Parcial — ${okCount} OK, ${motivo}`,
      })
      .eq("id", job.id);

    console.log(`[worker] Job ${job.id} ${concluiu ? "concluído" : "PARCIAL"}: ${okCount} OK / ${errCount} erros / ${pendencias.length} pendências`);
    return new Response(
      JSON.stringify({ ok: concluiu, job_id: job.id, ok_count: okCount, erro_count: errCount, pendencias: pendencias.length }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }

    );
  } catch (err) {
    const msg = (err as Error)?.message || String(err);
    console.error(`[worker] Job ${job.id} exception:`, msg);
    await supabase
      .from("fin_negociacao_jobs")
      .update({
        status: "erro",
        erro_msg: msg.slice(0, 1000),
        finalizado_em: new Date().toISOString(),
        progresso: "Falhou (exceção)",
      })
      .eq("id", job.id);
    return new Response(
      JSON.stringify({ ok: false, job_id: job.id, error: msg }),
      { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
