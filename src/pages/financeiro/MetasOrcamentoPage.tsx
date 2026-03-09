// src/pages/financeiro/MetasOrcamentoPage.tsx
import { useState, useCallback } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  Target, TrendingUp, TrendingDown, AlertTriangle,
  RefreshCw, DollarSign, Percent, BarChart3, Loader2, Settings
} from 'lucide-react';
import { syncVendas, syncCompras, syncAuvoExpenses, syncOS, syncRecebimentos, syncPagamentos } from '@/api/syncService';
import toast from 'react-hot-toast';
import MetasConfigDialog from '@/components/financeiro/MetasConfigDialog';
import {
  useMetasResultados, formatBRL, formatPct, statusBadge,
  getPeriodRange, MetaComResultado
} from '@/hooks/useMetasResultados';

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

  const { metasComResultado, execTotal, isLoading, refetch, hasOsData } = useMetasResultados(selectedYear, selectedMonth);

  const [configOpen, setConfigOpen] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    const { start, end } = getPeriodRange(selectedYear, selectedMonth);
    let ok = 0;
    let fail = 0;
    const details: string[] = [];

    try {
      await syncOS();
      ok++;
    } catch (_e) { fail++; }

    try {
      const resVendas = await syncVendas(start, end);
      ok += resVendas.upserted;
    } catch (_e) { fail++; }

    try {
      const resCompras = await syncCompras(start, end);
      ok += resCompras.upserted;
    } catch (_e) { fail++; }

    try {
      const resAuvo = await syncAuvoExpenses(selectedMonth, selectedYear);
      ok += resAuvo.synced;
      const bt = resAuvo.by_type;
      if (bt['48782']) details.push(`Combustível R$ ${(bt['48782'].total || 0).toFixed(2)}`);
      if (bt['48784']) details.push(`Hospedagem R$ ${(bt['48784'].total || 0).toFixed(2)}`);
      if (bt['49032']) details.push(`Pedágio R$ ${(bt['49032'].total || 0).toFixed(2)}`);
    } catch (_e) { fail++; }

    // Sync GC Recebimentos + Pagamentos (with date filter for selected period)
    const dateFilter = { dataInicio: start, dataFim: end };
    try {
      const resRec = await syncRecebimentos(undefined, dateFilter);
      ok += resRec.importados;
    } catch (_e) { fail++; }

    try {
      const resPag = await syncPagamentos(undefined, dateFilter);
      ok += resPag.importados;
    } catch (_e) { fail++; }

    if (fail === 0) {
      const auvoInfo = details.length > 0 ? ` | Auvo: ${details.join(', ')}` : '';
      toast.success(`Tudo sincronizado: ${ok} registros${auvoInfo}`);
    } else {
      toast.error(`Sincronização parcial: ${ok} registros ok, ${fail} erros`);
    }
    refetch();
    setSyncingAll(false);
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

          <Button variant="outline" size="sm" onClick={() => setConfigOpen(true)}>
            <Settings className="h-4 w-4 mr-1" /> Configurar
          </Button>

          <Button variant="default" size="sm" onClick={handleSyncAll} disabled={syncingAll}>
            {syncingAll ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
            Sincronizar Tudo
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
      <MetasConfigDialog open={configOpen} onOpenChange={setConfigOpen} />
    </div>
  );
}
