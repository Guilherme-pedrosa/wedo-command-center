/**
 * fis-sync-saida — traz as notas de SAÍDA do GestãoClick para a base fiscal.
 *
 * Cobre os três modelos que compõem receita:
 *   /notas_fiscais_produtos     -> NF-e  (modelo 55)
 *   /notas_fiscais_consumidores -> NFC-e (modelo 65)
 *   /notas_fiscais_servicos     -> NFS-e
 *
 * Por que não reaproveitar gc_vendas: a venda no GC não carrega CFOP nem
 * natureza da operação, então a Regra 1.3 (expurgo de devolução, bonificação
 * e retorno de garantia) não teria como ser aplicada. A NF carrega — inclusive
 * CFOP por item — e é o documento que a Receita enxerga.
 *
 * A NFS-e ainda traz as retenções na fonte declaradas (pis_retido/cofins_retido
 * + valores), que alimentam a Regra 3.
 *
 * Esta função NÃO decide o que é receita. Só traz o que o GC diz.
 */
import { installGcUsuarioId } from "../_shared/gc-user.ts";
installGcUsuarioId();

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const GC_BASE_URL = "https://api.gestaoclick.com";
const MIN_DELAY_MS = 350;
const TIMEOUT_MS = 25_000;
let lastCallTime = 0;

async function rateLimitedFetch(url: string, options: RequestInit): Promise<Response> {
  const elapsed = Date.now() - lastCallTime;
  if (elapsed < MIN_DELAY_MS) await new Promise((r) => setTimeout(r, MIN_DELAY_MS - elapsed));
  lastCallTime = Date.now();
  return fetch(url, options);
}

/** Aceita "1.234,56" e "1234.56" — o GC alterna conforme o campo. */
function num(raw: unknown): number {
  if (raw === null || raw === undefined || raw === "") return 0;
  const s = String(raw).trim();
  const normalizado = s.includes(",") ? s.replace(/\./g, "").replace(",", ".") : s;
  const n = parseFloat(normalizado);
  return Number.isFinite(n) ? n : 0;
}

function txt(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  return s === "" ? null : s;
}

function flag(raw: unknown): boolean {
  const s = String(raw ?? "").trim().toLowerCase();
  return s === "1" || s === "true" || s === "sim";
}

/** Data do GC vem como YYYY-MM-DD ou DD/MM/YYYY. */
function dataIso(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  const iso = s.match(/^(\d{4}-\d{2}-\d{2})/);
  if (iso) return iso[1];
  const br = s.match(/^(\d{2})\/(\d{2})\/(\d{4})/);
  if (br) return `${br[3]}-${br[2]}-${br[1]}`;
  return null;
}

