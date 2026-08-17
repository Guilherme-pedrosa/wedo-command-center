// Busca o total de comissões/premiações no projeto "Auvo GC Sync" (tela de Premiação).
// Fonte oficial: edge function `premiacao` daquele projeto (totais.comissao_final).
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const AUVO_URL = "https://bysljmkwkxrkovsaodxv.supabase.co/functions/v1/premiacao";
const AUVO_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJ5c2xqbWt3a3hya292c2FvZHh2Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMyNTU5NDIsImV4cCI6MjA4ODgzMTk0Mn0.MeOJPCPTB4gWuDnpIEA5btGgfAOvd63bOm0ApMf4eZA";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    let month = String(body?.month || "");
    if (!month) {
      const y = Number(body?.year);
      const m = Number(body?.month_number ?? body?.mes);
      if (!y || !m) throw new Error("Informe { month: 'YYYY-MM' } ou { year, month_number }");
      month = `${y}-${String(m).padStart(2, "0")}`;
    }

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
    const payload = {
      ok: true,
      month,
      comissao_total: Number(t.comissao_total) || 0,
      comissao_final: Number(t.comissao_final ?? t.comissao_total) || 0,
      reducao_valor: Number(t.reducao_valor) || 0,
      bonus_meta_valor: Number(t.bonus_meta_valor) || 0,
      bonus_telemetria_valor: Number(t.bonus_telemetria_valor) || 0,
      faturamento_premiacao: Number(t.faturamento) || 0,
      os_count: Number(t.os_count) || 0,
    };

    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
