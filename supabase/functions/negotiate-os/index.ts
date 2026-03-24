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
  situacao_ids?: string[];
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
      const situacaoIds = Array.isArray(body.situacao_ids) && body.situacao_ids.length > 0
        ? body.situacao_ids
        : [SITUACAO_ORIGEM];

      const allOS: Record<string, unknown>[] = [];

      for (const situacaoId of situacaoIds) {
        let page = 1;
        let totalPages = 1;

        while (page <= totalPages) {
          const params = new URLSearchParams({
            limite: "100",
            pagina: String(page),
            situacao_id: situacaoId,
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
            console.log(`[negotiate-os] GC API error for situacao ${situacaoId}: ${response.status}`);
            break;
          }

          const data = await response.json();
          const records = Array.isArray(data?.data) ? data.data : [];
          totalPages = data?.meta?.total_paginas || 1;

          allOS.push(...records);
          page++;
        }
      }

      // Group by client
      const byClient: Record<string, { cliente_id: string; nome_cliente: string; os_list: any[]; valor_total: number }> = {};

      for (const os of allOS) {
        const valor = parseFloat(String(os.valor_total || "0")) || 0;
        if (valor <= 0) continue; // ignore non-negotiable OS

        const clienteId = String(os.cliente_id || "sem_cliente");
        const nomeCliente = String(os.nome_cliente || "Sem cliente").trim();

        if (!byClient[clienteId]) {
          byClient[clienteId] = {
            cliente_id: clienteId,
            nome_cliente: nomeCliente,
            os_list: [],
            valor_total: 0,
          };
        }

        // Prefer non-generic client name (GC sometimes returns "Consumidor" for some OS in the same client)
        const nomeAtual = byClient[clienteId].nome_cliente.toLowerCase();
        if (
          (nomeAtual === "consumidor" || nomeAtual === "consumidor final" || nomeAtual === "sem cliente") &&
          nomeCliente.toLowerCase() !== "consumidor" &&
          nomeCliente.toLowerCase() !== "consumidor final" &&
          nomeCliente.toLowerCase() !== "sem cliente" &&
          nomeCliente !== ""
        ) {
          byClient[clienteId].nome_cliente = nomeCliente;
        }

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
        .filter((c) => c.os_list.length >= 1)
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
      const { os_ids, parcelas, dia_vencimento, mes_inicio, nome_cliente, cliente_gc_id, situacao_ids } = body as any;
      const valoresParcelas = (body as any).valores_parcelas as number[] | undefined;
      const valorNegociado = (body as any).valor_negociado as number | undefined;

      if (!os_ids?.length || !parcelas || !dia_vencimento || !mes_inicio) {
        return new Response(
          JSON.stringify({ error: "Missing required fields: os_ids, parcelas, dia_vencimento, mes_inicio" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }

      // Calculate per-OS value distribution based on negotiated values
      // Total negotiated value split proportionally across OS by their original values
      const useCustomValues = Array.isArray(valoresParcelas) && valoresParcelas.length === parcelas;

      // Get sequential negotiation number
      const { data: negNumData, error: negNumErr } = await supabase.rpc("next_negociacao_number");
      const negociacao_numero = negNumErr ? Date.now() : (negNumData as number);
      console.log(`[negotiate-os] Negociação nº${negociacao_numero}`);

      const roundMoney = (value: number) => Math.round(value * 100) / 100;

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

      // Passivo vencimento = último dia útil do mês subsequente
      const lastNegotiatedDate = new Date(`${dueDates[dueDates.length - 1]}T00:00:00Z`);
      const nextMonth = new Date(Date.UTC(lastNegotiatedDate.getUTCFullYear(), lastNegotiatedDate.getUTCMonth() + 2, 0)); // último dia do mês seguinte
      // Recuar para último dia útil (seg-sex)
      while (nextMonth.getUTCDay() === 0 || nextMonth.getUTCDay() === 6) {
        nextMonth.setUTCDate(nextMonth.getUTCDate() - 1);
      }
      const residualDueDate = `${nextMonth.getUTCFullYear()}-${String(nextMonth.getUTCMonth() + 1).padStart(2, "0")}-${String(nextMonth.getUTCDate()).padStart(2, "0")}`;

      const negTag = `NEG${negociacao_numero}`;

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

      // 2. Steps A → B → C for each OS
      const passthroughKeys = [
        "vendedor_id", "tecnico_id", "saida", "previsao_entrega",
        "transportadora_id", "centro_custo_id", "aos_cuidados_de",
        "validade", "introducao", "observacoes", "observacoes_interna",
        "valor_frete", "condicao_pagamento", "forma_pagamento_id",
        "data_primeira_parcela", "numero_parcelas", "intervalo_dias",
        "equipamentos", "pagamentos", "produtos", "servicos",
      ];

      for (const os of osDetails) {
        try {
          const basePayload: Record<string, unknown> = {
            tipo: os.tipo,
            codigo: os.codigo,
            cliente_id: os.cliente_id,
            data: os.data,
          };

          for (const key of passthroughKeys) {
            const rawValue = os.raw[key];
            if (rawValue === undefined || rawValue === null) continue;
            if (key === "forma_pagamento_id" && String(rawValue).trim() === "") continue;
            basePayload[key] = rawValue;
          }

          // ── STEP A ──
          console.log(`[negotiate-os] STEP A: OS ${os.id} → intermediário`);
          const stepAPayload = { ...basePayload, situacao_id: SITUACAO_INTERMEDIARIA };
          const stepAResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(stepAPayload) }
          );
          const stepAData = await stepAResp.json();
          if (!stepAResp.ok && stepAData?.code !== 200) {
            gcUpdateResults.push({ os_id: os.id, status: "error", error: `Step A failed: ${stepAData?.message || stepAResp.status}` });
            continue;
          }
          console.log(`[negotiate-os] STEP A OK: OS ${os.id}`);
          await new Promise((r) => setTimeout(r, 500));

          // ── STEP B ──
          console.log(`[negotiate-os] STEP B: OS ${os.id} → ${parcelas} parcelas + passivo`);

          const totalOriginal = osDetails.reduce((s, o) => s + o.valor_total, 0);
          const osRatio = totalOriginal > 0 ? os.valor_total / totalOriginal : 1 / osDetails.length;
          const valorOSNegociado = valorNegociado && valorNegociado < totalOriginal
            ? roundMoney(valorNegociado * osRatio)
            : os.valor_total;
          const valorOSResidual = roundMoney(os.valor_total - valorOSNegociado);

          let osParcelaValues: number[];
          if (useCustomValues && valoresParcelas) {
            const totalCustom = valoresParcelas.reduce((a: number, b: number) => a + b, 0);
            osParcelaValues = valoresParcelas.map((v: number) => roundMoney((v / totalCustom) * valorOSNegociado));
            const roundDiff = roundMoney(valorOSNegociado - osParcelaValues.reduce((a, b) => a + b, 0));
            if (roundDiff !== 0) osParcelaValues[osParcelaValues.length - 1] = roundMoney(osParcelaValues[osParcelaValues.length - 1] + roundDiff);
          } else {
            const valorParcelaOS = Math.floor((valorOSNegociado / parcelas) * 100) / 100;
            const valorUltimaOS = roundMoney(valorOSNegociado - valorParcelaOS * (parcelas - 1));
            osParcelaValues = Array.from({ length: parcelas }, (_, i) =>
              i === parcelas - 1 ? valorUltimaOS : valorParcelaOS
            );
          }

          console.log(`[negotiate-os] OS ${os.id}: original=${os.valor_total}, negociado=${valorOSNegociado}, passivo=${valorOSResidual}`);

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

          const pagamentosNegociados = dueDates.map((dt, idx) => {
            const pagamento: Record<string, unknown> = {
              data_vencimento: dt,
              valor: osParcelaValues[idx].toFixed(2),
              descricao: `${negTag} - Parcela ${idx + 1}/${parcelas} - OS ${os.codigo}`,
            };
            if (formaPagamentoId) pagamento.forma_pagamento_id = formaPagamentoId;
            if (nomeFormaPagamento) pagamento.nome_forma_pagamento = nomeFormaPagamento;
            if (planoContasId) { pagamento.plano_contas_id = planoContasId; pagamento.categoria_id = planoContasId; }
            if (nomePlanoConta) { pagamento.nome_plano_conta = nomePlanoConta; pagamento.nome_categoria = nomePlanoConta; }
            return { pagamento };
          });

          const pagamentosComPassivo = valorOSResidual > 0.01
            ? [...pagamentosNegociados, { pagamento: {
                data_vencimento: residualDueDate,
                valor: valorOSResidual.toFixed(2),
                descricao: `Passivo OS ${os.codigo} (negociação ${negociacao_numero})`,
                ...(formaPagamentoId ? { forma_pagamento_id: formaPagamentoId } : {}),
                ...(nomeFormaPagamento ? { nome_forma_pagamento: nomeFormaPagamento } : {}),
                ...(planoContasId ? { plano_contas_id: planoContasId, categoria_id: planoContasId } : {}),
                ...(nomePlanoConta ? { nome_plano_conta: nomePlanoConta, nome_categoria: nomePlanoConta } : {}),
              } }]
            : pagamentosNegociados;

          const stepBPayload: Record<string, unknown> = {
            ...basePayload,
            situacao_id: SITUACAO_INTERMEDIARIA,
            data_primeira_parcela: dueDates[0],
            numero_parcelas: String(pagamentosComPassivo.length),
            condicao_pagamento: pagamentosComPassivo.length > 1 ? "parcelado" : "a_vista",
            intervalo_dias: pagamentosComPassivo.length > 1 ? "30" : "0",
            pagamentos: pagamentosComPassivo,
          };

          const existingObs = String(stepBPayload["observacoes"] || "");
          stepBPayload["observacoes"] = existingObs
            ? `${existingObs}\nnegociado nº${negociacao_numero}`
            : `negociado nº${negociacao_numero}`;
          if (formaPagamentoId) stepBPayload["forma_pagamento_id"] = formaPagamentoId;

          // Extra delay after Step A to let GC settle
          await new Promise((r) => setTimeout(r, 1000));

          const stepBResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(stepBPayload) }
          );
          const stepBText = await stepBResp.text();
          let stepBData: any;
          try { stepBData = JSON.parse(stepBText); } catch { stepBData = {}; }
          console.log(`[negotiate-os] STEP B response ${stepBResp.status}: ${stepBText.slice(0, 500)}`);
          if (!stepBResp.ok && stepBData?.code !== 200) {
            gcUpdateResults.push({ os_id: os.id, status: "error", error: `Step B failed: ${stepBData?.message || stepBResp.status} - ${stepBText.slice(0, 200)}` });
            // Revert Step A: restore original situation
            try {
              await rateLimitedFetch(
                `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
                { method: "PUT", headers: gcHeaders, body: JSON.stringify({ ...basePayload, situacao_id: situacaoIds?.[0] || SITUACAO_ORIGEM }) }
              );
              console.log(`[negotiate-os] Step A reverted for OS ${os.id}`);
            } catch { /* best-effort revert */ }
            continue;
          }
          console.log(`[negotiate-os] STEP B OK: OS ${os.id}`);
          await new Promise((r) => setTimeout(r, 500));

          // ── STEP C ──
          console.log(`[negotiate-os] STEP C: OS ${os.id} → final`);
          const refreshResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { headers: gcHeaders }
          );
          const refreshData = await refreshResp.json();
          const refreshedOS = refreshData?.data || refreshData;

          const stepCPayload: Record<string, unknown> = {
            tipo: String(refreshedOS.tipo || os.tipo),
            codigo: String(refreshedOS.codigo || os.codigo),
            cliente_id: String(refreshedOS.cliente_id || os.cliente_id),
            data: String(refreshedOS.data || os.data),
            situacao_id: SITUACAO_DESTINO,
          };
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
            console.log(`[negotiate-os] STEP C OK: OS ${os.id} ✓`);
            gcUpdateResults.push({ os_id: os.id, status: "ok" });
          } else {
            gcUpdateResults.push({ os_id: os.id, status: "error", error: `Step C failed: ${stepCData?.message || stepCResp.status}` });
          }
        } catch (err) {
          gcUpdateResults.push({ os_id: os.id, status: "error", error: (err as Error).message });
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 3. Build negotiated groups + persist passive financial links
      // ═══════════════════════════════════════════════════════════════
      const successOS = osDetails.filter((os) =>
        gcUpdateResults.find((r) => r.os_id === os.id && r.status === "ok")
      );

      const buildPlanForOS = (osValorTotal: number) => {
        const totalOriginalAll = osDetails.reduce((sum, item) => sum + item.valor_total, 0);
        const osRatio = totalOriginalAll > 0 ? osValorTotal / totalOriginalAll : 1 / Math.max(osDetails.length, 1);
        const negotiatedTotal = valorNegociado && valorNegociado < totalOriginalAll
          ? roundMoney(valorNegociado * osRatio)
          : osValorTotal;

        let parcelValues: number[];
        if (useCustomValues && valoresParcelas) {
          const totalCustom = valoresParcelas.reduce((a: number, b: number) => a + b, 0);
          parcelValues = valoresParcelas.map((value: number) => roundMoney((value / totalCustom) * negotiatedTotal));
          const parcelDiff = roundMoney(negotiatedTotal - parcelValues.reduce((a, b) => a + b, 0));
          if (parcelDiff !== 0 && parcelValues.length > 0) {
            parcelValues[parcelValues.length - 1] = roundMoney(parcelValues[parcelValues.length - 1] + parcelDiff);
          }
        } else {
          const baseParcel = Math.floor((negotiatedTotal / parcelas) * 100) / 100;
          const lastParcel = roundMoney(negotiatedTotal - baseParcel * (parcelas - 1));
          parcelValues = Array.from({ length: parcelas }, (_, index) =>
            index === parcelas - 1 ? lastParcel : baseParcel
          );
        }

        const residual = roundMoney(osValorTotal - negotiatedTotal);
        return { negotiatedTotal, residual, parcelValues };
      };

      const successPlans = successOS.map((os) => ({ os, plan: buildPlanForOS(os.valor_total) }));
      const totalNegotiatedSuccess = roundMoney(successPlans.reduce((sum, item) => sum + item.plan.negotiatedTotal, 0));
      const totalResidualSuccess = roundMoney(successPlans.reduce((sum, item) => sum + item.plan.residual, 0));
      const grupoIds: string[] = [];

      if (successPlans.length > 0 && totalNegotiatedSuccess > 0) {
        const groupValues = Array.from({ length: parcelas }, (_, index) =>
          roundMoney(successPlans.reduce((sum, item) => sum + (item.plan.parcelValues[index] ?? 0), 0))
        );
        const groupDiff = roundMoney(totalNegotiatedSuccess - groupValues.reduce((sum, value) => sum + value, 0));
        if (groupDiff !== 0 && groupValues.length > 0) {
          groupValues[groupValues.length - 1] = roundMoney(groupValues[groupValues.length - 1] + groupDiff);
        }

        const clienteNome = successPlans[0].os.nome_cliente || nome_cliente || "Cliente";
        const osRef = successPlans.map(({ os, plan }) => {
          const equip = os.nome_equipamento ? ` (${os.nome_equipamento})` : "";
          return `OS ${os.codigo}${equip} — Original: R$ ${os.valor_total.toFixed(2)} · Negociado: R$ ${plan.negotiatedTotal.toFixed(2)} · Passivo: R$ ${plan.residual.toFixed(2)}`;
        }).join("\n");

        console.log(`[negotiate-os] Criando ${parcelas} grupo(s) para ${successPlans.length} OS...`);

        for (let i = 0; i < parcelas; i++) {
          const valor = groupValues[i] ?? 0;
          const vencimento = dueDates[i];
          const nomeGrupo = `${clienteNome} — Neg. nº${negociacao_numero} (${i + 1}/${parcelas})`;

          const osCodigos = successPlans.map(({ os }) => os.codigo);
          const { data: grupo, error: grupoErr } = await supabase
            .from("fin_grupos_receber")
            .insert({
              nome: nomeGrupo,
              cliente_gc_id: cliente_gc_id || successPlans[0].os.cliente_id || null,
              nome_cliente: clienteNome,
              valor_total: valor,
              data_vencimento: vencimento,
              status: "aberto",
              itens_total: successPlans.length,
              negociacao_numero: negociacao_numero,
              os_codigos: osCodigos,
              observacao: `Neg. nº${negociacao_numero} — Parcela ${i + 1}/${parcelas} — R$ ${valor.toFixed(2)}\nVencimento: ${vencimento}\nPassivo total: R$ ${totalResidualSuccess.toFixed(2)} (${residualDueDate})\n\n${osRef}`,
            })
            .select("id")
            .single();

          if (grupoErr) {
            console.error(`[negotiate-os] Error creating grupo ${i + 1}:`, grupoErr.message);
            continue;
          }
          grupoIds.push(grupo.id);
          console.log(`[negotiate-os] Grupo ${i + 1}/${parcelas} criado: ${grupo.id}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 4. STEP D: Tag/update negotiated receivables and capture passive
      // ═══════════════════════════════════════════════════════════════
      const passiveReceivables = new Map<string, {
        cliente_gc_id: string;
        nome_cliente: string;
        valor_residual: number;
        negociacao_origem_numero: number;
        gc_recebimento_id: string;
        gc_codigo: string | null;
        os_codigos: string[];
        observacao: string;
      }>();
      const linkedReceivableIds = new Map<string, string>();

      const buildReceivableKey = (osCodigo: string, dueDate: string, value: number, kind: "neg" | "passive") =>
        `${kind}:${osCodigo}:${dueDate}:${roundMoney(value).toFixed(2)}`;

      const upsertLocalReceivable = async (params: {
        rec: Record<string, unknown>;
        dueDate: string;
        desiredDesc: string;
        desiredObs: string;
        osCodigo: string;
      }): Promise<string | null> => {
        const recId = String(params.rec?.id || "").trim();
        if (!recId) return null;

        const payload = {
          gc_id: recId,
          gc_codigo: params.rec?.codigo ? String(params.rec.codigo) : null,
          gc_payload_raw: params.rec,
          descricao: params.desiredDesc,
          observacao: params.desiredObs,
          os_codigo: params.osCodigo,
          tipo: "os",
          origem: "gc_os",
          valor: normalizeMoney(params.rec?.valor ?? params.rec?.valor_total),
          cliente_gc_id: String(params.rec?.cliente_id || cliente_gc_id || "") || null,
          nome_cliente: String(params.rec?.nome_cliente || nome_cliente || "") || null,
          data_vencimento: params.dueDate || null,
          data_competencia: params.rec?.data_competencia ? String(params.rec.data_competencia) : null,
          data_liquidacao: params.rec?.data_liquidacao ? String(params.rec.data_liquidacao) : null,
          liquidado: String(params.rec?.liquidado || "0") === "1",
          status: String(params.rec?.liquidado || "0") === "1" ? "pago" : "pendente",
          last_synced_at: new Date().toISOString(),
        };

        const { data: existingLocal, error: existingErr } = await supabase
          .from("fin_recebimentos")
          .select("id")
          .eq("gc_id", recId)
          .maybeSingle();

        if (existingErr) {
          console.warn(`[negotiate-os] STEP D local lookup error ${recId}: ${existingErr.message}`);
          return null;
        }

        if (existingLocal?.id) {
          const { error: updateErr } = await supabase
            .from("fin_recebimentos")
            .update(payload)
            .eq("id", existingLocal.id);

          if (updateErr) {
            console.warn(`[negotiate-os] STEP D local update error ${recId}: ${updateErr.message}`);
            return null;
          }

          return existingLocal.id;
        }

        const { data: insertedLocal, error: insertErr } = await supabase
          .from("fin_recebimentos")
          .insert(payload)
          .select("id")
          .single();

        if (insertErr) {
          console.warn(`[negotiate-os] STEP D local insert error ${recId}: ${insertErr.message}`);
          return null;
        }

        return insertedLocal?.id ?? null;
      };

      for (const { os, plan } of successPlans) {
        try {
          await new Promise((r) => setTimeout(r, 800));
          console.log(`[negotiate-os] STEP D: OS ${os.codigo} → buscando financeiros`);

          const expectedByDueDate = new Map<string, number[]>();
          for (let idx = 0; idx < dueDates.length; idx++) {
            const due = dueDates[idx];
            const bucket = expectedByDueDate.get(due) || [];
            bucket.push(plan.parcelValues[idx] ?? 0);
            expectedByDueDate.set(due, bucket);
          }
          if (plan.residual > 0.01) {
            const residualBucket = expectedByDueDate.get(residualDueDate) || [];
            residualBucket.push(plan.residual);
            expectedByDueDate.set(residualDueDate, residualBucket);
          }

          const normalizeMoney = (value: unknown): number => {
            const parsed = Number.parseFloat(String(value ?? "0").replace(",", "."));
            if (!Number.isFinite(parsed)) return 0;
            return roundMoney(parsed);
          };

          const codigoLower = os.codigo.toLowerCase();
          const rawList: Record<string, unknown>[] = [];
          let page = 1;
          let totalPages = 1;

          while (page <= totalPages) {
            const searchParams = new URLSearchParams({
              limite: "100",
              pagina: String(page),
              cliente_id: cliente_gc_id || os.cliente_id,
              data_inicio: dueDates[0],
              data_fim: residualDueDate,
            });

            const recResp = await rateLimitedFetch(
              `${GC_BASE_URL}/api/recebimentos?${searchParams.toString()}`,
              { headers: gcHeaders }
            );

            if (!recResp.ok) {
              console.warn(`[negotiate-os] STEP D: fetch failed ${recResp.status}`);
              break;
            }

            const recData = await recResp.json();
            const pageItems = Array.isArray(recData?.data) ? recData.data : [];
            rawList.push(...pageItems);
            totalPages = recData?.meta?.total_paginas || 1;
            page++;
          }

          const matching = rawList.filter((item: any) => {
            const rec = item?.Recebimento || item?.recebimento || item;
            const dueDate = String(rec?.data_vencimento || "").slice(0, 10);
            const expectedValues = expectedByDueDate.get(dueDate) || [];
            if (expectedValues.length === 0) return false;

            const desc = String(rec?.descricao || "").toLowerCase();
            const recValue = normalizeMoney(rec?.valor ?? rec?.valor_total);
            const matchesOS = desc.includes(codigoLower) || desc.includes(`os ${codigoLower}`);
            const matchesValue = expectedValues.some((value) => Math.abs(value - recValue) <= 0.02);
            return matchesOS || matchesValue;
          });

          console.log(`[negotiate-os] STEP D: ${rawList.length} financeiros, ${matching.length} candidatos para OS ${os.codigo}`);

          for (const item of matching) {
            const rec = item?.Recebimento || item?.recebimento || item;
            const recId = String(rec?.id || "").trim();
            if (!recId) continue;

            const recValue = normalizeMoney(rec?.valor ?? rec?.valor_total);
            const dueDate = String(rec?.data_vencimento || "").slice(0, 10);
            const currentDesc = String(rec?.descricao || "").trim();
            const currentObs = String(rec?.observacoes || rec?.observacao || "").trim();
            const isPassive = currentDesc.toUpperCase().includes("PASSIVO")
              || (dueDate === residualDueDate && plan.residual > 0.01 && Math.abs(plan.residual - recValue) <= 0.02)
              || (plan.residual > 0.01 && Math.abs(plan.residual - recValue) <= 0.02 && !plan.parcelValues.some((pv) => Math.abs(pv - recValue) <= 0.02));

            const cleanedDesc = currentDesc
              .replace(/^\[?\s*neg[\s#\.\-]*\d+\]?\s*[-–—:]?\s*/i, "")
              .replace(/^NEG\d+\s*[-–—:]?\s*/i, "")
              .trim();

            const desiredDesc = currentDesc.toUpperCase().includes(negTag.toUpperCase())
              ? currentDesc
              : isPassive
                ? `Passivo OS ${os.codigo} (negociação ${negociacao_numero})`
                : `${negTag} - ${cleanedDesc || `OS ${os.codigo}`}`;

            const obsLine = isPassive
              ? `passivo da negociação nº${negociacao_numero}`
              : `negociado nº${negociacao_numero}`;
            const desiredObs = currentObs
              ? (currentObs.includes(obsLine) ? currentObs : `${currentObs}\n${obsLine}`)
              : obsLine;

            if (desiredDesc !== currentDesc || desiredObs !== currentObs) {
              const putPayload: Record<string, unknown> = {
                descricao: desiredDesc,
                observacoes: desiredObs,
                data_vencimento: rec.data_vencimento,
                plano_contas_id: rec.plano_contas_id,
                forma_pagamento_id: rec.forma_pagamento_id,
                conta_bancaria_id: rec.conta_bancaria_id,
                valor: rec.valor,
                data_competencia: rec.data_competencia,
              };

              const putResp = await rateLimitedFetch(
                `${GC_BASE_URL}/api/recebimentos/${recId}`,
                { method: "PUT", headers: gcHeaders, body: JSON.stringify(putPayload) }
              );
              const putData = await putResp.json();

              if (putResp.ok || putData?.code === 200) {
                console.log(`[negotiate-os] STEP D OK: ${recId} → "${desiredDesc}"`);
              } else {
                console.warn(`[negotiate-os] STEP D ERRO: ${recId}: ${putData?.data?.mensagem || putData?.message || putResp.status}`);
              }
            }

            const localReceivableId = await upsertLocalReceivable({
              rec,
              dueDate,
              desiredDesc,
              desiredObs,
              osCodigo: os.codigo,
            });

            if (localReceivableId) {
              const mapKey = buildReceivableKey(os.codigo, dueDate, recValue, isPassive ? "passive" : "neg");
              linkedReceivableIds.set(mapKey, localReceivableId);
            }

            if (isPassive) {
              passiveReceivables.set(recId, {
                cliente_gc_id: cliente_gc_id || os.cliente_id,
                nome_cliente: os.nome_cliente || nome_cliente || "Cliente",
                valor_residual: plan.residual,
                negociacao_origem_numero: negociacao_numero,
                gc_recebimento_id: recId,
                gc_codigo: rec?.codigo ? String(rec.codigo) : null,
                os_codigos: [os.codigo],
                observacao: `Financeiro passivo da negociação nº${negociacao_numero}\nOS ${os.codigo}\nVencimento: ${residualDueDate}\nValor: R$ ${plan.residual.toFixed(2)}`,
              });
            }
          }
        } catch (stepDErr: any) {
          console.warn(`[negotiate-os] STEP D error (non-fatal): ${stepDErr.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 4b. Persist passive receivables locally for future renegotiation
      // ═══════════════════════════════════════════════════════════════
      for (const passive of passiveReceivables.values()) {
        const { data: existingResidual } = await supabase
          .from("fin_residuos_negociacao")
          .select("id")
          .eq("gc_recebimento_id", passive.gc_recebimento_id)
          .maybeSingle();

        if (existingResidual?.id) {
          await supabase
            .from("fin_residuos_negociacao")
            .update({
              cliente_gc_id: passive.cliente_gc_id,
              nome_cliente: passive.nome_cliente,
              valor_residual: passive.valor_residual,
              negociacao_origem_numero: passive.negociacao_origem_numero,
              gc_codigo: passive.gc_codigo,
              os_codigos: passive.os_codigos,
              observacao: passive.observacao,
            })
            .eq("id", existingResidual.id);
        } else {
          await supabase.from("fin_residuos_negociacao").insert({
            cliente_gc_id: passive.cliente_gc_id,
            nome_cliente: passive.nome_cliente,
            valor_residual: passive.valor_residual,
            negociacao_origem_numero: passive.negociacao_origem_numero,
            gc_recebimento_id: passive.gc_recebimento_id,
            gc_codigo: passive.gc_codigo,
            os_codigos: passive.os_codigos,
            observacao: passive.observacao,
            utilizado: false,
          });
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 5. Link negotiated receivables to groups (best-effort after sync)
      // ═══════════════════════════════════════════════════════════════
      if (grupoIds.length > 0 && successPlans.length > 0) {
        try {
          // Wait for GC receivables to settle
          console.log(`[negotiate-os] Waiting 3s for GC receivables to settle...`);
          await new Promise((r) => setTimeout(r, 3000));

          for (let i = 0; i < grupoIds.length && i < parcelas; i++) {
            const grupoId = grupoIds[i];
            const vencimento = dueDates[i];

            for (const { os, plan } of successPlans) {
              const valorParcela = plan.parcelValues[i] ?? 0;
              if (valorParcela <= 0.01) continue;

              const mapKey = buildReceivableKey(os.codigo, vencimento, valorParcela, "neg");
              let recebimentoId = linkedReceivableIds.get(mapKey);

              // Fallback: search local DB if not found in Step D mapping
              if (!recebimentoId) {
                // Attempt 1: exact date match
                const { data: recsExact } = await supabase
                  .from("fin_recebimentos")
                  .select("id, gc_codigo, valor, data_vencimento, os_codigo")
                  .eq("os_codigo", os.codigo)
                  .eq("liquidado", false)
                  .is("grupo_id", null)
                  .eq("data_vencimento", vencimento)
                  .limit(5);

                let recs = recsExact || [];

                // Attempt 2: fallback by tag in description
                if (recs.length === 0) {
                  const { data: recsTag } = await supabase
                    .from("fin_recebimentos")
                    .select("id, gc_codigo, valor, data_vencimento, os_codigo, descricao")
                    .eq("liquidado", false)
                    .is("grupo_id", null)
                    .ilike("descricao", `%${negTag}%`)
                    .ilike("descricao", `%OS ${os.codigo}%`)
                    .not("descricao", "ilike", "%PASSIVO%")
                    .limit(10);

                  recs = (recsTag || []).filter((r: any) => {
                    const recDate = String(r.data_vencimento || "").slice(0, 10);
                    return recDate === vencimento;
                  });
                }

                // Find best match by value
                const match = recs.find((r: any) => Math.abs(Number(r.valor) - valorParcela) <= 0.02);
                if (match) {
                  recebimentoId = match.id;
                  console.log(`[negotiate-os] Step 5 fallback found: ${recebimentoId} for OS ${os.codigo}`);
                }
              }

              if (!recebimentoId) {
                console.warn(`[negotiate-os] Grupo ${i + 1}: financeiro não encontrado para OS ${os.codigo} (${vencimento} / ${valorParcela.toFixed(2)})`);
                continue;
              }

              await supabase
                .from("fin_grupo_receber_itens")
                .insert({
                  grupo_id: grupoId,
                  recebimento_id: recebimentoId,
                  valor: valorParcela,
                  os_codigo_original: os.codigo,
                  snapshot_valor: valorParcela,
                  snapshot_data: vencimento,
                });

              await supabase
                .from("fin_recebimentos")
                .update({ grupo_id: grupoId })
                .eq("id", recebimentoId);

              console.log(`[negotiate-os] Grupo ${i + 1}: item vinculado (OS ${os.codigo} / ${valorParcela.toFixed(2)})`);
            }
          }
        } catch (linkErr: any) {
          console.warn(`[negotiate-os] Link error (non-fatal): ${linkErr.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // STEP 6: Processar residuais — SEM tocar na OS, APENAS financeiro GC
      // ═══════════════════════════════════════════════════════════════
      const residualIds: string[] = body.residual_ids || [];
      const residualResults: Array<{ id: string; status: string; error?: string }> = [];

      if (residualIds.length > 0) {
        // Buscar dados dos residuais selecionados
        const { data: residuaisData } = await supabase
          .from("fin_residuos_negociacao")
          .select("id, gc_recebimento_id, valor_residual, os_codigos, negociacao_origem_numero, nome_cliente")
          .in("id", residualIds)
          .eq("utilizado", false);

        const residuaisSelecionados = (residuaisData || []) as Array<{
          id: string;
          gc_recebimento_id: string | null;
          valor_residual: number;
          os_codigos: string[] | null;
          negociacao_origem_numero: number | null;
          nome_cliente: string;
        }>;

        console.log(`[negotiate-os] Step 6: ${residuaisSelecionados.length} residuais a processar`);

        // Use the first grupo (parcela 1) to attach residual items
        const grupoIdForResidual = grupoIds.length > 0 ? grupoIds[0] : null;

        for (const residual of residuaisSelecionados) {
          try {
            if (!residual.gc_recebimento_id) {
              console.warn(`[negotiate-os] Step 6: residual ${residual.id} sem gc_recebimento_id, pulando GC update`);
              residualResults.push({ id: residual.id, status: "error", error: "Sem gc_recebimento_id" });
              continue;
            }

            // Step 6A: PUT no GC — atualizar vencimento + descrição do PASSIVO
            const novoVencimento = dueDates[0]; // mesmo primeiro vencimento da negociação
            const osRef = residual.os_codigos?.length
              ? residual.os_codigos.map((c: string) => `OS ${c}`).join(', ')
              : '';
            const negOrigem = residual.negociacao_origem_numero
              ? `ex-Neg.${residual.negociacao_origem_numero}`
              : '';
            const novaDescricao = `${negTag} - Parcela - ${osRef} ${negOrigem}`.trim();

            // First GET the current receivable to preserve required fields
            const getResp = await rateLimitedFetch(
              `${GC_BASE_URL}/api/recebimentos/${residual.gc_recebimento_id}`,
              { headers: gcHeaders }
            );

            let putPayload: Record<string, unknown> = {
              data_vencimento: novoVencimento,
              descricao: novaDescricao,
            };

            if (getResp.ok) {
              const getData = await getResp.json();
              const rec = getData?.data?.[0] || getData?.data || getData?.Recebimento || getData;
              if (rec?.id) {
                // Preserve required fields from existing record
                putPayload = {
                  ...putPayload,
                  valor: rec.valor,
                  plano_contas_id: rec.plano_contas_id,
                  forma_pagamento_id: rec.forma_pagamento_id,
                  conta_bancaria_id: rec.conta_bancaria_id,
                  data_competencia: rec.data_competencia,
                  observacoes: `${String(rec.observacoes || '')}\nnegociado nº${negociacao_numero}`.trim(),
                };
              }
            }

            const putResp = await rateLimitedFetch(
              `${GC_BASE_URL}/api/recebimentos/${residual.gc_recebimento_id}`,
              { method: "PUT", headers: gcHeaders, body: JSON.stringify(putPayload) }
            );
            const putText = await putResp.text();

            if (!putResp.ok) {
              let putData: any;
              try { putData = JSON.parse(putText); } catch { putData = {}; }
              if (putData?.code !== 200) {
                console.error(`[negotiate-os] Step 6A falhou residual ${residual.id}: ${putText.slice(0, 300)}`);
                residualResults.push({ id: residual.id, status: "error", error: `GC PUT falhou (${putResp.status}): ${putText.slice(0, 200)}` });
                continue;
              }
            }

            console.log(`[negotiate-os] Step 6A OK: residual ${residual.id} vencimento → ${novoVencimento}`);

            // Step 6B: Vincular ao grupo local (fin_grupo_receber_itens)
            if (grupoIdForResidual) {
              // Find or create local receivable for this GC record
              const { data: localRec } = await supabase
                .from("fin_recebimentos")
                .select("id")
                .eq("gc_id", residual.gc_recebimento_id)
                .maybeSingle();

              let localRecId = localRec?.id;

              if (!localRecId) {
                // Try by gc_codigo
                const { data: localRec2 } = await supabase
                  .from("fin_recebimentos")
                  .select("id")
                  .eq("gc_codigo", residual.gc_recebimento_id)
                  .maybeSingle();
                localRecId = localRec2?.id;
              }

              if (localRecId) {
                await supabase.from("fin_grupo_receber_itens").insert({
                  grupo_id: grupoIdForResidual,
                  recebimento_id: localRecId,
                  valor: residual.valor_residual,
                  os_codigo_original: residual.os_codigos?.[0] || null,
                  snapshot_valor: residual.valor_residual,
                  snapshot_data: novoVencimento,
                });

                await supabase.from("fin_recebimentos")
                  .update({ grupo_id: grupoIdForResidual, data_vencimento: novoVencimento, descricao: novaDescricao })
                  .eq("id", localRecId);

                console.log(`[negotiate-os] Step 6B: residual vinculado ao grupo ${grupoIdForResidual}`);
              } else {
                console.warn(`[negotiate-os] Step 6B: recebimento local não encontrado para gc_id=${residual.gc_recebimento_id}`);
              }
            }

            // Step 6C: Marcar residual como utilizado
            await supabase
              .from("fin_residuos_negociacao")
              .update({ utilizado: true, utilizado_em: new Date().toISOString() })
              .eq("id", residual.id);

            residualResults.push({ id: residual.id, status: "ok" });
            console.log(`[negotiate-os] Residual ${residual.id} processado com sucesso`);
          } catch (err) {
            console.error(`[negotiate-os] Step 6 exception residual ${residual.id}:`, (err as Error).message);
            residualResults.push({ id: residual.id, status: "error", error: (err as Error).message });
          }
        }
      }

      const okCount = gcUpdateResults.filter((r) => r.status === "ok").length;
      const errCount = gcUpdateResults.filter((r) => r.status === "error").length;

      await supabase.from("fin_sync_log").insert({
        tipo: "negotiate-os",
        status: errCount > 0 ? (okCount > 0 ? "partial" : "erro") : "ok",
        payload: { os_ids, parcelas, dia_vencimento, mes_inicio, cliente_gc_id, valorNegociado },
        resposta: { gcUpdateResults, grupoIds, total_negociado: totalNegotiatedSuccess, total_passivo: totalResidualSuccess },
        duracao_ms: Date.now() - startTime,
      });

      return new Response(
        JSON.stringify({
          success: true,
          results: gcUpdateResults,
          residual_results: residualResults,
          grupos_criados: grupoIds.length,
          grupo_ids: grupoIds,
          negociacao_numero,
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
