import { describe, expect, it } from 'vitest';
import { computeAjustesMeta, computeAliquotaEfetiva, computeOutrosCustos, computeRateioFator, isLancamentoFolhaComercial, PLANOS_IMPOSTO_IDS, PLANOS_POR_COMPETENCIA_IDS } from '@/hooks/useMetasResultados';

describe('resultados operação — rateio e pró-rata', () => {
  it('não rateia nada no modo Comercial + Serviços', () => {
    expect(computeRateioFator(240_000, 372_000, true)).toBe(1);
  });

  it('no modo Apenas Serviços o fator é a participação dos serviços na receita total', () => {
    expect(computeRateioFator(240_000, 372_000, false)).toBeCloseTo(240_000 / 372_000, 10);
    expect(computeRateioFator(0, 0, false)).toBe(1);
  });

  it('fixos NÃO rateiam no modo Apenas Serviços (existiriam com ou sem o comercial); só pró-rata', () => {
    const { fatorRealizado, fatorMetaAbsoluta } = computeAjustesMeta('custo_fixo', 'Aluguel / Galpão', 0.65, 0.1, false);
    expect(fatorRealizado).toBeCloseTo(0.1, 10);
    expect(fatorMetaAbsoluta).toBeCloseTo(0.1, 10);
  });

  it('pró-labore fica 80% nos serviços no modo Apenas Serviços (20% é do comercial)', () => {
    expect(computeAjustesMeta('custo_fixo', 'Pró-Labore', 1, 1, false).fatorRealizado).toBeCloseTo(0.8, 10);
    expect(computeAjustesMeta('custo_fixo', 'Pró-Labore', 1, 1, true).fatorRealizado).toBe(1);
  });

  it('impostos são proporcionais à receita no modo Apenas Serviços, e a meta percentual fica intacta', () => {
    const { fatorRealizado, fatorMetaAbsoluta } = computeAjustesMeta('custo_variavel', 'Impostos (DAS/ISS/IRPJ/CSLL)', 0.65, 0.1, false);
    expect(fatorRealizado).toBeCloseTo(0.65, 10);
    expect(fatorMetaAbsoluta).toBe(1);
  });

  it('custos diretos da operação e receitas não recebem ajuste', () => {
    expect(computeAjustesMeta('custo_variavel', 'Comissões e Premiações (Técnicos)', 0.65, 0.1, false).fatorRealizado).toBe(1);
    expect(computeAjustesMeta('custo_variavel', 'Custo com Peças para Operações', 0.65, 0.1, false).fatorRealizado).toBe(1);
    expect(computeAjustesMeta('receita', 'EXECUÇÃO DE SERVIÇOS + COIFAS', 0.65, 0.1, false).fatorRealizado).toBe(1);
  });

  it('identifica remuneração do comercial (Filipe/Pedro) sem capturar fretes ou outros planos', () => {
    const planoSalarioAdm = 'bbce323d-c7ee-4795-97d6-f924d373c371';
    expect(isLancamentoFolhaComercial(planoSalarioAdm, {
      descricao: 'PAGAMENTO DE SERVIÇOS PRESTADOS COLABORADOR - FILIPE CARVALHO',
      nome_fornecedor: '60.104.608 FILIPE FARIAS DE CARVALHO',
    })).toBe(true);
    expect(isLancamentoFolhaComercial(planoSalarioAdm, {
      descricao: 'Compra de nº 4592',
      nome_fornecedor: '64.307.233 PEDRO HENRIQUE PEREIRA RODRIGUES',
    })).toBe(true);
    expect(isLancamentoFolhaComercial(planoSalarioAdm, {
      descricao: 'Compra de nº 4425 - FRETE EQUIPAMENTOS MINERVA 16/07',
      nome_fornecedor: '64.307.233 PEDRO HENRIQUE PEREIRA RODRIGUES',
    })).toBe(false);
    expect(isLancamentoFolhaComercial('outro-plano-qualquer', {
      descricao: 'ADIANTAMENTO DE SERVIÇOS PRESTADOS - FILIPE FARIAS',
      nome_fornecedor: '60.104.608 FILIPE FARIAS DE CARVALHO',
    })).toBe(false);
  });

  it('planos de imposto usam a guia do mês seguinte (referência), comissões seguem por competência', () => {
    const impostos = [
      '367198e3-1eee-46b5-8d4a-af208852198e',
      '1726df3a-f803-4f28-b7ee-1930f94b569f',
      'e37b446f-e96f-4fe0-ab52-cfbaeb2e7c7c',
      '3692812b-86d8-4ec7-be51-542af1424d2d',
      '8f50518c-131e-4b4c-a8ca-a9fd3f5bea88',
      'df1e63ee-92db-4046-887a-9f4cbd5d4115',
      '2e311d38-f51c-40d9-baa8-ecdf3080c99d',
    ];
    for (const plano of impostos) {
      expect(PLANOS_IMPOSTO_IDS.has(plano)).toBe(true);
      expect(PLANOS_POR_COMPETENCIA_IDS.has(plano)).toBe(false);
    }
    expect(PLANOS_POR_COMPETENCIA_IDS.has('e7299b90-98d2-4d7a-a04c-78ba40cc847a')).toBe(true);
  });
});

describe('resultados operação — mesma régua do Raio-X', () => {
  it('alíquota efetiva = guias (venc. M+1) ÷ receita, só nos meses elegíveis com guia e receita', () => {
    const r = computeAliquotaEfetiva(
      { '2026-05': 10000, '2026-06': 0, '2026-07': 12000, '2026-08': 3000 },
      { '2026-05': 100000, '2026-06': 90000, '2026-07': 100000, '2026-08': 110000 },
      ['2026-05', '2026-06', '2026-07'], // agosto não é elegível: a guia vence em setembro, mês ainda aberto
    );
    expect(r.meses).toEqual(['2026-05', '2026-07']);
    expect(r.aliquota).toBeCloseTo(22000 / 200000, 6);
  });

  it('sem histórico a alíquota é nula e a provisão cai na meta %', () => {
    expect(computeAliquotaEfetiva({}, {}, ['2026-01']).aliquota).toBeNull();
  });

  it('outros custos: planos sem meta entram; estoque/capex e societário ficam fora; vendedor é do comercial', () => {
    const nomes = { p1: 'Transportadora', p2: 'Comissão de vendedores', p3: 'Aquisição de máquinas para revenda', p4: 'Transferências de  Sócios', p5: 'Combustivel' };
    const pag = [
      { plano_contas_id: 'p1', valor: -800 }, { plano_contas_id: 'p2', valor: 300 },
      { plano_contas_id: 'p3', valor: 5000 }, { plano_contas_id: 'p4', valor: 1000 }, { plano_contas_id: 'p5', valor: 900 },
    ];
    const comMeta = new Set(['p5']);
    const tudo = computeOutrosCustos(pag, comMeta, nomes, true);
    expect(tudo.total).toBe(1100);
    expect(tudo.itens.map(i => i.nome)).toEqual(['Transportadora', 'Comissão de vendedores']);
    expect(computeOutrosCustos(pag, comMeta, nomes, false).total).toBe(800);
  });
});
