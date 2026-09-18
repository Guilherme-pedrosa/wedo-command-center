import { describe, expect, it } from 'vitest';
import {
  TABELA_TAXAS_PADRAO,
  regraDaForma,
  resumirTaxas,
  tabelaValida,
  taxaDoTitulo,
} from './taxasRecebimento';

/** Título real: venda 42386, cartão parcelado, taxa lançada como desconto. */
const comDescontoLancado = {
  gc_payload_raw: {
    valor: '5599.00', desconto: '462.58', taxa_banco: '0.00', taxa_operadora: '0.00',
    valor_total: '5136.42', nome_forma_pagamento: 'Cartão de Crédito',
  },
};

/** Mesmo perfil, mas ninguém lançou a taxa — metade dos títulos de cartão. */
const semNadaLancado = {
  gc_payload_raw: {
    valor: '3207.58', desconto: '0.00', taxa_banco: '0.00', taxa_operadora: '0.00',
    valor_total: '3207.58', nome_forma_pagamento: 'Cartão de Crédito',
  },
};

describe('taxaDoTitulo', () => {
  it('o que está lançado no GC manda, e vale como real', () => {
    const t = taxaDoTitulo(comDescontoLancado);
    expect(t).toMatchObject({ valor: 462.58, origem: 'gc' });
  });

  it('cartão sem nada lançado recebe taxa estimada pela tabela', () => {
    const t = taxaDoTitulo(semNadaLancado);
    expect(t.origem).toBe('estimada');
    expect(t.percentual).toBe(5.81);
    expect(t.valor).toBeCloseTo(186.36, 2); // 3207.58 × 5,81 %
  });

  it('PIX e boleto sem regra na tabela não recebem estimativa', () => {
    const pix = taxaDoTitulo({ gc_payload_raw: { valor: '1000.00', desconto: '0.00', nome_forma_pagamento: 'PIX' } });
    expect(pix).toMatchObject({ valor: 0, origem: 'nenhuma' });
  });

  it('casa a forma sem acento e sem diferenciar maiúsculas', () => {
    expect(regraDaForma('cartão de crédito', TABELA_TAXAS_PADRAO)?.percentual).toBe(5.81);
    expect(regraDaForma('LINK DE CARTÃO', TABELA_TAXAS_PADRAO)?.percentual).toBe(5.81);
    expect(regraDaForma('Cartão de Débito', TABELA_TAXAS_PADRAO)?.percentual).toBe(1.37);
    expect(regraDaForma('Boleto Bancário', TABELA_TAXAS_PADRAO)).toBeNull();
  });

  it('soma taxa_banco e taxa_operadora quando o GC as traz', () => {
    const t = taxaDoTitulo({ gc_payload_raw: { valor: '100.00', desconto: '0', taxa_banco: '1.50', taxa_operadora: '2.25', nome_forma_pagamento: 'Cartão de Crédito' } });
    expect(t).toMatchObject({ valor: 3.75, origem: 'gc' });
  });

  it('aplica valor fixo quando a tabela tiver', () => {
    const t = taxaDoTitulo(
      { gc_payload_raw: { valor: '200.00', desconto: '0', nome_forma_pagamento: 'Boleto Bancário' } },
      [{ forma: 'BOLETO', percentual: 0, fixo: 2.5 }],
    );
    expect(t).toMatchObject({ valor: 2.5, origem: 'estimada' });
  });
});

describe('resumirTaxas', () => {
  it('separa o lançado do estimado e aponta quais títulos', () => {
    const r = resumirTaxas([comDescontoLancado, semNadaLancado]);
    expect(r.lancadas).toBe(462.58);
    expect(r.estimadas).toBeCloseTo(186.36, 2);
    expect(r.total).toBeCloseTo(648.94, 2);
    expect(r.titulosEstimados).toHaveLength(1);
    expect(r.titulosEstimados[0].forma).toBe('Cartão de Crédito');
  });
});

describe('tabelaValida', () => {
  it('cai na padrão quando os parâmetros vierem sem tabela ou inválidos', () => {
    expect(tabelaValida(undefined)).toBe(TABELA_TAXAS_PADRAO);
    expect(tabelaValida([])).toBe(TABELA_TAXAS_PADRAO);
    expect(tabelaValida([{ forma: 'X', percentual: 150, fixo: 0 }])).toBe(TABELA_TAXAS_PADRAO);
    expect(tabelaValida([{ forma: '', percentual: 1, fixo: 0 }])).toBe(TABELA_TAXAS_PADRAO);
  });

  it('aceita tabela bem formada', () => {
    const t = [{ forma: 'CARTAO', percentual: 4.2, fixo: 0 }];
    expect(tabelaValida(t)).toBe(t);
  });
});