function primeiroDiaDoMes(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

/**
 * Classifica o status da nota. "Aprovada" é a única que entra na base
 * (Regra 1.2); as demais ficam registradas para rastro, marcadas.
 */
function classificarSituacao(situacao: string | null) {
  const s = (situacao ?? "").toLowerCase();
  return {
    autorizada: /aprovad|autorizad/.test(s),
    cancelada: /cancelad/.test(s),
    denegada: /denegad/.test(s),
  };
}

interface EndpointCfg {
  endpoint: string;
  modelo: "55" | "65" | "NFSE";
  raiz: string;
}

const ENDPOINTS: EndpointCfg[] = [
  { endpoint: "/api/notas_fiscais_produtos", modelo: "55", raiz: "NotaFiscalProduto" },
  { endpoint: "/api/notas_fiscais_consumidores", modelo: "65", raiz: "NotaFiscalConsumidor" },
  { endpoint: "/api/notas_fiscais_servicos", modelo: "NFSE", raiz: "NotaFiscalServico" },
];

/** O GC ora devolve { Entidade: {...} }, ora o objeto direto. */
function desembrulhar(registro: Record<string, unknown>, raiz: string): Record<string, unknown> {
  const interno = registro?.[raiz];
  if (interno && typeof interno === "object" && !Array.isArray(interno)) {
    return interno as Record<string, unknown>;
  }
  return registro;
}

function mapearProduto(n: Record<string, unknown>, modelo: "55" | "65", registro: unknown) {
  const dataEmissao = dataIso(n.data_emissao ?? n.data);
  if (!dataEmissao) return null;
  const sit = txt(n.situacao_nf) ?? txt(n.situacao);

  return {
    gc_id: String(n.id ?? ""),
    modelo,
    numero: txt(n.numero_nf ?? n.numero),
    serie: txt(n.serie),
    chave: txt(n.chave),
    protocolo: txt(n.protocolo),
    data_emissao: dataEmissao,
    competencia: primeiroDiaDoMes(dataEmissao),
    situacao_nf: sit,
    ...classificarSituacao(sit),
    natureza_operacao: txt(n.natureza_operacao),
    codigo_cfop: txt(n.codigo_cfop),
    descricao_cfop: txt(n.descricao_cfop),
    destinatario_nome: txt(n.destinatario_nome ?? n.destinatario_fornecedor_nome),
    destinatario_doc: txt(n.destinatario_cnpj) ?? txt(n.destinatario_cpf),
    destinatario_uf: txt(n.destinatario_uf),
    destinatario_ie: txt(n.destinatario_ie),
    consumidor_final: flag(n.consumidor_final ?? n.indicador_final),
    valor_produtos: num(n.valor_produtos),
    valor_servico: 0,
    valor_desconto: num(n.valor_desconto),
    valor_frete: num(n.valor_frete),
    valor_total_nf: num(n.valor_total_nf),
    base_icms: num(n.base_icms),
    valor_icms: num(n.valor_icms),
    base_icms_st: num(n.base_icms_st),
    valor_icms_st: num(n.valor_icms_st),
    valor_fcp: num(n.valor_fcp),
    valor_fcp_st: num(n.valor_fcp_st),
    valor_ipi: num(n.valor_ipi),
    valor_pis: num(n.valor_pis),
    valor_cofins: num(n.valor_cofins),
    gc_payload_raw: registro,
    last_synced_at: new Date().toISOString(),
  };
}

function mapearServico(n: Record<string, unknown>, registro: unknown) {
  const dataEmissao = dataIso(n.data_emissao ?? n.data);
  if (!dataEmissao) return null;
  const sit = txt(n.situacao_nf) ?? txt(n.situacao);

  // Na NFS-e, valor_pis/valor_cofins são os valores RETIDOS quando os
  // respectivos flags *_retido estão ligados.
  return {
    gc_id: String(n.id ?? ""),
    modelo: "NFSE" as const,
    numero: txt(n.numero),
    serie: txt(n.serie ?? n.rps),
    chave: txt(n.codigo_verificacao),
    protocolo: null,
    data_emissao: dataEmissao,
    competencia: primeiroDiaDoMes(dataEmissao),
    situacao_nf: sit,
    ...classificarSituacao(sit),
    natureza_operacao: txt(n.nome_natureza_operacao ?? n.codigo_natureza_operacao),
    codigo_cfop: null,
    descricao_cfop: null,
    destinatario_nome: txt(n.destinatario_razao_social ?? n.destinatario_nome_cliente),
    destinatario_doc: txt(n.destinatario_cnpj) ?? txt(n.destinatario_cpf),
    destinatario_uf: txt(n.destinatario_estado_endereco),
    destinatario_ie: null,
    consumidor_final: null,
    valor_produtos: 0,
    valor_servico: num(n.valor_servico),
    valor_desconto: num(n.descontos),
    valor_frete: 0,
    valor_total_nf: num(n.valor_total),
    base_icms: 0,
    valor_icms: 0,
    base_icms_st: 0,
    valor_icms_st: 0,
    valor_fcp: 0,
    valor_fcp_st: 0,
    valor_ipi: 0,
    valor_pis: num(n.valor_pis),
    valor_cofins: num(n.valor_cofins),
    valor_base_calculo: num(n.valor_base_calculo),
    pis_retido: flag(n.pis_retido),
    cofins_retido: flag(n.cofins_retido),
    csll_retido: flag(n.csll_retido),
    ir_retido: flag(n.ir_retido),
    inss_retido: flag(n.inss_retido),
    iss_retido: flag(n.iss_retido),
    valor_iss: num(n.valor_iss),
    valor_ir: num(n.valor_ir),
    valor_csll: num(n.valor_csll),
    valor_inss: num(n.valor_inss),
    gc_payload_raw: registro,
    last_synced_at: new Date().toISOString(),
  };
}

function mapearItens(n: Record<string, unknown>, nfSaidaId: string) {
  const produtos = Array.isArray(n.produtos) ? n.produtos : [];
  return produtos.map((wrap: Record<string, unknown>, idx: number) => {
    const p = (wrap?.produto ?? wrap) as Record<string, unknown>;
    return {
      nf_saida_id: nfSaidaId,
      ordem: idx + 1,
      produto_gc_id: txt(p.produto_id),
      codigo_produto: txt(p.codigo_produto),
      nome_produto: txt(p.nome_produto),
      cfop: txt(p.cfop),
      ncm: txt(p.NCM ?? p.ncm),
      unidade: txt(p.unidade),
      quantidade: num(p.quantidade),
      valor_venda: num(p.valor_venda ?? p.valor_total),
    };
  });
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const inicio = Date.now();

  try {
    const gcAccessToken = Deno.env.get("GC_ACCESS_TOKEN");
    const gcSecretToken = Deno.env.get("GC_SECRET_TOKEN");
    if (!gcAccessToken || !gcSecretToken) {
      return new Response(JSON.stringify({ error: "GC credentials not configured" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );
    const gcHeaders = {
      "access-token": gcAccessToken,
      "secret-access-token": gcSecretToken,
      "Content-Type": "application/json",
    };

    let dataInicio: string | null = null;
    let dataFim: string | null = null;
    let somenteModelo: string | null = null;
    try {
      const body = await req.json();
      dataInicio = body?.data_inicio ?? null;
      dataFim = body?.data_fim ?? null;
      somenteModelo = body?.modelo ?? null;
    } catch { /* sem body */ }

    if (!dataInicio || !dataFim) {
      return new Response(
        JSON.stringify({ error: "Informe data_inicio e data_fim (YYYY-MM-DD)" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resumo: Record<string, { lidas: number; gravadas: number; itens: number; erros: number }> = {};
    const anomalias: Record<string, unknown>[] = [];
    let incompleto = false;

    for (const cfg of ENDPOINTS) {
      if (somenteModelo && cfg.modelo !== somenteModelo) continue;
      resumo[cfg.modelo] = { lidas: 0, gravadas: 0, itens: 0, erros: 0 };

      let pagina = 1;
      let totalPaginas = 1;

      while (pagina <= totalPaginas) {
        if (Date.now() - inicio > TIMEOUT_MS) { incompleto = true; break; }

        const params = new URLSearchParams({
          limite: "100",
          pagina: String(pagina),
          data_inicio: dataInicio,
          data_fim: dataFim,
        });
        const resp = await rateLimitedFetch(`${GC_BASE_URL}${cfg.endpoint}?${params}`, {
          headers: gcHeaders,
        });

        if (resp.status === 429) { await new Promise((r) => setTimeout(r, 2000)); continue; }
        if (!resp.ok) {
          resumo[cfg.modelo].erros++;
          anomalias.push({
            competencia: primeiroDiaDoMes(dataInicio),
            tipo: "GC_API_ERRO",
            severidade: "critico",
            referencia: cfg.endpoint,
            descricao: `GC devolveu ${resp.status} em ${cfg.endpoint} página ${pagina}.`,
          });
          break;
        }

        const json = await resp.json();
        const registros = Array.isArray(json?.data) ? json.data : [];
        totalPaginas = Number(json?.meta?.total_paginas ?? 1) || 1;

        for (const registro of registros) {
          resumo[cfg.modelo].lidas++;
          const n = desembrulhar(registro, cfg.raiz);

          const cabecalho =
            cfg.modelo === "NFSE"
              ? mapearServico(n, registro)
              : mapearProduto(n, cfg.modelo, registro);

          if (!cabecalho || !cabecalho.gc_id) {
            resumo[cfg.modelo].erros++;
            anomalias.push({
              competencia: primeiroDiaDoMes(dataInicio),
              tipo: "NF_SEM_ID_OU_DATA",
              severidade: "critico",
              referencia: String(n.id ?? n.numero ?? "?"),
              descricao: `Nota ${cfg.modelo} sem id ou sem data de emissão legível.`,
            });
            continue;
          }

          const { data: gravada, error: erroCab } = await supabase
            .from("fis_nf_saida")
            .upsert(cabecalho, { onConflict: "modelo,gc_id" })
            .select("id")
            .single();

          if (erroCab || !gravada) {
            resumo[cfg.modelo].erros++;
            anomalias.push({
              competencia: cabecalho.competencia,
              tipo: "ERRO_GRAVACAO",
              severidade: "critico",
              referencia: cabecalho.gc_id,
              descricao: `Falha ao gravar NF ${cfg.modelo} ${cabecalho.numero ?? ""}: ${erroCab?.message}`,
            });
            continue;
          }
          resumo[cfg.modelo].gravadas++;

          if (cfg.modelo !== "NFSE") {
            const itens = mapearItens(n, gravada.id);
            await supabase.from("fis_nf_saida_item").delete().eq("nf_saida_id", gravada.id);
            if (itens.length > 0) {
              const { error: erroItens } = await supabase.from("fis_nf_saida_item").insert(itens);
              if (erroItens) {
                resumo[cfg.modelo].erros++;
              } else {
                resumo[cfg.modelo].itens += itens.length;
              }
            }

            // CFOP no cabeçalho é obrigatório para a Regra 1.3.
            if (!cabecalho.codigo_cfop && cabecalho.autorizada) {
              anomalias.push({
                competencia: cabecalho.competencia,
                tipo: "NF_SEM_CFOP",
                severidade: "critico",
                referencia: cabecalho.gc_id,
                descricao:
                  `NF-e ${cabecalho.numero ?? cabecalho.gc_id} autorizada sem CFOP no cabeçalho — ` +
                  `não classificável pela Regra 1.3.`,
              });
            }
          }
        }

        pagina++;
      }
      if (incompleto) break;
    }

    if (anomalias.length > 0) {
      await supabase.from("fis_anomalia").insert(anomalias);
    }

    return new Response(
      JSON.stringify({
        ok: true,
        periodo: { data_inicio: dataInicio, data_fim: dataFim },
        resumo,
        anomalias: anomalias.length,
        incompleto,
        mensagem: incompleto
          ? "Tempo limite atingido — repita a chamada para continuar."
          : "Sincronização concluída.",
      }),
      {
        status: incompleto ? 202 : 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      },
    );
  } catch (e) {
    return new Response(
      JSON.stringify({ ok: false, error: String((e as Error)?.message ?? e) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
