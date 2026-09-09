// NFSe annotation preserves financial fields
import { GC_API_USER_ID, installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { financialActor, financialErrorStatus } from "../_shared/financial-auth.ts";
import { assertNegotiationSettlement, settlementCents } from "../_shared/negotiation-settlement.ts";
import { buildReceivableNfsePayload, assertReceivableNfseConfirmed } from "../_shared/receivable-nfse.ts";

const corsHeaders = {
  "X-Wedo-Negotiation-Protocol": "20260909-v2",
  "X-Wedo-Nfse-Protocol": "20260909-v2",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
let lastCallTime = 0;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < MIN_DELAY_MS) {
    await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  }
  lastCallTime = Date.now();
  return fetch(url, options);
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const body = await req.json();
    const {
      endpoint,
      method = "GET",
      payload,
      params,
      operation,
    } = body as {
      endpoint: string;
      method?: string;
      payload?: Record<string, unknown>;
      params?: Record<string, string>;
      operation?: string;
    };

    if (!endpoint || !/^\/api\/[a-z_]+(?:\/[0-9]+)?$/.test(endpoint)) {
      return new Response(JSON.stringify({ error: "Missing 'endpoint' parameter" }), {
        status: 400,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const admin = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);
    const verb = method.toUpperCase();
    if (!["GET", "POST", "PUT", "PATCH", "DELETE"].includes(verb)) throw new Error("Método inválido");
    const authorization = req.headers.get("authorization") || "";
    if (authorization !== `Bearer ${serviceKey}`) {
      const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
      if (!token) throw new Error("UNAUTHORIZED: sessão obrigatória");
      const { data, error } = await admin.auth.getUser(token);
      if (error || !data?.user) throw new Error("UNAUTHORIZED: sessão inválida");
    }
    if (verb !== "GET" && /^\/api\/(recebimentos|pagamentos)(?:\/|$)/.test(endpoint)) {
      await financialActor(req, admin, serviceKey);
    }

    // O proxy é a fronteira central: qualquer usuario_id recebido do cliente é
    // descartado e substituído pelo usuário técnico da API.
    const url = new URL(`${GC_BASE_URL}${endpoint}`);
    if (params && Object.keys(params).length > 0) {
      for (const [key, value] of Object.entries(params)) {
        url.searchParams.set(key, String(value));
      }
    }
    url.searchParams.set("usuario_id", GC_API_USER_ID);

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
      "usuario-id": GC_API_USER_ID,
    };
    const readFreshReceipt = async (id: string) => {
      const result = await rateLimitedFetch(`${GC_BASE_URL}/api/recebimentos/${id}`, { headers: gcHeaders });
      const body = await result.json();
      const record = body?.data?.data ?? body?.data ?? body;
      if (
        !result.ok ||
        Number(body?.code ?? 200) >= 400 ||
        ["error", "erro"].includes(body?.status) ||
        String(record?.id) !== id
      )
        throw new Error(`Título GC ${id} não pôde ser confirmado.`);
      return record;
    };
    const osId = endpoint.match(/^\/api\/ordens_servicos\/([0-9]+)$/)?.[1];
    if (verb !== "GET" && /^\/api\/ordens_servicos(?:\/|$)/.test(endpoint)) {
      const financialFields = [
        "pagamentos",
        "forma_pagamento_id",
        "condicao_pagamento",
        "numero_parcelas",
        "data_primeira_parcela",
        "intervalo_dias",
      ];
      if (
        financialFields.some((field) => payload && Object.hasOwn(payload, field)) ||
        ["8896431", "7063724"].includes(String(payload?.situacao_id))
      )
        await financialActor(req, admin, serviceKey);
      if (osId) {
        const osResponse = await rateLimitedFetch(`${GC_BASE_URL}/api/ordens_servicos/${osId}`, { headers: gcHeaders });
        const osBody = await osResponse.json();
        const os = osBody?.data?.data ?? osBody?.data ?? osBody;
        if (!osResponse.ok || Number(osBody?.code ?? 200) >= 400 || String(os?.id) !== osId || !os.codigo)
          throw new Error("OS não pôde ser conferida antes da alteração.");
        const { data: groups, error: groupError } = await admin
          .from("fin_grupos_receber")
          .select("id")
          .contains("os_codigos", [String(os.codigo)])
          .not("negociacao_numero", "is", null)
          .neq("status", "cancelado")
          .limit(1);
        const { data: reservations, error: reservationError } = await admin
          .from("fin_negociacao_reservas")
          .select("id")
          .eq("origin_key", `os:${osId}`)
          .in("estado", ["reservado", "consumido"])
          .limit(1);
        if (groupError || reservationError) throw new Error(groupError?.message || reservationError?.message);
        if (groups?.length || reservations?.length)
          throw new Error(
            "OS vinculada ou reservada em negociação: alteração pelo proxy bloqueada; use a operação auditada do acordo.",
          );
      }
    }
    let verifiedPayload = payload;
    const receiptId = endpoint.match(/^\/api\/recebimentos\/([0-9]+)$/)?.[1];
    if (operation && (operation !== "receivable_nfse" || verb !== "PUT" || !receiptId))
      throw new Error("Operação de NFS-e inválida.");
    let nfseBefore: Record<string, any> | undefined;
    if (endpoint === "/api/recebimentos" && verb !== "GET" && (verb !== "POST" || payload?.id !== undefined))
      throw new Error("Alteração financeira sem identidade individual não é permitida.");
    if (receiptId && verb !== "GET") {
      const fresh = await readFreshReceipt(receiptId);
      if (operation === "receivable_nfse") {
        verifiedPayload = buildReceivableNfsePayload(fresh, payload || {});
        nfseBefore = fresh;
      } else {
        const grouped = await assertNegotiationSettlement(admin, receiptId, fresh, readFreshReceipt);
        if (
          grouped &&
          (verb !== "PUT" ||
            ![1, "1", true].includes(payload?.liquidado as any) ||
            settlementCents(payload?.valor) !== settlementCents(fresh.valor ?? fresh.valor_total) ||
            String(payload?.cliente_id) !== String(fresh.cliente_id) ||
            String(payload?.data_vencimento) !== String(fresh.data_vencimento))
        ) {
          throw new Error("Alteração de título negociado exige operação de renegociação auditada");
        }
        if (grouped) {
          // Settlement may change only payment state/date. Preserve current GC financial
          // fields so a direct caller cannot inject discounts or move the title's owner.
          const paymentDate = String(payload?.data_liquidacao ?? "");
          if (
            !/^\d{4}-\d{2}-\d{2}$/.test(paymentDate) ||
            new Date(`${paymentDate}T12:00:00Z`).toISOString().slice(0, 10) !== paymentDate
          )
            throw new Error("Data de liquidação inválida");
          verifiedPayload = { liquidado: 1, data_liquidacao: paymentDate };
          for (const field of [
            "descricao",
            "data_vencimento",
            "data_competencia",
            "valor",
            "plano_contas_id",
            "forma_pagamento_id",
            "conta_bancaria_id",
            "cliente_id",
            "entidade",
            "centro_custo_id",
            "juros",
            "multa",
            "desconto",
            "taxa_banco",
            "taxa_operadora",
            "funcionario_id",
            "transportadora_id",
            "rateios",
            "atributos",
          ]) {
            if (fresh[field] !== undefined && fresh[field] !== null && fresh[field] !== "")
              verifiedPayload[field] = fresh[field];
          }
          verifiedPayload.valor ??= fresh.valor_total;
        }
      }
    }

    const fetchOptions: RequestInit = {
      method: method.toUpperCase(),
      headers: gcHeaders,
    };

    if (verifiedPayload && ["POST", "PUT", "PATCH"].includes(method.toUpperCase())) {
      const protectedPayload =
        typeof verifiedPayload === "object" && !Array.isArray(verifiedPayload)
          ? { ...verifiedPayload, usuario_id: GC_API_USER_ID }
          : verifiedPayload;
      fetchOptions.body = JSON.stringify(protectedPayload);
    }

    const startTime = Date.now();
    const response = await rateLimitedFetch(url.toString(), fetchOptions);
    const duration = Date.now() - startTime;

    const responseText = await response.text();
    let responseData: unknown;
    try {
      responseData = JSON.parse(responseText);
    } catch {
      responseData = responseText;
    }

    if (nfseBefore) {
      const result = responseData as any;
      if (!response.ok || Number(result?.code ?? 200) >= 400 || ["error", "erro"].includes(result?.status))
        throw new Error("GC recusou a vinculação da NFS-e.");
      const confirmed = await readFreshReceipt(receiptId!);
      assertReceivableNfseConfirmed(nfseBefore, confirmed, verifiedPayload!);
      const { error: auditError } = await admin.from("fin_sync_log").insert({
        tipo: "gc_recebimento_nfse",
        status: "success",
        resposta: {
          gc_id: receiptId,
          nfse_numero: payload?.nfse_numero,
          financeiro_preservado: true,
        },
      });
      if (auditError) throw new Error(`NFS-e conferida, mas auditoria falhou: ${auditError.message}`);
      responseData = { code: 200, data: confirmed };
    }

    // ── Enriquecimento de CNPJ removido daqui ──
    // Causava timeout (300+ chamadas sequenciais por request).
    // Deve rodar em job separado, não no proxy hot-path.

    return new Response(
      JSON.stringify({
        status: response.status,
        data: responseData,
        duration_ms: duration,
      }),
      {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      status: financialErrorStatus(error),
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
