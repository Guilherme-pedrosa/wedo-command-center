import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { financialActor, financialErrorStatus } from "../_shared/financial-auth.ts";
import { scanNegotiationResiduals } from "../_shared/negotiation-scan.ts";

const cors = { "X-Wedo-Negotiation-Protocol": "20260909-v2", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version" };
const reply = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { ...cors, "Content-Type": "application/json" } });
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return reply({ error: "Método não permitido." }, 405);
  try {
    const service = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, service);
    await financialActor(req, supabase, service);
    let last = 0;
    const gc = async (endpoint: string) => {
      if (!/^\/api\/recebimentos(\/\d+)?(\?.*)?$/.test(endpoint)) throw new Error("Endpoint inválido.");
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 350 - (Date.now() - last))));
      last = Date.now();
      const result = await fetch(`https://api.gestaoclick.com${endpoint}`, { headers: { "access-token": Deno.env.get("GC_ACCESS_TOKEN") ?? "", "secret-access-token": Deno.env.get("GC_SECRET_TOKEN") ?? "" } });
      if (!result.ok) throw Object.assign(new Error(`GC HTTP ${result.status}; nenhuma remoção aplicada.`), { status: result.status });
      const value = await result.json();
      if (value.success === false || ["error", "erro"].includes(value.status) || Number(value.code ?? 200) >= 400 || value.errors) throw new Error("GC retornou erro de negócio.");
      return value;
    };
    const result = await scanNegotiationResiduals(supabase, gc);
    const { error: logError } = await supabase.from("fin_sync_log").insert({ tipo: "scan_passivos", status: result.success ? "success" : "partial", resposta: result });
    if (logError) { result.success = false; result.partial = true; result.errors.push(`Falha ao registrar a conferência: ${logError.message}`); }
    return reply(result);
  } catch (error) { return reply({ success: false, error: error instanceof Error ? error.message : String(error) }, financialErrorStatus(error)); }
});
