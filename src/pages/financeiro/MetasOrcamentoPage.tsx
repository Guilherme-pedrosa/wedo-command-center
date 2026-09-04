// src/pages/financeiro/MetasOrcamentoPage.tsx – refactored to use shared hook
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
import { supabase } from '@/integrations/supabase/client';
import toast from 'react-hot-toast';
import MetasConfigDialog from '@/components/financeiro/MetasConfigDialog';
import AnaliseIAMetas from '@/components/financeiro/AnaliseIAMetas';
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

// Linha informativa (não é meta): total de compras de peças finalizadas no período
// (entrada de estoque). Não é custo da operação — apenas referência de reposição.
const SaidasOsRow = ({ valor, execTotal }: { valor: number; execTotal: number }) => {
  const pct = execTotal > 0 ? valor / execTotal : 0;
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg border border-dashed border-blue-300 bg-blue-50/40 dark:bg-blue-950/20">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate text-foreground">
            Custo com Peças (compras finalizadas no período)
          </span>
          <span className="text-xs text-muted-foreground">informativo · entrada de estoque</span>
        </div>
        <Badge variant="outline" className="text-xs bg-blue-100 text-blue-800 border-blue-200">
          REFERÊNCIA
        </Badge>
      </div>
      <div className="grid grid-cols-3 gap-2 text-xs text-muted-foreground">
        <div>
          <span className="block text-[10px] uppercase tracking-wide">Origem</span>
          <span className="font-medium text-foreground">Compras finalizadas · valor total</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wide">Total</span>
          <span className="font-medium text-foreground">{formatBRL(valor)}</span>
        </div>

        <div>
          <span className="block text-[10px] uppercase tracking-wide">% Fatur.</span>
          <span className="font-medium text-foreground">
            {execTotal > 0 ? formatPct(pct) : '—'}
          </span>
        </div>
      </div>
    </div>
  );
};

// Linha informativa: vendas de balcão (gc_vendas concretizadas) — faturamento, custo
// real (qtd × valor_custo) e margem bruta.
const VendasBalcaoRow = ({ faturamento, custo }: { faturamento: number; custo: number }) => {
  return (
    <div className="flex flex-col gap-1 p-3 rounded-lg border border-dashed border-purple-300 bg-purple-50/40 dark:bg-purple-950/20">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-sm truncate text-foreground">
            Uso Interno / Maleta — Custo de Produtos
          </span>
          <span className="text-xs text-muted-foreground">somado ao custo de Peças/Estoque</span>
        </div>
        <Badge variant="outline" className="text-xs bg-purple-100 text-purple-800 border-purple-200">
          ENTRA NO RESULTADO
        </Badge>
      </div>
      <div className="grid grid-cols-2 gap-2 text-xs text-muted-foreground">
        <div>
          <span className="block text-[10px] uppercase tracking-wide">Origem</span>
          <span className="font-medium text-foreground">Vendas · situação "Uso Interno / Maleta"</span>
        </div>
        <div>
          <span className="block text-[10px] uppercase tracking-wide">Custo Real</span>
          <span className="font-medium text-foreground">{formatBRL(custo)}</span>
        </div>
      </div>
    </div>
  );
};



