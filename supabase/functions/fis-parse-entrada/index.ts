/**
 * fis-parse-entrada — projeta os XMLs de NF-e de entrada nas tabelas fiscais,
 * em nível de ITEM e por competência.
 *
 * Usa o MESMO parser da precificação (_shared/nfeXmlParser.ts). A diferença
 * está no destino: precificação guarda o estado atual de cada produto
 * (fin_produto_tributos, UNIQUE por produto); apuração precisa do razão da
 * competência, congelado como estava na nota.
 *
 * Esta função NÃO decide crédito — só registra o que o XML diz. A decisão
 * fiscal mora em src/lib/apuracaoFiscal.ts, coberta por testes.
 */
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  parseXmlItems,
  getXmlMeta,
  getXmlIde,
  getXmlEmitente,
  getXmlTotais,
  temCsosn,
  type XmlItemTax,
} from "../_shared/nfeXmlParser.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

const BUCKET = "nf-xmls";
/** Margem para devolver 202 e retomar noutra chamada, como sync-compras. */
const TIMEOUT_MS = 25_000;

interface Anomalia {
  tipo: string;
  severidade: "info" | "aviso" | "critico";
  referencia: string;
  descricao: string;
  competencia?: string;
}

function primeiroDiaDoMes(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

function mapearItem(item: XmlItemTax, nfEntradaId: string) {
  return {
    nf_entrada_id: nfEntradaId,
    ordem: item.nItem,
    codigo_produto: item.cProd || null,
    nome_produto: item.xProd || null,
    ncm: item.NCM || null,
    cfop: item.CFOP || null,
    unidade: item.uCom || null,
    quantidade: item.qCom,
    valor_produto: item.vProd,
    valor_frete: 0, // frete da NF-e é rateado à parte por ratear-frete-compras
    valor_desconto: item.vDesc,
    valor_ipi: item.ipi_vIPI,

    cst_pis: item.pis_cst || null,
    cst_cofins: item.cofins_cst || null,
    cst_icms: item.icms_cst || null,
    origem_mercadoria: item.icms_orig || null,

    base_pis: item.pis_vBC,
    aliq_pis: item.pis_pPIS,
    valor_pis: item.pis_vPIS,
    base_cofins: item.cofins_vBC,
    aliq_cofins: item.cofins_pCOFINS,
    valor_cofins: item.cofins_vCOFINS,

    base_icms: item.icms_vBC,
    aliq_icms: item.icms_pICMS,
    valor_icms: item.icms_vICMS,
    perc_reducao_bc: item.icms_pRedBC,
    valor_icms_st: item.icms_vICMSST,
    valor_fcp_st: item.icms_vFCPST,
    valor_difal_dest: item.icms_vICMSUFDest,
    valor_difal_remet: item.icms_vICMSUFRemet,
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const inicio = Date.now();
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  try {
    let dataInicio: string | null = null;
    let dataFim: string | null = null;
    let reprocessar = false;
    try {
      const body = await req.json();
      dataInicio = body?.data_inicio ?? null;
      dataFim = body?.data_fim ?? null;
      reprocessar = body?.reprocessar === true;
    } catch { /* sem body */ }

    // Notas emitidas por nós não são entrada.
    const { data: cfg } = await supabase
      .from("fin_configuracoes")
      .select("valor")
      .eq("chave", "CNPJ_EMPRESA")
      .maybeSingle();
    const cnpjEmpresa = String(cfg?.valor ?? "").replace(/\D/g, "");

    let q = supabase
      .from("fin_nfe_xml_index")
      .select("chave, storage_path, data_emissao, cnpj_emitente")
      .order("data_emissao", { ascending: true });
    if (dataInicio) q = q.gte("data_emissao", dataInicio);
    if (dataFim) q = q.lte("data_emissao", dataFim);

    const { data: indice, error: erroIndice } = await q;
    if (erroIndice) throw erroIndice;

    let jaProcessadas = new Set<string>();
    if (!reprocessar) {
      const { data: existentes } = await supabase.from("fis_nf_entrada").select("chave");
      jaProcessadas = new Set((existentes ?? []).map((r: { chave: string }) => r.chave));
    }

    let processadas = 0;
    let puladas = 0;
    let falhas = 0;
    let itensGravados = 0;
    const anomalias: Anomalia[] = [];
    let incompleto = false;

    for (const linha of indice ?? []) {
      if (Date.now() - inicio > TIMEOUT_MS) { incompleto = true; break; }
      if (!reprocessar && jaProcessadas.has(linha.chave)) { puladas++; continue; }

      const emitenteCnpj = String(linha.cnpj_emitente ?? "").replace(/\D/g, "");
      if (cnpjEmpresa && emitenteCnpj === cnpjEmpresa) { puladas++; continue; }

      const { data: arquivo, error: erroDownload } = await supabase.storage
        .from(BUCKET)
        .download(linha.storage_path);

      if (erroDownload || !arquivo) {
        falhas++;
        anomalias.push({
          tipo: "XML_ILEGIVEL",
          severidade: "critico",
          referencia: linha.chave,
          descricao: `Falha ao baixar ${linha.storage_path}: ${erroDownload?.message ?? "arquivo vazio"}`,
        });
        continue;
      }

      const xml = await arquivo.text();
      const itens = parseXmlItems(xml);
      const meta = getXmlMeta(xml);
      const ide = getXmlIde(xml);
      const emit = getXmlEmitente(xml);
      const totais = getXmlTotais(xml);

      const chave = meta.chave || linha.chave;
      const dataEmissao = ide.dataEmissao || meta.data_emissao || linha.data_emissao;

      if (!dataEmissao) {
        falhas++;
        anomalias.push({
          tipo: "DATA_EMISSAO_AUSENTE",
          severidade: "critico",
          referencia: chave,
          descricao: "Sem data de emissão legível — impossível alocar competência.",
        });
        continue;
      }
      const competencia = primeiroDiaDoMes(dataEmissao);

      if (itens.length === 0) {
        falhas++;
        anomalias.push({
          tipo: "NF_SEM_ITENS",
          severidade: "critico",
          referencia: chave,
          competencia,
          descricao: `Nenhum item <det> encontrado em ${linha.storage_path}.`,
        });
        continue;
      }

      // CRT ausente: tenta corroborar pelo CSOSN antes de desistir. Não
      // "chuta" regime — apenas registra o que dá para afirmar.
      let crt = emit.crt;
      if (crt === null && temCsosn(itens)) {
        crt = 1;
        anomalias.push({
          tipo: "CRT_INFERIDO_POR_CSOSN",
          severidade: "aviso",
          referencia: chave,
          competencia,
          descricao:
            "Emitente sem tag CRT; regime Simples Nacional inferido pela presença de CSOSN. " +
            "Confirmar antes de fechar a competência — impacta a Regra 2.4.",
        });
      } else if (crt === null) {
        anomalias.push({
          tipo: "CRT_AUSENTE",
          severidade: "critico",
          referencia: chave,
          competencia,
          descricao:
            "Emitente sem CRT e sem CSOSN. O crédito destes itens fica bloqueado até " +
            "classificação manual do regime do fornecedor.",
        });
      }

      const semCfop = itens.filter((i) => !i.CFOP).length;
      if (semCfop > 0) {
        anomalias.push({
          tipo: "ITEM_SEM_CFOP",
          severidade: "critico",
          referencia: chave,
          competencia,
          descricao: `${semCfop} item(ns) sem CFOP no XML — não classificáveis.`,
        });
      }

      const { data: cab, error: erroCab } = await supabase
        .from("fis_nf_entrada")
        .upsert(
          {
            chave,
            modelo: ide.modelo,
            numero: ide.numero || null,
            serie: ide.serie || null,
            cnpj_emitente: emit.cnpj || linha.cnpj_emitente || null,
            nome_emitente: emit.nome || meta.nome_emitente || null,
            uf_emitente: emit.uf || null,
            crt_emitente: crt,
            natureza_operacao: meta.nat_op || null,
            data_emissao: dataEmissao,
            competencia,
            valor_produtos: totais.vProd,
            valor_frete: totais.vFrete,
            valor_desconto: totais.vDesc,
            valor_ipi: totais.vIPI,
            valor_icms: totais.vICMS,
            valor_icms_st: totais.vST,
            valor_total: totais.vNF,
            storage_path: linha.storage_path,
            parsed_at: new Date().toISOString(),
          },
          { onConflict: "chave" },
        )
        .select("id")
        .single();

      if (erroCab || !cab) {
        falhas++;
        anomalias.push({
          tipo: "ERRO_GRAVACAO",
          severidade: "critico",
          referencia: chave,
          competencia,
          descricao: `Falha ao gravar cabeçalho: ${erroCab?.message}`,
        });
        continue;
      }

      // Reparse é idempotente: troca o conjunto de itens da nota inteira.
      await supabase.from("fis_nf_entrada_item").delete().eq("nf_entrada_id", cab.id);
      const { error: erroItens } = await supabase
        .from("fis_nf_entrada_item")
        .insert(itens.map((i) => mapearItem(i, cab.id)));

      if (erroItens) {
        falhas++;
        anomalias.push({
          tipo: "ERRO_GRAVACAO_ITENS",
          severidade: "critico",
          referencia: chave,
          competencia,
          descricao: `Falha ao gravar itens: ${erroItens.message}`,
        });
        continue;
      }

      itensGravados += itens.length;
      processadas++;
    }

    if (anomalias.length > 0) {
      await supabase.from("fis_anomalia").insert(
        anomalias.map((a) => ({
          competencia: a.competencia ?? dataInicio ?? new Date().toISOString().slice(0, 8) + "01",
          tipo: a.tipo,
          severidade: a.severidade,
          referencia: a.referencia,
          descricao: a.descricao,
        })),
      );
    }

    return new Response(
      JSON.stringify({
        ok: true,
        processadas,
        puladas,
        falhas,
        itens: itensGravados,
        anomalias: anomalias.length,
        incompleto,
        mensagem: incompleto
          ? "Tempo limite atingido — chame novamente para continuar de onde parou."
          : "Parse concluído.",
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
