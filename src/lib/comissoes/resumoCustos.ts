import { centavos, type calcularVenda } from './calculo';

type LinhaComissao = ReturnType<typeof calcularVenda>;

/** Breakdown of the existing calculation, without attributing candidate freight. */
export function resumirCustosComissao(linha: LinhaComissao) {
  const { a } = linha;
  const custoProdutos = centavos(a.custoProdutos);
  const custoServicos = centavos(a.custoServicos);
  const impostos = centavos(a.imposto);
  const taxasRecebimento = centavos(linha.taxasRecebimento);
  const demaisDespesas = centavos(a.deslocamento.custoAdicional + a.extras.total + a.custoFixo + a.garantia + linha.custoAdicional);
  const custoFrete = centavos(linha.custoFrete);
  // The displayed total must reconcile with the profit used for the commission,
  // even when GC stores unit costs with four decimal places.
  const totalCustosAntesComissao = centavos(a.receitaLiquida - linha.lucroAntes);
  const ajusteArredondamento = centavos(totalCustosAntesComissao - custoProdutos - custoServicos - impostos - taxasRecebimento - demaisDespesas - custoFrete);
  const rateios = linha.conferencia?.ajustes.fretes ?? [];
  const freteIncluidoNoCusto = centavos(rateios.filter(rateio => rateio.incluidoNoCusto).reduce((soma, rateio) => soma + rateio.valor, 0));
  const fontesAtribuidas = rateios.map(rateio => {
    const fonte = linha.fretes?.find(item => item.id === rateio.fonteId);
    const fonteAlterada = !fonte || Math.abs(fonte.valor - rateio.limite) > 0.02;
    const situacaoPagamento = !fonte ? 'Fonte não localizada na última consulta'
      : !fonte.pagamentos.length ? 'Baixa não localizada'
      : fonte.pago >= fonte.valor - 0.02 ? 'Baixa integral no GC'
      : fonte.pago > 0 ? 'Baixa parcial no GC'
      : 'Sem baixa no GC';
    return {
      fonteId: rateio.fonteId,
      rotulo: fonte?.compraCodigo ? `Pedido ${fonte.compraCodigo}` : fonte?.fornecedor || rateio.fonteId,
      valor: centavos(rateio.valor),
      incluidoNoCusto: rateio.incluidoNoCusto,
      fonte,
      fonteAlterada,
      situacaoPagamento,
      pagoNaFonte: fonte ? centavos(fonte.pago) : null,
      valorTotalFonte: fonte ? centavos(fonte.valor) : null,
    };
  });
  const fontesCandidatas = linha.fretesPendentes;
  const avisosFrete = [...new Set([
    ...(linha.consultaFretes === 'pendente' ? ['Atualização dos pagamentos de frete pendente no GC'] : []),
    ...(fontesAtribuidas.some(item => item.fonteAlterada) ? ['Fonte ou valor do frete mudou: conferir novamente'] : []),
    ...fontesAtribuidas.flatMap(item => item.fonte?.avisos ?? []),
    ...(fontesCandidatas.length ? [`${fontesCandidatas.length} fonte(s) com indício de vínculo; valores ainda não atribuídos à venda`] : []),
  ])];
  const fretePendente = !rateios.length || avisosFrete.length > 0;
  const situacaoFrete = !rateios.length
    ? 'Frete a conferir — nenhum custo vinculado'
    : fretePendente ? 'Frete atribuído com pendência de conferência' : 'Frete atribuído à venda';
  return {
    custoProdutos, custoServicos, impostos, taxasRecebimento, demaisDespesas,
    custoFrete, freteIncluidoNoCusto, receitaFrete: centavos(a.receitaFrete),
    totalCustosAntesComissao, ajusteArredondamento,
    lucroAntes: linha.lucroAntes, lucroFinal: centavos(linha.lucroAntes - linha.comissao),
    margemAntes: linha.margemAntes, margemFinal: linha.margemFinal,
    fretePendente, situacaoFrete, avisosFrete, fontesAtribuidas, fontesCandidatas,
  };
}

export type ResumoCustos = ReturnType<typeof resumirCustosComissao>;
