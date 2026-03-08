import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

// Títulos genéricos que NÃO são nomes de contraparte
const TITULOS_GENERICOS = new Set([
  "pix enviado","pix recebido","transferência","transferencia",
  "ted enviado","ted recebido","doc enviado","doc recebido",
  "tarifa","taxa","iof","pagamento","recebimento","juros",
  "rendimento","aplicação","aplicacao","resgate","estorno",
]);

function nomeValido(s: string | null | undefined): string | null {
  if (!s) return null;
  const t = s.trim().toLowerCase();
  return TITULOS_GENERICOS.has(t) ? null : s.trim();
}

// Extrai nome real de descrições como "PAGAMENTO DE TITULO - INDUCERGEM INDUSTRIAL LTDA"
const NOMES_GENERICOS_DESC = new Set([
  "PIX", "TED", "DOC", "BOLETO", "TITULO", "TITULOS",
  "TRANSFERENCIA", "TRANSFERÊNCIA", "PAGAMENTO", "RECEBIMENTO",
  "CREDITO", "CRÉDITO", "DEBITO", "DÉBITO"
]);

function extrairNomeDescricao(descricao: unknown): string | null {
  if (!descricao || typeof descricao !== "string") return null;
  const match = descricao.match(/[-–]\s+([A-Za-zÀ-ÖØ-öø-ÿ0-9 .&\/'",-]+)$/);
  if (!match) return null;
  const nome = match[1].trim();
  if (nome.length < 3) return null;
  const primeira = nome.split(/\s+/)[0].toUpperCase();
  if (NOMES_GENERICOS_DESC.has(primeira)) return null;
  return nome;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const supabase    = createClient(supabaseUrl, serviceKey);
  const startMs     = Date.now();

  const body = await req.json().catch(() => ({}));
  const now  = new Date();
  const dataFim    = body.dataFim ?? now.toISOString().substring(0, 10);
  const dataInicio = body.dataInicio ?? (() => {
    const d = new Date(now.getTime() - (body.days ?? 7) * 86400000);
    return d.toISOString().substring(0, 10);
  })();

  try {
    const proxyUrl     = `${supabaseUrl}/functions/v1/inter-proxy`;
    const proxyHeaders = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${serviceKey}`,
    };

    // ── Cascade de endpoints: enriquecido primeiro ──
    const ENDPOINTS = [
      {
        path:    `/banking/v3/extrato/enriquecido?dataInicio=${dataInicio}&dataFim=${dataFim}`,
        label:   "v3/enriquecido",
        extract: (d: any) => d.transacoes ?? d.resultado ?? (Array.isArray(d) ? d : null),
        rich:    true,
      },
      {
        path:    `/banking/v3/extrato?dataInicio=${dataInicio}&dataFim=${dataFim}&pagina=0&tamanhoPagina=500`,
        label:   "v3/extrato",
        extract: (d: any) => d.transacoes ?? d.resultado ?? (Array.isArray(d) ? d : null),
        rich:    true,
      },
      {
        path:    `/banking/v2/extrato/completo?dataInicio=${dataInicio}&dataFim=${dataFim}`,
        label:   "v2/completo",
        extract: (d: any) => d.transacoes ?? d.resultado ?? (Array.isArray(d) ? d : null),
        rich:    false,
      },
      {
        path:    `/banking/v2/extrato?dataInicio=${dataInicio}&dataFim=${dataFim}`,
        label:   "v2/extrato",
        extract: (d: any) => d.transacoes ?? d.resultado ?? (Array.isArray(d) ? d : null),
        rich:    false,
      },
    ];

    let transacoes: any[] | null = null;
    let endpointUsado = "";
    let endpointRich  = false;

    for (const ep of ENDPOINTS) {
      try {
        console.log(`[inter-extrato] Tentando ${ep.label}...`);
        const res  = await fetch(proxyUrl, {
          method: "POST", headers: proxyHeaders,
          body: JSON.stringify({ path: ep.path, method: "GET" }),
        });
        const data = await res.json().catch(() => ({}));

        // Detectar 404/403 tanto no status HTTP quanto no body
        if (res.status === 404 || res.status === 403 ||
            res.status === 401 || res.status === 500) {
          console.warn(`[inter-extrato] ${ep.label} → HTTP ${res.status}, próximo...`);
          continue;
        }
        if (data?.raw && String(data.raw).match(/40[34]|404|not found/i)) {
          console.warn(`[inter-extrato] ${ep.label} → body 404, próximo...`);
          continue;
        }
        if (data?.error && String(data.error).match(/40[34]|404|not found/i)) {
          console.warn(`[inter-extrato] ${ep.label} → error 404, próximo...`);
          continue;
        }

        const lista = ep.extract(data);
        if (Array.isArray(lista)) {
          transacoes    = lista;
          endpointUsado = ep.label;
          endpointRich  = ep.rich;
          console.log(`[inter-extrato] ✅ ${ep.label} → ${lista.length} transações`);
          break;
        }
        console.warn(`[inter-extrato] ${ep.label} → resposta inesperada, próximo...`);
      } catch (e) {
        console.warn(`[inter-extrato] ${ep.label} → exception: ${(e as Error).message}`);
      }
    }

    if (!transacoes) {
      throw new Error(
        "Todos os endpoints Inter retornaram erro. " +
        "Verifique: 1) escopo extrato.read no Portal Inter; " +
        "2) secret INTER_NUMERO_CONTA no Supabase; " +
        "3) certificado ativo."
      );
    }

    if (transacoes.length === 0) {
      return new Response(
        JSON.stringify({ success: true, extrato: { total: 0, inserted: 0, skipped: 0, errors: 0 } }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    let inserted = 0, skipped = 0, errors = 0;

    for (const tx of transacoes) {
      try {
        const det    = tx.detalhe ?? tx.detalhes ?? {};
        const tipoOp = (tx.tipoOperacao ?? "").toUpperCase();
        const tipoTx = (tx.tipoTransacao ?? tx.tipo ?? "").toUpperCase();

        // Crédito: tipoOperacao "C" ou tipoTransacao "CREDITO"/"ENTRADA"
        const isCredito =
          tipoOp === "C" ||
          tipoTx === "CREDITO" ||
          tipoTx === "ENTRADA";
        const tipo = isCredito ? "CREDITO" : "DEBITO";

        // ── Extração de campos enriquecidos ──
        const cpfCnpjRaw = isCredito
          ? (det.cpfCnpjPagador ?? det.cpfCnpjRemetente ?? det.cpfCnpj ?? tx.cpfCnpjContraparte)
          : (det.cpfCnpjBeneficiario ?? det.cpfCnpjRecebedor ?? det.cpfCnpjDestinatario ?? det.cpfCnpj ?? tx.cpfCnpjContraparte);
        const cpfCnpj = cpfCnpjRaw ? String(cpfCnpjRaw).replace(/\D/g, "") || null : null;

        const nomeRaw = isCredito
          ? (det.nomePagador ?? det.nomeRemetente ?? det.nome ?? tx.nomeContraparte)
          : (det.nomeBeneficiario ?? det.nomeRecebedor ?? det.nomeDestinatario ?? det.nome ?? tx.nomeContraparte);
        const nomeContraparte = nomeValido(nomeRaw)
          ?? extrairNomeDescricao(tx.descricao ?? tx.titulo ?? tx.historico);

        const chavePix    = det.chavePixRecebedor ?? det.chavePixBeneficiario ?? det.chavePixPagador ?? det.chave ?? null;
        const codigoBarras= det.codigoBarras ?? null;
        const realId      = det.endToEndId ?? tx.endToEndId ?? tx.codigoTransacao ?? codigoBarras ?? null;
        const valor       = Math.abs(parseFloat(String(tx.valor ?? "0").replace(",", ".")));
        // Inter API retorna horários em BRT (UTC-3) sem timezone info
        const dataHoraRaw = tx.dataHora ?? tx.dataInclusao ?? tx.dataEntrada ?? tx.dataMovimento ?? now.toISOString();
        // Se não tem timezone (+/-), assumir BRT (-03:00)
        const dataHora = (() => {
          const s = String(dataHoraRaw).trim();
          if (/[+-]\d{2}:\d{2}$/.test(s) || s.endsWith("Z")) return s; // já tem TZ
          // Formato "2026-03-07 10:59:30.000" → "2026-03-07T10:59:30-03:00"
          const iso = s.replace(" ", "T").replace(/\.000$/, "");
          return `${iso}-03:00`;
        })();

        // ── Dedup sem endToEndId: janela ±2 dias ──
        if (!realId) {
          const base = new Date(dataHora);
          const df   = new Date(base.getTime() - 2*86400000).toISOString().substring(0,10);
          const dt   = new Date(base.getTime() + 2*86400000).toISOString().substring(0,10);

          const { data: existing } = await supabase
            .from("fin_extrato_inter")
            .select("id, nome_contraparte, cpf_cnpj")
            .eq("valor", valor).eq("tipo", tipo)
            .gte("data_hora", `${df}T00:00:00`)
            .lte("data_hora", `${dt}T23:59:59`)
            .limit(1);

          if (existing?.length) {
            const ex = existing[0] as any;
            // Enriquecer se registro existente tem campos vazios
            const patch: any = {};
            if (nomeContraparte && !ex.nome_contraparte) {
              patch.nome_contraparte = nomeContraparte;
              patch.contrapartida    = nomeContraparte;
            }
            if (cpfCnpj && !ex.cpf_cnpj) patch.cpf_cnpj = cpfCnpj;
            if (Object.keys(patch).length) {
              await supabase.from("fin_extrato_inter").update(patch).eq("id", ex.id);
            }
            skipped++;
            continue;
          }
        }

        // ── Remover fantasmas (fallback sem real endToEndId) ──
        if (realId) {
          const dateOnly = String(dataHora).substring(0,10);
          const { data: phantoms } = await supabase
            .from("fin_extrato_inter")
            .select("id, end_to_end_id")
            .eq("valor", valor).eq("tipo", tipo)
            .gte("data_hora", `${dateOnly}T00:00:00`)
            .lte("data_hora", `${dateOnly}T23:59:59`)
            .neq("end_to_end_id", realId);

          if (phantoms?.length) {
            const fallbackIds = phantoms
              .filter((p: any) =>
                /^\d{4}-\d{2}-\d{2}-/.test(p.end_to_end_id) ||
                /^webhook-/.test(p.end_to_end_id))
              .map((p: any) => p.id);
            if (fallbackIds.length)
              await supabase.from("fin_extrato_inter").delete().in("id", fallbackIds);
          }
        }

        const endToEndId = realId ?? `${String(dataHora).substring(0,10)}-${valor}-${tipo}`;

        // ── Montar record sem sobrescrever campos já preenchidos ──
        // Campos ausentes (undefined) → upsert NÃO sobrescreve o banco
        const record: any = {
          end_to_end_id: endToEndId,
          tipo,
          tipo_transacao: tx.tipoTransacao ?? null,
          valor,
          data_hora: dataHora,
          descricao: tx.titulo ?? tx.descricao ?? tx.historico ?? null,
          payload_raw: tx,
        };
        if (nomeContraparte) {
          record.nome_contraparte = nomeContraparte;
          record.contrapartida    = nomeContraparte;
        }
        if (cpfCnpj)     record.cpf_cnpj      = cpfCnpj;
        if (chavePix)    record.chave_pix      = chavePix;
        if (codigoBarras)record.codigo_barras  = codigoBarras;

        const { error: upsertErr } = await supabase
          .from("fin_extrato_inter")
          .upsert(record, { onConflict: "end_to_end_id", ignoreDuplicates: false });

        if (upsertErr) { console.error("[inter-extrato] upsert:", upsertErr.message); errors++; }
        else inserted++;

      } catch (txErr) {
        console.error("[inter-extrato] tx error:", (txErr as Error).message);
        errors++;
      }
    }

    const duracao = Date.now() - startMs;
    try {
      await supabase.from("fin_sync_log").insert({
        tipo: "inter_extrato_sync",
        status: errors > 0 ? "partial" : "success",
        duracao_ms: duracao,
        payload: { dataInicio, dataFim, endpoint: endpointUsado, rich: endpointRich },
        resposta: { total: transacoes.length, inserted, skipped, errors },
      });
    } catch { /* não bloquear */ }

    console.log("[inter-extrato] Disparando reconciliation-engine...");
    const reconRes  = await fetch(`${supabaseUrl}/functions/v1/reconciliation-engine`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${serviceKey}` },
      body: JSON.stringify({}),
    });
    const reconData = await reconRes.json().catch(() => ({ error: "parse error" }));

    return new Response(
      JSON.stringify({
        success: true,
        extrato: { total: transacoes.length, inserted, skipped, errors, duracao_ms: duracao, endpoint: endpointUsado },
        reconciliacao: reconData,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );

  } catch (err) {
    const msg = (err as Error).message;
    console.error("[inter-extrato] ERRO:", msg);
    try {
      await supabase.from("fin_sync_log").insert({
        tipo: "inter_extrato_sync", status: "error",
        duracao_ms: Date.now() - startMs, erro: msg,
      });
    } catch { /* ignore */ }
    return new Response(
      JSON.stringify({ success: false, error: msg }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
