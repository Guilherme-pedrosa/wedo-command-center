/**
 * Custo de compra com o desconto da nota aplicado.
 *
 * A precificação usa como custo o valor do item no pedido de compra do Gestão
 * Click, e só cai para o valor da NF quando não há pedido. O problema é que o
 * pedido guarda o preço de tabela: dos 1.137 pedidos de 2026, **nenhum** tem o
 * campo de desconto preenchido. O desconto é concedido na nota (vDesc do XML)
 * e nunca volta para o pedido.
 *
 * Resultado: 99 dos 124 itens com desconto tinham o custo do pedido idêntico
 * ao bruto da nota. Nos equipamentos da Globalvac isso dá 63,9% acima do custo
 * real — uma máquina de embalar a vácuo entrava na precificação por R$ 27.000
 * quando a nota cobrou R$ 16.470. Precificando sobre um custo inflado, o preço
 * de venda sai fora de mercado.
 */

export interface NotaComDesconto {
  /** Pedido a que a nota se refere. Só interessa desconto da MESMA compra. */
  compra_gc_id?: string | null;
  /** vDesc do item, valor absoluto para a quantidade toda. */
  v_desc?: number | null;
  /** vUnCom — unitário bruto, antes do desconto. */
  v_un_com?: number | null;
  /** qCom — quantidade comercial. */
  q_com?: number | null;
  /** Unitário já líquido, gravado pelo parser do XML. */
  valor_unitario_nf?: number | null;
}

export interface CompraDeReferencia {
  compra_gc_id: string;
}

/**
 * Fração do custo que sobra depois do desconto da nota, em (0, 1].
 *
 * É razão e não subtração de propósito: pedido e nota nem sempre estão na
 * mesma unidade — é para isso que existe o `detectKitRatio` na página — e uma
 * razão atravessa a conversão de unidade sem precisar conhecê-la.
 */
export function fatorDescontoNf(
  tributo: NotaComDesconto | null | undefined,
  compra: CompraDeReferencia | null | undefined,
): number {
  if (!tributo || !compra) return 1;

  // Desconto de uma nota antiga não diz nada sobre o custo do pedido atual.
  if (String(tributo.compra_gc_id ?? "") !== String(compra.compra_gc_id ?? "")) return 1;

  const desconto = Number(tributo.v_desc) || 0;
  if (desconto <= 0) return 1;

  const bruto = (Number(tributo.v_un_com) || 0) * (Number(tributo.q_com) || 0);
  if (bruto <= 0) return 1;

  const fator = (bruto - desconto) / bruto;
  // Desconto maior que o próprio item é dado inconsistente. Zerar ou inverter
  // o custo seria pior que ignorar: preço de venda iria a zero.
  return fator > 0 && fator <= 1 ? fator : 1;
}

/**
 * Aplica o desconto da nota sobre o custo vindo do pedido de compra.
 *
 * Devolve o custo inalterado quando não há desconto, quando a nota é de outra
 * compra, ou quando o pedido **já** veio com o preço líquido — 3 dos 124 itens
 * chegam assim, e descontar de novo cobraria o desconto duas vezes.
 */
export function custoComDescontoDaNf(
  custoDoPedido: number,
  tributo: NotaComDesconto | null | undefined,
  compra: CompraDeReferencia | null | undefined,
): number {
  if (!(custoDoPedido > 0)) return custoDoPedido;

  const fator = fatorDescontoNf(tributo, compra);
  if (fator === 1) return custoDoPedido;

  const liquido = Number(tributo?.valor_unitario_nf) || 0;
  if (liquido > 0 && Math.abs(custoDoPedido - liquido) < 0.01) return custoDoPedido;

  return custoDoPedido * fator;
}
