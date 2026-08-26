/**
 * Importação fiscal direta de XML.
 *
 * Sobe um .zip (ou vários, ou .xml solto) e o sistema descobre sozinho o que
 * é cada documento — sem consultar o GestãoClick. O que separa entrada de
 * saída é o CNPJ do emitente comparado ao da empresa: se fomos nós que
 * emitimos, é saída; se foi terceiro, é entrada.
 *
 * O XML é o documento fiscal. O ERP é conveniência: ele ajuda a provar uso
 * operacional (pedido de compra), mas a apuração não depende dele para existir.
 */
import { supabase } from "@/integrations/supabase/client";
import { coletarXmls, dividirNfeEmLotes, type XmlExtraido } from "@/lib/nfeUpload";
import {
  parseXmlItems,
  getXmlMeta,
  getXmlIde,
  getXmlEmitente,
  getXmlTotais,
  parseNfse,
  ehNfse,
  temCsosn,
} from "../../supabase/functions/_shared/nfeXmlParser";

const BUCKET = "nf-xmls";

/**
 * As tabelas fis_* ainda não constam nos tipos gerados do Supabase. Este
 * builder mínimo descreve só o que usamos aqui — encadeamento e a forma da
 * resposta. Depois de regenerar os tipos, trocar por eles.
 */
interface RespostaUnica {
  data: { id: string } | null;
  error: { message: string } | null;
}
interface RespostaValor {
  data: { valor: string | null } | null;
  error: { message: string } | null;
}

interface Consulta extends PromiseLike<{ data: unknown; error: { message: string } | null }> {
  select(colunas: string): Consulta;
  eq(coluna: string, valor: unknown): Consulta;
  upsert(linhas: unknown, opcoes?: { onConflict?: string }): Consulta;
  update(valores: unknown): Consulta;
  insert(linhas: unknown): Consulta;
  delete(): Consulta;
  single(): Promise<RespostaUnica>;
  maybeSingle(): Promise<RespostaUnica & RespostaValor>;
}

const db = supabase as unknown as { from(tabela: string): Consulta };

export type TipoDocumento = "nfe_entrada" | "nfe_saida" | "nfse_saida" | "nfse_entrada" | "ignorado";

export interface ResultadoImportacao {
  arquivosLidos: number;
  zipsAninhados: number;
  xmlsEncontrados: number;
  nfeEntrada: number;
  nfeSaida: number;
  nfseSaida: number;
  nfseEntrada: number;
  ignorados: number;
  jaExistiam: number;
  itensGravados: number;
  erros: { arquivo: string; motivo: string }[];
  competencias: string[];
}

function soDigitos(v: string | null | undefined): string {
  return String(v ?? "").replace(/\D/g, "");
}

function primeiroDiaDoMes(iso: string): string {
  return `${iso.slice(0, 7)}-01`;
}

async function lerCnpjEmpresa(): Promise<string> {
  const { data } = await db
    .from("fin_configuracoes")
    .select("valor")
    .eq("chave", "CNPJ_EMPRESA")
    .maybeSingle();
  const cnpj = soDigitos(data?.valor);
  if (!cnpj) {
    throw new Error(
      "CNPJ_EMPRESA não está configurado em fin_configuracoes. Sem ele não dá para " +
      "distinguir nota emitida por nós de nota recebida de terceiro.",
    );
  }
  return cnpj;
}

/** Decide o que o documento é, sem depender de nome de arquivo nem do ERP. */
export function classificarDocumento(xml: string, cnpjEmpresa: string): TipoDocumento {
  if (ehNfse(xml)) {
    const nfse = parseNfse(xml);
    if (!nfse) return "ignorado";
    return soDigitos(nfse.prestadorCnpj) === cnpjEmpresa ? "nfse_saida" : "nfse_entrada";
  }
  const emit = getXmlEmitente(xml);
  if (!emit.cnpj) return "ignorado";
  return soDigitos(emit.cnpj) === cnpjEmpresa ? "nfe_saida" : "nfe_entrada";
}

