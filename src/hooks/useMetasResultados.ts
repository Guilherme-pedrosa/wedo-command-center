// src/hooks/useMetasResultados.ts
// Shared hook & utilities for Resultados Operação
import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { classificarPlanoSemMeta } from '@/lib/raioXAnual';
import { fetchAllRows, dedupeBy } from '@/lib/supabasePaginate';

// ─── TIPOS ─────────────────────────────────────────────────────────────────
export interface Meta {
  id: string;
  nome: string;
  categoria: 'receita' | 'custo_variavel' | 'custo_fixo';
  tipo_meta: 'absoluto' | 'percentual';
  meta_valor: number | null;
  meta_percentual: number | null;
  fonte?: string | null;
}

export interface MetaPlanoContas {
  meta_id: string;
  plano_contas_id: string;
  centro_custo_id: string | null;
  peso: number;
}

export interface MetaComResultado extends Meta {
  realizado: number;
  meta_calculada: number;
  delta: number;
  pct_faturamento: number;
  status: 'verde' | 'amarelo' | 'vermelho';
  progresso: number;
  provisionado?: boolean;
}

// Classificação da meta. A regra vem de fin_metas.fonte (coluna explícita), NUNCA do nome:
// heurística por substring é instável — 'at' casava com "Contratos", e renomear uma meta na tela
// trocava silenciosamente a fórmula do realizado.
export type MetaFonte =
  | 'receita_pcm' | 'receita_locacao' | 'receita_servicos' | 'receita_ecolab' | 'receita_produtos'
  | 'custo_venda_produtos' | 'custo_pecas_operacao' | 'comissoes' | 'impostos' | 'prolabore' | 'generico';

const FONTES_VALIDAS = new Set<MetaFonte>([
  'receita_pcm', 'receita_locacao', 'receita_servicos', 'receita_ecolab', 'receita_produtos',
  'custo_venda_produtos', 'custo_pecas_operacao', 'comissoes', 'impostos', 'prolabore', 'generico',
]);

/** Fallback só para metas novas ainda sem `fonte` gravada. */
const inferirFonteLegado = (meta: Pick<Meta, 'nome' | 'categoria'>): MetaFonte => {
  const n = meta.nome.toLowerCase();
  const receita = meta.categoria === 'receita';
  if (!receita && (n.includes('comiss') || n.includes('premia'))) return 'comissoes';
  if (!receita && n.includes('impost')) return 'impostos';
  if (!receita && n.includes('labore')) return 'prolabore';
  if (!receita && n.includes('venda') && n.includes('produto')) return 'custo_venda_produtos';
  if (!receita && meta.categoria === 'custo_variavel' && isMetaPecasOperacao(n)) return 'custo_pecas_operacao';
  if (receita && (n.includes('contrato') || n.includes('pcm'))) return 'receita_pcm';
  if (receita && n.includes('loca')) return 'receita_locacao';
  if (receita && (n.includes('ecolab') || n.includes('chamado'))) return 'receita_ecolab';
  if (receita && (n.includes('coifa') || n.includes('execu') || n.includes('higieniza'))) return 'receita_servicos';
  if (receita && (n.includes('venda') || n.includes('produto') || n.includes('peça'))) return 'receita_produtos';
  return 'generico';
};

export const classificarMeta = (meta: Pick<Meta, 'nome' | 'categoria' | 'fonte'>): MetaFonte => {
  const f = String(meta.fonte || '').trim() as MetaFonte;
  if (FONTES_VALIDAS.has(f) && f !== 'generico') return f;
  if (f === 'generico') return 'generico';
  return inferirFonteLegado(meta);
};

// Receitas de venda de produtos/peças — excluídas do modo "Apenas Serviços".
const FONTES_COMERCIAL = new Set<MetaFonte>(['receita_produtos', 'custo_venda_produtos']);

// ─── UTILITÁRIOS ────────────────────────────────────────────────────────────
export const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

export const formatPct = (v: number) => `${(v * 100).toFixed(1)}%`;

export const getPeriodRange = (year: number, month: number) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  return { start, end };
};

export const calcStatus = (
  categoria: string,
  realizado: number,
  meta_calculada: number
): 'verde' | 'amarelo' | 'vermelho' => {
  const ratio = meta_calculada > 0 ? realizado / meta_calculada : 0;
  if (categoria === 'receita') {
    if (ratio >= 1) return 'verde';
    if (ratio >= 0.8) return 'amarelo';
    return 'vermelho';
  } else {
    // Custo com meta zero: qualquer gasto já é estouro — não pode aparecer "OK".
    if (meta_calculada <= 0) return realizado > 0 ? 'vermelho' : 'verde';
    if (ratio <= 1) return 'verde';
    if (ratio <= 1.15) return 'amarelo';
    return 'vermelho';
  }
};

