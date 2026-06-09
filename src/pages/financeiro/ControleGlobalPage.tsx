// src/pages/financeiro/ControleGlobalPage.tsx
import { useMemo, useState } from 'react';
import { useControleGlobal, type ControleGlobalKPIs } from '@/hooks/useControleGlobal';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Button } from '@/components/ui/button';
import { RefreshCw, TrendingDown, TrendingUp, Minus } from 'lucide-react';

const formatBRL = (v: number) =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const formatPct = (v: number) => `${(v * 100).toFixed(2)}%`;

const MESES = [
  'Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
  'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro',
];

type KpiKey = keyof ControleGlobalKPIs;

interface KpiSpec {
  key: KpiKey;
  label: string;
  format: 'brl' | 'pct';
  tone?: 'positive' | 'negative' | 'neutral';
  group: 'resultado' | 'pendencias' | 'os' | 'estoque';
  // Para o comparativo: subir é bom ou ruim?
  betterWhen: 'higher' | 'lower';
}

const KPIS: KpiSpec[] = [
  { key: 'totalRecebido',         label: 'Total Recebido Global',         format: 'brl', group: 'resultado', betterWhen: 'higher' },
  { key: 'totalFaturado',         label: 'Total Faturado Global',         format: 'brl', group: 'resultado', betterWhen: 'higher' },
  { key: 'totalDespesas',         label: 'Total Despesas',                format: 'brl', group: 'resultado', betterWhen: 'lower' },
  { key: 'margemBrutaFaturado',   label: 'Margem Bruta (Faturado)',       format: 'brl', group: 'resultado', betterWhen: 'higher' },
  { key: 'margemBrutaRecebido',   label: 'Margem Bruta (Recebido)',       format: 'brl', group: 'resultado', betterWhen: 'higher' },
  { key: 'margemPct',             label: 'Margem % (Recebido)',           format: 'pct', group: 'resultado', betterWhen: 'higher' },
  { key: 'faltaReceber',          label: 'Falta Receber (Fat. − Receb.)', format: 'brl', group: 'pendencias', betterWhen: 'lower' },
  { key: 'aguardandoSemNf',       label: 'Aguardando Receb. (sem NF)',    format: 'brl', group: 'pendencias', betterWhen: 'lower' },
  { key: 'aguardandoNegociacao',  label: 'Aguardando Negociação',         format: 'brl', group: 'pendencias', betterWhen: 'lower' },
  { key: 'totalAReceberGeral',    label: 'Total a Receber Geral',         format: 'brl', group: 'pendencias', betterWhen: 'lower' },
  { key: 'totalDeveriaTerRecebido', label: 'Total Deveria Ter Recebido',  format: 'brl', group: 'pendencias', betterWhen: 'higher' },
  { key: 'totalOsAbertas',        label: 'Total OS Abertas',              format: 'brl', group: 'os', betterWhen: 'higher' },
  { key: 'totalOsExecutadas',     label: 'Total OS Executadas',           format: 'brl', group: 'os', betterWhen: 'higher' },
  { key: 'emHaverSemGc',          label: 'Em Haver (sem GC) — Resíduos',  format: 'brl', group: 'estoque', betterWhen: 'lower' },
  { key: 'valorEmEstoque',        label: 'Valor em Estoque (Custo)',      format: 'brl', group: 'estoque', betterWhen: 'neutral' as any },
];

const GROUP_TITLES: Record<KpiSpec['group'], string> = {
  resultado: '📊 Resultado',
  pendencias: '⏳ Pendências',
  os: '🛠️ Ordens de Serviço',
  estoque: '📦 Estoque & Em Haver',
};

interface KpiCardProps {
  spec: KpiSpec;
  current?: ControleGlobalKPIs;
  previous?: ControleGlobalKPIs;
}

