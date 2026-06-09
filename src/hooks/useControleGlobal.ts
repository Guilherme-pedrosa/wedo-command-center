// src/hooks/useControleGlobal.ts
// Hook que calcula o "Controle Global" mensal (mesmos KPIs da planilha
// DASHBOARD_2025_WEDO_GC.xlsx). Mês selecionado + mês anterior para comparativo.
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';

export interface ControleGlobalKPIs {
  totalRecebido: number;
  totalFaturado: number;
  totalDespesas: number;
  margemBrutaFaturado: number;
  margemBrutaRecebido: number;
  margemPct: number; // (recebido - despesas) / recebido
  faltaReceber: number; // faturado - recebido (mês)
  aguardandoSemNf: number;
  aguardandoNegociacao: number;
  totalAReceberGeral: number;
  totalDeveriaTerRecebido: number;
  totalOsAbertas: number;
  totalOsExecutadas: number;
  // Globais (não dependem do mês)
  valorEmEstoque: number;
  emHaverSemGc: number;
}

const monthRange = (year: number, month: number) => {
  const start = new Date(year, month - 1, 1);
  const end = new Date(year, month, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    start: `${start.getFullYear()}-${pad(start.getMonth() + 1)}-${pad(start.getDate())}`,
    end: `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())}`,
  };
};

// Pagina por 1000 registros até esgotar.
async function fetchAll<T = any>(
  table: 'fin_recebimentos' | 'fin_pagamentos' | 'os_index',
  cols: string,
  build: (q: any) => any,
): Promise<T[]> {
  const PAGE = 1000;
  let out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    let q: any = (supabase as any).from(table).select(cols).range(from, from + PAGE - 1);
    q = build(q);
    const { data, error } = await q;
    if (error) throw error;
    if (!data || data.length === 0) break;
    out = out.concat(data as T[]);
    if (data.length < PAGE) break;
  }
  return out;
}

const sum = (rows: any[], key: string) =>
  rows.reduce((acc, r) => acc + (Number(r?.[key]) || 0), 0);

async function computeMonth(year: number, month: number): Promise<ControleGlobalKPIs> {
  const { start, end } = monthRange(year, month);

  // Recebimentos do mês (por vencimento) — exclui cancelados
  const recVenc = await fetchAll<any>('fin_recebimentos', 'valor,liquidado,nf_numero,data_liquidacao,status', (q) =>
    q.gte('data_vencimento', start).lte('data_vencimento', end).neq('status', 'cancelado'),
  );
  // Recebidos no mês (por liquidação)
  const recLiq = await fetchAll<any>('fin_recebimentos', 'valor,status', (q) =>
    q.eq('liquidado', true).gte('data_liquidacao', start).lte('data_liquidacao', end).neq('status', 'cancelado'),
  );
  // Pagamentos do mês (por vencimento) — exclui cancelados
  const pagVenc = await fetchAll<any>('fin_pagamentos', 'valor,status', (q) =>
    q.gte('data_vencimento', start).lte('data_vencimento', end).neq('status', 'cancelado'),
  );
  // OS do mês (data_saida)
  const osMes = await fetchAll<any>('os_index', 'valor_total,nome_situacao,data_saida', (q) =>
    q.gte('data_saida', start).lte('data_saida', end),
  );

  const totalRecebido = sum(recLiq, 'valor');
  const totalFaturado = sum(recVenc, 'valor');
  const totalDespesas = sum(pagVenc, 'valor');
  const margemBrutaFaturado = totalFaturado - totalDespesas;
  const margemBrutaRecebido = totalRecebido - totalDespesas;
  const margemPct = totalRecebido > 0 ? margemBrutaRecebido / totalRecebido : 0;
  const faltaReceber = totalFaturado - totalRecebido;

  const aguardandoSemNf = recVenc
    .filter((r) => !r.liquidado && !r.nf_numero)
    .reduce((a, r) => a + (Number(r.valor) || 0), 0);

  const totalAReceberGeral = recVenc
    .filter((r) => !r.liquidado)
    .reduce((a, r) => a + (Number(r.valor) || 0), 0);

  const totalDeveriaTerRecebido = totalRecebido + totalAReceberGeral;

  const isExec = (s: string | null) => (s || '').toUpperCase().startsWith('EXECUTADO');
  const isRejeitada = (s: string | null) =>
    (s || '').toUpperCase().includes('NÃO APROVAD') || (s || '').toUpperCase().includes('NAO APROVAD');

  const aguardandoNegociacao = osMes
    .filter((o) => (o.nome_situacao || '').toUpperCase().includes('AGUARDANDO NEGOCIA'))
    .reduce((a, o) => a + (Number(o.valor_total) || 0), 0);

  const totalOsExecutadas = osMes
    .filter((o) => isExec(o.nome_situacao))
    .reduce((a, o) => a + (Number(o.valor_total) || 0), 0);

  const totalOsAbertas = osMes
    .filter((o) => !isExec(o.nome_situacao) && !isRejeitada(o.nome_situacao))
    .reduce((a, o) => a + (Number(o.valor_total) || 0), 0);

  // Globais
  const { data: estoqueRows } = await (supabase as any)
    .from('gc_produtos_cache')
    .select('estoque,valor_custo,ativo')
    .eq('ativo', true)
    .limit(50000);
  const valorEmEstoque = (estoqueRows || []).reduce(
    (a: number, p: any) => a + (Number(p.estoque) || 0) * (Number(p.valor_custo) || 0),
    0,
  );

  const { data: residuos } = await (supabase as any)
    .from('fin_residuos_negociacao')
    .select('valor_residual,utilizado')
    .eq('utilizado', false)
    .limit(10000);
  const emHaverSemGc = (residuos || []).reduce(
    (a: number, r: any) => a + (Number(r.valor_residual) || 0),
    0,
  );

  return {
    totalRecebido,
    totalFaturado,
    totalDespesas,
    margemBrutaFaturado,
    margemBrutaRecebido,
    margemPct,
    faltaReceber,
    aguardandoSemNf,
    aguardandoNegociacao,
    totalAReceberGeral,
    totalDeveriaTerRecebido,
    totalOsAbertas,
    totalOsExecutadas,
    valorEmEstoque,
    emHaverSemGc,
  };
}

export function useControleGlobal(year: number, month: number) {
  const prevMonthDate = new Date(year, month - 2, 1);
  const prevYear = prevMonthDate.getFullYear();
  const prevMonth = prevMonthDate.getMonth() + 1;

  const curQ = useQuery({
    queryKey: ['controle-global', year, month],
    queryFn: () => computeMonth(year, month),
    staleTime: 60_000,
  });
  const prevQ = useQuery({
    queryKey: ['controle-global', prevYear, prevMonth],
    queryFn: () => computeMonth(prevYear, prevMonth),
    staleTime: 60_000,
  });

  return {
    current: curQ.data,
    previous: prevQ.data,
    isLoading: curQ.isLoading || prevQ.isLoading,
    refetch: () => {
      curQ.refetch();
      prevQ.refetch();
    },
  };
}
