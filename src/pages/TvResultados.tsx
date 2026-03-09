// src/pages/TvResultados.tsx — TV Summary: resumo por categoria
import { useEffect, useMemo } from 'react';
import { useMetasResultados, formatBRL, formatPct, calcStatus } from '@/hooks/useMetasResultados';
import { CheckCircle, XCircle, AlertTriangle, TrendingUp, TrendingDown, Percent, DollarSign, Trophy, Medal } from 'lucide-react';

const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

type CatStatus = 'verde' | 'amarelo' | 'vermelho';

const StatusIcon = ({ status, size = 'h-10 w-10' }: { status: CatStatus; size?: string }) => {
  if (status === 'verde') return <CheckCircle className={`${size} text-emerald-400`} />;
  if (status === 'amarelo') return <AlertTriangle className={`${size} text-yellow-400`} />;
  return <XCircle className={`${size} text-red-400`} />;
};

const statusBorder = (s: CatStatus) =>
  s === 'verde' ? 'border-emerald-500/40' : s === 'amarelo' ? 'border-yellow-500/40' : 'border-red-500/40';

const statusBg = (s: CatStatus) =>
  s === 'verde' ? 'bg-emerald-500/10' : s === 'amarelo' ? 'bg-yellow-500/10' : 'bg-red-500/10';

const statusLabel = (s: CatStatus) =>
  s === 'verde' ? 'DENTRO DA META' : s === 'amarelo' ? 'ATENÇÃO' : 'FORA DA META';

const statusLabelColor = (s: CatStatus) =>
  s === 'verde' ? 'text-emerald-400' : s === 'amarelo' ? 'text-yellow-400' : 'text-red-400';

