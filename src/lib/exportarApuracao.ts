/**
 * Exportação da apuração em XLSX, no formato de livro fiscal.
 *
 * O export anterior eram dezesseis linhas de totais — não dá para conferir
 * nada com isso, nem para a contabilidade cruzar com o que ela tem. Aqui sai
 * uma aba por livro, uma linha por item, com as colunas que um registro de
 * entradas/saídas tem: emitente, CFOP, base, imposto destacado, chave.
 *
 * Acrescentamos as colunas que são a razão deste sistema existir: se o item
 * entrou na base de crédito, quanto entrou, por que, e se a decisão foi da
 * regra ou de uma pessoa.
 */
import type { ResultadoApuracao, LinhaCredito, LinhaReceita } from "@/lib/apuracaoService";

/** Data ISO para o formato que o Excel brasileiro entende. */
function dataBr(iso: string | null | undefined): string {
  if (!iso) return "";
  const [a, m, d] = iso.slice(0, 10).split("-");
  return d && m && a ? `${d}/${m}/${a}` : "";
}

function linhaEntrada(l: LinhaCredito) {
  return {
    "Inscrição": l.cnpjEmitente ?? "",
    "Emitente": l.fornecedor,
    "Regime do Emitente": l.regime,
    "Data Emissão": dataBr(l.dataEmissao),
    "Modelo": l.modelo ?? "",
    "Série": l.serie ?? "",
    "Número": l.numero ?? "",
    "Item": l.item,
    "Descrição": l.produto ?? "",
    "NCM": l.ncm ?? "",
    "CFOP": l.cfop ?? "",
    "Unidade": l.unidade ?? "",
    "Quantidade": l.quantidade,
    "Valor do Item": l.valorProduto,
    "Desconto": l.valorDesconto,
    "Valor Líquido": +(l.valorProduto - l.valorDesconto).toFixed(2),
    "CST PIS/COFINS": l.cstPisCofins ?? "",
    "Base PIS": l.basePis,
    "Valor PIS Destacado": l.valorPisDestacado,
    "Base COFINS": l.baseCofins,
    "Valor COFINS Destacado": l.valorCofinsDestacado,
    "CST/CSOSN ICMS": l.cstIcms ?? "",
    "Base ICMS": l.baseIcms,
    "Base Reduzida %": l.percReducaoBc,
    "Valor ICMS Destacado": l.valorIcmsDestacado,
    "ICMS ST": l.valorIcmsSt,
    "Valor IPI": l.valorIpi,
    // A partir daqui é o que a apuração decidiu, não o que a nota diz.
    "Pedido de Compra": l.temPedidoCompra ? "SIM" : "NÃO",
    "Na Base PIS/COFINS": l.decisao.permitido ? "SIM" : "NÃO",
    "Base Creditada": l.decisao.permitido ? l.decisao.base : 0,
    "Crédito PIS (1,65%)": l.decisao.permitido ? +(l.decisao.base * 0.0165).toFixed(2) : 0,
    "Crédito COFINS (7,6%)": l.decisao.permitido ? +(l.decisao.base * 0.076).toFixed(2) : 0,
    "Crédito ICMS": l.decisaoIcms.permitido ? l.decisaoIcms.base : 0,
    "Regra Aplicada": l.decisao.regra,
    "Motivo PIS/COFINS": l.decisao.motivo,
    "Motivo ICMS": l.decisaoIcms.motivo,
    "Decisão Manual": l.decidoManualmente ? "SIM" : "",
    "Conferir": l.decisao.requerRevisao ? "SIM" : "",
    "Chave de Acesso": l.chave,
  };
}

/** Registro de saidas de mercadoria: NF-e e NFC-e, com CFOP e ICMS. */
function linhaSaidaProduto(l: LinhaReceita) {
  return {
    "Modelo": l.modelo,
    "Número": l.numero ?? "",
    "Destinatário": l.cliente ?? "",
    "CFOP": l.cfop ?? "",
    "Natureza da Operação": l.natureza ?? "",
    "Valor": l.valor,
    "Na Base de Débito": l.compoe ? "SIM" : "NÃO",
    "Motivo": l.motivo,
    "Documento GC": l.gcId,
  };
}

/**
 * Servicos prestados: NFS-e nao tem CFOP nem ICMS, tem ISS municipal.
 * Misturar com mercadoria numa lista so confunde a conferencia -- sao livros
 * fiscais diferentes.
 */
function linhaSaidaServico(l: LinhaReceita) {
  return {
    "NFS-e": l.numero ?? "",
    "Tomador": l.cliente ?? "",
    "Discriminação": l.natureza ?? "",
    "Valor do Serviço": l.valor,
    "Na Base de Débito": l.compoe ? "SIM" : "NÃO",
    "Motivo": l.motivo,
    "Documento GC": l.gcId,
  };
}

