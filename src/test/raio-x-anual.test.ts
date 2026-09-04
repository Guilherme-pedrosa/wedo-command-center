import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { construirRaioX, osSemTitulo } from '@/lib/raioXAnual';

describe('raio-x anual — leitura de dados', () => {
  it('toda paginação do hook é por keyset: id > último id, ordenada por id, sem OFFSET e sem count(*)', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/hooks/useRaioXAnual.ts'), 'utf8');
    // count: 'exact' faz um count(*) inteiro por tabela e estourava o statement_timeout do banco;
    // .range() é OFFSET, que relê tudo de novo a cada página.
    expect(src).not.toMatch(/count: 'exact'/);
    expect(src).not.toMatch(/\.range\(/);
    const paginas = (src.match(/\.order\('id'\)\.limit\(PAGE\)/g) || []).length;
    const keysets = (src.match(/\.gt\('id', depois\)/g) || []).length;
    expect(paginas).toBeGreaterThan(0);
    expect(keysets).toBe(paginas);
  });

  it('não martela o banco: no máximo 3 leituras simultâneas, retry 1 e sem refetch ao focar a janela', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/hooks/useRaioXAnual.ts'), 'utf8');
    const grupos = src.match(/await Promise\.all\(\[([\s\S]*?)\n  \]\);/g) || [];
    expect(grupos.length).toBeGreaterThan(1);
    for (const g of grupos) expect((g.match(/todas</g) || []).length).toBeLessThanOrEqual(3);
    expect((src.match(/retry: 1/g) || []).length).toBe(2);
    expect((src.match(/refetchOnWindowFocus: false/g) || []).length).toBe(2);
  });

  it('comissões não são disparadas em paralelo contra a edge (estoura timeout e virava R$ 0)', () => {
    const src = fs.readFileSync(path.resolve(process.cwd(), 'src/hooks/useRaioXAnual.ts'), 'utf8');
    expect(src).not.toMatch(/Promise\.all\([^)]*premiacao-comissoes-total/s);
    expect(src).toMatch(/for \(const m of mesesDoAno[\s\S]*premiacao-comissoes-total/);
  });
});

