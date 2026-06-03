import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";

const OS_EXECUTADOS_STATUS = [
  "EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA",
  "EXECUTADO - AGUARDANDO PAGAMENTO",
  "EXECUTADO COM NOTA EMITIDA",
  "EXECUTADO - FINANCEIRO SEPARADO",
  "EXECUTADO - CIGAM",
  "EXECUTADO POR CONTRATO",
  "EXECUTADO - FECHADO CHAMADO",
  "EXECUTADO EM GARANTIA",
  "EXECUTADO -PATRIMÔNIO",
  "EXECUTADO - LIBERADO P/ FATURAMENTO (CIGAM SEM BAIXA ESTOQ)",
];

function normalize(s: string): string {
  return (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[.,/\\-]/g, " ")
    .replace(/\b(ltda|me|epp|eireli|s\/?a|sa)\b\.?/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isDeslocamento(desc: string): boolean {
  const n = normalize(desc);
  return n.includes("deslocamento") || n.includes("desloc.") || n.startsWith("desloc");
}

function isHospedagemAlimentacao(desc: string): boolean {
  const n = normalize(desc);
  return n.includes("hospedag") || n.includes("alimentac") || n.includes("refeic") || n.includes("diaria") || n.includes("hotel");
}

function isServicoTaxa5(desc: string): boolean {
  const n = normalize(desc);
  return n.includes("higienizac") && n.includes("coifa");
}

function isServicoTaxa10(desc: string): boolean {
  const n = normalize(desc);
  return n.includes("reoperac");
}

function toNum(v: unknown): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const raw = String(v).trim();
  const ptBr = raw.replace(/\./g, "").replace(",", ".");
  const parsedPtBr = parseFloat(ptBr);
  if (!Number.isNaN(parsedPtBr) && raw.includes(",")) return parsedPtBr;
  const parsed = parseFloat(raw);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function calcItemTotal(item: Record<string, unknown>): number {
  if (item.valor_total !== null && item.valor_total !== undefined && String(item.valor_total).trim() !== "") {
    return Math.max(0, toNum(item.valor_total));
  }

  const quantidade = toNum(item.quantidade) || 1;
  const bruto =
    toNum(item.valor_total_bruto) ||
    toNum(item.valor_bruto) ||
    toNum(item.subtotal) ||
    ((toNum(item.valor_venda) || toNum(item.valor_unitario)) * quantidade);

  const descontoPercentual =
    toNum(item.desconto_porcentagem) ||
    toNum(item.desconto_percentual) ||
    toNum(item.percentual_desconto) ||
    toNum(item.percentualDesconto);

  if (descontoPercentual >= 100) return 0;
  if (descontoPercentual > 0) return Math.max(0, bruto - (bruto * descontoPercentual / 100));

  const descontoValor =
    toNum(item.desconto_valor) ||
    toNum(item.valor_desconto) ||
    toNum(item.valorDesconto);

  if (descontoValor > 0) return Math.max(0, bruto - descontoValor);

  const descontoGenerico = toNum(item.desconto);
  if (descontoGenerico >= 100) return 0;
  if (descontoGenerico > 0) return Math.max(0, bruto - (bruto * descontoGenerico / 100));

  return Math.max(0, bruto);
}

function computeFaturamentoPremiacao(detail: Record<string, unknown>): number {
  const produtos: Record<string, unknown>[] = (Array.isArray(detail.produtos) ? detail.produtos : [])
    .map((x: any) => x?.produto || x)
    .filter(Boolean);
  const servicos: Record<string, unknown>[] = (Array.isArray(detail.servicos) ? detail.servicos : [])
    .map((x: any) => x?.servico || x)
    .filter(Boolean);

  const totalRecebidoOS = toNum(detail.valor_total);
  const totalRecebidoPecasOS = toNum(detail.valor_produtos);
  const totalRecebidoServicosOS = toNum(detail.valor_servicos);

  let valorPecas = 0;
  let valorServicos = 0;
  let valorServicosTaxa5 = 0;
  let valorServicosTaxa10 = 0;
  let faturamentoOs = 0;

  for (const p of produtos) {
    const descProd = String(p.nome_produto || p.detalhes || "");
    const total = calcItemTotal(p);
    const hospAlim = isHospedagemAlimentacao(descProd);
    const semValorRecebido = total <= 0 || totalRecebidoOS <= 0 || totalRecebidoPecasOS <= 0;
    if (!hospAlim && !semValorRecebido) {
      valorPecas += total;
      faturamentoOs += total;
    }
  }

  for (const s of servicos) {
    const desc = String(s.nome_servico || s.nome || s.descricao || s.detalhes || "");
    const total = calcItemTotal(s);
    const desloc = isDeslocamento(desc);
    const hospAlim = isHospedagemAlimentacao(desc);
    const semValorRecebido = total <= 0 || totalRecebidoOS <= 0 || totalRecebidoServicosOS <= 0;
    if (desloc || hospAlim || semValorRecebido || total <= 0) continue;

    if (isServicoTaxa5(desc)) {
      valorServicosTaxa5 += total;
    } else if (isServicoTaxa10(desc)) {
      valorServicosTaxa10 += total;
    } else {
      valorServicos += total;
    }
    faturamentoOs += total;
  }

  const descValorOS = toNum(detail.desconto_valor) || toNum(detail.desconto) || toNum(detail.valor_desconto);
  const descPctOS = toNum(detail.desconto_porcentagem);
  const subtotalOS = valorPecas + valorServicos;
  const descontoGeral = descValorOS > 0 ? descValorOS : (descPctOS > 0 ? subtotalOS * (descPctOS / 100) : 0);

  if (descontoGeral > 0) {
    const baseTotal = valorPecas + valorServicos + valorServicosTaxa5 + valorServicosTaxa10;
    if (baseTotal > 0) {
      const rateioPecas = descontoGeral * (valorPecas / baseTotal);
      const rateioServ = descontoGeral * (valorServicos / baseTotal);
      const rateioServ5 = descontoGeral * (valorServicosTaxa5 / baseTotal);
      const rateioServ10 = descontoGeral * (valorServicosTaxa10 / baseTotal);
      valorPecas = Math.max(0, valorPecas - rateioPecas);
      valorServicos = Math.max(0, valorServicos - rateioServ);
      valorServicosTaxa5 = Math.max(0, valorServicosTaxa5 - rateioServ5);
      valorServicosTaxa10 = Math.max(0, valorServicosTaxa10 - rateioServ10);
      faturamentoOs = Math.max(0, faturamentoOs - (rateioPecas + rateioServ + rateioServ5 + rateioServ10));
    }
  }

  if (totalRecebidoOS <= 0) {
    return 0;
  }

  valorPecas = Math.min(valorPecas, totalRecebidoPecasOS);
  const totalServicos = valorServicos + valorServicosTaxa5 + valorServicosTaxa10;
  if (totalServicos > totalRecebidoServicosOS && totalServicos > 0) {
    const ratio = totalRecebidoServicosOS / totalServicos;
    valorServicos *= ratio;
    valorServicosTaxa5 *= ratio;
    valorServicosTaxa10 *= ratio;
  }

  return Math.max(0, faturamentoOs);
}

async function fetchOsDetail(osId: string, gcHeaders: Record<string, string>): Promise<Record<string, unknown> | null> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const resp = await fetch(`${GC_BASE_URL}/api/ordens_servicos/${osId}`, { headers: gcHeaders });
      if (resp.status === 429) {
        await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        continue;
      }
      if (!resp.ok) return null;
      const data = await resp.json().catch(() => null);
      return data?.data || data;
    } catch {
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const { year, month } = await req.json().catch(() => ({ year: null, month: null }));
    const y = Number(year);
    const m = Number(month);
    if (!Number.isInteger(y) || !Number.isInteger(m) || m < 1 || m > 12) {
      return new Response(JSON.stringify({ ok: false, error: "Informe year e month válidos." }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const mm = String(m).padStart(2, "0");
    const start = `${y}-${mm}-01`;
    const end = `${y}-${mm}-${String(new Date(y, m, 0).getDate()).padStart(2, "0")}`;

    const supabase = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const gcHeaders = {
      "access-token": Deno.env.get("GC_ACCESS_TOKEN")!,
      "secret-access-token": Deno.env.get("GC_SECRET_TOKEN")!,
      "Content-Type": "application/json",
    };

    const { data: retornosData, error: retornosError } = await supabase
      .from("fin_os_retornos")
      .select("os_codigo, tecnico_original, tecnico_retorno, valor")
      .eq("ano", y)
      .eq("mes", m);
    if (retornosError) throw retornosError;

    const retornoByCodigo = new Map<string, any>();
    for (const r of retornosData || []) {
      const code = String(r.os_codigo || "").trim();
      if (code) retornoByCodigo.set(code, r);
    }
    const retornoCodes = new Set(Array.from(retornoByCodigo.keys()));

    const { data: baseRows, error: baseError } = await supabase
      .from("os_index")
      .select("os_id, os_codigo, nome_cliente, nome_situacao, nome_vendedor, data_saida")
      .in("nome_situacao", OS_EXECUTADOS_STATUS)
      .gte("data_saida", start)
      .lte("data_saida", end);
    if (baseError) throw baseError;

    let retornoRows: any[] = [];
    const missingRetornoCodes = Array.from(retornoCodes).filter(
      (code) => !(baseRows || []).some((r: any) => String(r.os_codigo) === code),
    );
    if (missingRetornoCodes.length > 0) {
      const { data, error } = await supabase
        .from("os_index")
        .select("os_id, os_codigo, nome_cliente, nome_situacao, nome_vendedor, data_saida")
        .in("os_codigo", missingRetornoCodes);
      if (error) throw error;
      retornoRows = data || [];
      const foundCodes = new Set(retornoRows.map((row: any) => String(row.os_codigo || "").trim()).filter(Boolean));
      for (const code of missingRetornoCodes) {
        if (!foundCodes.has(code)) {
          const retorno = retornoByCodigo.get(code);
          retornoRows.push({
            os_id: `retorno:${code}`,
            os_codigo: code,
            nome_cliente: null,
            nome_situacao: "RETORNO LANÇADO",
            nome_vendedor: retorno?.tecnico_original || null,
            data_saida: null,
          });
        }
      }
    }

    const byOsId = new Map<string, any>();
    for (const row of [...(baseRows || []), ...retornoRows]) {
      if (row?.os_id) byOsId.set(String(row.os_id), row);
    }

    const rows = Array.from(byOsId.values());
    const details = new Map<string, Record<string, unknown>>();
    const PAR = 6;
    for (let i = 0; i < rows.length; i += PAR) {
      const batch = rows.slice(i, i + PAR);
      const fetched = await Promise.all(batch.map((row: any) => {
        const osId = String(row.os_id || "");
        return osId.startsWith("retorno:") ? Promise.resolve(null) : fetchOsDetail(osId, gcHeaders);
      }));
      batch.forEach((row: any, idx: number) => {
        if (fetched[idx]) details.set(String(row.os_id), fetched[idx]!);
      });
    }

    const ordens = [];
    for (const row of rows) {
      const detail = details.get(String(row.os_id));
      const codigo = String(row.os_codigo || detail?.codigo || "").trim();
      const dataSaida = String(detail.data_saida || row.data_saida || "").split("T")[0];
      const isRetorno = retornoCodes.has(codigo);
      const retorno = retornoByCodigo.get(codigo);
      if (!detail && !isRetorno) continue;

      if (!isRetorno) {
        if (!dataSaida || dataSaida < start || dataSaida > end) continue;
        const [dy, dm, dd] = dataSaida.split("-").map(Number);
        const dow = new Date(Date.UTC(dy, (dm || 1) - 1, dd || 1)).getUTCDay();
        if (dow === 0 || dow === 6) continue;
      }

      const valorCalculado = detail ? computeFaturamentoPremiacao(detail) : 0;
      const valor = isRetorno && valorCalculado <= 0 ? toNum(retorno?.valor) : valorCalculado;
      if (valor <= 0) continue;

      ordens.push({
        os_codigo: codigo,
        nome_vendedor: String(detail?.nome_vendedor || row.nome_vendedor || retorno?.tecnico_original || "") || null,
        nome_situacao: String(detail?.nome_situacao || row.nome_situacao || "") || null,
        data_saida: dataSaida || row.data_saida || null,
        valor_total: valor,
        valor_deslocamento: 0,
      });
    }

    return new Response(JSON.stringify({ ok: true, year: y, month: m, ordens }), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    return new Response(JSON.stringify({ ok: false, error: (error as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