// ─── COMPONENTE PRINCIPAL ───────────────────────────────────────────────────
export default function MetasOrcamentoPage() {
  const now = new Date();
  const [selectedYear, setSelectedYear]   = useState(now.getFullYear());
  const [selectedMonth, setSelectedMonth] = useState(now.getMonth() + 1);
  const [includeCommercial, setIncludeCommercial] = useState(true);
  const [prorataFixos, setProrataFixos] = useState(true);

  const { metasComResultado, execTotal, rateioFator, folhaComercialExcluida, isCurrentMonth, diasNoMes, isLoading, refetch, hasOsData, osError, saidasPecasOs, comprasPecasTotal, vendasBalcao } = useMetasResultados(selectedYear, selectedMonth, includeCommercial, prorataFixos);

  const [configOpen, setConfigOpen] = useState(false);
  const [syncingAll, setSyncingAll] = useState(false);
  const handleSyncAll = useCallback(async () => {
    setSyncingAll(true);
    const { start, end } = getPeriodRange(selectedYear, selectedMonth);

    try {
      const { data, error } = await supabase.functions.invoke('sync-all', {
        body: {
          data_inicio: start,
          data_fim: end,
        },
      });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);
      if (data?.skipped) throw new Error(data.reason || 'Sincronização ignorada');

      const runId: string | undefined = data?.run_id;
      if (!runId) throw new Error('Sincronização não retornou identificador de execução');

      toast(`Sincronização ${start}→${end} iniciada — aguardando conclusão...`);

      // Polling do resultado (a sync roda em background para não estourar timeout)
      const deadline = Date.now() + 10 * 60 * 1000;
      let finalRow: any = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5000));
        const { data: row } = await supabase
          .from('fin_sync_log')
          .select('status, erro, resposta')
          .eq('id', runId)
          .maybeSingle();
        if (row && row.status !== 'running') { finalRow = row; break; }
      }

      if (!finalRow) {
        toast('Sincronização ainda em andamento — os dados serão atualizados em instantes.');
      } else if (finalRow.status === 'erro') {
        throw new Error(finalRow.erro || 'Erro na sincronização');
      } else {
        const res: any = finalRow.resposta || {};
        const recOrphans = Number(res?.recebimentos?.cancelled_orphans || 0);
        const pagOrphans = Number(res?.pagamentos?.cancelled_orphans || 0);
        if (finalRow.status === 'partial') {
          toast(`Sincronizado com avisos: ${finalRow.erro ?? ''}`);
        } else {
          toast.success(`Sincronizado ${start}→${end} · removidos ${recOrphans + pagOrphans} órfãos`);
        }
      }
    } catch (e: any) {
      toast.error(e.message || 'Erro ao sincronizar período');
    } finally {
      refetch();
      setSyncingAll(false);
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
          <div className="flex bg-muted p-1 rounded-md mr-2">
            <Button
              variant={includeCommercial ? "default" : "ghost"}
              size="sm"
              className="h-8 text-xs px-3"
              onClick={() => setIncludeCommercial(true)}
            >
              Comercial + Serviços
            </Button>
            <Button
              variant={!includeCommercial ? "default" : "ghost"}
              size="sm"
              className="h-8 text-xs px-3"
              onClick={() => setIncludeCommercial(false)}
            >
              Apenas Serviços
            </Button>
          </div>

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


      {osError && (
        <div className="rounded-md bg-red-500/10 border border-red-500/30 p-3 text-sm text-red-700 dark:text-red-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Não consegui ler as OS do período: <strong>{osError}</strong>. O banco respondeu devagar —
            clique em recarregar. Não é falta de dados e não precisa sincronizar.
          </span>
        </div>
      )}

      {!osError && !hasOsData && (
        <div className="rounded-md bg-yellow-500/10 border border-yellow-500/30 p-3 text-sm text-yellow-700 dark:text-yellow-400 flex items-center gap-2">
          <AlertTriangle className="h-4 w-4 shrink-0" />
          <span>
            Tabela de OS ainda não possui dados de <strong>data_saida</strong> e <strong>valor_total</strong>.
            Execute o sync do GestãoClick para popular os campos.
            Até lá, AT+Coifa e Ecolab usam fin_recebimentos como fallback.
          </span>
        </div>
      )}

      {isCurrentMonth && (
        <div className="rounded-md bg-blue-500/10 border border-blue-500/30 p-3 text-sm text-blue-700 dark:text-blue-400 flex items-center justify-between gap-3 flex-wrap">
          <span className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>
              Mês em andamento (dia {now.getDate()} de {diasNoMes}): a receita é parcial e os custos do mês
              inteiro já estão lançados por vencimento.{' '}
              {prorataFixos
                ? 'Custos fixos e suas metas estão pró-rata pelos dias corridos.'
                : 'Sem pró-rata, a margem só é comparável no fechamento do mês.'}
            </span>
          </span>
          <Button variant="outline" size="sm" className="h-7 text-xs shrink-0" onClick={() => setProrataFixos(v => !v)}>
            Fixos pró-rata: {prorataFixos ? 'ligado' : 'desligado'}
          </Button>
        </div>
      )}

      {!includeCommercial && (
        <div className="rounded-md bg-muted/60 border border-border p-3 text-xs text-muted-foreground">
          Modo Apenas Serviços: custos fixos 100% nos serviços (existiriam com ou sem o comercial). O comercial
          carrega os salários do time de vendas ({formatBRL(folhaComercialExcluida)} excluídos da Folha ADM),
          20% do pró-labore, impostos proporcionais ({formatPct(rateioFator)} ficam nos serviços) e o custo
          cheio dos produtos vendidos.
        </div>
      )}

      {metasComResultado.some(m => m.provisionado) && (
        <div className="rounded-md bg-muted/60 border border-border p-3 text-xs text-muted-foreground">
          Impostos exibidos por provisão (meta % sobre a receita): as guias referentes a este mês vencem no mês
          seguinte e ainda não foram todas lançadas. O valor real substitui a provisão quando as guias entram.
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

      {/* PAINEL ANÁLISE IA */}
      <AnaliseIAMetas
        ano={selectedYear}
        mes={selectedMonth}
        execTotal={execTotal}
        margemLiquida={margemLiquida}
        totalCustos={totalCustos}
        metas={metasComResultado}
      />

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
            : custosVar.flatMap(m => {
                const n = (m.nome || '').toLowerCase();
                const isPecas = n.includes('peça') || n.includes('peca') || n.includes('operaç') || n.includes('operac') || n.includes('estoque');
                const row = <MetaRow key={m.id} m={m} execTotal={execTotal} />;

                if (isPecas) {
                  return [
                    row,
                    <SaidasOsRow key={`${m.id}-compras-info`} valor={comprasPecasTotal} execTotal={execTotal} />,
                    <VendasBalcaoRow key={`${m.id}-balcao`} faturamento={vendasBalcao.faturamento} custo={vendasBalcao.custo} />
                  ];
                }

                return [row];
              })
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
