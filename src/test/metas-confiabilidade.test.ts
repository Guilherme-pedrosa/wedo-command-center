import { describe, it, expect } from 'vitest';
import { fetchAllRows, dedupeBy } from '@/lib/supabasePaginate';
import { classificarMeta, computeAjustesMeta, isParcelamentoImposto, escolherComissoes } from '@/hooks/useMetasResultados';

describe('paginação', () => {
  it('lê todas as páginas e não para no limite de 1000', async () => {
    const total = 2350;
    const rows = Array.from({ length: total }, (_, i) => ({ id: String(i) }));
    const out = await fetchAllRows<{ id: string }>((from, to) =>
      Promise.resolve({ data: rows.slice(from, to + 1), error: null }));
    expect(out).toHaveLength(total);
    expect(out[total - 1].id).toBe(String(total - 1));
  });

  it('propaga erro em vez de devolver total parcial', async () => {
    await expect(fetchAllRows<{ id: string }>(() =>
      Promise.resolve({ data: null, error: { message: 'statement timeout' } })))
      .rejects.toThrow('statement timeout');
  });

  it('erro na segunda página não vira soma menor', async () => {
    const rows = Array.from({ length: 1500 }, (_, i) => ({ id: String(i) }));
    await expect(fetchAllRows<{ id: string }>((from, to) =>
      from === 0
        ? Promise.resolve({ data: rows.slice(from, to + 1), error: null })
        : Promise.resolve({ data: null, error: { message: 'falhou' } })))
      .rejects.toThrow('falhou');
  });

  it('deduplica pela chave canônica', () => {
    const out = dedupeBy([{ id: 'a' }, { id: 'a' }, { id: 'b' }], r => r.id);
    expect(out.map(r => r.id)).toEqual(['a', 'b']);
  });
});

describe('classificação de metas', () => {
  it('usa a coluna fonte e ignora o nome', () => {
    expect(classificarMeta({ nome: 'Qualquer nome novo', categoria: 'receita', fonte: 'receita_locacao' })).toBe('receita_locacao');
    expect(classificarMeta({ nome: 'Contratos PCM', categoria: 'receita', fonte: 'receita_pcm' })).toBe('receita_pcm');
  });

  it('não confunde "Contratos" com serviços (bug do substring "at")', () => {
    expect(classificarMeta({ nome: 'Contratos PCM', categoria: 'receita', fonte: null })).toBe('receita_pcm');
  });

  it('renomear a meta não muda a fórmula quando há fonte', () => {
    const antes = classificarMeta({ nome: 'EXECUÇÃO DE SERVIÇOS + COIFAS', categoria: 'receita', fonte: 'receita_servicos' });
    const depois = classificarMeta({ nome: 'Serviços Técnicos 2027', categoria: 'receita', fonte: 'receita_servicos' });
    expect(depois).toBe(antes);
  });

  it('cai no fallback por nome só sem fonte', () => {
    expect(classificarMeta({ nome: 'Comissões e Premiações (Técnicos)', categoria: 'custo_variavel', fonte: null })).toBe('comissoes');
    expect(classificarMeta({ nome: 'Energia + Água', categoria: 'custo_fixo', fonte: null })).toBe('generico');
  });

  it('ajustes de rateio seguem a fonte, não o nome', () => {
    const imposto = computeAjustesMeta('custo_variavel', 'Tributos 2027', 0.5, 1, false, 'impostos');
    expect(imposto.fatorRealizado).toBeCloseTo(0.5);
    const prolabore = computeAjustesMeta('custo_fixo', 'Retirada dos sócios', 1, 1, false, 'prolabore');
    expect(prolabore.fatorRealizado).toBeLessThan(1);
  });
});

describe('parcelamento de imposto', () => {
  it('identifica parcelamento / dívida ativa', () => {
    expect(isParcelamentoImposto({ descricao: 'PARCELAMENTO PGFN 2024' })).toBe(true);
    expect(isParcelamentoImposto({ descricao: 'DÍVIDA ATIVA UNIÃO' })).toBe(true);
    expect(isParcelamentoImposto({ descricao: 'DARF IRPJ 08/2026' })).toBe(false);
  });
});

describe('comissões', () => {
  it('origem indisponível não vira zero silencioso', () => {
    const r = escolherComissoes(null, { valor: 12715.94, em: '2026-09-01T10:00:00Z' }, 0);
    expect(r.valor).toBeCloseTo(12715.94);
    expect(r.fonte).toBe('cache');
  });
});