export const statusBadge = (status: 'verde' | 'amarelo' | 'vermelho') => {
  const map = {
    verde:    { label: 'OK',       class: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
    amarelo:  { label: 'ATENÇÃO',  class: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    vermelho: { label: 'ALERTA',   class: 'bg-red-100 text-red-800 border-red-200' },
  };
  return map[status];
};

// A meta de peças da operação é reconhecida pelo nome ("Custo com Peças para Operações",
// "…estoque"). Só ela lê o custo real das saídas de estoque e ganha as linhas informativas
// de compras e uso interno na tela. "CUSTOS EXTRAS COM AS OPERAÇÕES" NÃO é essa meta —
// "operaç" sozinho já duplicou as linhas informativas uma vez.
export const isMetaPecasOperacao = (nome: string) => {
  const n = String(nome || '').toLowerCase();
  if (n.includes('venda') && n.includes('produto')) return false;
  return n.includes('peça') || n.includes('peca') || n.includes('estoque');
};

// Combustível e hospedagem vêm do contas a pagar (fin_pagamentos), como todo custo. O Auvo só
// tinha o que o técnico lançava (jan/26 sem nada) e divergia do que foi pago — o Raio-X anual
// já lia do contas a pagar; as duas telas agora batem.

// Planos apurados por competência (ver comentário no hook).
export const PLANOS_POR_COMPETENCIA_IDS = new Set([
  'e7299b90-98d2-4d7a-a04c-78ba40cc847a', // COMISSÕES E BONIFICAÇÕES
]);

// Planos de imposto: a guia do mês M vence em M+1 (DAS/PIS/COFINS ~dia 20-25, ICMS/ISS ~dia 10).
// A data_competencia dos lançamentos vem preenchida igual ao vencimento, então o imposto
// REFERENTE ao mês M são as guias com data_vencimento em M+1 — regra confirmada pelo Guilherme:
// "o imposto de julho é ref a junho, o de agosto ref a julho".
export const PLANOS_IMPOSTO_IDS = new Set([
  '367198e3-1eee-46b5-8d4a-af208852198e', // Impostos - importação IPI
  '1726df3a-f803-4f28-b7ee-1930f94b569f', // Impostos - PIS
  'e37b446f-e96f-4fe0-ab52-cfbaeb2e7c7c', // Impostos - COFINS
  '3692812b-86d8-4ec7-be51-542af1424d2d', // Impostos - ICMS
  '8f50518c-131e-4b4c-a8ca-a9fd3f5bea88', // Impostos - ISS
  'df1e63ee-92db-4046-887a-9f4cbd5d4115', // Impostos - Simples Nacional
  '2e311d38-f51c-40d9-baa8-ecdf3080c99d', // ISSQN Prest.Serv.Próprio
]);

// Regra de custeio do modo "Apenas Serviços" (definida pelo Guilherme, 03/09/2026):
// o custo fixo existiria com ou sem o comercial, então fica 100% nos serviços.
// O comercial (vendas) carrega apenas o que existe por causa dele:
//   - salários do comercial (Filipe e Pedro — excluídos por lançamento da Folha ADM);
//   - 20% do pró-labore;
//   - impostos proporcionais à participação das vendas no faturamento;
//   - custo cheio dos produtos vendidos (meta própria, já fora do modo serviços).
export const computeRateioFator = (execServicos: number, execTotalFull: number, includeCommercial: boolean) =>
  includeCommercial ? 1 : execTotalFull > 0 ? execServicos / execTotalFull : 1;

export const PROLABORE_FRACAO_COMERCIAL = 0.2;

// Planos onde caem os salários/encargos do time comercial (Filipe e Pedro, PJ).
export const PLANOS_FOLHA_ADM_COMERCIAL = new Set([
  'bbce323d-c7ee-4795-97d6-f924d373c371', // CONTRATAÇÃO DE SERVIÇOS / SALÁRIO ADM
  '27287f2b-af8b-4a6d-b9af-b8b9b8286500', // Encargos Funcionários ADM - Alimentação / Refeição
]);
const FORNECEDOR_COMERCIAL_REGEX = /FILIPE FARIAS|PEDRO HENRIQUE/i;
// Só remuneração conta como custo comercial: fretes/reembolsos pagos a eles são da operação.
const REMUNERACAO_REGEX = /(SERVI[ÇC]OS PRESTADOS|SAL[ÁA]RIO|ADIANTAMENTO|BONIFICA)/i;
const COMPRA_SECA_REGEX = /^Compra de nº \d+\s*$/i;

export const isLancamentoFolhaComercial = (
  planoUuid: string,
  row: { descricao?: string | null; nome_fornecedor?: string | null },
) => {
  if (!PLANOS_FOLHA_ADM_COMERCIAL.has(planoUuid)) return false;
  if (!FORNECEDOR_COMERCIAL_REGEX.test(String(row.nome_fornecedor || ''))) return false;
  const desc = String(row.descricao || '');
  return REMUNERACAO_REGEX.test(desc) || COMPRA_SECA_REGEX.test(desc);
};

// Fatores aplicados a cada meta no modo Apenas Serviços:
// impostos → proporcionais à receita; pró-labore → 80%; demais fixos → 100% (só pró-rata).
export const computeAjustesMeta = (
  categoria: Meta['categoria'],
  nome: string,
  rateioFator: number,
  fracaoProrata: number,
  includeCommercial: boolean = true,
  fonte?: MetaFonte,
) => {
  const efetiva = fonte ?? inferirFonteLegado({ nome, categoria });
  const isImposto = categoria === 'custo_variavel' && efetiva === 'impostos';
  const isProlabore = categoria === 'custo_fixo' && efetiva === 'prolabore';
  const fatorComercial = !includeCommercial && isProlabore ? 1 - PROLABORE_FRACAO_COMERCIAL : 1;
  const prorata = categoria === 'custo_fixo' ? fracaoProrata : 1;
  return {
    fatorRealizado: (isImposto ? rateioFator : 1) * prorata * fatorComercial,
    fatorMetaAbsoluta: categoria === 'custo_fixo' ? prorata * fatorComercial : 1,
  };
};

// Alíquota efetiva de impostos = guias (vencimento M+1) ÷ receita executada, nos meses fechados
// em que a guia já existe. É a estimativa enquanto a guia do mês não vem — a meta (16%) é alvo,
// não estimativa, e inflava o custo do mês corrente em ~60%. Mesma régua do Raio-X anual.
export const computeAliquotaEfetiva = (
  guiasPorMesRef: Record<string, number>,
  receitaPorMes: Record<string, number>,
  mesesElegiveis: string[],
): { aliquota: number | null; meses: string[] } => {
  let guias = 0;
  let receita = 0;
  const usados: string[] = [];
  for (const m of mesesElegiveis) {
    const g = guiasPorMesRef[m] || 0;
    const r = receitaPorMes[m] || 0;
    if (g <= 0 || r <= 0) continue;
    guias += g;
    receita += r;
    usados.push(m);
  }
  return { aliquota: receita > 0 ? guias / receita : null, meses: usados };
};

// Pagamentos em planos que não estão em nenhuma meta de custo entram como "Outros custos"
// (transportadora, tarifas, químicos…), exceto estoque/capex e societário; comissão de
// vendedores é do comercial. Sem isso o resultado do mês ignorava esses custos.
export const computeOutrosCustos = (
  pagamentos: { plano_contas_id: string; valor: number }[],
  planosComMeta: Set<string>,
  nomesPlanos: Record<string, string>,
  includeCommercial: boolean,
): { total: number; itens: { nome: string; valor: number }[] } => {
  const porPlano = new Map<string, number>();
  for (const p of pagamentos) {
    const plano = String(p.plano_contas_id || '');
    if (!plano || planosComMeta.has(plano)) continue;
    const nome = nomesPlanos[plano] || '(plano sem nome)';
    const classe = classificarPlanoSemMeta(nome);
    if (classe === 'fora') continue;
    if (classe === 'outros_comercial' && !includeCommercial) continue;
    porPlano.set(nome, (porPlano.get(nome) || 0) + Math.abs(p.valor || 0));
  }
  const itens = [...porPlano.entries()].map(([nome, valor]) => ({ nome, valor })).sort((a, b) => b.valor - a.valor);
  return { total: itens.reduce((a, i) => a + i.valor, 0), itens };
};

// Comissões: a fonte oficial é a tela de Premiação (edge do Auvo GC Sync). Quando ela não
// responde, o valor não pode virar R$ 0 com status OK — cai no último valor obtido (guardado
// no navegador) e, sem ele, nas comissões pagas no mês seguinte (contas a pagar), sinalizado.
export type ComissoesFonte = 'premiacao' | 'cache' | 'pagas_m1';
export const escolherComissoes = (
  premiacao: number | null | undefined,
  cache: { valor: number; em: string } | null,
  pagasM1: number,
): { valor: number; fonte: ComissoesFonte; em: string | null } => {
  if (typeof premiacao === 'number' && Number.isFinite(premiacao)) return { valor: premiacao, fonte: 'premiacao', em: null };
  if (cache) return { valor: cache.valor, fonte: 'cache', em: cache.em };
  return { valor: pagasM1, fonte: 'pagas_m1', em: null };
};

const PLANO_PCM_CONTRATOS = '27867721';
const PLANO_PCM_LOCACAO = '27867722';
const PLANO_COMISSOES_ID = 'e7299b90-98d2-4d7a-a04c-78ba40cc847a';
type PremiacaoTotais = { comissao_total: number; comissao_final: number; faturamento_premiacao: number };
const premiacaoCacheKey = (m: string) => `wedo:premiacao-totais:${m}`;
const lerPremiacaoCache = (m: string): { valor: number; em: string } | null => {
  try {
    const raw = localStorage.getItem(premiacaoCacheKey(m));
    if (!raw) return null;
    const p = JSON.parse(raw) as { valor?: number; em?: string };
    return typeof p.valor === 'number' && p.em ? { valor: p.valor, em: p.em } : null;
  } catch { return null; }
};
const gravarPremiacaoCache = (m: string, valor: number) => {
  try { localStorage.setItem(premiacaoCacheKey(m), JSON.stringify({ valor, em: new Date().toISOString() })); } catch { /* sem storage */ }
};

// ─── HOOK ──────────────────────────────────────────────────────────────────
export const useMetasResultados = (
  year: number,
  month: number,
  includeCommercial: boolean = true,
  prorataFixos: boolean = false,
) => {
  const { start, end } = getPeriodRange(year, month);

  // Pró-rata só faz sentido no mês corrente: fixos (realizado e meta) proporcionais
  // aos dias já corridos, para a margem parcial não comparar 3 dias de receita com
  // um mês inteiro de custo lançado.
  const hoje = new Date();
  const isCurrentMonth = hoje.getFullYear() === year && hoje.getMonth() + 1 === month;
  const diasNoMes = new Date(year, month, 0).getDate();
  const fracaoProrata = prorataFixos && isCurrentMonth ? hoje.getDate() / diasNoMes : 1;

  const { data: metas = [], isLoading: loadingMetas } = useQuery({
    queryKey: ['fin_metas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_metas').select('*').eq('ativo', true);
      if (error) throw error;
      return data as Meta[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: mapeamentos = [], isLoading: loadingMap } = useQuery({
    queryKey: ['fin_meta_plano_contas'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_meta_plano_contas').select('*');
      if (error) throw error;
      return data as MetaPlanoContas[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: planos = { map: {}, nomes: {} }, isLoading: loadingPlanos } = useQuery({
    queryKey: ['fin_plano_contas_gc_map_nomes'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_plano_contas').select('id, gc_id, nome');
      if (error) throw error;
      const map: Record<string, string> = {};
      const nomes: Record<string, string> = {};
      for (const row of data || []) {
        if (row.gc_id) map[row.gc_id] = row.id;
        nomes[row.id] = String(row.nome || '');
      }
      return { map, nomes };
    },
    staleTime: 10 * 60 * 1000,
  });
  const planoContasMap = planos.map;
  const nomesPlanos = planos.nomes;

  const { data: centrosCustoMap = {} } = useQuery({
    queryKey: ['fin_centros_custo_map'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_centros_custo').select('id, codigo');
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const row of data || []) {
        if (row.codigo) map[row.id] = row.codigo;
      }
      return map;
    },
    staleTime: 10 * 60 * 1000,
  });

  const { data: recebimentos = [], isLoading: loadingRec, refetch: refetchRec } = useQuery({
    queryKey: ['fin_recebimentos_metas', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<{ id: string; plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null }>(
        (from, to) => supabase
          .from('fin_recebimentos')
          .select('id, plano_contas_id, centro_custo_id, valor, status')
          .neq('status', 'cancelado')
          .gte('data_vencimento', start)
          .lte('data_vencimento', end)
          .order('id', { ascending: true })
          .range(from, to) as any);
      return dedupeBy(rows, r => r.id);
    },
  });

  const { data: pagamentos = [], isLoading: loadingPag, refetch: refetchPag } = useQuery({
    queryKey: ['fin_pagamentos_metas', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<{ id: string; plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null; data_liquidacao: string | null; descricao: string | null; nome_fornecedor: string | null }>(
        (from, to) => supabase
          .from('fin_pagamentos')
          .select('id, plano_contas_id, centro_custo_id, valor, status, data_liquidacao, descricao, nome_fornecedor')
          .neq('status', 'cancelado')
          .gte('data_vencimento', start)
          .lte('data_vencimento', end)
          .order('id', { ascending: true })
          .range(from, to) as any);
      return dedupeBy(rows, r => r.id);
    },
  });

  // Pagamentos filtrados por DATA DE COMPETÊNCIA (para Comissões/Premiações e Despesas com Veículos).
  // Esses custos devem refletir o mês de competência, não o vencimento.
  const { data: pagamentosCompetencia = [], isLoading: loadingPagComp, refetch: refetchPagComp } = useQuery({
    queryKey: ['fin_pagamentos_metas_competencia', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<{ id: string; plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null }>(
        (from, to) => supabase
          .from('fin_pagamentos')
          .select('id, plano_contas_id, centro_custo_id, valor, status')
          .neq('status', 'cancelado')
          .gte('data_competencia', start)
          .lte('data_competencia', end)
          .order('id', { ascending: true })
          .range(from, to) as any);
      return dedupeBy(rows, r => r.id);
    },
  });

  // Impostos referentes ao mês selecionado = guias com VENCIMENTO no mês seguinte
  // (ver comentário em PLANOS_IMPOSTO_IDS).
  const nextMonthYear = month === 12 ? year + 1 : year;
  const nextMonth = month === 12 ? 1 : month + 1;
  const { start: refStart, end: refEnd } = getPeriodRange(nextMonthYear, nextMonth);
  const { data: pagamentosImpostoRef = [], isLoading: loadingImpRef, refetch: refetchImpRef } = useQuery({
    queryKey: ['fin_pagamentos_impostos_ref', refStart, refEnd],
    queryFn: async () => {
      const rows = await fetchAllRows<{ id: string; plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null; descricao: string | null; nome_fornecedor: string | null }>(
        (from, to) => supabase
          .from('fin_pagamentos')
          .select('id, plano_contas_id, centro_custo_id, valor, status, descricao, nome_fornecedor')
          .neq('status', 'cancelado')
          .gte('data_vencimento', refStart)
          .lte('data_vencimento', refEnd)
          .order('id', { ascending: true })
          .range(from, to) as any);
      return dedupeBy(rows, r => r.id);
    },
  });

  // Plano de contas (UUIDs) que devem ser apurados por COMPETÊNCIA em vez de vencimento.
  // - COMISSÕES E BONIFICAÇÕES (28054594) → Comissões e Premiações (Técnicos)
  const PLANOS_POR_COMPETENCIA = PLANOS_POR_COMPETENCIA_IDS;

  // Espelha EXATAMENTE o "Relatório de Ordens de Serviços" do GestãoClick:
  // só esses status entram em Execução + Coifas.
  const OS_EXECUTADOS_STATUS = [
    'EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA',
    'EXECUTADO - AGUARDANDO PAGAMENTO',
    'EXECUTADO COM NOTA EMITIDA',
    'EXECUTADO - FINANCEIRO SEPARADO',
    'EXECUTADO - FECHADO CHAMADO', 
    'CHAMADO FECHADO - FATURADO', // Adicionado conforme solicitado
  ];

  const { data: osExecutadas = [], isLoading: loadingOS, refetch: refetchOS, dataUpdatedAt: osDataUpdatedAt, error: errorOS } = useQuery({
    queryKey: ['os_executadas_metas', start, end],
    queryFn: async () => {
      const raw = await fetchAllRows<any>((from, to) => supabase
        .from('os_index')
        .select('os_id, os_codigo, nome_cliente, nome_situacao, nome_vendedor, valor_total, valor_pecas, valor_pecas_custo, data_saida, data_execucao_real, execucao_verificacao_status, execucao_verificacao_motivo')
        .in('nome_situacao', OS_EXECUTADOS_STATUS)
        .gte('data_saida', start)
        .lte('data_saida', end)
        .order('os_id', { ascending: true })
        .range(from, to) as any);
      // Uma OS pode ter vários orçamentos vinculados: a chave canônica é os_id.
      const rows = dedupeBy(raw, r => String(r.os_id)) as { os_id: string; os_codigo: string; nome_cliente: string | null; nome_situacao: string | null; nome_vendedor: string | null; valor_total: number | null; valor_pecas: number | null; valor_pecas_custo: number | null; data_saida: string | null; data_execucao_real: string | null; execucao_verificacao_status: string | null; execucao_verificacao_motivo: string | null }[];
      // Exclui apenas OS com execução real antiga, anterior ao período analisado.
      // Ex: OS faturada (data_saida) em Maio mas executada em Nov/2025 não deve contar em Maio/2026.
      // OS com execução real posterior ao período permanece, pois consta no relatório do GC por data_saida.
      return rows.filter(os => {
        if (!os.data_execucao_real) return true;
        return os.data_execucao_real >= start;
      });
    },
  });


  // Vendas: somente Concretizada (situacao_id = 7063585) entra no faturamento.
  // Mantemos no banco vendas Canceladas/Outras pra rastreabilidade, mas filtramos aqui.
  const VENDAS_SITUACAO_CONCRETIZADA = '7063585';
  const { data: vendasConcretizadas = [], isLoading: loadingVendas, refetch: refetchVendas } = useQuery({
    queryKey: ['gc_vendas_metas', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<any>((from, to) => supabase
        .from('gc_vendas')
        .select('gc_id, codigo, nome_cliente, nome_situacao, situacao_id, valor_total, valor_produtos, data, gc_payload_raw')
        .eq('situacao_id', VENDAS_SITUACAO_CONCRETIZADA)
        .gte('data', start)
        .lte('data', end)
        .order('gc_id', { ascending: true })
        .range(from, to) as any);
      return dedupeBy(rows, r => String(r.gc_id)) as { gc_id: string; codigo: string; nome_cliente: string | null; nome_situacao: string | null; situacao_id: string | null; valor_total: number | null; valor_produtos: number | null; data: string | null; gc_payload_raw: any }[];
    },
  });

  // Custo de Peças: apenas as duas situações confirmadas pelo usuário —
  // 1675070 (Finalizado - mercadoria chegou) e 1675083 (COMPRADO - AG CHEGADA).
  // NÃO inclui "COMPRADO - AG CHEGADA PARA ESTOQUE" nem outras variantes.
  const COMPRAS_CUSTO_SITUACAO_IDS = ['1675070', '1675083'];
  const { data: comprasFinalizadas = [], isLoading: loadingCompras, refetch: refetchCompras } = useQuery({
    queryKey: ['gc_compras_metas', start, end],
    queryFn: async () => {
      const byData = await fetchAllRows<any>((from, to) => supabase
        .from('gc_compras' as any)
        .select('gc_id, codigo, nome_fornecedor, nome_situacao, situacao_id, valor_total, data, cadastrado_em')
        .in('situacao_id', COMPRAS_CUSTO_SITUACAO_IDS)
        .gte('data', start)
        .lte('data', end)
        .order('gc_id', { ascending: true })
        .range(from, to) as any);
      if (byData.length > 0) return dedupeBy(byData, r => String(r.gc_id));
      const byCad = await fetchAllRows<any>((from, to) => supabase
        .from('gc_compras' as any)
        .select('gc_id, codigo, nome_fornecedor, nome_situacao, situacao_id, valor_total, data, cadastrado_em')
        .in('situacao_id', COMPRAS_CUSTO_SITUACAO_IDS)
        .gte('cadastrado_em', start)
        .lte('cadastrado_em', end + 'T23:59:59')
        .order('gc_id', { ascending: true })
        .range(from, to) as any);
      return dedupeBy(byCad, r => String(r.gc_id));
    },
  });


  // gc_recebimentos filtrado por competência (para categorias gerais)
  const { data: gcRecebimentos = [], isLoading: loadingGcRec, refetch: refetchGcRec } = useQuery({
    queryKey: ['gc_recebimentos_metas', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<any>((from, to) => supabase
        .from('gc_recebimentos')
        .select('gc_id, gc_codigo, descricao, valor, plano_contas_id, centro_custo_id, data_vencimento, liquidado')
        .gte('data_competencia', start)
        .lte('data_competencia', end)
        .order('gc_id', { ascending: true })
        .range(from, to) as any);
      return dedupeBy(rows, r => String(r.gc_id)) as { gc_id: string; gc_codigo: string; descricao: string | null; valor: number; plano_contas_id: string | null; centro_custo_id: string | null; data_vencimento: string | null; liquidado: boolean }[];
    },
  });

  // Contratos PCM: APENAS Confirmado / Confirmado Manual (liquidado=true).
  // Atrasado/Em Aberto NÃO entra (cliente pode cancelar antes de pagar).
  const PCM_PLANO_IDS = ['27867721', '27867722'];
  const { data: gcRecPCM = [], isLoading: loadingGcPCM, refetch: refetchGcPCM } = useQuery({
    queryKey: ['gc_recebimentos_pcm', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<any>((from, to) => supabase
        .from('gc_recebimentos')
        .select('gc_id, gc_codigo, descricao, valor, plano_contas_id, centro_custo_id, data_vencimento, liquidado')
        .in('plano_contas_id', PCM_PLANO_IDS)
        .eq('liquidado', true)
        .gte('data_vencimento', start)
        .lte('data_vencimento', end)
        .order('gc_id', { ascending: true })
        .range(from, to) as any);
      return dedupeBy(rows, r => String(r.gc_id)) as { gc_id: string; gc_codigo: string; descricao: string | null; valor: number; plano_contas_id: string | null; centro_custo_id: string | null; data_vencimento: string | null; liquidado: boolean }[];
    },
  });

  // Faturamento Executado = OS Execução+Coifa + Chamados (Ecolab) + PCM Confirmado + (opcional) Venda de Produtos.
  // Chamado fechado/faturado é receita real de serviço e entra na base — igual ao Raio-X anual
  // (~R$ 15 mil/mês que a margem ignorava). Só a base de % de peças segue sem chamados.
  const { execTotal, execTotalFull, rateioFator } = useMemo(() => {
    const osTotal = osExecutadas.reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
    const recFinanceiro = gcRecPCM.reduce((acc, r) => acc + (r.valor || 0), 0);
    const vendasTotal = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);
    const execServicos = osTotal + recFinanceiro;
    const full = execServicos + vendasTotal;
    return {
      execTotal: includeCommercial ? full : execServicos,
      execTotalFull: full,
      rateioFator: computeRateioFator(execServicos, full, includeCommercial),
    };
  }, [gcRecPCM, osExecutadas, vendasConcretizadas, includeCommercial]);

  // Base de comissões: Ecolab/Chamados + Execução Serviços/Coifas
  const baseComissoes = useMemo(() => {
    const EXEC_SERVICO_STATUS = [
      'EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA',
      'EXECUTADO - AGUARDANDO PAGAMENTO',
      'EXECUTADO - FINANCEIRO SEPARADO',
      'EXECUTADO COM NOTA EMITIDA',
    ];
    const ECOLAB_STATUS = [
      'EXECUTADO - FECHADO CHAMADO',
      'CHAMADO FECHADO - FATURADO'
    ];
    return osExecutadas
      .filter(os =>
        ECOLAB_STATUS.includes(os.nome_situacao ?? '') ||
        EXEC_SERVICO_STATUS.includes(os.nome_situacao ?? '')
      )
      .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
  }, [osExecutadas]);


  // Venda de Balcão: situacao_id 7340612 ("Concretizada - Uso Interno / Maleta").
  // Faturamento = valor_produtos (exclui frete); custo = valor_custo do payload GC.
  const VENDAS_BALCAO_SITUACAO_IDS = ['7340612'];
  const { data: vendasBalcaoRows = [], refetch: refetchVendasBalcao } = useQuery({
    queryKey: ['gc_vendas_balcao', start, end],
    queryFn: async () => {
      const rows = await fetchAllRows<any>((from, to) => supabase
        .from('gc_vendas')
        .select('gc_id, valor_produtos, gc_payload_raw, data, situacao_id')
        .in('situacao_id', VENDAS_BALCAO_SITUACAO_IDS)
        .gte('data', start)
        .lte('data', end)
        .order('gc_id', { ascending: true })
        .range(from, to) as any);
      return dedupeBy(rows, r => String(r.gc_id)) as { valor_produtos: number | null; gc_payload_raw: any }[];
    },
  });
  const vendasBalcao = useMemo(() => {
    let faturamento = 0;
    let custo = 0;
    for (const v of vendasBalcaoRows) {
      faturamento += Number(v.valor_produtos) || 0;
      const custoVenda = parseFloat(String(v.gc_payload_raw?.valor_custo || '0')) || 0;
      custo += custoVenda;
    }
    return { faturamento, custo };
  }, [vendasBalcaoRows]);

  // Comissões / Premiações: valor oficial vem da tela de Premiação do projeto "Auvo GC Sync"
  // (comissao_final = bruto − reduções + bônus de meta/telemetria). Aquela edge monta o mês do
  // zero quando o cache dela está frio (passa de 90 s; quente, ~15 s): limite de 60 s por
  // tentativa e tentativas espaçadas — a segunda em geral já pega o cache quente.
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { data: premiacaoTotais, isLoading: loadingPremiacao, refetch: refetchPremiacao } = useQuery({
    queryKey: ['premiacao_comissoes_total', year, month],
    queryFn: async () => {
      const resultado = await Promise.race([
        supabase.functions.invoke('premiacao-comissoes-total', { body: { month: monthStr } }),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('Premiação demorou mais de 60 s')), 60_000)),
      ]);
      const { data, error } = resultado as { data: any; error: any };
      if (error) throw error;
      if (!data || data.ok === false || typeof data.comissao_final !== 'number') throw new Error(data?.error || 'Falha ao buscar premiações');
      gravarPremiacaoCache(monthStr, Number(data.comissao_final) || 0);
      return data as PremiacaoTotais;
    },
    staleTime: 10 * 60 * 1000,
    retry: 2,
    retryDelay: 10_000,
    refetchOnWindowFocus: false,
  });
  // Comissões pagas no mês seguinte (plano COMISSÕES E BONIFICAÇÕES) — já vêm na consulta de
  // referência M+1 dos impostos; ficam ~1 mês defasadas em relação à Premiação.
  const comissoesPagasM1 = useMemo(() =>
    pagamentosImpostoRef
      .filter(r => r.plano_contas_id === PLANO_COMISSOES_ID)
      .reduce((acc, r) => acc + Math.abs(r.valor || 0), 0),
  [pagamentosImpostoRef]);
  const comissoesEscolha = useMemo(() => escolherComissoes(
    premiacaoTotais ? Number(premiacaoTotais.comissao_final) : null,
    premiacaoTotais ? null : lerPremiacaoCache(monthStr),
    comissoesPagasM1,
  ), [premiacaoTotais, monthStr, comissoesPagasM1]);
  const comissoesPremiacao = comissoesEscolha.valor;
  const comissoesFonte = comissoesEscolha.fonte;
  const comissoesAtualizadoEm = comissoesEscolha.em;

  // Custo de Venda de Produtos (concretizadas que entraram no faturamento)
  const custoVendasProdutos = useMemo(() => {
    return vendasConcretizadas.reduce((acc, v) => {
      const custoVenda = parseFloat(String(v.gc_payload_raw?.valor_custo || '0')) || 0;
      return acc + custoVenda;
    }, 0);
  }, [vendasConcretizadas]);

  // Total de remuneração do comercial (Filipe/Pedro) excluída dos fixos no modo Apenas Serviços.
  const folhaComercialExcluida = useMemo(() =>
    pagamentos
      .filter(r => isLancamentoFolhaComercial(r.plano_contas_id, r as { descricao?: string | null; nome_fornecedor?: string | null }))
      .reduce((acc, r) => acc + Math.abs(r.valor || 0), 0),
  [pagamentos]);

  // ─── Alíquota efetiva: guias com vencimento em [fev, M] ↔ receita executada de [jan, M-1] ───
  const mesRef = (y: number, m: number, delta: number) => {
    const d = new Date(y, m - 1 + delta, 1);
    return { y: d.getFullYear(), m: d.getMonth() + 1 };
  };
  // Mesma janela do Raio-X anual: os meses anteriores do próprio ano (jan..M-1).
  const histIni = { y: year, m: 1 };
  const histFim = mesRef(year, month, -1);
  const guiasIni = { y: year, m: 2 }; // guia de janeiro vence em fevereiro
  const histStart = getPeriodRange(histIni.y, histIni.m).start;
  const histEnd = getPeriodRange(histFim.y, histFim.m).end;
  const guiasStart = getPeriodRange(guiasIni.y, guiasIni.m).start;
  const guiasEnd = end;
  const { data: historicoImpostos, isLoading: loadingHist } = useQuery({
    queryKey: ['impostos_aliquota_efetiva', histStart, histEnd],
    staleTime: 30 * 60 * 1000,
    queryFn: async () => {
      // O histórico anual estoura 1000 linhas facilmente: sem paginação a alíquota efetiva
      // era calculada sobre uma receita truncada (alíquota inflada).
      const [guias, os, pcm, vendas] = await Promise.all([
        fetchAllRows<any>((f, t) => supabase.from('fin_pagamentos').select('id, valor, data_vencimento')
          .in('plano_contas_id', [...PLANOS_IMPOSTO_IDS]).neq('status', 'cancelado')
          .gte('data_vencimento', guiasStart).lte('data_vencimento', guiasEnd)
          .order('id', { ascending: true }).range(f, t) as any),
        fetchAllRows<any>((f, t) => supabase.from('os_index').select('os_id, valor_total, data_saida')
          .in('nome_situacao', OS_EXECUTADOS_STATUS).gte('data_saida', histStart).lte('data_saida', histEnd)
          .order('os_id', { ascending: true }).range(f, t) as any),
        fetchAllRows<any>((f, t) => supabase.from('gc_recebimentos').select('gc_id, valor, data_vencimento')
          .in('plano_contas_id', PCM_PLANO_IDS).eq('liquidado', true)
          .gte('data_vencimento', histStart).lte('data_vencimento', histEnd)
          .order('gc_id', { ascending: true }).range(f, t) as any),
        fetchAllRows<any>((f, t) => supabase.from('gc_vendas').select('gc_id, valor_total, data')
          .eq('situacao_id', VENDAS_SITUACAO_CONCRETIZADA).gte('data', histStart).lte('data', histEnd)
          .order('gc_id', { ascending: true }).range(f, t) as any),
      ]);
      const mes = (d: string | null) => String(d || '').slice(0, 7);
      const mesAnterior = (m: string) => {
        const [y, mm] = m.split('-').map(Number);
        return mm === 1 ? `${y - 1}-12` : `${y}-${String(mm - 1).padStart(2, '0')}`;
      };
      const guiasPorMesRef: Record<string, number> = {};
      for (const g of dedupeBy(guias, r => String(r.id))) {
        const k = mesAnterior(mes(g.data_vencimento));
        guiasPorMesRef[k] = (guiasPorMesRef[k] || 0) + Math.abs(Number(g.valor) || 0);
      }
      const receitaPorMes: Record<string, number> = {};
      const add = (k: string, v: number) => { receitaPorMes[k] = (receitaPorMes[k] || 0) + v; };
      for (const o of dedupeBy(os, r => String(r.os_id))) add(mes(o.data_saida), Number(o.valor_total) || 0);
      for (const p of dedupeBy(pcm, r => String(r.gc_id))) add(mes(p.data_vencimento), Number(p.valor) || 0);
      for (const v of dedupeBy(vendas, r => String(r.gc_id))) add(mes(v.data), Number(v.valor_total) || 0);
      return { guiasPorMesRef, receitaPorMes };
    },
  });
  const hojeKey = hoje.toISOString().slice(0, 10);
  const aliquotaEfetiva = useMemo(() => {
    if (!historicoImpostos) return { aliquota: null as number | null, meses: [] as string[] };
    // Só entra o mês cuja guia já deveria estar toda lançada: o mês de vencimento (M+1) terminou.
    const agora = new Date(hojeKey + 'T12:00:00');
    const elegiveis: string[] = [];
    for (let mm = 1; mm < month; mm++) {
      const r = { y: year, m: mm };
      const venc = mesRef(r.y, r.m, 1);
      const fimVenc = new Date(venc.y, venc.m, 0);
      if (fimVenc < agora) elegiveis.push(`${r.y}-${String(r.m).padStart(2, '0')}`);
    }
    return computeAliquotaEfetiva(historicoImpostos.guiasPorMesRef, historicoImpostos.receitaPorMes, elegiveis);
  }, [historicoImpostos, year, month, hojeKey]);

  // ─── Outros custos: pagamentos do mês em planos fora de qualquer meta de custo ───
  const outrosCustos = useMemo(() => {
    const metasCusto = new Set(metas.filter(m => m.categoria !== 'receita').map(m => m.id));
    const planosComMeta = new Set(mapeamentos.filter(l => metasCusto.has(l.meta_id)).map(l => String(l.plano_contas_id)));
    return computeOutrosCustos(pagamentos, planosComMeta, nomesPlanos, includeCommercial);
  }, [metas, mapeamentos, pagamentos, nomesPlanos, includeCommercial]);

  const metasComResultado = useMemo((): MetaComResultado[] => {
    return metas.filter(meta => {
      // Modo "Apenas Serviços": sai receita e custo de venda de produtos (pela fonte, não pelo nome).
      if (!includeCommercial && FONTES_COMERCIAL.has(classificarMeta(meta))) return false;
      return true;
    }).map(meta => {
      const rawLinks = mapeamentos.filter(m => m.meta_id === meta.id);
      // Dedupe links por (plano_contas_id + centro_custo_id) — evita somar 2x
      // quando há mapeamentos duplicados em fin_meta_plano_contas.
      const seenLinks = new Set<string>();
      const links = rawLinks.filter(l => {
        const key = `${l.plano_contas_id}|${l.centro_custo_id ?? ''}`;
        if (seenLinks.has(key)) return false;
        seenLinks.add(key);
        return true;
      });
      // Nenhum lançamento pode ser somado 2x na mesma meta (ex.: mesmo plano
      // mapeado em 2 centros de custo — lançamentos sem centro casariam nos dois).
      const countedRecords = new Set<string>();
      let realizado = 0;
      const nome = meta.nome.toLowerCase();
      const fonte = classificarMeta(meta);

      // Comissões / Premiações (Técnicos): fonte oficial = tela de Premiação (Auvo GC Sync)
      if (fonte === 'comissoes') {
        realizado = comissoesPremiacao;
      }
      else if (fonte === 'receita_pcm') {
        realizado = gcRecPCM
          .filter(r => r.plano_contas_id === PLANO_PCM_CONTRATOS)
          .reduce((acc, r) => acc + (r.valor || 0), 0);
      }
      // Locação de Equipamentos vem do MESMO conjunto do card de contratos (recebimentos
      // liquidados no plano de locação). Antes caía no genérico (fin_recebimentos por
      // vencimento) e divergia do card por causa de outra base.
      else if (fonte === 'receita_locacao') {
        realizado = gcRecPCM
          .filter(r => r.plano_contas_id === PLANO_PCM_LOCACAO)
          .reduce((acc, r) => acc + (r.valor || 0), 0);
      }
      else if (fonte === 'receita_servicos') {
        const EXEC_SERVICO_STATUS = [
          'EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA',
          'EXECUTADO - AGUARDANDO PAGAMENTO',
          'EXECUTADO - FINANCEIRO SEPARADO',
          'EXECUTADO COM NOTA EMITIDA',
        ];
        realizado = osExecutadas
          .filter(os => EXEC_SERVICO_STATUS.includes(os.nome_situacao ?? ''))
          .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
      }
      else if (fonte === 'receita_ecolab') {
        const ECOLAB_STATUS = [
          'EXECUTADO - FECHADO CHAMADO',
          'CHAMADO FECHADO - FATURADO'
        ];
        realizado = osExecutadas
          .filter(os => ECOLAB_STATUS.includes(os.nome_situacao ?? ''))
          .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
      }
      else if (fonte === 'receita_produtos') {
        realizado = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);
      }
      else if (fonte === 'custo_venda_produtos') {
        // Custo real (valor_custo GC) das vendas de produtos concretizadas no período
        realizado = custoVendasProdutos;
      }
      else if (fonte === 'custo_pecas_operacao') {
        // Custo da operação = custo REAL das peças que saíram do estoque para OS no período
        // + custo das saídas internas (Uso Interno / Maleta) que também consomem estoque.
        // Excluímos peças de 'Ecolab / Chamados' do custo de operação/serviços.
        const ECOLAB_STATUS = [
          'EXECUTADO - FECHADO CHAMADO',
          'CHAMADO FECHADO - FATURADO'
        ];
        const custoOs = osExecutadas
          .filter(os => !ECOLAB_STATUS.includes(os.nome_situacao ?? ''))
          .reduce((acc, os) => acc + (Number(os.valor_pecas_custo) || 0), 0);
        const custoUsoInterno = vendasBalcaoRows.reduce((acc, v) => {
          return acc + (parseFloat(String(v.gc_payload_raw?.valor_custo || '0')) || 0);
        }, 0);
        realizado = custoOs + custoUsoInterno;
      }
      else {
        for (const link of links) {
          const planoUuid = link.plano_contas_id;
          const centroUuid = link.centro_custo_id || null;
          // Sempre fin_pagamentos/fin_recebimentos (contas a pagar/receber), nunca gc_* (mistura compras).
          // Impostos: guias do mês seguinte (referência = mês selecionado).
          // Planos marcados como "por competência" usam pagamentosCompetencia.
          const usaImpostoRef = meta.categoria !== 'receita' && PLANOS_IMPOSTO_IDS.has(planoUuid);
          const usaCompetencia =
            !usaImpostoRef && meta.categoria !== 'receita' && PLANOS_POR_COMPETENCIA.has(planoUuid);
          const source = meta.categoria === 'receita'
            ? recebimentos
            : (usaImpostoRef ? pagamentosImpostoRef : (usaCompetencia ? pagamentosCompetencia : pagamentos));
          const dedupPrefix = usaImpostoRef ? 'ref' : usaCompetencia ? 'comp' : 'venc';
          const soma = source
            .filter(r =>
              r.plano_contas_id === planoUuid &&
              (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid)
            )
            .filter(r => includeCommercial || meta.categoria !== 'custo_fixo' || !isLancamentoFolhaComercial(planoUuid, r as { descricao?: string | null; nome_fornecedor?: string | null }))
            .filter(r => {
              const key = `${dedupPrefix}:${r.id}`;
              if (countedRecords.has(key)) return false;
              countedRecords.add(key);
              return true;
            })
            .reduce((acc, r) => acc + Math.abs(r.valor || 0), 0);
          realizado += soma * (link.peso || 1);
        }
      }

      // Base do percentual:
      // - Comissões/Premiações: Ecolab + Execução Serviços/Coifas
      // - Custo de peças/operações: APENAS Execução + Coifas (não inclui PCM, Vendas, Ecolab)
      // - Demais: Faturamento Executado total
      const isComissao = fonte === 'comissoes';
      const isCustoVendaProdutos = fonte === 'custo_venda_produtos';
      const isCustoPecasOperacao = fonte === 'custo_pecas_operacao';

      const baseExecCoifa = osExecutadas
        .filter(os =>
          os.nome_situacao !== 'EXECUTADO - FECHADO CHAMADO' &&
          os.nome_situacao !== 'CHAMADO FECHADO - FATURADO'
        )
        .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);

      // Receita de Venda de Produtos concretizadas — base do custo de venda de produtos
      const baseVendasProdutos = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);

      const basePercentual = isComissao
        ? baseComissoes
        : isCustoVendaProdutos
          ? baseVendasProdutos
          : isCustoPecasOperacao
            ? baseExecCoifa
            : execTotal;

      // Rateio (Apenas Serviços) e pró-rata (mês corrente) — fixos e impostos.
      // Metas percentuais não recebem rateio: a base (execTotal) já encolhe no modo serviços.
      const { fatorRealizado, fatorMetaAbsoluta } = computeAjustesMeta(meta.categoria, nome, rateioFator, fracaoProrata, includeCommercial, fonte);
      realizado = realizado * fatorRealizado;

      const meta_calculada =
        meta.tipo_meta === 'absoluto'
          ? (meta.meta_valor || 0) * fatorMetaAbsoluta
          : (meta.meta_percentual || 0) * basePercentual;

      // Provisão de impostos: as guias do mês selecionado vencem no mês seguinte e só são
      // lançadas por volta do dia 20-25. Enquanto o lançado está claramente incompleto
      // (< 50% da estimativa), mostra a estimativa pela alíquota efetiva dos últimos meses
      // fechados — igual ao Raio-X; sem histórico, cai na meta %. Um mês fechado com alíquota
      // real abaixo da estimativa mantém o valor real das guias.
      const isMetaImposto = fonte === 'impostos' && meta.categoria === 'custo_variavel';
      let provisionado = false;
      if (isMetaImposto && meta.tipo_meta === 'percentual') {
        const estimativa = (aliquotaEfetiva.aliquota ?? (meta.meta_percentual || 0)) * basePercentual;
        if (realizado < estimativa * 0.5) {
          realizado = estimativa;
          provisionado = true;
        }
      }

      const delta = realizado - meta_calculada;
      const pct_faturamento = execTotal > 0 ? realizado / execTotal : 0;
      const status = calcStatus(meta.categoria, realizado, meta_calculada);
      const progresso = meta_calculada > 0
        ? Math.min(Math.round((realizado / meta_calculada) * 100), 150)
        : 0;

      return { ...meta, realizado, meta_calculada, delta, pct_faturamento, status, progresso, provisionado };
    });
  }, [metas, mapeamentos, recebimentos, pagamentos, pagamentosCompetencia, pagamentosImpostoRef, gcRecebimentos, gcRecPCM, osExecutadas, vendasConcretizadas, custoVendasProdutos, vendasBalcaoRows, comprasFinalizadas, execTotal, baseComissoes, comissoesPremiacao, planoContasMap, centrosCustoMap, includeCommercial, rateioFator, fracaoProrata, aliquotaEfetiva]);

  const hasOsData = osExecutadas.length > 0 && osExecutadas.some(os => os.data_saida);
  // Erro de leitura (ex.: statement timeout com o banco lento) NÃO é tabela vazia: a tela
  // precisa distinguir para não mandar o usuário "sincronizar" — o que só piora a carga.
  const osError = errorOS ? ((errorOS as Error).message || 'falha ao ler as OS') : null;

  // Saídas de peças para OS no período — soma o CUSTO real das peças que saíram do estoque
  // (valor_pecas_custo = quantidade × valor_custo do produto), espelhando o "Custo total"
  // do Relatório de Produtos Vendidos do GC. NÃO inclui serviços nem valor de venda.
  // Custo real das peças que saíram do estoque. Peças consignadas (100% de desconto,
  // ex.: Ecolab) são descartadas item-a-item no sync — então OS de Chamado entram aqui
  // apenas pelas peças efetivamente faturadas.
  const saidasPecasOs = useMemo(() => {
    const ECOLAB_STATUS = [
      'EXECUTADO - FECHADO CHAMADO',
      'CHAMADO FECHADO - FATURADO'
    ];
    return osExecutadas
      .filter(os => !ECOLAB_STATUS.includes(os.nome_situacao ?? ''))
      .reduce((acc, os) => acc + (Number(os.valor_pecas_custo) || 0), 0);
  }, [osExecutadas]);

  // Total de compras finalizadas no período (entrada de estoque) — informativo
  const comprasPecasTotal = useMemo(
    () => comprasFinalizadas.reduce((acc, c) => acc + (Number(c.valor_total) || 0), 0),
    [comprasFinalizadas]
  );


  const refetch = useCallback(() => {
    refetchRec(); refetchPag(); refetchPagComp(); refetchImpRef(); refetchGcRec(); refetchGcPCM(); refetchOS(); refetchVendas(); refetchCompras(); refetchPremiacao();
  }, [refetchRec, refetchPag, refetchPagComp, refetchImpRef, refetchGcRec, refetchGcPCM, refetchOS, refetchVendas, refetchCompras, refetchPremiacao]);

  const isLoading = loadingMetas || loadingMap || loadingPlanos || loadingRec || loadingPag || loadingPagComp || loadingImpRef || loadingGcRec || loadingGcPCM || loadingOS || loadingVendas || loadingCompras || loadingHist;

  return { metasComResultado, execTotal, execTotalFull, rateioFator, folhaComercialExcluida, fracaoProrata, isCurrentMonth, diasNoMes, isLoading, refetch, hasOsData, osError, aliquotaEfetiva, outrosCustos, comissoesFonte, comissoesAtualizadoEm, osExecutadas, saidasPecasOs, comprasPecasTotal, vendasBalcao, custoVendasProdutos, comissoesPremiacao, premiacaoTotais, loadingPremiacao, dataUpdatedAt: osDataUpdatedAt };
};
