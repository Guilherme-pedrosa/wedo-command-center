import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { financialActor, financialErrorStatus } from "../_shared/financial-auth.ts";

const headers = {
  "X-Wedo-Negotiation-Protocol": "20260909-v2",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Content-Type": "application/json",
};

// Este fluxo antigo identificava passivos por descrição e podia alterar títulos de outro acordo.
// A escrita de títulos negociados pertence exclusivamente ao executor com plano e reserva.
serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers });
  if (req.method !== "POST") return new Response(JSON.stringify({ error: "Método não permitido" }), { status: 405, headers });
  try {
    const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, key);
    await financialActor(req, admin, key);
    return new Response(JSON.stringify({
      success: false,
      error: "Atualização legada de passivos desativada. Use a conferência de saldos para leitura e a negociação com plano validado para alterar títulos.",
      code: "LEGACY_TAGGING_DISABLED",
    }), { status: 409, headers });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error instanceof Error ? error.message : String(error) }), { status: financialErrorStatus(error), headers });
  }
});
