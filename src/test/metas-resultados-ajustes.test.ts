import { describe, expect, it } from 'vitest';
import { computeAjustesMeta, computeRateioFator, PLANOS_IMPOSTO_IDS, PLANOS_POR_COMPETENCIA_IDS } from '@/hooks/useMetasResultados';

describe('resultados operação — rateio e pró-rata', () => {
  it('não rateia nada no modo Comercial + Serviços', () => {
    expect(computeRateioFator(240_000, 372_000, true)).toBe(1);
  });

  it('no modo Apenas Serviços o fator é a participação dos serviços na receita total', () => {
    expect(computeRateioFator(240_000, 372_000, false)).toBeCloseTo(240_000 / 372_000, 10);
    expect(computeRateioFator(0, 0, false)).toBe(1);
  });

  it('fixos recebem rateio e pró-rata no realizado e na meta absoluta', () => {
    const { fatorRealizado, fatorMetaAbsoluta } = computeAjustesMeta('custo_fixo', 'Aluguel / Galpão', 0.65, 0.1);
    expect(fatorRealizado).toBeCloseTo(0.065, 10);
    expect(fatorMetaAbsoluta).toBeCloseTo(0.065, 10);
  });

  it('impostos recebem rateio mas não pró-rata, e a meta percentual fica intacta', () => {
    const { fatorRealizado, fatorMetaAbsoluta } = computeAjustesMeta('custo_variavel', 'Impostos (DAS/ISS/IRPJ/CSLL)', 0.65, 0.1);
    expect(fatorRealizado).toBeCloseTo(0.65, 10);
    expect(fatorMetaAbsoluta).toBe(1);
  });

  it('custos diretos da operação e receitas não recebem ajuste', () => {
    expect(computeAjustesMeta('custo_variavel', 'Comissões e Premiações (Técnicos)', 0.65, 0.1).fatorRealizado).toBe(1);
    expect(computeAjustesMeta('custo_variavel', 'Custo com Peças para Operações', 0.65, 0.1).fatorRealizado).toBe(1);
    expect(computeAjustesMeta('receita', 'EXECUÇÃO DE SERVIÇOS + COIFAS', 0.65, 0.1).fatorRealizado).toBe(1);
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
