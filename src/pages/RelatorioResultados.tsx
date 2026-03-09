// src/pages/RelatorioResultados.tsx — Relatório público de Resultados Operação
import { useState } from 'react';
import { useMetasResultados, formatBRL, formatPct, statusBadge, MetaComResultado } from '@/hooks/useMetasResultados';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Target, TrendingUp, TrendingDown, DollarSign, Percent, BarChart3, AlertTriangle
} from 'lucide-react';

const MetaRow = ({ m, execTotal }: { m: MetaComResultado; execTotal: number }) => {
  const badge = statusBadge(m.status);
  const isCusto = m.categoria !== 'receita';
  const isAcima = m.delta > 0;

  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg border border-border bg-card">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate text-foreground">{m.nome}</span>
          {m.tipo_meta === 'percentual' && (
            <span className="text-xs text-muted-foreground">({formatPct(m.meta_percentual || 0)} do fatur.)</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-xs font-medium ${isCusto && isAcima ? 'text-destructive' : !isCusto && !isAcima ? 'text-destructive' : 'text-muted-foreground'}`}>
            {isAcima ? `+${formatBRL(m.delta)}` : formatBRL(m.delta)}
          </span>
          <Badge variant="outline" className={`text-xs ${badge.class}`}>{badge.label}</Badge>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div><span className="block text-[10px] uppercase tracking-wide">Meta</span><span className="font-medium text-foreground">{formatBRL(m.meta_calculada)}</span></div>
        <div><span className="block text-[10px] uppercase tracking-wide">Realizado</span><span className="font-medium text-foreground">{formatBRL(m.realizado)}</span></div>
        <div><span className="block text-[10px] uppercase tracking-wide">% Fatur.</span><span className="font-medium text-foreground">{execTotal > 0 ? formatPct(m.pct_faturamento) : '—'}</span></div>
      </div>
      <Progress
        value={Math.min(m.progresso, 100)}
        className={`h-1.5 mt-1 ${m.status === 'verde' ? '[&>div]:bg-emerald-500' : m.status === 'amarelo' ? '[&>div]:bg-yellow-500' : '[&>div]:bg-red-500'}`}
      />
    </div>
  );
};

const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

export default function RelatorioResultados() {
  const now = new Date();
  const [selectedYear, setSelectedYear] = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);

  const { metasComResultado, execTotal, isLoading } = useMetasResultados(selectedYear, selectedMonth);

  const receitas = metasComResultado.filter(m => m.categoria === 'receita');
  const custosVar = metasComResultado.filter(m => m.categoria === 'custo_variavel');
  const custosFixos = metasComResultado.filter(m => m.categoria === 'custo_fixo');

  const totalMetaReceita = receitas.reduce((a, m) => a + m.meta_calculada, 0);
  const totalRealReceita = receitas.reduce((a, m) => a + m.realizado, 0);
  const totalCustos = [...custosVar, ...custosFixos].reduce((a, m) => a + m.realizado, 0);
  const margemLiquida = execTotal > 0 ? (execTotal - totalCustos) / execTotal : 0;
  const totalAlertas = metasComResultado.filter(m => m.status !== 'verde').length;
  const margemColor = margemLiquida >= 0.30 ? 'text-emerald-600' : margemLiquida >= 0.15 ? 'text-yellow-600' : 'text-destructive';

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="max-w-5xl mx-auto p-6 space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-4 print:gap-2">
          <div>
            <h1 className="text-2xl font-bold flex items-center gap-2">
              <Target className="h-6 w-6 text-primary" />
              Resultados Operação — {meses[selectedMonth - 1]} {selectedYear}
            </h1>
            <p className="text-muted-foreground text-sm mt-1">Relatório de acompanhamento de metas</p>
          </div>
          <div className="flex items-center gap-2 print:hidden">
            <Select value={String(selectedMonth)} onValueChange={v => setSelectedMonth(Number(v))}>
              <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
              <SelectContent>{meses.map((m, i) => <SelectItem key={i+1} value={String(i+1)}>{m}</SelectItem>)}</SelectContent>
            </Select>
            <Select value={String(selectedYear)} onValueChange={v => setSelectedYear(Number(v))}>
              <SelectTrigger className="w-24"><SelectValue /></SelectTrigger>
              <SelectContent>{[2025, 2026, 2027].map(a => <SelectItem key={a} value={String(a)}>{a}</SelectItem>)}</SelectContent>
            </Select>
          </div>
        </div>

        {isLoading ? (
          <p className="text-muted-foreground text-center py-12">Carregando dados…</p>
        ) : (
          <>
            {/* Summary cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><DollarSign className="h-3.5 w-3.5" />Faturamento Executado</div>
                <div className="text-xl font-bold">{formatBRL(execTotal)}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Meta: {formatBRL(totalMetaReceita)}</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><Percent className="h-3.5 w-3.5" />Margem Líquida</div>
                <div className={`text-xl font-bold ${margemColor}`}>{formatPct(margemLiquida)}</div>
                <div className="text-xs text-muted-foreground mt-0.5">Meta: ≥ 30%</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><BarChart3 className="h-3.5 w-3.5" />Total Custos</div>
                <div className="text-xl font-bold">{formatBRL(totalCustos)}</div>
                <div className="text-xs text-muted-foreground mt-0.5">{execTotal > 0 ? formatPct(totalCustos / execTotal) : '—'} do fatur.</div>
              </CardContent></Card>
              <Card><CardContent className="pt-4">
                <div className="flex items-center gap-2 text-muted-foreground text-xs mb-1"><AlertTriangle className="h-3.5 w-3.5 text-yellow-500" />Alertas</div>
                <div className={`text-xl font-bold ${totalAlertas > 0 ? 'text-destructive' : 'text-emerald-600'}`}>{totalAlertas}</div>
                <div className="text-xs text-muted-foreground mt-0.5">de {metasComResultado.length} indicadores</div>
              </CardContent></Card>
            </div>

            {/* Receitas */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2">
                <TrendingUp className="h-4 w-4 text-emerald-500" /> Receitas
                <Badge variant="outline" className="text-xs ml-auto">{formatBRL(totalRealReceita)} / {formatBRL(totalMetaReceita)}</Badge>
              </CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {receitas.map(m => <MetaRow key={m.id} m={m} execTotal={execTotal} />)}
              </CardContent>
            </Card>

            {/* Custos Variáveis */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2">
                <Percent className="h-4 w-4 text-blue-500" /> Custos Variáveis
                <Badge variant="outline" className="text-xs ml-auto">{formatBRL(custosVar.reduce((a, m) => a + m.realizado, 0))}</Badge>
              </CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {custosVar.map(m => <MetaRow key={m.id} m={m} execTotal={execTotal} />)}
              </CardContent>
            </Card>

            {/* Custos Fixos */}
            <Card>
              <CardHeader className="pb-3"><CardTitle className="text-base flex items-center gap-2">
                <TrendingDown className="h-4 w-4 text-red-400" /> Custos Fixos
                <Badge variant="outline" className="text-xs ml-auto">{formatBRL(custosFixos.reduce((a, m) => a + m.realizado, 0))}</Badge>
              </CardTitle></CardHeader>
              <CardContent className="flex flex-col gap-2">
                {custosFixos.map(m => <MetaRow key={m.id} m={m} execTotal={execTotal} />)}
              </CardContent>
            </Card>

            {/* Resultado */}
            <Card className={`border-2 ${margemLiquida >= 0.30 ? 'border-emerald-400' : margemLiquida >= 0.15 ? 'border-yellow-400' : 'border-red-400'}`}>
              <CardContent className="pt-4 flex flex-col md:flex-row items-center justify-between gap-4">
                <div><p className="text-sm text-muted-foreground">Resultado</p><p className="text-2xl font-bold">{formatBRL(execTotal - totalCustos)}</p></div>
                <div className="text-center"><p className="text-sm text-muted-foreground">Margem Líquida</p><p className={`text-3xl font-bold ${margemColor}`}>{formatPct(margemLiquida)}</p></div>
                <div className="text-right"><p className="text-sm text-muted-foreground">Faturamento</p><p className="text-2xl font-bold">{formatBRL(execTotal)}</p></div>
              </CardContent>
            </Card>
          </>
        )}

        <p className="text-center text-xs text-muted-foreground py-4">
          WeDo Hub • Gerado em {new Date().toLocaleString('pt-BR')}
        </p>
      </div>
    </div>
  );
}
