import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
const SITUACAO_ORIGEM = "7116099"; // Executado - Ag Negociação Financeira
const SITUACAO_INTERMEDIARIA = "8896431"; // Ag Compra de Peças (permite editar pagamentos)
const SITUACAO_DESTINO = "7063724"; // Executado - Ag Pagamento
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

function extractText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value);
  if (!value || typeof value !== "object") return "";

  const obj = value as Record<string, unknown>;
  const preferred = [
    obj.nome,
    obj.descricao,
    obj.equipamento,
    obj.texto,
    obj.Equipamento,
    obj.equipamento_nome,
    obj.modelo,
    obj.identificacao,
  ];

  for (const candidate of preferred) {
    const text = extractText(candidate);
    if (text && text !== "[object Object]") return text;
  }

  for (const nested of Object.values(obj)) {
    const text = extractText(nested);
    if (text && text !== "[object Object]") return text;
  }

  return "";
}

function extractEquipamentoNome(equipamentos: unknown): string {
  if (!Array.isArray(equipamentos)) return "";

  return equipamentos
    .map((eq) => {
      const wrapper = eq && typeof eq === "object" ? (eq as Record<string, unknown>) : null;
      const raw = wrapper && wrapper.Equipamento && typeof wrapper.Equipamento === "object"
        ? wrapper.Equipamento
        : wrapper && wrapper.equipamento && typeof wrapper.equipamento === "object"
          ? wrapper.equipamento
          : eq;
      return extractText(raw);
    })
    .find(Boolean) || "";
}

interface NegotiateRequest {
  action: "list" | "execute";
  os_ids?: string[];
  parcelas?: number;
  dia_vencimento?: number;
  mes_inicio?: string; // YYYY-MM
  forma_pagamento_id?: string;
  nome_cliente?: string;
  cliente_gc_id?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const startTime = Date.now();

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");