async function gravarNfeEntrada(xml: string, storagePath: string) {
  const itens = parseXmlItems(xml);
  const meta = getXmlMeta(xml);
  const ide = getXmlIde(xml);
  const emit = getXmlEmitente(xml);
  const totais = getXmlTotais(xml);

  const dataEmissao = ide.dataEmissao || meta.data_emissao;
  if (!meta.chave || !dataEmissao) throw new Error("XML sem chave ou sem data de emissão");

  // CRT ausente: o CSOSN corrobora Simples sem precisar chutar.
  let crt = emit.crt;
  if (crt === null && temCsosn(itens)) crt = 1;

  const competencia = primeiroDiaDoMes(dataEmissao);

  const { data: cab, error } = await db
    .from("fis_nf_entrada")
    .upsert(
      {
        chave: meta.chave,
        modelo: ide.modelo,
        numero: ide.numero || null,
        serie: ide.serie || null,
        cnpj_emitente: emit.cnpj || null,
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
        storage_path: storagePath,
        parsed_at: new Date().toISOString(),
      },
      { onConflict: "chave" },
    )
    .select("id")
    .single();

  if (error || !cab) throw new Error(error?.message ?? "falha ao gravar cabeçalho");

  await db.from("fis_nf_entrada_item").delete().eq("nf_entrada_id", cab.id);
  const linhas = itens.map((i) => ({
    nf_entrada_id: cab.id,
    ordem: i.nItem,
    codigo_produto: i.cProd || null,
    nome_produto: i.xProd || null,
    ncm: i.NCM || null,
    cfop: i.CFOP || null,
    unidade: i.uCom || null,
    quantidade: i.qCom,
    valor_produto: i.vProd,
    valor_frete: 0,
    valor_desconto: i.vDesc,
    valor_ipi: i.ipi_vIPI,
    cst_pis: i.pis_cst || null,
    cst_cofins: i.cofins_cst || null,
    cst_icms: i.icms_cst || null,
    origem_mercadoria: i.icms_orig || null,
    base_pis: i.pis_vBC,
    aliq_pis: i.pis_pPIS,
    valor_pis: i.pis_vPIS,
    base_cofins: i.cofins_vBC,
    aliq_cofins: i.cofins_pCOFINS,
    valor_cofins: i.cofins_vCOFINS,
    base_icms: i.icms_vBC,
    aliq_icms: i.icms_pICMS,
    valor_icms: i.icms_vICMS,
    perc_reducao_bc: i.icms_pRedBC,
    valor_icms_st: i.icms_vICMSST,
    valor_fcp_st: i.icms_vFCPST,
    valor_difal_dest: i.icms_vICMSUFDest,
    valor_difal_remet: i.icms_vICMSUFRemet,
  }));
  if (linhas.length) {
    const { error: erroItens } = await db.from("fis_nf_entrada_item").insert(linhas);
    if (erroItens) throw new Error(erroItens.message);
  }
  return { competencia, itens: linhas.length };
}

/**
 * Grava NF-e de saída vinda de XML.
 *
 * Cuidado central: a mesma nota pode já ter entrado pelo sync do GestãoClick.
 * Duplicar aqui dobraria a receita e o débito. Por isso procuramos pela CHAVE
 * antes de inserir — se já existe, atualizamos aquela linha em vez de criar
 * outra com gc_id diferente.
 */
