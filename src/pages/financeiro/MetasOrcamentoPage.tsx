// src/pages/financeiro/MetasOrcamentoPage.tsx
import { useState, useMemo, useCallback } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Target, TrendingUp, TrendingDown, AlertTriangle,
  RefreshCw, DollarSign, Percent, BarChart3, ShoppingCart, Loader2
} from 'lucide-react';
import { syncVendas, syncCompras } from '@/api/syncService';
import toast from 'react-hot-toast';

// ─── TIPOS ─────────────────────────────────────────────────────────────────
interface Meta {
  id: string;
  nome: string;
  categoria: 'receita' | 'custo_variavel' | 'custo_fixo';
  tipo_meta: 'absoluto' | 'percentual';
  meta_valor: number | null;
  meta_percentual: number | null;
}

interface MetaPlanoContas {
  meta_id: string;
  plano_contas_id: string;
  centro_custo_id: string | null;
  peso: number;
}

interface MetaComResultado extends Meta {
  realizado: number;
  meta_calculada: number;
  delta: number;
  pct_faturamento: number;
  status: 'verde' | 'amarelo' | 'vermelho';
  progresso: number;
}

// ─── UTILITÁRIOS ────────────────────────────────────────────────────────────
const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

const formatPct = (v: number) => `${(v * 100).toFixed(1)}%`;

const getPeriodRange = (year: number, month: number) => {
  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;
  return { start, end };
};

const calcStatus = (
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
    // custo_fixo e custo_variavel — menor = melhor
    if (ratio <= 1) return 'verde';
    if (ratio <= 1.15) return 'amarelo';
    return 'vermelho';
  }
};

const statusBadge = (status: 'verde' | 'amarelo' | 'vermelho') => {
  const map = {
    verde:    { label: 'OK',       class: 'bg-emerald-100 text-emerald-800 border-emerald-200' },
    amarelo:  { label: 'ATENÇÃO',  class: 'bg-yellow-100 text-yellow-800 border-yellow-200' },
    vermelho: { label: 'ALERTA',   class: 'bg-red-100 text-red-800 border-red-200' },
  };
  return map[status];
};

