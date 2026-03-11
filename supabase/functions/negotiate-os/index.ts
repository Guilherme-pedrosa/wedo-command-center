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
        .filter((c) => c.os_list.length > 1)
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
          console.log(`[negotiate-os] STEP B: OS ${os.id} → ${parcelas} parcelas`);
          const valorOS = os.valor_total;
          const valorParcelaOS = Math.floor((valorOS / parcelas) * 100) / 100;
          const valorUltimaOS = Math.round((valorOS - valorParcelaOS * (parcelas - 1)) * 100) / 100;

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

          const stepBPayload: Record<string, unknown> = {
            ...basePayload,
            situacao_id: SITUACAO_INTERMEDIARIA,
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
              if (planoContasId) { pagamento.plano_contas_id = planoContasId; pagamento.categoria_id = planoContasId; }
              if (nomePlanoConta) { pagamento.nome_plano_conta = nomePlanoConta; pagamento.nome_categoria = nomePlanoConta; }
              return { pagamento };
            }),
          };

          const existingObs = String(stepBPayload["observacoes"] || "");
          stepBPayload["observacoes"] = existingObs
            ? `${existingObs}\nnegociado nº${negociacao_numero}`
            : `negociado nº${negociacao_numero}`;
          if (formaPagamentoId) stepBPayload["forma_pagamento_id"] = formaPagamentoId;

          const stepBResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/ordens_servicos/${os.id}`,
            { method: "PUT", headers: gcHeaders, body: JSON.stringify(stepBPayload) }
          );
          const stepBData = await stepBResp.json();
          if (!stepBResp.ok && stepBData?.code !== 200) {
            gcUpdateResults.push({ os_id: os.id, status: "error", error: `Step B failed: ${stepBData?.message || stepBResp.status}` });
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
      // 3. CREATE GROUPS IMMEDIATELY (before Step D to avoid timeout)
      // ═══════════════════════════════════════════════════════════════
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

        console.log(`[negotiate-os] Criando ${parcelas} grupo(s) para ${successOS.length} OS...`);

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
              itens_total: successOS.length,
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
          console.log(`[negotiate-os] Grupo ${i + 1}/${parcelas} criado: ${grupo.id}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 4. STEP D: Tag descriptions in GC (best-effort, single pass)
      // ═══════════════════════════════════════════════════════════════
      for (const os of successOS) {
        try {
          await new Promise((r) => setTimeout(r, 800));
          console.log(`[negotiate-os] STEP D: OS ${os.codigo} → buscando financeiros`);

          const valorOS = os.valor_total;
          const valorParcelaOS = Math.floor((valorOS / parcelas) * 100) / 100;
          const valorUltimaOS = Math.round((valorOS - valorParcelaOS * (parcelas - 1)) * 100) / 100;

          const expectedByDueDate = new Map<string, number[]>();
          for (let idx = 0; idx < dueDates.length; idx++) {
            const due = dueDates[idx];
            const expectedValue = Number((idx === parcelas - 1 ? valorUltimaOS : valorParcelaOS).toFixed(2));
            const bucket = expectedByDueDate.get(due) || [];
            bucket.push(expectedValue);
            expectedByDueDate.set(due, bucket);
          }

          const sortedDueDates = [...dueDates].sort();
          const minDueDate = sortedDueDates[0];
          const maxDueDate = sortedDueDates[sortedDueDates.length - 1];

          const normalizeMoney = (value: unknown): number => {
            const parsed = Number.parseFloat(String(value ?? "0").replace(",", "."));
            if (!Number.isFinite(parsed)) return 0;
            return Math.round(parsed * 100) / 100;
          };

          const codigoLower = os.codigo.toLowerCase();

          // Single fetch pass
          const searchParams = new URLSearchParams({
            limite: "100",
            pagina: "1",
            data_inicio: minDueDate,
            data_fim: maxDueDate,
          });

          const recResp = await rateLimitedFetch(
            `${GC_BASE_URL}/api/recebimentos?${searchParams.toString()}`,
            { headers: gcHeaders }
          );

          if (!recResp.ok) {
            console.warn(`[negotiate-os] STEP D: fetch failed ${recResp.status}`);
            continue;
          }

          const recData = await recResp.json();
          const rawList = Array.isArray(recData?.data) ? recData.data : [];

          const matching = rawList.filter((item: any) => {
            const rec = item?.Recebimento || item?.recebimento || item;
            const desc = String(rec?.descricao || "").toLowerCase();
            const matchesOS = desc.includes(codigoLower) || desc.includes(`os ${codigoLower}`);
            const dueDate = String(rec?.data_vencimento || "").slice(0, 10);
            const expectedValues = expectedByDueDate.get(dueDate) || [];
            const recValue = normalizeMoney(rec?.valor ?? rec?.valor_total);
            const matchesValue = expectedValues.some((v) => Math.abs(v - recValue) <= 0.02);
            return matchesOS || matchesValue;
          });

          console.log(`[negotiate-os] STEP D: ${rawList.length} financeiros, ${matching.length} candidatos para OS ${os.codigo}`);

          for (const item of matching) {
            const rec = item?.Recebimento || item?.recebimento || item;
            const recId = String(rec?.id || "").trim();
            if (!recId) continue;

            const currentDesc = String(rec?.descricao || "").trim();
            if (currentDesc.toUpperCase().includes(negTag.toUpperCase())) continue;

            const cleanedDesc = currentDesc
              .replace(/^\[?\s*neg[\s#\.\-]*\d+\]?\s*[-–—:]?\s*/i, "")
              .replace(/^NEG\d+\s*[-–—:]?\s*/i, "")
              .trim();
            const newDesc = `${negTag} - ${cleanedDesc || `OS ${os.codigo}`}`;

            const putPayload: Record<string, unknown> = {
              descricao: newDesc,
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
              console.log(`[negotiate-os] STEP D OK: ${recId} → "${newDesc}"`);
            } else {
              console.warn(`[negotiate-os] STEP D ERRO: ${recId}: ${putData?.message || putResp.status}`);
            }
          }
        } catch (stepDErr: any) {
          console.warn(`[negotiate-os] STEP D error (non-fatal): ${stepDErr.message}`);
        }
      }

      // ═══════════════════════════════════════════════════════════════
      // 5. Link fin_recebimentos to groups (best-effort after sync)
      // ═══════════════════════════════════════════════════════════════
      if (grupoIds.length > 0 && successOS.length > 0) {
        try {
          for (let i = 0; i < grupoIds.length && i < parcelas; i++) {
            const grupoId = grupoIds[i];
            const vencimento = dueDates[i];

            for (const os of successOS) {
              const { data: recs } = await supabase
                .from("fin_recebimentos")
                .select("id, gc_codigo, valor, data_vencimento, os_codigo")
                .eq("os_codigo", os.codigo)
                .eq("liquidado", false)
                .is("grupo_id", null)
                .eq("data_vencimento", vencimento)
                .limit(5);

              if (recs && recs.length > 0) {
                for (const rec of recs) {
                  await supabase
                    .from("fin_grupo_receber_itens")
                    .insert({
                      grupo_id: grupoId,
                      recebimento_id: rec.id,
                      valor: rec.valor,
                      os_codigo_original: rec.os_codigo || os.codigo,
                      snapshot_valor: rec.valor,
                      snapshot_data: vencimento,
                    });

                  await supabase
                    .from("fin_recebimentos")
                    .update({ grupo_id: grupoId })
                    .eq("id", rec.id);
                }
                console.log(`[negotiate-os] Grupo ${i + 1}: ${recs.length} itens vinculados (OS ${os.codigo})`);
              }
            }
          }
        } catch (linkErr: any) {
          console.warn(`[negotiate-os] Link error (non-fatal): ${linkErr.message}`);
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
