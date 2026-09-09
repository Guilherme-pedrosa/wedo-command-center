// Negotiation integrity protocol: 20260909-v2.
import { GC_API_USER_ID, installGcUsuarioId } from "../_shared/gc-user.ts";
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { negotiationRequest } from "../_shared/negotiation-service.ts";
import { negotiationCents } from "../_shared/negotiation-plan.ts";
installGcUsuarioId();

serve(async (req) =>
  negotiationRequest(req, {
    supabase: createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!),
    serviceKey: Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    url: Deno.env.get("SUPABASE_URL")!,
    gcHeaders: {
      "access-token": Deno.env.get("GC_ACCESS_TOKEN") ?? "",
      "secret-access-token": Deno.env.get("GC_SECRET_TOKEN") ?? "",
      "Content-Type": "application/json",
    },
    technicalUser: GC_API_USER_ID,
    resolveOsTotal: (raw) => negotiationCents(raw.valor_total) / 100,
    fetch,
  }),
);