// ─── HOOK DE DADOS ──────────────────────────────────────────────────────────
const useMetas = (year: number, month: number) => {
  const { start, end } = getPeriodRange(year, month);

  // 1. Busca metas e mapeamentos
  const { data: metas = [], isLoading: loadingMetas } = useQuery({
    queryKey: ['fin_metas'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_metas')
        .select('*')
        .eq('ativo', true);
      if (error) throw error;
      return data as Meta[];
    },
    staleTime: 5 * 60 * 1000,
  });

  const { data: mapeamentos = [], isLoading: loadingMap } = useQuery({
    queryKey: ['fin_meta_plano_contas'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_meta_plano_contas')
        .select('*');
      if (error) throw error;
      return data as MetaPlanoContas[];
    },
    staleTime: 5 * 60 * 1000,
  });

  // 1b. Busca mapas de tradução GC_ID → UUID
  const { data: planoContasMap = {}, isLoading: loadingPlanos } = useQuery({
    queryKey: ['fin_plano_contas_gc_map'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_plano_contas')
        .select('id, gc_id');
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const row of data || []) {
        if (row.gc_id) map[row.gc_id] = row.id;
      }
      return map;
    },
    staleTime: 10 * 60 * 1000,
  });

  const { data: centrosCustoMap = {}, isLoading: loadingCentros } = useQuery({
    queryKey: ['fin_centros_custo_gc_map'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_centros_custo')
        .select('id, codigo');
      if (error) throw error;
      const map: Record<string, string> = {};
      for (const row of data || []) {
        if (row.codigo) map[row.codigo] = row.id;
      }
      return map;
    },
    staleTime: 10 * 60 * 1000,
  });

  // 2. Busca recebimentos do período (liquidados OU pago_sistema)
  const { data: recebimentos = [], isLoading: loadingRec, refetch: refetchRec } = useQuery({
    queryKey: ['fin_recebimentos_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_recebimentos')
        .select('plano_contas_id, centro_custo_id, valor')
        .or('liquidado.eq.true,and(pago_sistema.eq.true,status.eq.pago)')
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { plano_contas_id: string; centro_custo_id: string | null; valor: number }[];
    },
  });

  // 3. Busca pagamentos do período (liquidados OU pago_sistema)
  const { data: pagamentos = [], isLoading: loadingPag, refetch: refetchPag } = useQuery({
    queryKey: ['fin_pagamentos_metas', start, end],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_pagamentos')
        .select('plano_contas_id, centro_custo_id, valor')
        .or('liquidado.eq.true,and(pago_sistema.eq.true,status.eq.pago)')
        .gte('data_vencimento', start)
        .lte('data_vencimento', end);
      if (error) throw error;
      return data as { plano_contas_id: string; centro_custo_id: string | null; valor: number }[];
    },
  });

  // 3b. Busca OS executadas do período (para AT+Coifa, Ecolab e Contratos)
  const OS_EXECUTADOS_STATUS = [
    'EXECUTADO - AGUARDANDO NEGOCIAÇÃO FINANCEIRA',
    'EXECUTADO - AGUARDANDO PAGAMENTO',
    'EXECUTADO COM NOTA EMITIDA',
    'EXECUTADO - FINANCEIRO SEPARADO',
    'EXECUTADO - CIGAM',
    'EXECUTADO POR CONTRATO',
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

  // 3c. Busca vendas concretizadas do período (para Venda de Produtos / Peças)
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

  // 4. Calcula EXEC_TOTAL — OS (AT+Ecolab) + receitas financeiras (PCM, Locação, etc.) + vendas
  const execTotal = useMemo(() => {
    // GC IDs dos planos de receita cobertos por OS (AT+Coifa, Ecolab, Contratos)
    const receitaGcIds_OS = ['27867720', '27867721']; // Execução de Serviços Aprovados + Contratos de serviços
    // GC IDs cobertos por gc_vendas (Venda de Produtos/Peças)
    const receitaGcIds_Vendas = ['27867722']; // Venda de Produtos
    const receitaUuids_OS = receitaGcIds_OS
      .map(gcId => planoContasMap[gcId])
      .filter(Boolean);
    const receitaUuids_Vendas = receitaGcIds_Vendas
      .map(gcId => planoContasMap[gcId])
      .filter(Boolean);

    // Todos os planos de receita (para fallback total)
    const receitaGcIds = ['27867720', '27867721', '27867722', '27867718', '27867719'];
    const receitaUuids = receitaGcIds
      .map(gcId => planoContasMap[gcId])
      .filter(Boolean);

    // Total de OS executadas (substitui AT+Coifa e Ecolab de fin_recebimentos)
    const osTotal = osExecutadas.reduce((acc, os) => acc + (os.valor_total ?? 0), 0);

    // Total de vendas concretizadas (substitui Venda Produtos de fin_recebimentos)
    const vendasTotal = vendasConcretizadas.reduce((acc, v) => acc + (v.valor_total ?? 0), 0);

    // Receitas financeiras excluindo planos cobertos por OS e vendas
    const excludedUuids = [...receitaUuids_OS, ...receitaUuids_Vendas];
    const recFinanceiro = recebimentos
      .filter(r => r.plano_contas_id && receitaUuids.includes(r.plano_contas_id) && !excludedUuids.includes(r.plano_contas_id))
      .reduce((acc, r) => acc + (r.valor || 0), 0);

    // Combinar: OS + vendas + receitas financeiras restantes
    const hasExternalData = osExecutadas.length > 0 || vendasConcretizadas.length > 0;
    if (hasExternalData) {
      return osTotal + vendasTotal + recFinanceiro;
    }

    // Fallback: tudo de fin_recebimentos
    return recebimentos
      .filter(r => r.plano_contas_id && receitaUuids.includes(r.plano_contas_id))
      .reduce((acc, r) => acc + (r.valor || 0), 0);
  }, [recebimentos, planoContasMap, osExecutadas, vendasConcretizadas]);

  // 5. Calcula realizado por meta
  const metasComResultado = useMemo((): MetaComResultado[] => {
    return metas.map(meta => {
      const links = mapeamentos.filter(m => m.meta_id === meta.id);
      let realizado = 0;
      const nome = meta.nome.toLowerCase();

      // AT + Coifa: OS executadas exceto Ecolab/Tenda e exceto Contratos
      if (meta.categoria === 'receita' && (nome.includes('at') || nome.includes('coifa') || nome.includes('higienização'))) {
        realizado = osExecutadas
          .filter(os => {
            const cliente = (os.nome_cliente ?? '').toLowerCase();
            const sit = os.nome_situacao ?? '';
            return sit !== 'EXECUTADO POR CONTRATO' &&
              !cliente.includes('ecolab') && !cliente.includes('tenda');
          })
          .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
        
        // Fallback to fin_recebimentos if no OS data
        if (realizado === 0 && osExecutadas.length === 0) {
          for (const link of links) {
            const planoUuid = planoContasMap[link.plano_contas_id];
            const centroUuid = link.centro_custo_id ? centrosCustoMap[link.centro_custo_id] : null;
            if (!planoUuid) continue;
            const soma = recebimentos
              .filter(r => r.plano_contas_id === planoUuid && (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid))
              .reduce((acc, r) => acc + (r.valor || 0), 0);
            realizado += soma * (link.peso || 1);
          }
        }
      }
      // Ecolab / Chamados: OS executadas de Ecolab ou Tenda (exceto Contratos)
      else if (meta.categoria === 'receita' && (nome.includes('ecolab') || nome.includes('chamado'))) {
        realizado = osExecutadas
          .filter(os => {
            const cliente = (os.nome_cliente ?? '').toLowerCase();
            const sit = os.nome_situacao ?? '';
            return sit !== 'EXECUTADO POR CONTRATO' &&
              (cliente.includes('ecolab') || cliente.includes('tenda'));
          })
          .reduce((acc, os) => acc + (os.valor_total ?? 0), 0);
        
        // Fallback to fin_recebimentos if no OS data
        if (realizado === 0 && osExecutadas.length === 0) {
          for (const link of links) {
            const planoUuid = planoContasMap[link.plano_contas_id];
            const centroUuid = link.centro_custo_id ? centrosCustoMap[link.centro_custo_id] : null;
            if (!planoUuid) continue;
            const soma = recebimentos
              .filter(r => r.plano_contas_id === planoUuid && (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid))
              .reduce((acc, r) => acc + (r.valor || 0), 0);
            realizado += soma * (link.peso || 1);
          }
        }
      }
      // Contratos PCM: busca direto de fin_recebimentos pelo plano "Contratos de serviços" (gc_id: 27867721)
      else if (meta.categoria === 'receita' && (nome.includes('contrato') || nome.includes('pcm'))) {
        const contratosUuid = planoContasMap['27867721'];
        if (contratosUuid) {
          realizado = recebimentos
            .filter(r => r.plano_contas_id === contratosUuid)
            .reduce((acc, r) => acc + (r.valor || 0), 0);
        }
      }
      // Venda de Produtos / Peças: busca de gc_vendas (Concretizado + Venda Futura)
      else if (meta.categoria === 'receita' && (nome.includes('venda') || nome.includes('produto') || nome.includes('peça'))) {
        realizado = vendasConcretizadas
          .reduce((acc, v) => acc + (v.valor_total ?? 0), 0);
      }
      // All other metas: use fin_recebimentos or fin_pagamentos
      else {
        for (const link of links) {
          const planoUuid = planoContasMap[link.plano_contas_id];
          const centroUuid = link.centro_custo_id ? centrosCustoMap[link.centro_custo_id] : null;
          if (!planoUuid) continue;
          const source = meta.categoria === 'receita' ? recebimentos : pagamentos;
          const soma = source
            .filter(r =>
              r.plano_contas_id === planoUuid &&
              (centroUuid === null || !r.centro_custo_id || r.centro_custo_id === centroUuid)
            )
            .reduce((acc, r) => acc + (r.valor || 0), 0);
          realizado += soma * (link.peso || 1);
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
  }, [metas, mapeamentos, recebimentos, pagamentos, osExecutadas, vendasConcretizadas, execTotal, planoContasMap, centrosCustoMap]);

  const hasOsData = osExecutadas.length > 0 && osExecutadas.some(os => os.data_saida);

  const refetch = () => { refetchRec(); refetchPag(); refetchOS(); refetchVendas(); };
  const isLoading = loadingMetas || loadingMap || loadingPlanos || loadingCentros || loadingRec || loadingPag || loadingOS || loadingVendas;

  return { metasComResultado, execTotal, isLoading, refetch, hasOsData };
};

// ─── COMPONENTE ROW ──────────────────────────────────────────────────────────
const MetaRow = ({ m, execTotal }: { m: MetaComResultado; execTotal: number }) => {
  const badge = statusBadge(m.status);
  const isCusto = m.categoria !== 'receita';
  const isAcima = m.delta > 0;

  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg border border-border bg-card hover:bg-accent/30 transition-colors">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate text-foreground">{m.nome}</span>
          {m.tipo_meta === 'percentual' && (
            <span className="text-xs text-muted-foreground">
              ({formatPct(m.meta_percentual || 0)} do fatur.)
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-medium ${isCusto && isAcima ? 'text-destructive' : !isCusto && !isAcima ? 'text-destructive' : 'text-muted-foreground'}`}>
            {isCusto
              ? (isAcima ? `+${formatBRL(m.delta)}` : formatBRL(m.delta))
              : (isAcima ? `+${formatBRL(m.delta)}` : formatBRL(m.delta))
            }
          </span>
          <Badge variant="outline" className={`text-xs ${badge.class}`}>
            {badge.label}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div>
          <span className="block text-[10px] uppercase tracking-wide">Meta</span>
          <span className="font-medium text-foreground">{formatBRL(m.meta_calculada)}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wide">Realizado</span>
          <span className="font-medium text-foreground">{formatBRL(m.realizado)}</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wide">% Fatur.</span>
          <span className="font-medium text-foreground">
            {execTotal > 0 ? formatPct(m.pct_faturamento) : '—'}
          </span>
        </div>
      </div>

      <Progress
        value={Math.min(m.progresso, 100)}
        className={`h-1.5 mt-1 ${
          m.status === 'verde' ? '[&>div]:bg-emerald-500' :
          m.status === 'amarelo' ? '[&>div]:bg-yellow-500' :
          '[&>div]:bg-red-500'
        }`}
      />
    </div>
  );
};

// ─── COMPONENTE PRINCIPAL ───────────────────────────────────────────────────
export default function MetasOrcamentoPage() {
  const now = new Date();
  const [selectedYear, setSelectedYear]   = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);

  const { metasComResultado, execTotal, isLoading, refetch, hasOsData } = useMetas(selectedYear, selectedMonth);

  const [syncingVendas, setSyncingVendas] = useState(false);
  const handleSyncVendas = useCallback(async () => {
    setSyncingVendas(true);
    try {
      const { start, end } = getPeriodRange(selectedYear, selectedMonth);
      const result = await syncVendas(start, end);
      toast.success(`Vendas sincronizadas: ${result.upserted} registros`);
      refetch();
    } catch (err: any) {
      toast.error(`Erro ao sincronizar vendas: ${err.message}`);
    } finally {
      setSyncingVendas(false);
    }
  }, [selectedYear, selectedMonth, refetch]);

  const receitas       = metasComResultado.filter(m => m.categoria === 'receita');
  const custosVar      = metasComResultado.filter(m => m.categoria === 'custo_variavel');
  const custosFixos    = metasComResultado.filter(m => m.categoria === 'custo_fixo');

  const totalMetaReceita  = receitas.reduce((a, m) => a + m.meta_calculada, 0);
  const totalRealReceita  = receitas.reduce((a, m) => a + m.realizado, 0);
  const totalCustos       = [...custosVar, ...custosFixos].reduce((a, m) => a + m.realizado, 0);
  const margemLiquida     = execTotal > 0 ? (execTotal - totalCustos) / execTotal : 0;
  const totalAlertas      = metasComResultado.filter(m => m.status !== 'verde').length;

  const margemColor =
    margemLiquida >= 0.30 ? 'text-emerald-600' :
    margemLiquida >= 0.15 ? 'text-yellow-600' : 'text-destructive';

  const meses = [
    'Janeiro','Fevereiro','Março','Abril','Maio','Junho',
    'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'
  ];
  const anos = [2025, 2026, 2027];

  return (
    <div className="flex flex-col gap-6 p-6">
      {/* HEADER */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2 text-foreground">
            <Target className="h-6 w-6 text-primary" />
            Metas & Orçamento
          </h1>
          <p className="text-muted-foreground text-sm mt-1">
            Acompanhamento em tempo real vs. metas orçadas
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Select
            value={String(selectedMonth)}
            onValueChange={v => setSelectedMonth(Number(v))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {meses.map((m, i) => (
                <SelectItem key={i + 1} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={String(selectedYear)}
            onValueChange={v => setSelectedYear(Number(v))}
          >
            <SelectTrigger className="w-24">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {anos.map(a => (
                <SelectItem key={a} value={String(a)}>{a}</SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Button variant="outline" size="sm" onClick={handleSyncVendas} disabled={syncingVendas}>
            {syncingVendas ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ShoppingCart className="h-4 w-4 mr-1" />}
            Sync Vendas
          </Button>

          <Button variant="outline" size="icon" onClick={refetch} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          </Button>
        </div>
      </div>

      {!hasOsData && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3 text-sm text-yellow-700 dark:text-yellow-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Tabela de OS ainda não possui dados de <strong>data_saida</strong> e <strong>valor_total</strong>.
            Execute o sync do GestãoClick para popular os campos.
            Até lá, AT+Coifa e Ecolab usam fin_recebimentos como fallback.
          </span>
        </div>
      )}

      {/* CARDS RESUMO */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <DollarSign className="h-3.5 w-3.5" />
              Faturamento Executado
            </div>
            <div className="text-xl font-bold text-foreground">{formatBRL(execTotal)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              Meta: {formatBRL(totalMetaReceita)}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <Percent className="h-3.5 w-3.5" />
              Margem Líquida
            </div>
            <div className={`text-xl font-bold ${margemColor}`}>
              {formatPct(margemLiquida)}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">Meta: ≥ 30%</div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <BarChart3 className="h-3.5 w-3.5" />
              Total Custos Realizados
            </div>
            <div className="text-xl font-bold text-foreground">{formatBRL(totalCustos)}</div>
            <div className="text-xs text-muted-foreground mt-0.5">
              {execTotal > 0 ? formatPct(totalCustos / execTotal) : '—'} do fatur.
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="pt-4">
            <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1">
              <AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />
              Alertas Ativos
            </div>
            <div className={`text-xl font-bold ${totalAlertas > 0 ? 'text-destructive' : 'text-emerald-600'}`}>
              {totalAlertas}
            </div>
            <div className="text-xs text-muted-foreground mt-0.5">
              de {metasComResultado.length} indicadores
            </div>
          </CardContent>
        </Card>
      </div>

      {/* SEÇÃO RECEITAS */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingUp className="h-4 w-4 text-emerald-500" />
            Receitas
            <Badge variant="outline" className="text-xs ml-auto">
              {formatBRL(totalRealReceita)} / {formatBRL(totalMetaReceita)}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {isLoading
            ? <p className="text-sm text-muted-foreground">Carregando...</p>
            : receitas.length === 0
            ? <p className="text-sm text-muted-foreground">Nenhuma meta de receita cadastrada.</p>
            : receitas.map(m => <MetaRow key={m.id} m={m} execTotal={execTotal} />)
          }
        </CardContent>
      </Card>

      {/* SEÇÃO CUSTOS VARIÁVEIS */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Percent className="h-4 w-4 text-blue-500" />
            Custos Variáveis
            <span className="text-xs text-muted-foreground font-normal">(% sobre faturamento executado)</span>
            <Badge variant="outline" className="text-xs ml-auto">
              {formatBRL(custosVar.reduce((a, m) => a + m.realizado, 0))}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {isLoading
            ? <p className="text-sm text-muted-foreground">Carregando...</p>
            : custosVar.length === 0
            ? <p className="text-sm text-muted-foreground">Nenhuma meta de custo variável cadastrada.</p>
            : custosVar.map(m => <MetaRow key={m.id} m={m} execTotal={execTotal} />)
          }
        </CardContent>
      </Card>

      {/* SEÇÃO CUSTOS FIXOS */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <TrendingDown className="h-4 w-4 text-red-400" />
            Custos Fixos
            <span className="text-xs text-muted-foreground font-normal">(R$ absoluto mensal)</span>
            <Badge variant="outline" className="text-xs ml-auto">
              {formatBRL(custosFixos.reduce((a, m) => a + m.realizado, 0))}
            </Badge>
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2">
          {isLoading
            ? <p className="text-sm text-muted-foreground">Carregando...</p>
            : custosFixos.length === 0
            ? <p className="text-sm text-muted-foreground">Nenhuma meta de custo fixo cadastrada.</p>
            : custosFixos.map(m => <MetaRow key={m.id} m={m} execTotal={execTotal} />)
          }
        </CardContent>
      </Card>

      {/* RODAPÉ MARGEM */}
      <Card className={`border-2 ${
        margemLiquida >= 0.30 ? 'border-emerald-400' :
        margemLiquida >= 0.15 ? 'border-yellow-400' : 'border-red-400'
      }`}>
        <CardContent className="pt-4 flex flex-col md:flex-row items-center justify-between gap-4">
          <div>
            <p className="text-sm text-muted-foreground">Resultado do Período</p>
            <p className="text-2xl font-bold text-foreground">
              {formatBRL(execTotal - totalCustos)}
            </p>
          </div>
          <div className="text-center">
            <p className="text-sm text-muted-foreground">Margem Líquida</p>
            <p className={`text-3xl font-bold ${margemColor}`}>
              {formatPct(margemLiquida)}
            </p>
            <p className="text-xs text-muted-foreground">Meta: ≥ 30%</p>
          </div>
          <div className="text-right">
            <p className="text-sm text-muted-foreground">Faturamento Executado</p>
            <p className="text-2xl font-bold text-foreground">{formatBRL(execTotal)}</p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