async function gravarNfeSaida(xml: string) {
  const itens = parseXmlItems(xml);
  const meta = getXmlMeta(xml);
  const ide = getXmlIde(xml);
  const totais = getXmlTotais(xml);
  const dest = xml.match(/<dest>([\s\S]*?)<\/dest>/i)?.[1] ?? "";
  const tag = (b: string, t: string) =>
    b.match(new RegExp(`<${t}[^>]*>([^<]*)</${t}>`, "i"))?.[1]?.trim() ?? "";

  const dataEmissao = ide.dataEmissao || meta.data_emissao;
  if (!meta.chave || !dataEmissao) throw new Error("XML sem chave ou sem data de emissão");

  const cancelada = /<(?:[a-zA-Z0-9]+:)?(procEventoNFe|cancNFe)\b/i.test(xml);
  const cfopCabecalho = itens[0]?.CFOP ?? null;

  const registro = {
    modelo: ide.modelo === "65" ? "65" : "55",
    numero: ide.numero || null,
    serie: ide.serie || null,
    chave: meta.chave,
    data_emissao: dataEmissao,
    competencia: primeiroDiaDoMes(dataEmissao),
    situacao_nf: cancelada ? "Cancelada" : "Aprovada",
    autorizada: !cancelada,
    cancelada,
    denegada: false,
    natureza_operacao: meta.nat_op || null,
    codigo_cfop: cfopCabecalho,
    destinatario_nome: tag(dest, "xNome") || null,
    destinatario_doc: tag(dest, "CNPJ") || tag(dest, "CPF") || null,
    destinatario_uf: tag(dest.match(/<enderDest>([\s\S]*?)<\/enderDest>/i)?.[1] ?? "", "UF") || null,
    valor_produtos: totais.vProd,
    valor_servico: 0,
    valor_desconto: totais.vDesc,
    valor_frete: totais.vFrete,
    valor_total_nf: totais.vNF,
    valor_ipi: totais.vIPI,
    valor_icms: totais.vICMS,
    valor_icms_st: totais.vST,
    last_synced_at: new Date().toISOString(),
  };

  const { data: existente } = await db
    .from("fis_nf_saida").select("id").eq("chave", meta.chave).maybeSingle();

  let id: string;
  if (existente?.id) {
    const { error } = await db.from("fis_nf_saida").update(registro).eq("id", existente.id);
    if (error) throw new Error(error.message);
    id = existente.id;
  } else {
    const { data, error } = await db
      .from("fis_nf_saida")
      .insert({ ...registro, gc_id: meta.chave })
      .select("id").single();
    if (error || !data) throw new Error(error?.message ?? "falha ao inserir");
    id = data.id;
  }

  await db.from("fis_nf_saida_item").delete().eq("nf_saida_id", id);
  const linhas = itens.map((i) => ({
    nf_saida_id: id,
    ordem: i.nItem,
    codigo_produto: i.cProd || null,
    nome_produto: i.xProd || null,
    cfop: i.CFOP || null,
    ncm: i.NCM || null,
    unidade: i.uCom || null,
    quantidade: i.qCom,
    valor_venda: i.vProd,
  }));
  if (linhas.length) await db.from("fis_nf_saida_item").insert(linhas);

  return { competencia: registro.competencia, itens: linhas.length, jaExistia: !!existente?.id };
}

/** NFS-e emitida por nós: receita de serviço, com as retenções declaradas. */
async function gravarNfseSaida(xml: string) {
  const n = parseNfse(xml);
  if (!n || !n.dataEmissao) throw new Error("NFS-e sem data de emissão");

  const chave = n.codigoVerificacao || `NFSE-${n.numero}`;
  const registro = {
    modelo: "NFSE",
    numero: n.numero || null,
    chave,
    data_emissao: n.dataEmissao,
    competencia: primeiroDiaDoMes(n.dataEmissao),
    situacao_nf: n.cancelada ? "Cancelada" : "Aprovada",
    autorizada: !n.cancelada,
    cancelada: n.cancelada,
    denegada: false,
    natureza_operacao: n.discriminacao || null,
    destinatario_nome: n.tomadorNome || null,
    destinatario_doc: n.tomadorCnpj || null,
    destinatario_uf: n.tomadorUf || null,
    valor_produtos: 0,
    valor_servico: n.valorServicos,
    valor_desconto: n.valorDeducoes,
    valor_total_nf: n.valorLiquido || n.valorServicos,
    valor_base_calculo: n.baseCalculo,
    // Retenção só vale com valor atrás: a flag sozinha vem ligada por padrão
    // de cadastro em praticamente toda NFS-e.
    pis_retido: n.valorPis > 0,
    cofins_retido: n.valorCofins > 0,
    iss_retido: n.issRetido === 1,
    valor_pis: n.valorPis,
    valor_cofins: n.valorCofins,
    valor_iss: n.valorIss,
    valor_ir: n.valorIr,
    valor_csll: n.valorCsll,
    valor_inss: n.valorInss,
    last_synced_at: new Date().toISOString(),
  };

  const { data: existente } = await db
    .from("fis_nf_saida").select("id").eq("chave", chave).maybeSingle();

  if (existente?.id) {
    const { error } = await db.from("fis_nf_saida").update(registro).eq("id", existente.id);
    if (error) throw new Error(error.message);
    return { competencia: registro.competencia, itens: 0, jaExistia: true };
  }
  const { error } = await db.from("fis_nf_saida").insert({ ...registro, gc_id: chave });
  if (error) throw new Error(error.message);
  return { competencia: registro.competencia, itens: 0, jaExistia: false };
}