const KpiCard = ({ spec, current, previous }: KpiCardProps) => {
  const cur = current?.[spec.key] ?? 0;
  const prev = previous?.[spec.key] ?? 0;
  const diff = cur - prev;
  const diffPct = prev !== 0 ? (cur - prev) / Math.abs(prev) : null;

  const fmt = (v: number) => (spec.format === 'pct' ? formatPct(v) : formatBRL(v));

  let trendIcon = <Minus className="h-3 w-3" />;
  let trendClass = 'text-muted-foreground';
  if (diff > 0.01) {
    trendIcon = <TrendingUp className="h-3 w-3" />;
    trendClass = spec.betterWhen === 'higher' ? 'text-emerald-600' : spec.betterWhen === 'lower' ? 'text-red-600' : 'text-muted-foreground';
  } else if (diff < -0.01) {
    trendIcon = <TrendingDown className="h-3 w-3" />;
    trendClass = spec.betterWhen === 'lower' ? 'text-emerald-600' : spec.betterWhen === 'higher' ? 'text-red-600' : 'text-muted-foreground';
  }

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-2">
        <CardTitle className="text-xs uppercase tracking-wide text-muted-foreground font-medium">
          {spec.label}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="text-2xl font-bold tabular-nums text-foreground">{fmt(cur)}</div>
        <div className={`flex items-center gap-1 text-xs ${trendClass}`}>
          {trendIcon}
          <span className="tabular-nums">
            {diff >= 0 ? '+' : ''}{spec.format === 'pct' ? formatPct(diff) : formatBRL(diff)}
            {diffPct !== null && spec.format !== 'pct' && (
              <span className="ml-1 opacity-70">({diffPct >= 0 ? '+' : ''}{(diffPct * 100).toFixed(1)}%)</span>
            )}
          </span>
          <span className="text-muted-foreground/70 ml-1">vs mês ant.</span>
        </div>
        <div className="text-[10px] text-muted-foreground/80 tabular-nums">
          Mês anterior: {fmt(prev)}
        </div>
      </CardContent>
    </Card>
  );
};

export default function ControleGlobalPage() {
  const now = new Date();
  const [year, setYear] = useState(now.getFullYear());
  const [month, setMonth] = useState(now.getMonth() + 1);
  const { current, previous, isLoading, refetch } = useControleGlobal(year, month);

  const years = useMemo(() => {
    const arr: number[] = [];
    for (let y = now.getFullYear() + 1; y >= 2024; y--) arr.push(y);
    return arr;
  }, [now]);

  const groups = useMemo(() => {
    const map: Record<string, KpiSpec[]> = {};
    for (const k of KPIS) {
      (map[k.group] = map[k.group] || []).push(k);
    }
    return map;
  }, []);

  return (
    <div className="p-6 space-y-6 max-w-[1600px] mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Controle Global</h1>
          <p className="text-sm text-muted-foreground">
            Dashboard mensal com todos os KPIs do controle financeiro · {MESES[month - 1]} / {year}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Select value={String(month)} onValueChange={(v) => setMonth(Number(v))}>
            <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {MESES.map((m, i) => (
                <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={String(year)} onValueChange={(v) => setYear(Number(v))}>
            <SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {years.map((y) => (
                <SelectItem key={y} value={String(y)}>{y}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button variant="outline" size="sm" onClick={() => refetch()} disabled={isLoading}>
            <RefreshCw className={`h-4 w-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
            Atualizar
          </Button>
        </div>
      </div>

      {isLoading && !current && (
        <div className="text-center text-muted-foreground py-12">Carregando KPIs…</div>
      )}

      {Object.entries(groups).map(([gKey, specs]) => (
        <section key={gKey} className="space-y-3">
          <h2 className="text-sm font-semibold text-foreground/80 tracking-wide">
            {GROUP_TITLES[gKey as KpiSpec['group']]}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {specs.map((s) => (
              <KpiCard key={s.key} spec={s} current={current} previous={previous} />
            ))}
          </div>
        </section>
      ))}

      <div className="text-xs text-muted-foreground border-t pt-3 mt-6">
        <strong>Fontes:</strong> Recebido = fin_recebimentos liquidados por data_liquidação ·
        Faturado/A Receber = fin_recebimentos por data_vencimento ·
        Despesas = fin_pagamentos por data_vencimento (exclui cancelados) ·
        OS = os_index por data_saida ·
        Estoque = gc_produtos_cache (custo × estoque, ativos) ·
        Em Haver = fin_residuos_negociacao não utilizados.
      </div>
    </div>
  );
}