    if (!gcAccessToken || !gcSecretToken) {
      return new Response(
        JSON.stringify({ error: "GC credentials not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const gcHeaders: Record<string, string> = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
    );

    const body: NegotiateRequest = await req.json();

    // ─── LIST ──────────────────────────────────────────────
    if (body.action === "list") {
      const allOS: Record<string, unknown>[] = [];
      let page = 1;
      let totalPages = 1;

      while (page <= totalPages) {
        const params = new URLSearchParams({
          limite: "100",
          pagina: String(page),
          situacao_id: SITUACAO_ORIGEM,
        });

        const response = await rateLimitedFetch(
          `${GC_BASE_URL}/api/ordens_servicos?${params.toString()}`,
          { headers: gcHeaders }
        );

        if (response.status === 429) {
          await new Promise((r) => setTimeout(r, 2000));
          continue;
        }

        if (!response.ok) {
          throw new Error(`GC API error: ${response.status}`);
        }

        const data = await response.json();
        const records = Array.isArray(data?.data) ? data.data : [];
        totalPages = data?.meta?.total_paginas || 1;

        allOS.push(...records);
        page++;
      }

      // Group by client
      const byClient: Record<string, { cliente_id: string; nome_cliente: string; os_list: any[]; valor_total: number }> = {};

      for (const os of allOS) {
        const clienteId = String(os.cliente_id || "sem_cliente");
        const nomeCliente = String(os.nome_cliente || "Sem cliente");

        if (!byClient[clienteId]) {
          byClient[clienteId] = {
            cliente_id: clienteId,
            nome_cliente: nomeCliente,
            os_list: [],
            valor_total: 0,
          };
        }

        const valor = parseFloat(String(os.valor_total || "0")) || 0;
        const equipamentos = Array.isArray(os.equipamentos) ? os.equipamentos : [];
        const nomeEquipamento = extractEquipamentoNome(equipamentos);
        const descricaoOS = extractText(os.descricao) || extractText(os.observacoes);

        byClient[clienteId].os_list.push({
          id: String(os.id),
          codigo: String(os.codigo || ""),
          descricao: nomeEquipamento || descricaoOS || "Sem descrição",
          valor_total: valor,
          nome_cliente: nomeCliente,
          data: String(os.data || ""),
          nome_situacao: String(os.nome_situacao || ""),
        });
        byClient[clienteId].valor_total += valor;
      }

      const clients = Object.values(byClient)
        .filter((c) => c.os_list.length > 0)
        .sort((a, b) => b.valor_total - a.valor_total);

      return new Response(
        JSON.stringify({
          success: true,
          total_os: allOS.length,
          clients,
          duration_ms: Date.now() - startTime,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // ─── EXECUTE ───────────────────────────────────────────
    if (body.action === "execute") {
      const { os_ids, parcelas, dia_vencimento, mes_inicio, nome_cliente, cliente_gc_id } = body;

      if (!os_ids?.length || !parcelas || !dia_vencimento || !mes_inicio) {
        return new Response(
          JSON.stringify({ error: "Missing required fields: os_ids, parcelas, dia_vencimento, mes_inicio" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Get sequential negotiation number
      const { data: negNumData, error: negNumErr } = await supabase.rpc("next_negociacao_number");
      const negociacao_numero = negNumErr ? Date.now() : (negNumData as number);
      console.log(`[negotiate-os] Negociação nº${negociacao_numero}`);

      // Generate due dates
      const [startYear, startMonth] = mes_inicio.split("-").map(Number);
      const dueDates: string[] = [];
      for (let i = 0; i < parcelas; i++) {
        const d = new Date(startYear, startMonth - 1 + i, dia_vencimento);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        dueDates.push(`${yyyy}-${mm}-${dd}`);
      }

      // 1. Fetch all OS details
      const osDetails: {
        id: string;
        codigo: string;
        tipo: string;
        cliente_id: string;
        data: string;
        valor_total: number;
        nome_cliente: string;
        nome_equipamento: string;
        raw: Record<string, unknown>;
      }[] = [];
      const gcUpdateResults: { os_id: string; status: string; error?: string }[] = [];

      for (const osId of os_ids) {
        try {
          const osResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${osId}`,
            { headers: gcHeaders }
          );

          if (!osResp.ok) {
            gcUpdateResults.push({ os_id: osId, status: "error", error: `Fetch failed: ${osResp.status}` });
            continue;
          }

          const osData = await osResp.json();
          const os = osData?.data || osData;
          const valorTotal = parseFloat(String(os.valor_total || "0")) || 0;

          if (valorTotal <= 0) {
            gcUpdateResults.push({ os_id: osId, status: "error", error: "Valor total = 0" });
            continue;
          }

          const nomeEquipamento = extractEquipamentoNome(os.equipamentos) || extractText(os.descricao) || extractText(os.observacoes);
          const dataBaseOS = String(os.data || os.data_saida || os.data_entrada || new Date().toISOString().slice(0, 10));

          osDetails.push({
            id: osId,
            codigo: String(os.codigo || ""),
            tipo: String(os.tipo || "servico"),
            cliente_id: String(os.cliente_id || ""),
            data: dataBaseOS,
            valor_total: valorTotal,
            nome_cliente: String(os.nome_cliente || nome_cliente || ""),
            nome_equipamento: nomeEquipamento,
            raw: (os && typeof os === "object" ? os : {}) as Record<string, unknown>,
          });
        } catch (err) {
          gcUpdateResults.push({ os_id: osId, status: "error", error: (err as Error).message });
        }
      }

      // 2. Three-step process for each OS:
      //    Step A: Move to intermediate status (Ag Compra de Peças) to allow editing
      //    Step B: Update pagamentos with negotiated installments
      //    Step C: Move to final status (Ag Pagamento) — GC generates the financial
      for (const os of osDetails) {
        try {
          // Build base payload preserving all OS fields
          const basePayload: Record<string, unknown> = {
            tipo: os.tipo,
            codigo: os.codigo,
            cliente_id: os.cliente_id,
            data: os.data,
          };

          const passthroughKeys = [
            "vendedor_id", "tecnico_id", "saida", "previsao_entrega",
            "transportadora_id", "centro_custo_id", "aos_cuidados_de",
            "validade", "introducao", "observacoes", "observacoes_interna",
            "valor_frete", "condicao_pagamento", "forma_pagamento_id",
            "data_primeira_parcela", "numero_parcelas", "intervalo_dias",
            "equipamentos", "pagamentos", "produtos", "servicos",
          ];

          for (const key of passthroughKeys) {
            const rawValue = os.raw[key];
            if (rawValue === undefined || rawValue === null) continue;
            if (key === "forma_pagamento_id" && String(rawValue).trim() === "") continue;
            basePayload[key] = rawValue;
          }

          // ── STEP A: Move to intermediate status ──
          console.log(`[negotiate-os] STEP A: OS ${os.id} → status intermediário (${SITUACAO_INTERMEDIARIA})`);
          const stepAPayload = { ...basePayload, situacao_id: SITUACAO_INTERMEDIARIA };

          const stepAResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(stepAPayload) }
          );
          const stepAData = await stepAResp.json();

          if (!stepAResp.ok && stepAData?.code !== 200) {
            gcUpdateResults.push({
              os_id: os.id, status: "error",
              error: `Step A failed: ${stepAData?.message || stepAResp.status}`,
            });
            continue;
          }
          console.log(`[negotiate-os] STEP A OK: OS ${os.id} movida para intermediário`);

          // Small delay between steps
          await new Promise((r) => setTimeout(r, 500));

          // ── STEP B: Edit pagamentos with negotiated installments ──
          console.log(`[negotiate-os] STEP B: OS ${os.id} → configurando ${parcelas} parcelas`);

          const valorOS = os.valor_total;
          const valorParcelaOS = Math.floor((valorOS / parcelas) * 100) / 100;
          const valorUltimaOS = Math.round((valorOS - valorParcelaOS * (parcelas - 1)) * 100) / 100;

          // Extract forma_pagamento and plano_contas from existing pagamentos
          const pagamentosRaw = Array.isArray(os.raw.pagamentos) ? os.raw.pagamentos : [];
          const primeiroPagamentoWrapper = (pagamentosRaw[0] && typeof pagamentosRaw[0] === "object")
            ? pagamentosRaw[0] as Record<string, unknown> : {};
          const primeiroPagamento = (
            (primeiroPagamentoWrapper.pagamento && typeof primeiroPagamentoWrapper.pagamento === "object" && primeiroPagamentoWrapper.pagamento) ||
            (primeiroPagamentoWrapper.Pagamento && typeof primeiroPagamentoWrapper.Pagamento === "object" && primeiroPagamentoWrapper.Pagamento) ||
            primeiroPagamentoWrapper
          ) as Record<string, unknown>;

          const formaPagamentoId = String(primeiroPagamento.forma_pagamento_id || basePayload["forma_pagamento_id"] || "");
          const nomeFormaPagamento = String(primeiroPagamento.nome_forma_pagamento || "");
          const planoContasId = String(primeiroPagamento.plano_contas_id || primeiroPagamento.categoria_id || "");
          const nomePlanoConta = String(primeiroPagamento.nome_plano_conta || primeiroPagamento.nome_categoria || "");

          const negTag = `NEG${negociacao_numero}`;

          const stepBPayload = {
            ...basePayload,
            situacao_id: SITUACAO_INTERMEDIARIA, // keep same status
            data_primeira_parcela: dueDates[0],
            numero_parcelas: String(parcelas),
            condicao_pagamento: parcelas > 1 ? "parcelado" : "a_vista",
            intervalo_dias: parcelas > 1
              ? String(Math.max(1, Math.round(
                  (new Date(`${dueDates[1]}T00:00:00Z`).getTime() - new Date(`${dueDates[0]}T00:00:00Z`).getTime()) /
                  (1000 * 60 * 60 * 24)
                )))
              : "0",
            pagamentos: dueDates.map((dt, idx) => {
              const descParcela = `${negTag} - Parcela ${idx + 1}/${parcelas} - OS ${os.codigo}`;
              const pagamento: Record<string, unknown> = {
                data_vencimento: dt,
                valor: (idx === parcelas - 1 ? valorUltimaOS : valorParcelaOS).toFixed(2),
                descricao: descParcela,
              };
              if (formaPagamentoId) pagamento.forma_pagamento_id = formaPagamentoId;
              if (nomeFormaPagamento) pagamento.nome_forma_pagamento = nomeFormaPagamento;
              if (planoContasId) {
                pagamento.plano_contas_id = planoContasId;
                pagamento.categoria_id = planoContasId;
              }
              if (nomePlanoConta) {
                pagamento.nome_plano_conta = nomePlanoConta;
                pagamento.nome_categoria = nomePlanoConta;
              }
              return { pagamento };
            }),
          };

          // Add negotiation note to observacoes
          const existingObs = String(stepBPayload["observacoes"] || "");
          stepBPayload["observacoes"] = existingObs
            ? `${existingObs}\nnegociado nº${negociacao_numero}`
            : `negociado nº${negociacao_numero}`;

          if (formaPagamentoId) {
            stepBPayload["forma_pagamento_id"] = formaPagamentoId;
          }

          const stepBResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(stepBPayload) }
          );
          const stepBData = await stepBResp.json();

          if (!stepBResp.ok && stepBData?.code !== 200) {
            gcUpdateResults.push({
              os_id: os.id, status: "error",
              error: `Step B failed: ${stepBData?.message || stepBResp.status}`,
            });
            continue;
          }
          console.log(`[negotiate-os] STEP B OK: OS ${os.id} parcelas configuradas`);

          await new Promise((r) => setTimeout(r, 500));

          // ── STEP C: Move to final status (Ag Pagamento) — triggers financial generation ──
          console.log(`[negotiate-os] STEP C: OS ${os.id} → status final (${SITUACAO_DESTINO})`);

          // Re-fetch OS to get the updated state after step B
          const refreshResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { headers: gcHeaders }
          );
          const refreshData = await refreshResp.json();
          const refreshedOS = refreshData?.data || refreshData;

          // Build step C payload from refreshed data
          const stepCPayload: Record<string, unknown> = {
            tipo: String(refreshedOS.tipo || os.tipo),
            codigo: String(refreshedOS.codigo || os.codigo),
            cliente_id: String(refreshedOS.cliente_id || os.cliente_id),
            data: String(refreshedOS.data || os.data),
            situacao_id: SITUACAO_DESTINO,
          };

          // Passthrough all fields from refreshed OS
          for (const key of passthroughKeys) {
            const val = refreshedOS[key];
            if (val === undefined || val === null) continue;
            if (key === "forma_pagamento_id" && String(val).trim() === "") continue;
            stepCPayload[key] = val;
          }

          const stepCResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(stepCPayload) }
          );
          const stepCData = await stepCResp.json();

          if (stepCResp.ok || stepCData?.code === 200) {
            console.log(`[negotiate-os] STEP C OK: OS ${os.id} → Ag Pagamento ✓`);

            // ── STEP D: Find generated recebimentos and update descriptions with neg number ──
            await new Promise((r) => setTimeout(r, 1000)); // wait for GC to generate financials
            console.log(`[negotiate-os] STEP D: OS ${os.id} → buscando recebimentos gerados`);

            try {
              const maxAttempts = 8;
              const waitBetweenAttemptsMs = 1500;
              const expectedByDueDate = new Map<string, number[]>();

              for (let idx = 0; idx < dueDates.length; idx++) {
                const due = dueDates[idx];
                const expectedValue = Number((idx === parcelas - 1 ? valorUltimaOS : valorParcelaOS).toFixed(2));
                const bucket = expectedByDueDate.get(due) || [];
                bucket.push(expectedValue);
                expectedByDueDate.set(due, bucket);
              }

              const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

              const normalizeMoney = (value: unknown): number => {
                const parsed = Number.parseFloat(String(value ?? "0").replace(",", "."));
                if (!Number.isFinite(parsed)) return 0;
                return Math.round(parsed * 100) / 100;
              };

              const parseDateLike = (value: unknown): number => {
                const raw = String(value ?? "").trim();
                if (!raw) return Number.NaN;
                const candidate = raw.includes("T") ? raw : raw.replace(" ", "T");
                const ts = Date.parse(candidate);
                return Number.isFinite(ts) ? ts : Number.NaN;
              };

              const unwrapFinancialRecord = (input: unknown): Record<string, unknown> => {
                let current: unknown = input;

                for (let i = 0; i < 5; i++) {
                  if (!current || typeof current !== "object") break;
                  const obj = current as Record<string, unknown>;

                  const hasId = Boolean(obj.id || obj.codigo);
                  const hasCoreFields = (
                    obj.descricao !== undefined ||
                    obj.valor !== undefined ||
                    obj.valor_total !== undefined ||
                    obj.data_vencimento !== undefined
                  );

                  if (hasId && hasCoreFields) return obj;

                  const preferredWrappers = [
                    "Recebimento",
                    "recebimento",
                    "Pagamento",
                    "pagamento",
                    "MovimentacaoFinanceira",
                    "movimentacao_financeira",
                    "movimentacao",
                    "data",
                  ];

                  let next: unknown = null;
                  for (const key of preferredWrappers) {
                    const candidate = obj[key];
                    if (candidate && typeof candidate === "object") {
                      next = candidate;
                      break;
                    }
                  }

                  if (!next) {
                    const nestedObjects = Object.values(obj).filter((v) => v && typeof v === "object");
                    if (nestedObjects.length === 1) {
                      next = nestedObjects[0];
                    }
                  }

                  if (!next) return obj;
                  current = next;
                }

                return (current && typeof current === "object") ? current as Record<string, unknown> : {};
              };

              const fetchFinancialRecords = async (
                endpoint: "/api/recebimentos" | "/api/pagamentos",
                maxPages: number,
                onlyOpen: boolean,
              ): Promise<Array<{ endpoint: "/api/recebimentos" | "/api/pagamentos"; record: Record<string, unknown> }>> => {
                const list: Array<{ endpoint: "/api/recebimentos" | "/api/pagamentos"; record: Record<string, unknown> }> = [];
                let recPage = 1;
                let recTotalPages = 1;

                while (recPage <= recTotalPages && recPage <= maxPages) {
                  const paramsObj: Record<string, string> = {
                    limite: "100",
                    pagina: String(recPage),
                  };
                  if (onlyOpen) paramsObj.liquidado = "0";

                  const searchParams = new URLSearchParams(paramsObj);
                  const recResp = await rateLimitedFetch(
                    `${GC_BASE_URL}${endpoint}?${searchParams.toString()}`,
                    { headers: gcHeaders }
                  );

                  if (!recResp.ok) break;

                  const recData = await recResp.json();
                  const rawList = Array.isArray(recData?.data) ? recData.data : [];
                  recTotalPages = Number(recData?.meta?.total_paginas || 1);

                  for (const item of rawList) {
                    const unwrapped = unwrapFinancialRecord(item);
                    const recId = String(unwrapped.id || unwrapped.codigo || "").trim();
                    if (!recId) continue;
                    list.push({ endpoint, record: unwrapped });
                  }
                  recPage++;
                }

                return list;
              };

              const codigoLower = os.codigo.toLowerCase();
              const nomeClienteLower = String(os.nome_cliente || "").toLowerCase();
              let matching: Array<{ endpoint: "/api/recebimentos" | "/api/pagamentos"; record: Record<string, unknown> }> = [];

              for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                const shouldFetchClosed = attempt % 3 === 0;
                const maxPages = attempt <= 2 ? 6 : 10;
                const gathered: Array<{ endpoint: "/api/recebimentos" | "/api/pagamentos"; record: Record<string, unknown> }> = [];

                for (const endpoint of ["/api/recebimentos", "/api/pagamentos"] as const) {
                  const openRecords = await fetchFinancialRecords(endpoint, maxPages, true);
                  gathered.push(...openRecords);

                  if (shouldFetchClosed) {
                    const allRecords = await fetchFinancialRecords(endpoint, Math.max(3, Math.floor(maxPages / 2)), false);
                    gathered.push(...allRecords);
                  }
                }

                const deduped = new Map<string, { endpoint: "/api/recebimentos" | "/api/pagamentos"; record: Record<string, unknown> }>();
                for (const item of gathered) {
                  const recId = String(item.record.id || item.record.codigo || "").trim();
                  if (!recId) continue;
                  deduped.set(`${item.endpoint}:${recId}`, item);
                }

                const allRecords = Array.from(deduped.values());
                const nowTs = Date.now();

                matching = allRecords.filter(({ record }) => {
                  const desc = String(record.descricao || "").toLowerCase();
                  const matchesOsByDesc =
                    desc.includes(`nº ${codigoLower}`) ||
                    desc.includes(`n° ${codigoLower}`) ||
                    desc.includes(`nº${codigoLower}`) ||
                    desc.includes(`n°${codigoLower}`) ||
                    desc.includes(`n\u00ba ${codigoLower}`) ||
                    desc.includes(`no ${codigoLower}`) ||
                    desc.includes(`os ${codigoLower}`) ||
                    (desc.includes("ordem de serviço") && desc.includes(codigoLower));

                  const dueDate = String(record.data_vencimento || record.vencimento || "").slice(0, 10);
                  const expectedValues = expectedByDueDate.get(dueDate) || [];
                  const recValue = normalizeMoney(record.valor ?? record.valor_total);
                  const matchesDueAndValue = expectedValues.some((v) => Math.abs(v - recValue) <= 0.02);

                  const recClienteId = String(record.cliente_id || "").trim();
                  const recNomeCliente = String(record.nome_cliente || "").toLowerCase();
                  const sameClient =
                    (Boolean(os.cliente_id) && recClienteId === String(os.cliente_id)) ||
                    (Boolean(nomeClienteLower) && Boolean(recNomeCliente) && recNomeCliente === nomeClienteLower);

                  const createdTs = parseDateLike(record.cadastrado_em || record.created_at || record.modificado_em);
                  const recentCreation = Number.isFinite(createdTs) && Math.abs(nowTs - createdTs) <= (1000 * 60 * 180);

                  return matchesOsByDesc || (matchesDueAndValue && (sameClient || recentCreation));
                });

                const alreadyTagged = matching.filter(({ record }) =>
                  String(record.descricao || "").toUpperCase().includes(negTag.toUpperCase())
                ).length;

                console.log(
                  `[negotiate-os] STEP D tentativa ${attempt}/${maxAttempts}: ${allRecords.length} financeiros varridos, ${matching.length} candidatos, ${alreadyTagged} já com ${negTag} (OS ${os.codigo})`
                );

                if (matching.length >= parcelas) break;
                if (attempt < maxAttempts) await wait(waitBetweenAttemptsMs);
              }

              if (matching.length === 0) {
                console.warn(`[negotiate-os] STEP D: nenhum financeiro encontrado para OS ${os.codigo}`);
              }

              for (const { endpoint, record } of matching) {
                const recId = String(record.id || "").trim();
                if (!recId) continue;

                const currentDesc = String(record.descricao || "").trim();
                const cleanedDesc = currentDesc
                  .replace(/^\[?\s*neg[\s#\.\-]*\d+\]?\s*[-–—:]?\s*/i, "")
                  .replace(/^NEG\d+\s*[-–—:]?\s*/i, "")
                  .trim();
                const newDesc = `${negTag} - ${cleanedDesc || `OS ${os.codigo}`}`;

                if (currentDesc === newDesc) continue;

                const putPayload: Record<string, unknown> = {
                  descricao: newDesc,
                  data_vencimento: record.data_vencimento,
                  plano_contas_id: record.plano_contas_id,
                  forma_pagamento_id: record.forma_pagamento_id,
                  conta_bancaria_id: record.conta_bancaria_id,
                  valor: record.valor,
                  data_competencia: record.data_competencia,
                };

                const putRecResp = await rateLimitedFetch(
                  `${GC_BASE_URL}${endpoint}/${recId}`,
                  { method: "PUT", headers: gcHeaders, body: JSON.stringify(putPayload) }
                );
                const putRecData = await putRecResp.json();

                if (putRecResp.ok || putRecData?.code === 200) {
                  console.log(`[negotiate-os] STEP D OK: ${endpoint} ${recId} → "${newDesc}"`);
                } else {
                  console.warn(`[negotiate-os] STEP D ERRO: ${endpoint} ${recId}: ${putRecData?.message || putRecResp.status}`);
                }
              }
            } catch (stepDErr: any) {
              console.warn(`[negotiate-os] STEP D error (non-fatal): ${stepDErr.message}`);
            }

            gcUpdateResults.push({ os_id: os.id, status: "ok" });
          } else {
            gcUpdateResults.push({
              os_id: os.id, status: "error",
              error: `Step C failed: ${stepCData?.message || stepCResp.status}`,
            });
          }
        } catch (err) {
          gcUpdateResults.push({ os_id: os.id, status: "error", error: (err as Error).message });
        }
      }

      // 3. Create fin_grupos_receber — one group per installment
      const successOS = osDetails.filter((os) =>
        gcUpdateResults.find((r) => r.os_id === os.id && r.status === "ok")
      );

      const totalValor = successOS.reduce((sum, os) => sum + os.valor_total, 0);
      const grupoIds: string[] = [];

      if (successOS.length > 0 && totalValor > 0) {
        const valorParcela = Math.floor((totalValor / parcelas) * 100) / 100;
        const valorUltima = Math.round((totalValor - valorParcela * (parcelas - 1)) * 100) / 100;
        const clienteNome = successOS[0].nome_cliente || nome_cliente || "Cliente";

        const osRef = successOS.map((os) => {
          const equip = os.nome_equipamento ? ` (${os.nome_equipamento})` : "";
          return `OS ${os.codigo}${equip} — R$ ${os.valor_total.toFixed(2)}`;
        }).join("\n");

        for (let i = 0; i < parcelas; i++) {
          const valor = i === parcelas - 1 ? valorUltima : valorParcela;
          const vencimento = dueDates[i];
          const nomeGrupo = `${clienteNome} — Neg. nº${negociacao_numero} (${i + 1}/${parcelas})`;

          const { data: grupo, error: grupoErr } = await supabase
            .from("fin_grupos_receber")
            .insert({
              nome: nomeGrupo,
              cliente_gc_id: cliente_gc_id || successOS[0].cliente_id || null,
              nome_cliente: clienteNome,
              valor_total: valor,
              data_vencimento: vencimento,
              status: "aberto",
              itens_total: 0,
              negociacao_numero: negociacao_numero,
              observacao: `Neg. nº${negociacao_numero} — Parcela ${i + 1}/${parcelas} — R$ ${valor.toFixed(2)}\nVencimento: ${vencimento}\n\n${osRef}`,
            })
            .select("id")
            .single();

          if (grupoErr) {
            console.error(`[negotiate-os] Error creating grupo ${i + 1}:`, grupoErr.message);
            continue;
          }
          grupoIds.push(grupo.id);
        }
      }

      const okCount = gcUpdateResults.filter((r) => r.status === "ok").length;
      const errCount = gcUpdateResults.filter((r) => r.status === "error").length;

      // Log
      await supabase.from("fin_sync_log").insert({
        tipo: "negotiate-os",
        status: errCount > 0 ? (okCount > 0 ? "partial" : "erro") : "ok",
        payload: { os_ids, parcelas, dia_vencimento, mes_inicio, cliente_gc_id },
        resposta: { gcUpdateResults, grupoIds, totalValor },
        duracao_ms: Date.now() - startTime,
      });

      return new Response(
        JSON.stringify({
          success: true,
          results: gcUpdateResults,
          grupos_criados: grupoIds.length,
          grupo_ids: grupoIds,
          summary: { total: os_ids.length, ok: okCount, errors: errCount },
          duration_ms: Date.now() - startTime,
        }),
        { status: 200, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'list' or 'execute'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("[negotiate-os] Fatal:", (error as Error).message);
    return new Response(
      JSON.stringify({ error: (error as Error).message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
