import { centavos, type calcularVenda } from './calculo';

type LinhaComissao = ReturnType<typeof calcularVenda>;

/**
 * Pedido de compra no Gestão Click para pagar a comissão de um vendedor.
 *
 * A comissão registrada aqui não saía do Argus: alguém tinha de abrir o GC e
 * lançar a despesa na mão, e o histórico de pagamento ficava só nesta tela.
 * O pedido de compra é o documento que o financeiro já usa para pagar
 * terceiros (situação "SERVIÇOS", 619 pedidos), então a comissão passa a
 * entrar por ele: um pedido por vendedor e período, com um item por venda
 * para a rastreabilidade não se perder, e uma parcela com o total, que vira
 * a conta a pagar.
 *
 * Só lógica pura aqui. Quem grava e enfileira é `api.ts`; quem chama o GC é
 * a edge function `process-gc-write-jobs`, com retry e lock.
 */

export interface ConfigPedidoGC {
  /** Situação de compra no GC. Padrão: SERVIÇOS (1739937). */
  situacaoId: string;
  /** Plano de contas da despesa. Padrão: "Comissão de vendedores" (27867702). */
  planoContasId: string;
  /** Centro de custo. Padrão: COMERCIAL (501356). */
  centroCustoId: string;
  /** Forma de pagamento da parcela. Padrão: PIX (4984165). */
  formaPagamentoId: string;
  /** Dias entre a emissão e o vencimento da parcela. */
  diasVencimento: number;
  /**
   * Cadastro de fornecedor de cada vendedor no GC, pela chave usada na tela.
   * Vendedor sem fornecedor não gera pedido — o GC exige `fornecedor_id`.
   */
  fornecedorPorVendedor: Record<string, string>;
  /**
   * Produto genérico "Comissão de vendas" no GC, quando existir. Sem ele o
   * item vai só com nome e valor — o GC aceita, mas não amarra a um cadastro.
   */
  produtoId?: string;
}

export const CONFIG_PEDIDO_GC_PADRAO: ConfigPedidoGC = {
  situacaoId: '1739937',
  planoContasId: '27867702',
  centroCustoId: '501356',
  formaPagamentoId: '4984165',
  diasVencimento: 5,
  fornecedorPorVendedor: {},
};

export interface VendaNoPedido {
  vendaId: string;
  codigo: string;
  cliente: string;
  data: string;
  comissao: number;
}

export interface PedidoCompraComissao {
  vendedorChave: string;
  vendedorNome: string;
  fornecedorId: string;
  periodoInicio: string;
  periodoFim: string;
  valorTotal: number;
  vendas: VendaNoPedido[];
  /** Corpo exato do POST /api/compras. */
  payload: Record<string, unknown>;
}

export interface Impedimento {
  vendaId: string;
  codigo: string;
  motivo: string;
}

const somaDias = (iso: string, dias: number) => {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
};

/**
 * Por que uma venda não pode entrar no pedido. `null` quando pode.
 *
 * Entra o que está fechado: conferida, com comissão, não retirada, e ainda
 * não paga nem já pedida. Pedido é documento contábil; não se emite sobre
 * número que ainda pode mudar.
 */
export function impedimentoDaVenda(linha: LinhaComissao, jaPedidas: Set<string>): string | null {
  if (jaPedidas.has(String(linha.venda.id))) return 'já incluída em outro pedido';
  if (linha.retirada) return 'comissão retirada';
  if (!linha.conferidaAtual) return 'conferência pendente ou desatualizada';
  if (!linha.custosValidos) return 'custos inválidos';
  if (!(linha.comissao > 0)) return 'sem comissão';
  if (linha.saldo <= 0) return 'já paga';
  if (!linha.vendedor || /\bAPI\b/i.test(linha.vendedor)) return 'sem vendedor';
  return null;
}

/**
 * Monta o pedido de um vendedor. Devolve também as vendas que ficaram de fora
 * e por quê — a tela mostra antes de confirmar, para ninguém descobrir depois
 * que metade não entrou.
 */