export default function TvResultados() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { metasComResultado, execTotal, isLoading, refetch, osExecutadas } = useMetasResultados(year, month);

  // Top 3 vendedores by faturamento (only chamados + executados)
  const top3Vendedores = useMemo(() => {
    const vendedorMap: Record<string, number> = {};
    for (const os of osExecutadas) {
      const nome = os.nome_vendedor?.trim();
      if (!nome) continue;
      vendedorMap[nome] = (vendedorMap[nome] || 0) + (os.valor_total ?? 0);
    }
    return Object.entries(vendedorMap)
      .map(([nome, total]) => ({ nome, total }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 3);
  }, [osExecutadas]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => refetch(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refetch]);

  // Aggregate by category
  const receitas = metasComResultado.filter(m => m.categoria === 'receita');
  const custosVar = metasComResultado.filter(m => m.categoria === 'custo_variavel');
  const custosFixos = metasComResultado.filter(m => m.categoria === 'custo_fixo');

  const aggregate = (items: typeof receitas) => {
    const meta = items.reduce((a, m) => a + m.meta_calculada, 0);
    const realizado = items.reduce((a, m) => a + m.realizado, 0);
    const alertas = items.filter(m => m.status !== 'verde').length;
    const total = items.length;
    return { meta, realizado, alertas, total };
  };

  const recAgg = aggregate(receitas);
  const cvAgg = aggregate(custosVar);
  const cfAgg = aggregate(custosFixos);

  const totalCustos = cvAgg.realizado + cfAgg.realizado;
  const resultado = execTotal - totalCustos;
  const margemLiquida = execTotal > 0 ? resultado / execTotal : 0;

  const recStatus = calcStatus('receita', recAgg.realizado, recAgg.meta);
  const cvStatus = calcStatus('custo_variavel', cvAgg.realizado, cvAgg.meta);
  const cfStatus = calcStatus('custo_fixo', cfAgg.realizado, cfAgg.meta);
  const margemStatus: CatStatus = margemLiquida >= 0.30 ? 'verde' : margemLiquida >= 0.15 ? 'amarelo' : 'vermelho';

  const totalOk = metasComResultado.filter(m => m.status === 'verde').length;
  const totalAlerta = metasComResultado.filter(m => m.status !== 'verde').length;

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-3xl text-muted-foreground animate-pulse">Carregando dados…</p>
      </div>
    );
  }

  const categories = [
    { label: 'Receitas', icon: <TrendingUp className="h-8 w-8 text-emerald-400" />, agg: recAgg, status: recStatus, isCost: false },
    { label: 'Custos Variáveis', icon: <Percent className="h-8 w-8 text-blue-400" />, agg: cvAgg, status: cvStatus, isCost: true },
    { label: 'Custos Fixos', icon: <TrendingDown className="h-8 w-8 text-red-400" />, agg: cfAgg, status: cfStatus, isCost: true },
  ];

  return (
    <div className="min-h-screen bg-background text-foreground p-8 flex flex-col gap-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-black tracking-tight">Resultados Operação</h1>
          <p className="text-xl text-muted-foreground mt-1">{meses[month - 1]} {year}</p>
        </div>
        <div className="flex items-center gap-8">
          <div className="flex items-center gap-3">
            <CheckCircle className="h-8 w-8 text-emerald-400" />
            <span className="text-3xl font-bold text-emerald-400">{totalOk}</span>
            <span className="text-lg text-muted-foreground">OK</span>
          </div>
          <div className="flex items-center gap-3">
            <XCircle className="h-8 w-8 text-red-400" />
            <span className="text-3xl font-bold text-red-400">{totalAlerta}</span>
            <span className="text-lg text-muted-foreground">Alertas</span>
          </div>
        </div>
      </div>

      {/* Big numbers */}
      <div className={`grid grid-cols-3 gap-8 p-8 rounded-2xl border-3 ${statusBorder(margemStatus)} ${statusBg(margemStatus)}`}>
        <div className="text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-widest mb-2">Faturamento</p>
          <p className="text-5xl font-black">{formatBRL(execTotal)}</p>
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-widest mb-2">Margem Líquida</p>
          <p className={`text-6xl font-black ${statusLabelColor(margemStatus)}`}>{formatPct(margemLiquida)}</p>
          <p className={`text-lg font-semibold mt-2 ${statusLabelColor(margemStatus)}`}>{statusLabel(margemStatus)}</p>
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-widest mb-2">Resultado</p>
          <p className="text-5xl font-black">{formatBRL(resultado)}</p>
        </div>
      </div>

      {/* Category summary cards */}
      <div className="grid grid-cols-3 gap-6 flex-1">
        {categories.map(cat => {
          const pct = cat.agg.meta > 0 ? (cat.agg.realizado / cat.agg.meta) * 100 : 0;
          return (
            <div
              key={cat.label}
              className={`flex flex-col gap-4 p-6 rounded-2xl border-2 ${statusBorder(cat.status)} ${statusBg(cat.status)}`}
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {cat.icon}
                  <h2 className="text-2xl font-bold">{cat.label}</h2>
                </div>
                <StatusIcon status={cat.status} />
              </div>

              <div className="flex-1 flex flex-col justify-center gap-4">
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Realizado</p>
                  <p className="text-4xl font-black">{formatBRL(cat.agg.realizado)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground uppercase tracking-wide mb-1">Meta</p>
                  <p className="text-2xl font-semibold text-muted-foreground">{formatBRL(cat.agg.meta)}</p>
                </div>

                {/* Progress bar */}
                <div className="w-full bg-muted/30 rounded-full h-4 overflow-hidden">
                  <div
                    className={`h-4 rounded-full transition-all ${
                      cat.status === 'verde' ? 'bg-emerald-500' :
                      cat.status === 'amarelo' ? 'bg-yellow-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.min(pct, 100)}%` }}
                  />
                </div>
                <p className={`text-xl font-bold ${statusLabelColor(cat.status)}`}>
                  {pct.toFixed(0)}% — {statusLabel(cat.status)}
                </p>
              </div>

              <div className="flex items-center justify-between text-sm text-muted-foreground border-t border-border/30 pt-3">
                <span>{cat.agg.total - cat.agg.alertas} de {cat.agg.total} OK</span>
                {cat.agg.alertas > 0 && (
                  <span className="text-red-400 font-medium">{cat.agg.alertas} alerta{cat.agg.alertas > 1 ? 's' : ''}</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer */}
      <p className="text-center text-sm text-muted-foreground">
        WeDo Hub • Atualiza automaticamente a cada 5 min • {new Date().toLocaleString('pt-BR')}
      </p>
    </div>
  );
}