// src/hooks/useMetasResultados.ts
// Shared hook & utilities for Resultados Operação
import { useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

// ─── TIPOS ─────────────────────────────────────────────────────────────────
export interface Meta {
  id: string;
  nome: string;
  categoria: 'receita' | 'custo_variavel' | 'custo_fixo';
  tipo_meta: 'absoluto' | 'percentual';
  meta_valor: number | null;
  meta_percentual: number | null;
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
}

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

// Auvo typeId → plano gc_id mapping
const AUVO_SOURCE_MAP: Record<string, number[]> = {
  '27867667': [48782],
  '27912040': [48784],
};

// Planos apurados por competência (ver comentário no hook).
export const PLANOS_POR_COMPETENCIA_IDS = new Set([
  'e7299b90-98d2-4d7a-a04c-78ba40cc847a', // COMISSÕES E BONIFICAÇÕES
  '367198e3-1eee-46b5-8d4a-af208852198e', // Impostos - importação IPI
  '1726df3a-f803-4f28-b7ee-1930f94b569f', // Impostos - PIS
  'e37b446f-e96f-4fe0-ab52-cfbaeb2e7c7c', // Impostos - COFINS
  '3692812b-86d8-4ec7-be51-542af1424d2d', // Impostos - ICMS
  '8f50518c-131e-4b4c-a8ca-a9fd3f5bea88', // Impostos - ISS
  'df1e63ee-92db-4046-887a-9f4cbd5d4115', // Impostos - Simples Nacional
  '2e311d38-f51c-40d9-baa8-ecdf3080c99d', // ISSQN Prest.Serv.Próprio
]);

// No modo "Apenas Serviços", fixos e impostos entram só na proporção dos serviços na
// receita total do mês — o restante pertence à operação comercial (vendas).
export const computeRateioFator = (execServicos: number, execTotalFull: number, includeCommercial: boolean) =>
  includeCommercial ? 1 : execTotalFull > 0 ? execServicos / execTotalFull : 1;

// Fatores aplicados a cada meta: rateio (fixos e impostos, modo Apenas Serviços) e
// pró-rata dos fixos pelos dias corridos (mês corrente, quando ligado).
export const computeAjustesMeta = (
  categoria: Meta['categoria'],
  nome: string,
  rateioFator: number,
  fracaoProrata: number,
) => {
  const isImposto = categoria === 'custo_variavel' && nome.toLowerCase().includes('impost');
  const rateia = categoria === 'custo_fixo' || isImposto;
  const prorata = categoria === 'custo_fixo' ? fracaoProrata : 1;
  return {
    fatorRealizado: (rateia ? rateioFator : 1) * prorata,
    fatorMetaAbsoluta: categoria === 'custo_fixo' ? rateioFator * prorata : 1,
  };
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

  const { data: planoContasMap = {}, isLoading: loadingPlanos } = useQuery({
    queryKey: ['fin_plano_contas_gc_map'],
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_plano_contas').select('id, gc_id');
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const row of data || []) {
        if (row.gc_id) map[row.gc_id] = row.id;
      }
      return map;
    },
    staleTime: 10 * 60 * 1000,
  });

  const uuidToGcId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const [gcId, uuid] of Object.entries(planoContasMap)) {
      map[uuid] = gcId;
    }
    return map;
  }, [planoContasMap]);

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
      const { data, error } = await supabase
        .from('fin_recebimentos')
        .select('plano_contas_id, centro_custo_id, valor, status')
        .neq('status', 'cancelado')
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null }[];
    },
  });

  const { data: pagamentos = [], isLoading: loadingPag, refetch: refetchPag } = useQuery({
    queryKey: ['fin_pagamentos_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_pagamentos')
        .select('plano_contas_id, centro_custo_id, valor, status, data_liquidacao')
        .neq('status', 'cancelado')
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null; data_liquidacao: string | null }[];
    },
  });

  // Pagamentos filtrados por DATA DE COMPETÊNCIA (para Comissões/Premiações e Despesas com Veículos).
  // Esses custos devem refletir o mês de competência, não o vencimento.
  const { data: pagamentosCompetencia = [], isLoading: loadingPagComp, refetch: refetchPagComp } = useQuery({
    queryKey: ['fin_pagamentos_metas_competencia', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_pagamentos')
        .select('plano_contas_id, centro_custo_id, valor, status')
        .neq('status', 'cancelado')
        .gte('data_competencia', start)
        .lte('data_competencia', end);
      if (error) throw error;
      return data as { plano_contas_id: string; centro_custo_id: string | null; valor: number; status: string | null }[];
    },
  });

  // Plano de contas (UUIDs) que devem ser apurados por COMPETÊNCIA em vez de vencimento.
  // - COMISSÕES E BONIFICAÇÕES (28054594) → Comissões e Premiações (Técnicos)
  // - Impostos: competem ao mês do fato gerador (faturamento). Por vencimento, o imposto
  //   de um mês forte vence no mês seguinte e come a margem do mês errado. Obs.: o DAS/PIS/
  //   COFINS do mês fechado só é lançado por volta do dia 20-25 seguinte — até lá o mês
  //   recém-fechado mostra imposto parcial.
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

  const { data: osExecutadas = [], isLoading: loadingOS, refetch: refetchOS, dataUpdatedAt: osDataUpdatedAt } = useQuery({
    queryKey: ['os_executadas_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('os_index')
        .select('os_id, os_codigo, nome_cliente, nome_situacao, nome_vendedor, valor_total, valor_pecas, valor_pecas_custo, data_saida, data_execucao_real')
        .in('nome_situacao', OS_EXECUTADOS_STATUS)
        .gte('data_saida', start)
        .lte('data_saida', end);
      if (error) throw error;
      const rows = (data ?? []) as { os_id: string; os_codigo: string; nome_cliente: string | null; nome_situacao: string | null; nome_vendedor: string | null; valor_total: number | null; valor_pecas: number | null; valor_pecas_custo: number | null; data_saida: string | null; data_execucao_real: string | null }[];
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
      const { data, error } = await supabase
        .from('gc_vendas')
        .select('gc_id, codigo, nome_cliente, nome_situacao, situacao_id, valor_total, valor_produtos, data, gc_payload_raw')
        .eq('situacao_id', VENDAS_SITUACAO_CONCRETIZADA)
        .gte('data', start)
        .lte('data', end);
      if (error) throw error;
      return data as { gc_id: string; codigo: string; nome_cliente: string | null; nome_situacao: string | null; situacao_id: string | null; valor_total: number | null; valor_produtos: number | null; data: string | null; gc_payload_raw: any }[];
    },
  });

  // Custo de Peças: apenas as duas situações confirmadas pelo usuário —
  // 1675070 (Finalizado - mercadoria chegou) e 1675083 (COMPRADO - AG CHEGADA).
  // NÃO inclui "COMPRADO - AG CHEGADA PARA ESTOQUE" nem outras variantes.
  const COMPRAS_CUSTO_SITUACAO_IDS = ['1675070', '1675083'];
  const { data: comprasFinalizadas = [], isLoading: loadingCompras, refetch: refetchCompras } = useQuery({
    queryKey: ['gc_compras_metas', start, end],
    queryFn: async () => {
      const { data: byData, error: err1 } = await supabase
        .from('gc_compras' as any)
        .select('gc_id, codigo, nome_fornecedor, nome_situacao, situacao_id, valor_total, data, cadastrado_em')
        .in('situacao_id', COMPRAS_CUSTO_SITUACAO_IDS)
        .gte('data', start)
        .lte('data', end);
      if (!err1 && byData && byData.length > 0) return byData as any[];
      const { data: byCad, error: err2 } = await supabase
        .from('gc_compras' as any)
        .select('gc_id, codigo, nome_fornecedor, nome_situacao, situacao_id, valor_total, data, cadastrado_em')
        .in('situacao_id', COMPRAS_CUSTO_SITUACAO_IDS)
        .gte('cadastrado_em', start)
        .lte('cadastrado_em', end + 'T23:59:59');
      if (err2) throw err2;
      return (byCad as any[]) ?? [];
    },
  });


  const { data: auvoExpenses = [], isLoading: loadingAuvo, refetch: refetchAuvo } = useQuery({
    queryKey: ['auvo_expenses_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('auvo_expenses_sync' as any)
        .select('type_id, amount, expense_date')
        .gte('expense_date', start)
        .lte('expense_date', end);
      if (error) throw error;
      return (data as any[]) as { type_id: number; amount: number; expense_date: string }[];
    },
  });

  // gc_recebimentos filtrado por competência (para categorias gerais)
  const { data: gcRecebimentos = [], isLoading: loadingGcRec, refetch: refetchGcRec } = useQuery({
    queryKey: ['gc_recebimentos_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gc_recebimentos')
        .select('gc_id, gc_codigo, descricao, valor, plano_contas_id, centro_custo_id, data_vencimento, liquidado')
        .gte('data_competencia', start)
        .lte('data_competencia', end);
      if (error) throw error;
      return data as { gc_id: string; gc_codigo: string; descricao: string | null; valor: number; plano_contas_id: string | null; centro_custo_id: string | null; data_vencimento: string | null; liquidado: boolean }[];
    },
  });

  // Contratos PCM: APENAS Confirmado / Confirmado Manual (liquidado=true).
  // Atrasado/Em Aberto NÃO entra (cliente pode cancelar antes de pagar).
  const PCM_PLANO_IDS = ['27867721', '27867722'];
  const { data: gcRecPCM = [], isLoading: loadingGcPCM, refetch: refetchGcPCM } = useQuery({
    queryKey: ['gc_recebimentos_pcm', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gc_recebimentos')
        .select('gc_id, gc_codigo, descricao, valor, plano_contas_id, centro_custo_id, data_vencimento, liquidado')
        .in('plano_contas_id', PCM_PLANO_IDS)
        .eq('liquidado', true)
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { gc_id: string; gc_codigo: string; descricao: string | null; valor: number; plano_contas_id: string | null; centro_custo_id: string | null; data_vencimento: string | null; liquidado: boolean }[];
    },
  });

  // Faturamento Executado = OS Execução+Coifa + PCM Confirmado + (opcional) Venda de Produtos
  // FECHADO CHAMADO (Ecolab/Chamados) NÃO entra na execução de serviço — é base só de comissão.
  const { execTotal, execTotalFull, rateioFator } = useMemo(() => {
    const osTotal = osExecutadas
      .filter(os =>
        os.nome_situacao !== 'EXECUTADO - FECHADO CHAMADO' &&
        os.nome_situacao !== 'CHAMADO FECHADO - FATURADO'
      )
      .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
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
      const { data, error } = await supabase
        .from('gc_vendas')
        .select('gc_id, valor_produtos, gc_payload_raw, data, situacao_id')
        .in('situacao_id', VENDAS_BALCAO_SITUACAO_IDS)
        .gte('data', start)
        .lte('data', end);
      if (error) throw error;
      return (data ?? []) as { valor_produtos: number | null; gc_payload_raw: any }[];
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
  // (comissao_final = bruto − reduções + bônus de meta/telemetria).
  const { data: premiacaoTotais, isLoading: loadingPremiacao, refetch: refetchPremiacao } = useQuery({
    queryKey: ['premiacao_comissoes_total', year, month],
    queryFn: async () => {
      const monthStr = `${year}-${String(month).padStart(2, '0')}`;
      const { data, error } = await supabase.functions.invoke('premiacao-comissoes-total', {
        body: { month: monthStr },
      });
      if (error) throw error;
      if (data?.ok === false) throw new Error(data.error || 'Falha ao buscar premiações');
      return data as { comissao_total: number; comissao_final: number; faturamento_premiacao: number };
    },
    staleTime: 10 * 60 * 1000,
  });
  const comissoesPremiacao = Number(premiacaoTotais?.comissao_final) || 0;

  // Custo de Venda de Produtos (concretizadas que entraram no faturamento)
  const custoVendasProdutos = useMemo(() => {
    return vendasConcretizadas.reduce((acc, v) => {
      const custoVenda = parseFloat(String(v.gc_payload_raw?.valor_custo || '0')) || 0;
      return acc + custoVenda;
    }, 0);
  }, [vendasConcretizadas]);

  const metasComResultado = useMemo((): MetaComResultado[] => {
    return metas.filter(meta => {
      if (!includeCommercial) {
        const nome = meta.nome.toLowerCase();
        // Ignora meta de custo de venda de produtos se comercial estiver desativado
        if (meta.categoria === 'custo_variavel' && nome.includes('venda') && nome.includes('produto')) return false;
        // Ignora meta de receita de venda de produtos se comercial estiver desativado
        if (meta.categoria === 'receita' && (nome.includes('venda') || nome.includes('produto'))) return false;
      }
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
      // Auvo não vem segmentado por centro de custo no cálculo das metas.
      // Se o mesmo plano Auvo estiver mapeado em 2 centros, soma o tipo Auvo apenas 1x.
      const seenAuvoSources = new Set<string>();
      let realizado = 0;
      const nome = meta.nome.toLowerCase();

      // Comissões / Premiações (Técnicos): fonte oficial = tela de Premiação (Auvo GC Sync)
      if (meta.categoria !== 'receita' && (nome.includes('comiss') || nome.includes('premia'))) {
        realizado = comissoesPremiacao;
      }
      else if (meta.categoria === 'receita' && (nome.includes('contrato') || nome.includes('pcm'))) {
        realizado = gcRecPCM
          .filter(r => r.plano_contas_id === '27867721')
          .reduce((acc, r) => acc + (r.valor || 0), 0);
      }
      else if (meta.categoria === 'receita' && (nome.includes('at') || nome.includes('coifa') || nome.includes('higienização'))) {
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
      else if (meta.categoria === 'receita' && (nome.includes('ecolab') || nome.includes('chamado'))) {
        const ECOLAB_STATUS = [
          'EXECUTADO - FECHADO CHAMADO',
          'CHAMADO FECHADO - FATURADO'
        ];
        realizado = osExecutadas
          .filter(os => ECOLAB_STATUS.includes(os.nome_situacao ?? ''))
          .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
      }
      else if (meta.categoria === 'receita' && (nome.includes('venda') || nome.includes('produto') || nome.includes('peça'))) {
        realizado = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);
      }
      else if (meta.categoria === 'custo_variavel' && nome.includes('venda') && nome.includes('produto')) {
        // Custo real (valor_custo GC) das vendas de produtos concretizadas no período
        realizado = custoVendasProdutos;
      }
      else if (meta.categoria === 'custo_variavel' && (nome.includes('peça') || nome.includes('estoque'))) {
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
          const gcId = uuidToGcId[planoUuid];
          const auvoTypeIds = gcId ? AUVO_SOURCE_MAP[gcId] : undefined;

          if (auvoTypeIds) {
            const auvoKey = `${gcId}:${auvoTypeIds.join(',')}`;
            if (seenAuvoSources.has(auvoKey)) continue;
            seenAuvoSources.add(auvoKey);

            const auvoSum = auvoExpenses
              .filter(e => auvoTypeIds.includes(e.type_id))
              .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);
            realizado += auvoSum * (link.peso || 1);
          } else {
            // Always use fin_pagamentos/fin_recebimentos (contas a pagar/receber)
            // instead of gc_pagamentos/gc_recebimentos to avoid mixing with compras.
            // Para planos marcados como "por competência", usa pagamentosCompetencia.
            const usaCompetencia =
              meta.categoria !== 'receita' && PLANOS_POR_COMPETENCIA.has(planoUuid);
            const source = meta.categoria === 'receita'
              ? recebimentos
              : (usaCompetencia ? pagamentosCompetencia : pagamentos);
            const soma = source
              .filter(r =>
                r.plano_contas_id === planoUuid &&
                (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid)
              )
              .reduce((acc, r) => acc + Math.abs(r.valor || 0), 0);
            realizado += soma * (link.peso || 1);
          }
        }
      }

      // Base do percentual:
      // - Comissões/Premiações: Ecolab + Execução Serviços/Coifas
      // - Custo de peças/operações: APENAS Execução + Coifas (não inclui PCM, Vendas, Ecolab)
      // - Demais: Faturamento Executado total
      const isComissao = nome.includes('comiss') || nome.includes('premia');
      const isCustoVendaProdutos =
        meta.categoria === 'custo_variavel' && nome.includes('venda') && nome.includes('produto');
      const isCustoPecasOperacao =
        !isCustoVendaProdutos &&
        meta.categoria === 'custo_variavel' &&
        (nome.includes('peça') || nome.includes('peca') || nome.includes('operaç') || nome.includes('operac') || nome.includes('estoque'));

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
      const { fatorRealizado, fatorMetaAbsoluta } = computeAjustesMeta(meta.categoria, nome, rateioFator, fracaoProrata);
      realizado = realizado * fatorRealizado;

      const meta_calculada =
        meta.tipo_meta === 'absoluto'
          ? (meta.meta_valor || 0) * fatorMetaAbsoluta
          : (meta.meta_percentual || 0) * basePercentual;

      const delta = realizado - meta_calculada;
      const pct_faturamento = execTotal > 0 ? realizado / execTotal : 0;
      const status = calcStatus(meta.categoria, realizado, meta_calculada);
      const progresso = meta_calculada > 0
        ? Math.min(Math.round((realizado / meta_calculada) * 100), 150)
        : 0;

      return { ...meta, realizado, meta_calculada, delta, pct_faturamento, status, progresso };
    });
  }, [metas, mapeamentos, recebimentos, pagamentos, pagamentosCompetencia, gcRecebimentos, gcRecPCM, osExecutadas, vendasConcretizadas, custoVendasProdutos, vendasBalcaoRows, comprasFinalizadas, auvoExpenses, execTotal, baseComissoes, comissoesPremiacao, planoContasMap, uuidToGcId, centrosCustoMap, includeCommercial, rateioFator, fracaoProrata]);

  const hasOsData = osExecutadas.length > 0 && osExecutadas.some(os => os.data_saida);

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
    refetchRec(); refetchPag(); refetchPagComp(); refetchGcRec(); refetchGcPCM(); refetchOS(); refetchVendas(); refetchCompras(); refetchAuvo(); refetchPremiacao();
  }, [refetchRec, refetchPag, refetchPagComp, refetchGcRec, refetchGcPCM, refetchOS, refetchVendas, refetchCompras, refetchAuvo, refetchPremiacao]);

  const isLoading = loadingMetas || loadingMap || loadingPlanos || loadingRec || loadingPag || loadingPagComp || loadingGcRec || loadingGcPCM || loadingOS || loadingVendas || loadingCompras || loadingAuvo;

  return { metasComResultado, execTotal, execTotalFull, rateioFator, fracaoProrata, isCurrentMonth, diasNoMes, isLoading, refetch, hasOsData, osExecutadas, saidasPecasOs, comprasPecasTotal, vendasBalcao, custoVendasProdutos, comissoesPremiacao, premiacaoTotais, loadingPremiacao, dataUpdatedAt: osDataUpdatedAt };
};
