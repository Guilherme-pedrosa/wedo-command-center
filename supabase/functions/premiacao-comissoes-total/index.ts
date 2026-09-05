// Busca o total de comissões/premiações no projeto "Auvo GC Sync" (tela de Premiação).
// Fonte oficial: edge function `premiacao` daquele projeto (totais.comissao_final).
//
// O valor é persistido em fin_premiacao_cache. Motivo: o cache no navegador não serve para
// nada em outro dispositivo nem no relatório público — quando a origem cai, o número virava
// R$ 0 "verde". Aqui, se a origem falhar, devolvemos o último valor bom com origem = "cache".
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AUVO_URL = "https://bysljmkwkxrkovsaodxv.supabase.co/functions/v1/premiacao";
const AUVO_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5c2xqbWt3a3hya292c2FvZHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTU5NDIsImV4cCI6MjA4ODgzMTk0Mn0.MeOJPCPTB4gWuDnpIEA5btGgfAOvd63bOm0ApMf4eZA";

const admin = () =>
  createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } },
  );

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  let month = "";
  try {
    const body = await req.json().catch(() => ({}));
    month = String(body?.month || "");
    if (!month) {
      const y = Number(body?.year);
      const m = Number(body?.month_number ?? body?.mes);
      if (!y || !m) throw new Error("Informe { month: 'YYYY-MM' } ou { year, month_number }");
      month = `${y}-${String(m).padStart(2, "0")}`;
    }
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("month deve ser 'YYYY-MM'");

    const resp = await fetch(AUVO_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: AUVO_ANON,
        Authorization: `Bearer ${AUVO_ANON}`,
      },
      body: JSON.stringify({ month }),
    });

    const data = await resp.json().catch(() => null);
    if (!resp.ok || !data || data.ok === false) {
      throw new Error(data?.error || `Falha ao consultar Premiação (HTTP ${resp.status})`);
    }

    const t = data.totais || {};
    const comissao_final = Number(t.comissao_final ?? t.comissao_total) || 0;
    const comissao_total = Number(t.comissao_total) || 0;
    const faturamento_premiacao = Number(t.faturamento) || 0;
    const calculado_em = new Date().toISOString();

    // Só grava valor plausível: um 0 vindo de mês incompleto não pode sobrescrever histórico bom.
    if (comissao_final > 0) {
      const sb = admin();
      const { data: anterior } = await sb
        .from("fin_premiacao_cache")
        .select("versao")
        .eq("mes", month)
        .maybeSingle();
      await sb.from("fin_premiacao_cache").upsert(
        {
          mes: month,
          comissao_final,
          comissao_total,
          faturamento_premiacao,
          origem: "premiacao",
          versao: (Number(anterior?.versao) || 0) + 1,
          calculado_em,
          updated_at: calculado_em,
        },
        { onConflict: "mes" },
      );
    }

    return json({
      ok: true,
      month,
      origem: "premiacao",
      calculado_em,
      comissao_total,
      comissao_final,
      reducao_valor: Number(t.reducao_valor) || 0,
      bonus_meta_valor: Number(t.bonus_meta_valor) || 0,
      bonus_telemetria_valor: Number(t.bonus_telemetria_valor) || 0,
      faturamento_premiacao,
      os_count: Number(t.os_count) || 0,
    });
  } catch (error) {
    // Origem indisponível: devolve o último valor calculado, marcado como cache.
    const mensagem = (error as Error).message;
    if (/^\d{4}-\d{2}$/.test(month)) {
      try {
        const { data: cache } = await admin()
          .from("fin_premiacao_cache")
          .select("comissao_final, comissao_total, faturamento_premiacao, calculado_em, versao")
          .eq("mes", month)
          .maybeSingle();
        if (cache) {
          return json({
            ok: true,
            month,
            origem: "cache",
            degradado: true,
            erro_origem: mensagem,
            calculado_em: cache.calculado_em,
            versao: cache.versao,
            comissao_total: Number(cache.comissao_total) || 0,
            comissao_final: Number(cache.comissao_final) || 0,
            faturamento_premiacao: Number(cache.faturamento_premiacao) || 0,
            reducao_valor: 0,
            bonus_meta_valor: 0,
            bonus_telemetria_valor: 0,
            os_count: 0,
          });
        }
      } catch { /* sem cache disponível */ }
    }
    return json({ ok: false, month, error: mensagem });
  }
});
