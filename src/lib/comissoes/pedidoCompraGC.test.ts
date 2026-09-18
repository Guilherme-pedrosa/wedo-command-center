import { describe, expect, it } from 'vitest';
import {
  CONFIG_PEDIDO_GC_PADRAO,
  configPedidoValida,
  impedimentoDaVenda,
  montarPedidoCompra,
} from './pedidoCompraGC';
import type { calcularVenda } from './calculo';

type Linha = ReturnType<typeof calcularVenda>;

/** Só o que o pedido lê; o resto da linha não importa aqui. */
const linha = (o: Partial<Linha> & { id: string; codigo?: string }): Linha =>
  ({
    venda: { id: o.id, codigo: o.codigo ?? `V${o.id}`, nome_cliente: 'CLIENTE X', data: '2026-08-10' },
    vendedor: 'Filipe Carvalho',
    vendedorChave: 'filipe carvalho',
    conferidaAtual: true,
    custosValidos: true,
    comissao: 150,
    pago: 0,
    saldo: 150,
    retirada: false,
    ...o,
  }) as unknown as Linha;

const config = {
  ...CONFIG_PEDIDO_GC_PADRAO,
  fornecedorPorVendedor: { 'filipe carvalho': '3705402' },
};

const base = {
  vendedorChave: 'filipe carvalho',
  vendedorNome: 'Filipe Carvalho',
  config,
  periodoInicio: '2026-08-01',
  periodoFim: '2026-08-31',
  hoje: '2026-09-18',
};

describe('impedimentoDaVenda', () => {
  it('venda fechada entra', () => {
    expect(impedimentoDaVenda(linha({ id: '1' }), new Set())).toBeNull();
  });

  it.each([
    [{ retirada: true }, 'comissão retirada'],
    [{ conferidaAtual: false }, 'conferência pendente ou desatualizada'],
    [{ custosValidos: false }, 'custos inválidos'],
    [{ comissao: 0, saldo: 0 }, 'sem comissão'],
    [{ pago: 150, saldo: 0 }, 'já paga'],
    [{ vendedor: 'API GC WEDO' }, 'sem vendedor'],
  ])('bloqueia %o com "%s"', (parcial, motivo) => {
    expect(impedimentoDaVenda(linha({ id: '1', ...(parcial as Partial<Linha>) }), new Set())).toBe(motivo);
  });

  it('venda já incluída noutro pedido não entra duas vezes', () => {
    expect(impedimentoDaVenda(linha({ id: '1' }), new Set(['1']))).toBe('já incluída em outro pedido');
  });
});

describe('montarPedidoCompra', () => {
  it('sem fornecedor configurado, não monta e explica', () => {
    const r = montarPedidoCompra({ ...base, config: CONFIG_PEDIDO_GC_PADRAO, linhas: [linha({ id: '1' })] });
    expect(r.pedido).toBeNull();
    expect(r.erro).toContain('sem fornecedor');
  });

  it('um item por venda, uma parcela com o total, no formato do POST /api/compras', () => {
    const r = montarPedidoCompra({
      ...base,
      linhas: [linha({ id: '1', codigo: '1001', comissao: 150, saldo: 150 }), linha({ id: '2', codigo: '1002', comissao: 80.5, saldo: 80.5 })],
    });
    expect(r.impedimentos).toEqual([]);
    const p = r.pedido!;
    expect(p.valorTotal).toBe(230.5);
    expect(p.fornecedorId).toBe('3705402');

    const payload = p.payload as { produtos: unknown[]; pagamentos: { pagamento: Record<string, string> }[]; situacao_id: string; fornecedor_id: string };
    expect(payload.fornecedor_id).toBe('3705402');
    expect(payload.situacao_id).toBe('1739937');
    expect(payload.produtos).toHaveLength(2);
    expect(payload.pagamentos).toHaveLength(1);
    expect(payload.pagamentos[0].pagamento.valor).toBe('230.50');
    expect(payload.pagamentos[0].pagamento.data_vencimento).toBe('2026-09-23'); // hoje + 5
    expect(payload.pagamentos[0].pagamento.forma_pagamento_id).toBe('4984165');
  });

  it('usa o saldo, não a comissão cheia: pagamento parcial já registrado fica fora', () => {
    const r = montarPedidoCompra({ ...base, linhas: [linha({ id: '1', comissao: 200, pago: 50, saldo: 150 })] });
    expect(r.pedido!.valorTotal).toBe(150);
  });

  it('separa o que entrou do que ficou de fora, com motivo', () => {
    const r = montarPedidoCompra({
      ...base,
      linhas: [linha({ id: '1' }), linha({ id: '2', retirada: true }), linha({ id: '3', conferidaAtual: false })],
    });
    expect(r.pedido!.vendas.map((v) => v.vendaId)).toEqual(['1']);
    expect(r.impedimentos.map((i) => [i.vendaId, i.motivo])).toEqual([
      ['2', 'comissão retirada'],
      ['3', 'conferência pendente ou desatualizada'],
    ]);
  });

  it('nenhuma venda apta: não monta', () => {
    const r = montarPedidoCompra({ ...base, linhas: [linha({ id: '1', retirada: true })] });
    expect(r.pedido).toBeNull();
    expect(r.erro).toBe('Nenhuma venda apta para o pedido.');
  });

  it('inclui produto_id só quando configurado', () => {
    const sem = montarPedidoCompra({ ...base, linhas: [linha({ id: '1' })] }).pedido!.payload as { produtos: { produto: Record<string, unknown> }[] };
    expect(sem.produtos[0].produto.produto_id).toBeUndefined();
    const com = montarPedidoCompra({ ...base, config: { ...config, produtoId: '999' }, linhas: [linha({ id: '1' })] }).pedido!.payload as { produtos: { produto: Record<string, unknown> }[] };
    expect(com.produtos[0].produto.produto_id).toBe('999');
  });
});

describe('configPedidoValida', () => {
  it('parâmetros vazios caem no padrão', () => {
    expect(configPedidoValida(undefined)).toEqual(CONFIG_PEDIDO_GC_PADRAO);
  });

  it('descarta id que não é numérico e vencimento fora da faixa, mantendo o resto', () => {
    const c = configPedidoValida({
      situacaoId: 'abc', planoContasId: '123', diasVencimento: 400,
      fornecedorPorVendedor: { a: '1', b: 'x', c: 7 },
    });
    expect(c.situacaoId).toBe(CONFIG_PEDIDO_GC_PADRAO.situacaoId);
    expect(c.planoContasId).toBe('123');
    expect(c.diasVencimento).toBe(CONFIG_PEDIDO_GC_PADRAO.diasVencimento);
    expect(c.fornecedorPorVendedor).toEqual({ a: '1' });
  });
});
