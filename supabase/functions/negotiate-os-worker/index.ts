import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = { "X-Wedo-Negotiation-Protocol": "20260909-v2", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type" };
const respond = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { ...cors, "Content-Type": "application/json" } });

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  const url = Deno.env.get("SUPABASE_URL")!;
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  if (!key || req.headers.get("authorization") !== `Bearer ${key}`) return respond({ error: "Worker exclusivo de serviço autenticado." }, 403);
  if (req.method !== "POST") return respond({ error: "Método não permitido." }, 405);
  const supabase = createClient(url, key);
  const body = await req.json().catch(() => ({}));
  let query = supabase.from("fin_negociacao_jobs").select("id,status").eq("status", "pendente").order("created_at", { ascending: true }).limit(1);
  if (body.job_id) query = query.eq("id", String(body.job_id));
  const { data: jobs, error } = await query;
  if (error) return respond({ error: error.message }, 500);
  const job = jobs?.[0];
  if (!job) return respond({ ok: true, message: "Nenhum job pendente. Execuções com efeitos incertos permanecem reservadas para conferência." });
  const token = crypto.randomUUID();
  try {
    // The executor claims atomically and reads the persisted payload, never a caller-supplied payload.
    const result = await fetch(`${url}/functions/v1/negotiate-os`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ action: "execute", _job_id: job.id, _execution_token: token }),
    });
    const text = await result.text();
    let value: any;
    try { value = JSON.parse(text); } catch { throw new Error(`Resposta inválida do executor (HTTP ${result.status}).`); }
    const complete = result.ok && value.success === true && value.integrity_verified === true && value.summary?.errors === 0;
    // Finalization belongs to the executor RPC; a competing worker never overwrites it.
    return respond({ ok: complete, job_id: job.id, ...value }, complete ? 200 : 409);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase.from("fin_negociacao_jobs").update({ status: "erro", erro_msg: `Efeito externo incerto: ${message}`.slice(0, 1000), progresso: "Conferência necessária; origens continuam reservadas." }).eq("id", job.id).eq("execution_token", token).eq("status", "processando");
    return respond({ ok: false, job_id: job.id, pending_reconciliation: true, error: message }, 500);
  }
});