export function montarPedidoCompra(opts: {
  vendedorChave: string;
  vendedorNome: string;
  linhas: LinhaComissao[];
  config: ConfigPedidoGC;
  periodoInicio: string;
  periodoFim: string;
  hoje: string;
  jaPedidas?: Set<string>;
}): { pedido: PedidoCompraComissao | null; impedimentos: Impedimento[]; erro?: string } {
  const fornecedorId = opts.config.fornecedorPorVendedor[opts.vendedorChave];
  if (!fornecedorId) {
    return {
      pedido: null,
      impedimentos: [],
      erro: `${opts.vendedorNome}: sem fornecedor do GC configurado nos parâmetros`,
    };
  }

  const jaPedidas = opts.jaPedidas ?? new Set<string>();
  const impedimentos: Impedimento[] = [];
  const vendas: VendaNoPedido[] = [];

  for (const linha of opts.linhas) {
    const motivo = impedimentoDaVenda(linha, jaPedidas);
    const codigo = String(linha.venda.codigo ?? linha.venda.id);
    if (motivo) {
      impedimentos.push({ vendaId: String(linha.venda.id), codigo, motivo });
      continue;
    }
    vendas.push({
      vendaId: String(linha.venda.id),
      codigo,
      cliente: String(linha.venda.nome_cliente ?? ''),
      data: String(linha.venda.data ?? '').slice(0, 10),
      // O saldo, não a comissão: pagamento parcial já registrado fica fora.
      comissao: centavos(linha.saldo),
    });
  }

  if (!vendas.length) {
    return { pedido: null, impedimentos, erro: 'Nenhuma venda apta para o pedido.' };
  }

  const valorTotal = centavos(vendas.reduce((s, v) => s + v.comissao, 0));
  const vencimento = somaDias(opts.hoje, opts.config.diasVencimento);
  const periodo = `${opts.periodoInicio.split('-').reverse().join('/')} a ${opts.periodoFim.split('-').reverse().join('/')}`;

  const payload: Record<string, unknown> = {
    fornecedor_id: fornecedorId,
    data: opts.hoje,
    data_emissao: opts.hoje,
    situacao_id: opts.config.situacaoId,
    centro_custo_id: opts.config.centroCustoId,
    plano_contas_id: opts.config.planoContasId,
    observacoes: `Comissão de vendas — ${opts.vendedorNome} — período ${periodo}. ${vendas.length} venda(s). Gerado pelo Argus.`,
    observacoes_interna: vendas.map((v) => `Venda ${v.codigo} (${v.cliente}, ${v.data.split('-').reverse().join('/')}): R$ ${v.comissao.toFixed(2)}`).join(' | '),
    produtos: vendas.map((v) => ({
      produto: {
        ...(opts.config.produtoId ? { produto_id: opts.config.produtoId } : {}),
        nome_produto: `Comissão venda ${v.codigo} — ${v.cliente}`.slice(0, 120),
        detalhes: `Venda ${v.codigo} de ${v.data.split('-').reverse().join('/')}`,
        unidade: 'UN',
        quantidade: '1.00',
        valor_custo: v.comissao.toFixed(2),
      },
    })),
    pagamentos: [
      {
        pagamento: {
          data_vencimento: vencimento,
          valor: valorTotal.toFixed(2),
          forma_pagamento_id: opts.config.formaPagamentoId,
          plano_contas_id: opts.config.planoContasId,
          observacao: `Comissão ${opts.vendedorNome} — ${periodo}`,
        },
      },
    ],
  };

  return {
    pedido: {
      vendedorChave: opts.vendedorChave,
      vendedorNome: opts.vendedorNome,
      fornecedorId,
      periodoInicio: opts.periodoInicio,
      periodoFim: opts.periodoFim,
      valorTotal,
      vendas,
      payload,
    },
    impedimentos,
  };
}

/** Valida a configuração vinda dos parâmetros; devolve a padrão se inválida. */
export function configPedidoValida(entrada: unknown): ConfigPedidoGC {
  const e = (entrada ?? {}) as Partial<ConfigPedidoGC>;
  const id = (v: unknown, padrao: string) => (typeof v === 'string' && /^\d+$/.test(v.trim()) ? v.trim() : padrao);
  const dias = Number(e.diasVencimento);
  const mapa: Record<string, string> = {};
  if (e.fornecedorPorVendedor && typeof e.fornecedorPorVendedor === 'object') {
    for (const [k, v] of Object.entries(e.fornecedorPorVendedor)) {
      if (typeof v === 'string' && /^\d+$/.test(v.trim())) mapa[k] = v.trim();
    }
  }
  return {
    situacaoId: id(e.situacaoId, CONFIG_PEDIDO_GC_PADRAO.situacaoId),
    planoContasId: id(e.planoContasId, CONFIG_PEDIDO_GC_PADRAO.planoContasId),
    centroCustoId: id(e.centroCustoId, CONFIG_PEDIDO_GC_PADRAO.centroCustoId),
    formaPagamentoId: id(e.formaPagamentoId, CONFIG_PEDIDO_GC_PADRAO.formaPagamentoId),
    diasVencimento: Number.isInteger(dias) && dias >= 0 && dias <= 90 ? dias : CONFIG_PEDIDO_GC_PADRAO.diasVencimento,
    fornecedorPorVendedor: mapa,
    ...(typeof e.produtoId === 'string' && /^\d+$/.test(e.produtoId.trim()) ? { produtoId: e.produtoId.trim() } : {}),
  };
}
