import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_CONFIG, defaultExtras } from './analisePickPack';
import { calcularVenda, centavos, type DadosVenda, type Parametros } from './calculo';
import type { FonteFrete } from './fretes';
import { resumirCustosComissao } from './resumoCustos';

const parametros: Parametros = {
  config: { ...DEFAULT_ANALYSIS_CONFIG, impostoPct: 10, custoFixoPct: 1, garantiaPct: 1 },
  margemAposComissao: false, origem: 'teste',
};
const fonte = (overrides: Partial<FonteFrete> = {}): FonteFrete => ({
  id: 'compra:100', compraId: '100', compraCodigo: '123', descricao: 'Entrega', fornecedor: 'Transportadora',
  valor: 60, pago: 60, pagamentos: [{ liquidado: true }], avisos: [], referenciasVendas: [], pedidosRelacionados: [], produtoIds: [],
  ...overrides,
});
function dados(): DadosVenda {
  return {
    venda: { id: 'venda', codigo: '12345', nome_cliente: 'Cliente', nome_situacao: 'Concretizada', valor_total: 1000,
      gc_payload_raw: { nome_vendedor: 'Ana', valor_frete: '20.00', produtos: [{ produto: { produto_id: 'produto', nome_produto: 'Máquina', quantidade: 1, valor_total: 900, valor_custo: 400 } }], servicos: [{ servico: { nome_servico: 'Instalação', quantidade: 1, valor_total: 80, valor_custo: 20 } }] } },
    consultaFinanceira: 'gc', consultaFretes: 'gc',
    recebimentos: [{ valor: 990, liquidado: true, gc_payload_raw: { valor: '1000', desconto: '5.00', taxa_banco: '2.00', taxa_operadora: '3.00' } }], pagamentos: [],
    conferencia: { venda_id: 'venda', conferido: false, ajustes: { custoAdicional: 7, deslocamento: { modo: 'manual', km: 10, custoPorKm: 1 }, extras: { ...defaultExtras(parametros.config), pedagio: 3 } } },
  };
}

describe('resumo visível dos custos e fretes de comissões', () => {
  it('reconcilia todos os custos com o lucro e distingue receita de frete do custo', () => {
    const d = dados();
    d.fretes = [fonte()];
    d.conferencia!.ajustes.fretes = [{ fonteId: 'compra:100', valor: 30, limite: 60, incluidoNoCusto: false, justificativa: 'Metade desta entrega' }];
    const linha = calcularVenda(d, parametros);
    const r = resumirCustosComissao(linha);
    expect(r).toMatchObject({ custoProdutos: 400, custoServicos: 20, impostos: 100, taxasRecebimento: 10, demaisDespesas: 40, custoFrete: 30, receitaFrete: 20, freteIncluidoNoCusto: 0, totalCustosAntesComissao: 600, lucroAntes: 400, lucroFinal: 355, margemAntes: 40, margemFinal: 35.5, ajusteArredondamento: 0, fretePendente: false });
    expect(r.fontesAtribuidas[0]).toMatchObject({ valor: 30, pagoNaFonte: 60, valorTotalFonte: 60, situacaoPagamento: 'Baixa integral no GC' });
    expect(r.totalCustosAntesComissao + r.lucroAntes).toBe(linha.a.receitaLiquida);
  });

  it('frete já incluído é informação e não duplica o custo dos itens', () => {
    const d = dados();
    d.fretes = [fonte()];
    d.conferencia!.ajustes.fretes = [{ fonteId: 'compra:100', valor: 30, limite: 60, incluidoNoCusto: true, justificativa: 'Custo da máquina já contém entrega' }];
    const r = resumirCustosComissao(calcularVenda(d, parametros));
    expect(r.custoFrete).toBe(0);
    expect(r.freteIncluidoNoCusto).toBe(30);
    expect(r.totalCustosAntesComissao).toBe(570);
    expect(r.lucroAntes).toBe(430);
    expect(r.fretePendente).toBe(false);
  });

  it('sem vínculo mantém frete a conferir, mesmo após consulta GC concluída', () => {
    const r = resumirCustosComissao(calcularVenda(dados(), parametros));
    expect(r.custoFrete).toBe(0);
    expect(r.fretePendente).toBe(true);
    expect(r.situacaoFrete).toBe('Frete a conferir — nenhum custo vinculado');
  });

  it('candidato pago não vira automaticamente custo nem prova de vínculo à venda', () => {
    const d = dados();
    d.fretes = [fonte({ produtoIds: ['produto'] })];
    const r = resumirCustosComissao(calcularVenda(d, parametros));
    expect(r.fontesCandidatas).toHaveLength(1);
    expect(r.fontesAtribuidas).toHaveLength(0);
    expect(r.custoFrete).toBe(0);
    expect(r.totalCustosAntesComissao).toBe(570);
    expect(r.avisosFrete).toContain('1 fonte(s) com indício de vínculo; valores ainda não atribuídos à venda');
  });

  it('exibe leitura pendente e fonte alterada mantendo o rateio salvo', () => {
    const d = dados();
    d.consultaFretes = 'pendente';
    d.fretes = [fonte({ valor: 90 })];
    d.conferencia!.ajustes.fretes = [{ fonteId: 'compra:100', valor: 30, limite: 60, incluidoNoCusto: false, justificativa: 'Metade anterior' }];
    const r = resumirCustosComissao(calcularVenda(d, parametros));
    expect(r.custoFrete).toBe(30);
    expect(r.fretePendente).toBe(true);
    expect(r.fontesAtribuidas[0].fonteAlterada).toBe(true);
    expect(r.avisosFrete).toEqual(expect.arrayContaining(['Atualização dos pagamentos de frete pendente no GC', 'Fonte ou valor do frete mudou: conferir novamente']));
  });

  it('fonte ausente ou sem título não inventa confirmação de baixa', () => {
    const d = dados();
    d.conferencia!.ajustes.fretes = [{ fonteId: 'compra:100', valor: 30, limite: 60, incluidoNoCusto: false, justificativa: 'Conferido antes' }];
    const ausente = resumirCustosComissao(calcularVenda(d, parametros));
    expect(ausente.fontesAtribuidas[0]).toMatchObject({ pagoNaFonte: null, fonteAlterada: true, situacaoPagamento: 'Fonte não localizada na última consulta' });
    d.fretes = [fonte({ pago: 0, pagamentos: [], avisos: ['Pagamento do frete ainda não localizado'] })];
    const semTitulo = resumirCustosComissao(calcularVenda(d, parametros));
    expect(semTitulo.fontesAtribuidas[0].situacaoPagamento).toBe('Baixa não localizada');
    expect(semTitulo.fretePendente).toBe(true);
  });

  it('preserva centavos do lucro com custo unitário de quatro casas e detalha arredondamento', () => {
    const d = dados();
    d.venda.gc_payload_raw.produtos[0].produto.valor_custo = 400.004;
    d.venda.gc_payload_raw.servicos[0].servico.valor_custo = 20.004;
    const linha = calcularVenda(d, parametros);
    const r = resumirCustosComissao(linha);
    expect(r.ajusteArredondamento).toBe(0.01);
    expect(centavos(r.custoProdutos + r.custoServicos + r.impostos + r.taxasRecebimento + r.demaisDespesas + r.custoFrete + r.ajusteArredondamento)).toBe(r.totalCustosAntesComissao);
    expect(centavos(r.totalCustosAntesComissao + r.lucroAntes)).toBe(1000);
  });
});