export interface OpcoesImportacao {
  onProgresso?: (mensagem: string) => void;
}

export async function importarXmlFiscal(
  arquivos: File[],
  opcoes: OpcoesImportacao = {},
): Promise<ResultadoImportacao> {
  const progresso = opcoes.onProgresso ?? (() => {});
  const cnpjEmpresa = await lerCnpjEmpresa();

  progresso("Abrindo arquivos...");
  const { xmls, zipsAninhados } = await coletarXmls(arquivos);

  const r: ResultadoImportacao = {
    arquivosLidos: arquivos.length,
    zipsAninhados,
    xmlsEncontrados: xmls.length,
    nfeEntrada: 0, nfeSaida: 0, nfseSaida: 0, nfseEntrada: 0,
    ignorados: 0, jaExistiam: 0, itensGravados: 0,
    erros: [], competencias: [],
  };
  const competencias = new Set<string>();

  let processados = 0;
  for (const lote of dividirNfeEmLotes(xmls, 50)) {
    for (const item of lote as XmlExtraido[]) {
      processados++;
      if (processados % 10 === 0 || processados === xmls.length) {
        progresso(`Processando ${processados} de ${xmls.length} XMLs...`);
      }
      try {
        const xml = await item.blob.text();
        const tipo = classificarDocumento(xml, cnpjEmpresa);

        if (tipo === "ignorado") { r.ignorados++; continue; }

        // Entrada de NF-e vai para o Storage: o documento precisa ficar
        // arquivado, é ele que sustenta o crédito numa fiscalização.
        let storagePath = "";
        if (tipo === "nfe_entrada") {
          const meta = getXmlMeta(xml);
          storagePath = `importacao/${meta.chave || item.nome}.xml`;
          await supabase.storage.from(BUCKET).upload(storagePath, item.blob, {
            upsert: true, contentType: "application/xml",
          });
          const totais = getXmlTotais(xml);
          const emit = getXmlEmitente(xml);
          const ide = getXmlIde(xml);
          if (meta.chave) {
            await db.from("fin_nfe_xml_index").upsert(
              {
                chave: meta.chave,
                cnpj_emitente: emit.cnpj || null,
                nome_emitente: emit.nome || null,
                numero_nf: ide.numero || null,
                data_emissao: ide.dataEmissao || meta.data_emissao || null,
                valor_total: totais.vNF,
                valor_produtos: totais.vProd,
                qtd_itens: parseXmlItems(xml).length,
                storage_path: storagePath,
              },
              { onConflict: "chave" },
            );
          }
        }

        let saida: { competencia: string; itens: number; jaExistia?: boolean };
        if (tipo === "nfe_entrada") {
          saida = await gravarNfeEntrada(xml, storagePath);
          r.nfeEntrada++;
        } else if (tipo === "nfe_saida") {
          saida = await gravarNfeSaida(xml);
          r.nfeSaida++;
          if (saida.jaExistia) r.jaExistiam++;
        } else if (tipo === "nfse_saida") {
          saida = await gravarNfseSaida(xml);
          r.nfseSaida++;
          if (saida.jaExistia) r.jaExistiam++;
        } else {
          // NFS-e recebida de terceiro: o crédito dela vem pela NF-e de
          // serviço (CFOP x933) quando o prestador emite modelo 55.
          r.nfseEntrada++;
          continue;
        }

        competencias.add(saida.competencia);
        r.itensGravados += saida.itens;
      } catch (e) {
        r.erros.push({ arquivo: item.nome, motivo: String((e as Error)?.message ?? e) });
      }
    }
  }

  r.competencias = [...competencias].sort();
  progresso("Concluído.");
  return r;
}
