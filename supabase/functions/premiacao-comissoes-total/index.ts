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

const CACHE_STALE_MS = 24 * 60 * 60 * 1000;

// A Premiação (outro projeto) leva mais de 150 s para montar um mês frio. Nenhum navegador
// espera isso — e esperar não é a resposta certa: o número já calculado serve.
// Então: responde na hora com o cache do banco e recalcula em segundo plano (waitUntil),
// que sobrevive ao fim da resposta. O cron mantém o mês corrente quente.
async function recalcular(month: string): Promise<{ comissao_final: number } | null> {
  const resp = await fetch(AUVO_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: AUVO_ANON, Authorization: `Bearer ${AUVO_ANON}` },
    body: JSON.stringify({ month }),
  });
  const data = await resp.json().catch(() => null);
  if (!resp.ok || !data || data.ok === false) {
    console.error(`[premiacao] ${month} falhou: HTTP ${resp.status} ${data?.error ?? ""}`);
    return null;
  }
  const t = data.totais || {};
  const comissao_final = Number(t.comissao_final ?? t.comissao_total) || 0;
  // Um zero (mês sem OS processada ainda) nunca sobrescreve um valor bom já gravado.
  if (!(comissao_final > 0)) {
    console.warn(`[premiacao] ${month} veio 0 — cache preservado`);
    return null;
  }
  const agora = new Date().toISOString();
  const sb = admin();
  const { data: anterior } = await sb.from("fin_premiacao_cache").select("versao").eq("mes", month).maybeSingle();
  const { error } = await sb.from("fin_premiacao_cache").upsert({
    mes: month,
    comissao_final,
    comissao_total: Number(t.comissao_total) || 0,
    faturamento_premiacao: Number(t.faturamento) || 0,
    origem: "premiacao",
    versao: (Number(anterior?.versao) || 0) + 1,
    calculado_em: agora,
    updated_at: agora,
  }, { onConflict: "mes" });
  if (error) console.error(`[premiacao] ${month} upsert falhou: ${error.message}`);
  return { comissao_final };
}

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
    const aguardar = body?.aguardar === true;

    const { data: cache } = await admin()
      .from("fin_premiacao_cache")
      .select("comissao_final, comissao_total, faturamento_premiacao, calculado_em, versao")
      .eq("mes", month)
      .maybeSingle();

    if (aguardar || !cache) {
      // Sem cache não há o que devolver: aqui vale esperar o cálculo (uso do cron).
      const calc = await recalcular(month);
      const { data: novo } = await admin()
        .from("fin_premiacao_cache")
        .select("comissao_final, comissao_total, faturamento_premiacao, calculado_em, versao")
        .eq("mes", month)
        .maybeSingle();
      if (!novo) {
        return json({ ok: false, month, error: calc ? "cache não gravado" : "Premiação indisponível e sem valor anterior" });
      }
      return json({
        ok: true, month, origem: "premiacao", degradado: false, atualizando: false,
        calculado_em: novo.calculado_em, versao: novo.versao,
        comissao_final: Number(novo.comissao_final) || 0,
        comissao_total: Number(novo.comissao_total) || 0,
        faturamento_premiacao: Number(novo.faturamento_premiacao) || 0,
      });
    }

    const idade = Date.now() - new Date(String(cache.calculado_em)).getTime();
    // Recalcula em segundo plano — a resposta não espera.
    try {
      (globalThis as { EdgeRuntime?: { waitUntil: (p: Promise<unknown>) => void } }).EdgeRuntime
        ?.waitUntil(recalcular(month).catch(() => null));
    } catch { /* runtime sem waitUntil */ }

    return json({
      ok: true,
      month,
      origem: idade > CACHE_STALE_MS ? "cache" : "premiacao",
      degradado: idade > CACHE_STALE_MS,
      atualizando: true,
      calculado_em: cache.calculado_em,
      versao: cache.versao,
      comissao_final: Number(cache.comissao_final) || 0,
      comissao_total: Number(cache.comissao_total) || 0,
      faturamento_premiacao: Number(cache.faturamento_premiacao) || 0,
    });
  } catch (error) {
    return json({ ok: false, month, error: (error as Error).message });
  }
});
