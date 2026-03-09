// src/pages/TvResultados.tsx — TV Display for operational results
import { useEffect } from 'react';
import { useMetasResultados, formatBRL, formatPct, MetaComResultado } from '@/hooks/useMetasResultados';
import { CheckCircle, XCircle, AlertTriangle, TrendingUp, TrendingDown } from 'lucide-react';

const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const StatusIcon = ({ status }: { status: 'verde' | 'amarelo' | 'vermelho' }) => {
  if (status === 'verde') return <CheckCircle className="h-8 w-8 text-emerald-400 shrink-0" />;
  if (status === 'amarelo') return <AlertTriangle className="h-8 w-8 text-yellow-400 shrink-0" />;
  return <XCircle className="h-8 w-8 text-red-400 shrink-0" />;
};

const statusBg = (status: 'verde' | 'amarelo' | 'vermelho') => {
  if (status === 'verde') return 'border-emerald-500/30 bg-emerald-500/5';
  if (status === 'amarelo') return 'border-yellow-500/30 bg-yellow-500/5';
  return 'border-red-500/30 bg-red-500/5';
};

const MetaTvRow = ({ m }: { m: MetaComResultado }) => (
  <div className={`flex items-center gap-4 p-4 rounded-xl border-2 ${statusBg(m.status)} transition-all`}>
    <StatusIcon status={m.status} />
    <div className="flex-1 min-w-0">
      <p className="text-lg font-semibold truncate">{m.nome}</p>
      <p className="text-sm text-muted-foreground">
        Meta: {formatBRL(m.meta_calculada)}
      </p>
    </div>
    <div className="text-right shrink-0">
      <p className="text-2xl font-bold">{formatBRL(m.realizado)}</p>
      <p className={`text-sm font-medium ${
        m.status === 'verde' ? 'text-emerald-400' :
        m.status === 'amarelo' ? 'text-yellow-400' : 'text-red-400'
      }`}>
        {m.progresso}%
      </p>
    </div>
  </div>
);

export default function TvResultados() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;

  const { metasComResultado, execTotal, isLoading, refetch } = useMetasResultados(year, month);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    const interval = setInterval(() => refetch(), 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refetch]);

  const receitas = metasComResultado.filter(m => m.categoria === 'receita');
  const custos = metasComResultado.filter(m => m.categoria !== 'receita');
  const totalCustos = custos.reduce((a, m) => a + m.realizado, 0);
  const margemLiquida = execTotal > 0 ? (execTotal - totalCustos) / execTotal : 0;
  const totalOk = metasComResultado.filter(m => m.status === 'verde').length;
  const totalAlerta = metasComResultado.filter(m => m.status !== 'verde').length;

  const margemColor = margemLiquida >= 0.30 ? 'text-emerald-400' : margemLiquida >= 0.15 ? 'text-yellow-400' : 'text-red-400';
  const margemBorder = margemLiquida >= 0.30 ? 'border-emerald-500' : margemLiquida >= 0.15 ? 'border-yellow-500' : 'border-red-500';

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <p className="text-2xl text-muted-foreground animate-pulse">Carregando dados…</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground p-8 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-black tracking-tight">
            Resultados Operação
          </h1>
          <p className="text-lg text-muted-foreground">{meses[month - 1]} {year}</p>
        </div>
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2">
            <CheckCircle className="h-6 w-6 text-emerald-400" />
            <span className="text-2xl font-bold text-emerald-400">{totalOk}</span>
            <span className="text-muted-foreground">OK</span>
          </div>
          <div className="flex items-center gap-2">
            <XCircle className="h-6 w-6 text-red-400" />
            <span className="text-2xl font-bold text-red-400">{totalAlerta}</span>
            <span className="text-muted-foreground">Alertas</span>
          </div>
        </div>
      </div>

      {/* Big numbers bar */}
      <div className={`grid grid-cols-3 gap-6 p-6 rounded-2xl border-2 ${margemBorder} bg-card`}>
        <div className="text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-wide mb-1">Faturamento</p>
          <p className="text-4xl font-black">{formatBRL(execTotal)}</p>
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-wide mb-1">Margem Líquida</p>
          <p className={`text-5xl font-black ${margemColor}`}>{formatPct(margemLiquida)}</p>
          <p className="text-xs text-muted-foreground mt-1">Meta: ≥ 30%</p>
        </div>
        <div className="text-center">
          <p className="text-sm text-muted-foreground uppercase tracking-wide mb-1">Resultado</p>
          <p className="text-4xl font-black">{formatBRL(execTotal - totalCustos)}</p>
        </div>
      </div>

      {/* Two columns */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 flex-1">
        {/* Receitas */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 mb-1">
            <TrendingUp className="h-5 w-5 text-emerald-400" />
            <h2 className="text-xl font-bold">Receitas</h2>
          </div>
          {receitas.map(m => <MetaTvRow key={m.id} m={m} />)}
        </div>

        {/* Custos */}
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 mb-1">
            <TrendingDown className="h-5 w-5 text-red-400" />
            <h2 className="text-xl font-bold">Custos</h2>
          </div>
          {custos.map(m => <MetaTvRow key={m.id} m={m} />)}
        </div>
      </div>

      {/* Footer */}
      <p className="text-center text-xs text-muted-foreground">
        WeDo Hub • Atualiza automaticamente a cada 5 min • {new Date().toLocaleString('pt-BR')}
      </p>
    </div>
  );
}
