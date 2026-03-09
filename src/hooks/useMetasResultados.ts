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
  '28160784': [49032],
  '28223100': [49032],
};

// ─── HOOK ──────────────────────────────────────────────────────────────────
export const useMetasResultados = (year: number, month: number) => {
  const { start, end } = getPeriodRange(year, month);

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

  const OS_EXECUTADOS_STATUS = [
    'EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA',
    'EXECUTADO - AGUARDANDO PAGAMENTO',
    'EXECUTADO COM NOTA EMITIDA',
    'EXECUTADO - FINANCEIRO SEPARADO',
    'EXECUTADO - CIGAM',
    'EXECUTADO POR CONTRATO',
    'EXECUTADO - FECHADO CHAMADO',
  ];

  const { data: osExecutadas = [], isLoading: loadingOS, refetch: refetchOS } = useQuery({
    queryKey: ['os_executadas_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('os_index')
        .select('os_id, os_codigo, nome_cliente, nome_situacao, valor_total, data_saida')
        .in('nome_situacao', OS_EXECUTADOS_STATUS)
        .gte('data_saida', start)
        .lte('data_saida', end);
      if (error) throw error;
      return data as { os_id: string; os_codigo: string; nome_cliente: string | null; nome_situacao: string | null; valor_total: number | null; data_saida: string | null }[];
    },
  });

  const { data: vendasConcretizadas = [], isLoading: loadingVendas, refetch: refetchVendas } = useQuery({
    queryKey: ['gc_vendas_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gc_vendas')
        .select('gc_id, codigo, nome_cliente, nome_situacao, valor_total, data')
        .gte('data', start)
        .lte('data', end);
      if (error) throw error;
      return data as { gc_id: string; codigo: string; nome_cliente: string | null; nome_situacao: string | null; valor_total: number | null; data: string | null }[];
    },
  });

  const { data: comprasFinalizadas = [], isLoading: loadingCompras, refetch: refetchCompras } = useQuery({
    queryKey: ['gc_compras_metas', start, end],
    queryFn: async () => {
      const { data: byData, error: err1 } = await supabase
        .from('gc_compras' as any)
        .select('gc_id, codigo, nome_fornecedor, nome_situacao, valor_total, data, cadastrado_em')
        .or('nome_situacao.ilike.%finalizado%mercadoria chegou%,nome_situacao.ilike.%comprado%ag chegada%')
        .gte('data', start)
        .lte('data', end);
      if (!err1 && byData && byData.length > 0) return byData as any[];
      const { data: byCad, error: err2 } = await supabase
        .from('gc_compras' as any)
        .select('gc_id, codigo, nome_fornecedor, nome_situacao, valor_total, data, cadastrado_em')
        .or('nome_situacao.ilike.%finalizado%mercadoria chegou%,nome_situacao.ilike.%comprado%ag chegada%')
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

  const { data: gcRecebimentos = [], isLoading: loadingGcRec, refetch: refetchGcRec } = useQuery({
    queryKey: ['gc_recebimentos_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gc_recebimentos')
        .select('gc_id, gc_codigo, descricao, valor, plano_contas_id, centro_custo_id, data_vencimento, liquidado')
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { gc_id: string; gc_codigo: string; descricao: string | null; valor: number; plano_contas_id: string | null; centro_custo_id: string | null; data_vencimento: string | null; liquidado: boolean }[];
    },
  });

  const { data: gcPagamentos = [], isLoading: loadingGcPag, refetch: refetchGcPag } = useQuery({
    queryKey: ['gc_pagamentos_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('gc_pagamentos')
        .select('gc_id, gc_codigo, descricao, valor, plano_contas_id, centro_custo_id, data_vencimento, liquidado')
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { gc_id: string; gc_codigo: string; descricao: string | null; valor: number; plano_contas_id: string | null; centro_custo_id: string | null; data_vencimento: string | null; liquidado: boolean }[];
    },
  });

  const execTotal = useMemo(() => {
    const receitaFinanceiraGcIds = ['27867721', '27867722'];
    const osTotal = osExecutadas.reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
    const vendasTotal = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);
    const recFinanceiro = gcRecebimentos
      .filter(r => r.plano_contas_id && receitaFinanceiraGcIds.includes(r.plano_contas_id))
      .reduce((acc, r) => acc + (r.valor || 0), 0);
    return osTotal + vendasTotal + recFinanceiro;
  }, [gcRecebimentos, osExecutadas, vendasConcretizadas]);

  const metasComResultado = useMemo((): MetaComResultado[] => {
    return metas.map(meta => {
      const links = mapeamentos.filter(m => m.meta_id === meta.id);
      let realizado = 0;
      const nome = meta.nome.toLowerCase();

      if (meta.categoria === 'receita' && (nome.includes('contrato') || nome.includes('pcm'))) {
        realizado = gcRecebimentos
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
        if (realizado === 0 && osExecutadas.length === 0) {
          for (const link of links) {
            const planoUuid = link.plano_contas_id;
            const centroUuid = link.centro_custo_id || null;
            const soma = recebimentos
              .filter(r => r.plano_contas_id === planoUuid && (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid))
              .reduce((acc, r) => acc + (r.valor || 0), 0);
            realizado += soma * (link.peso || 1);
          }
        }
      }
      else if (meta.categoria === 'receita' && (nome.includes('ecolab') || nome.includes('chamado'))) {
        realizado = osExecutadas
          .filter(os => os.nome_situacao === 'EXECUTADO - FECHADO CHAMADO')
          .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
        if (realizado === 0 && osExecutadas.length === 0) {
          for (const link of links) {
            const planoUuid = link.plano_contas_id;
            const centroUuid = link.centro_custo_id || null;
            const soma = recebimentos
              .filter(r => r.plano_contas_id === planoUuid && (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid))
              .reduce((acc, r) => acc + (r.valor || 0), 0);
            realizado += soma * (link.peso || 1);
          }
        }
      }
      else if (meta.categoria === 'receita' && (nome.includes('venda') || nome.includes('produto') || nome.includes('peça'))) {
        realizado = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);
      }
      else if (meta.categoria === 'custo_variavel' && (nome.includes('peça') || nome.includes('estoque'))) {
        realizado = comprasFinalizadas.reduce((acc, c) => acc + (c.valor_total ?? 0), 0);
        if (realizado === 0 && comprasFinalizadas.length === 0) {
          for (const link of links) {
            const gcId = uuidToGcId[link.plano_contas_id];
            if (gcId) {
              const soma = gcPagamentos
                .filter(r => r.plano_contas_id === gcId &&
                  (link.centro_custo_id === null || !r.centro_custo_id || r.centro_custo_id === link.centro_custo_id))
                .reduce((acc, r) => acc + Math.abs(r.valor || 0), 0);
              realizado += soma * (link.peso || 1);
            }
          }
        }
      }
      else {
        for (const link of links) {
          const planoUuid = link.plano_contas_id;
          const centroUuid = link.centro_custo_id || null;
          const gcId = uuidToGcId[planoUuid];
          const auvoTypeIds = gcId ? AUVO_SOURCE_MAP[gcId] : undefined;

          if (auvoTypeIds && auvoExpenses.length > 0) {
            const auvoSum = auvoExpenses
              .filter(e => auvoTypeIds.includes(e.type_id))
              .reduce((acc, e) => acc + (Number(e.amount) || 0), 0);
            realizado += auvoSum * (link.peso || 1);
          } else if (gcId) {
            const centroCodigo = centroUuid ? centrosCustoMap[centroUuid] : null;
            const source = meta.categoria === 'receita' ? gcRecebimentos : gcPagamentos;
            const soma = source
              .filter(r =>
                r.plano_contas_id === gcId &&
                (centroCodigo === null || centroCodigo === undefined || !r.centro_custo_id || r.centro_custo_id === centroCodigo)
              )
              .reduce((acc, r) => acc + Math.abs(r.valor || 0), 0);
            realizado += soma * (link.peso || 1);
          } else {
            const source = meta.categoria === 'receita' ? recebimentos : pagamentos;
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

      const meta_calculada =
        meta.tipo_meta === 'absoluto'
          ? (meta.meta_valor || 0)
          : (meta.meta_percentual || 0) * execTotal;

      const delta = realizado - meta_calculada;
      const pct_faturamento = execTotal > 0 ? realizado / execTotal : 0;
      const status = calcStatus(meta.categoria, realizado, meta_calculada);
      const progresso = meta_calculada > 0
        ? Math.min(Math.round((realizado / meta_calculada) * 100), 150)
        : 0;

      return { ...meta, realizado, meta_calculada, delta, pct_faturamento, status, progresso };
    });
  }, [metas, mapeamentos, recebimentos, pagamentos, gcRecebimentos, gcPagamentos, osExecutadas, vendasConcretizadas, comprasFinalizadas, auvoExpenses, execTotal, planoContasMap, uuidToGcId, centrosCustoMap]);

  const hasOsData = osExecutadas.length > 0 && osExecutadas.some(os => os.data_saida);

  const refetch = useCallback(() => {
    refetchRec(); refetchPag(); refetchGcRec(); refetchGcPag(); refetchOS(); refetchVendas(); refetchCompras(); refetchAuvo();
  }, [refetchRec, refetchPag, refetchGcRec, refetchGcPag, refetchOS, refetchVendas, refetchCompras, refetchAuvo]);

  const isLoading = loadingMetas || loadingMap || loadingPlanos || loadingRec || loadingPag || loadingGcRec || loadingGcPag || loadingOS || loadingVendas || loadingCompras || loadingAuvo;

  return { metasComResultado, execTotal, isLoading, refetch, hasOsData };
};