describe('raio-x anual — régua WeDo', () => {
  it('monta o mês com fixos 100% nos serviços, imposto da guia M+1 e caixa separado', () => {
    const r = construirRaioX({
      ano: 2026, ateMesFechado: 1,
      os: [
        { os_codigo: '1', nome_cliente: 'A', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 100000, valor_pecas_custo: 20000, data_saida: '2026-01-10' },
        { os_codigo: '2', nome_cliente: 'B', nome_situacao: 'EXECUTADO - FECHADO CHAMADO', valor_total: 10000, valor_pecas_custo: 0, data_saida: '2026-01-12' },
      ],
      pagamentos: [
        { plano_contas_id: 'fixo-x', valor: 30000, data_vencimento: '2026-01-05', categoria_meta: 'custo_fixo', nome_meta: 'Folha Técnico' },
        { plano_contas_id: '1726df3a-f803-4f28-b7ee-1930f94b569f', valor: 12000, data_vencimento: '2026-02-10', categoria_meta: 'custo_variavel', nome_meta: 'Impostos' },
        { plano_contas_id: 'var-y', valor: 5000, data_vencimento: '2026-01-08', categoria_meta: 'custo_variavel', nome_meta: 'Combustível' },
      ],
      vendas: [{ valor_total: 40000, custo: 25000, data: '2026-01-15', interna: false }],
      pcm: [{ valor: 10000, data_vencimento: '2026-01-20' }],
      comissoesPorMes: { '2026-01': 4000 },
      recebidosPorMes: { '2026-01': 90000 },
      pagosPorMes: { '2026-01': 120000 },
    });
    const m = r.meses[0];
    expect(m.recServ).toBe(120000);
    expect(m.recCom).toBe(40000);
    expect(m.imposto).toBe(12000);
    expect(m.impostoEstimado).toBe(false);
    // serviços: 120000 − (20000 peças + 4000 comissões + 30000 fixos + 5000 diretos + 12000×0.75 imposto)
    expect(Math.round(m.resServ)).toBe(120000 - 20000 - 4000 - 30000 - 5000 - 9000);
    // comercial: 40000 − (25000 cmv + 3000 imposto)
    expect(Math.round(m.resCom)).toBe(40000 - 25000 - 3000);
    expect(m.caixaLiquido).toBe(-30000);
  });

  it('estima o imposto quando a guia do mês seguinte não está lançada', () => {
    const r = construirRaioX({
      ano: 2026, ateMesFechado: 2,
      os: [
        { os_codigo: '1', nome_cliente: 'A', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 100000, valor_pecas_custo: 0, data_saida: '2026-01-10' },
        { os_codigo: '2', nome_cliente: 'A', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 100000, valor_pecas_custo: 0, data_saida: '2026-02-10' },
      ],
      pagamentos: [
        { plano_contas_id: '1726df3a-f803-4f28-b7ee-1930f94b569f', valor: 10000, data_vencimento: '2026-02-10', categoria_meta: 'custo_variavel', nome_meta: 'Impostos' },
      ],
      vendas: [], pcm: [], comissoesPorMes: {}, recebidosPorMes: {}, pagosPorMes: {},
    });
    expect(r.meses[0].impostoEstimado).toBe(false);
    expect(r.meses[0].imposto).toBe(10000);
    expect(r.meses[1].impostoEstimado).toBe(true);
    expect(r.meses[1].imposto).toBe(10000); // alíquota efetiva 10% × 100k
  });

  it('nunca troca guia real de mês antigo por estimativa, mesmo se baixa', () => {
    const r = construirRaioX({
      ano: 2026, ateMesFechado: 3,
      os: ['01', '02', '03'].map(mm => ({ os_codigo: mm, nome_cliente: 'A', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 100000, valor_pecas_custo: 0, data_saida: `2026-${mm}-10` })),
      pagamentos: [
        { plano_contas_id: '1726df3a-f803-4f28-b7ee-1930f94b569f', valor: 12000, data_vencimento: '2026-02-10', categoria_meta: 'custo_variavel', nome_meta: 'Impostos' },
        { plano_contas_id: '1726df3a-f803-4f28-b7ee-1930f94b569f', valor: 3000, data_vencimento: '2026-03-10', categoria_meta: 'custo_variavel', nome_meta: 'Impostos' },
      ],
      vendas: [], pcm: [], comissoesPorMes: {}, recebidosPorMes: {}, pagosPorMes: {},
    });
    expect(r.meses[1].imposto).toBe(3000); // guia baixa, mas real e de mês antigo: mantém
    expect(r.meses[1].impostoEstimado).toBe(false);
    expect(r.meses[2].impostoEstimado).toBe(true); // último mês sem guia: estima
  });

  it('custos em planos fora das metas entram em "outros"; estoque/capex e societário ficam fora', () => {
    const r = construirRaioX({
      ano: 2026, ateMesFechado: 1,
      os: [{ os_codigo: '1', nome_cliente: 'A', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 100000, valor_pecas_custo: 0, data_saida: '2026-01-10' }],
      pagamentos: [
        { plano_contas_id: 'x1', valor: 8000, data_vencimento: '2026-01-05', categoria_meta: null, nome_plano: 'Transportadora' },
        { plano_contas_id: 'x2', valor: 3000, data_vencimento: '2026-01-05', categoria_meta: null, nome_plano: 'Comissão de vendedores' },
        { plano_contas_id: 'x3', valor: 50000, data_vencimento: '2026-01-05', categoria_meta: null, nome_plano: 'Aquisição de máquinas para revenda' },
        { plano_contas_id: 'x4', valor: 10000, data_vencimento: '2026-01-05', categoria_meta: null, nome_plano: 'Transferências de  Sócios' },
      ],
      vendas: [], pcm: [], comissoesPorMes: {}, recebidosPorMes: {}, pagosPorMes: {},
    });
    expect(r.meses[0].outros).toBe(8000);
    expect(r.meses[0].outrosComercial).toBe(3000);
  });

  it('lista OS sem título e reconhece título pela descrição com nº', () => {
    const lista = osSemTitulo(
      [
        { os_codigo: '10', nome_cliente: 'A', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 500, valor_pecas_custo: 0, data_saida: '2026-01-01' },
        { os_codigo: '11', nome_cliente: 'B', nome_situacao: 'EXECUTADO - AGUARDANDO PAGAMENTO', valor_total: 700, valor_pecas_custo: 0, data_saida: '2026-01-02' },
        { os_codigo: '12', nome_cliente: 'C', nome_situacao: 'EXECUTADO - FECHADO CHAMADO', valor_total: 900, valor_pecas_custo: 0, data_saida: '2026-01-03' },
      ],
      [
        { os_codigo: '10', descricao: null, valor: 500, liquidado: true, data_liquidacao: '2026-01-05', data_vencimento: '2026-01-05' },
        { os_codigo: null, descricao: 'Ordem de serviço de nº 11 - NF 99', valor: 700, liquidado: false, data_liquidacao: null, data_vencimento: '2026-02-01' },
      ],
    );
    expect(lista).toHaveLength(0); // 10 por os_codigo, 11 pela descrição, 12 é chamado (fora)
  });
});