function abaResumo(r: ResultadoApuracao) {
  const linha = (rotulo: string, pis: number, cofins: number, icms: number | "" = "") => ({
    "Apuração": rotulo,
    "PIS": pis,
    "COFINS": cofins,
    "PIS + COFINS": +(pis + cofins).toFixed(2),
    "ICMS": icms,
  });

  return [
    linha("Receita bruta tributável", r.receitaBruta, r.receitaBruta, ""),
    linha(
      "(-) ICMS excluído da base (RE 574.706)",
      r.icmsExcluidoBaseDebito, r.icmsExcluidoBaseDebito, "",
    ),
    linha("Base de cálculo do débito", r.baseDebito, r.baseDebito, ""),

    linha("Alíquota %", r.pis.aliquota, r.cofins.aliquota, ""),
    linha("(=) Débito apurado", r.pis.valorDebito, r.cofins.valorDebito, r.icms.valorDebito),
    linha("Base de crédito", r.baseCredito, r.baseCredito, ""),
    linha("   da qual, Simples Nacional", r.baseCreditoSimples, r.baseCreditoSimples, ""),
    linha("(-) Crédito apurado", r.pis.valorCredito, r.cofins.valorCredito, r.icms.valorCredito),
    linha("(-) Retenções na fonte", r.totalRetencaoPis, r.totalRetencaoCofins, ""),
    linha("(-) Saldo credor anterior",
      r.pis.saldoCredorAnterior, r.cofins.saldoCredorAnterior, r.icms.saldoCredorAnterior),
    linha("(=) SALDO A RECOLHER",
      r.pis.saldoARecolher, r.cofins.saldoARecolher, r.icms.saldoARecolher),
    linha("Saldo credor a transportar",
      r.pis.saldoCredorProximo, r.cofins.saldoCredorProximo, r.icms.saldoCredorProximo),
  ];
}

export async function exportarApuracaoXlsx(r: ResultadoApuracao): Promise<void> {
  const XLSX = await import("xlsx");
  const wb = XLSX.utils.book_new();
  const competencia = r.competencia.slice(0, 7);

  const resumo = XLSX.utils.json_to_sheet(abaResumo(r));
  XLSX.utils.sheet_add_aoa(resumo, [
    [`Apuração fiscal — competência ${competencia}`],
    [
      `Notas de saída: ${r.contadores.notasSaidaNaBase} na base de ${r.contadores.notasSaida}`,
      `Itens de entrada: ${r.contadores.itensComCredito} com crédito de ${r.contadores.itensEntrada}`,
      `Itens a conferir: ${r.contadores.itensParaRevisao}`,
      `Anomalias: ${r.anomalias.length}`,
    ],
    [],
  ], { origin: "A1" });
  XLSX.utils.book_append_sheet(wb, resumo, "Resumo");

  // Fora da base primeiro: é o que a contabilidade precisa olhar.
  const entradas = [...r.linhasCredito]
    .sort((a, b) =>
      a.decisao.permitido !== b.decisao.permitido
        ? (a.decisao.permitido ? 1 : -1)
        : b.valorProduto - a.valorProduto)
    .map(linhaEntrada);
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(entradas), "Entradas");

  const ordenar = (xs: LinhaReceita[]) =>
    [...xs].sort((a, b) => (a.compoe !== b.compoe ? (a.compoe ? 1 : -1) : b.valor - a.valor));

  const produtos = ordenar(r.linhasReceita.filter((l) => l.modelo !== "NFSE"));
  if (produtos.length) {
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.json_to_sheet(produtos.map(linhaSaidaProduto)), "Saidas Produto",
    );
  }

  const servicos = ordenar(r.linhasReceita.filter((l) => l.modelo === "NFSE"));
  if (servicos.length) {
    XLSX.utils.book_append_sheet(
      wb, XLSX.utils.json_to_sheet(servicos.map(linhaSaidaServico)), "Servicos Prestados",
    );
  }

  if (r.retencoes.length) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        r.retencoes.map((x) => ({
          "NFS-e": x.nfNumero,
          "Cliente": x.nomeCliente ?? "",
          "Data Liquidação": dataBr(x.dataLiquidacao),
          "Valor Recebido": x.valorBase,
          "% da Nota": +(x.proporcao * 100).toFixed(2),
          "PIS Retido": x.valorPisRetido,
          "COFINS Retido": x.valorCofinsRetido,
        })),
      ),
      "Retencoes",
    );
  }

  if (r.anomalias.length) {
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(
        r.anomalias.map((a) => ({
          "Severidade": a.severidade,
          "Tipo": a.tipo,
          "Referência": a.referencia,
          "Descrição": a.descricao,
        })),
      ),
      "Anomalias",
    );
  }

  XLSX.writeFile(wb, `apuracao-${competencia}.xlsx`);
}
