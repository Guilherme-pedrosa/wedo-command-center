// src/pages/TvTecnicos.tsx — TV: Metas de Faturamento por Técnico
import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Trophy, ChevronLeft, ChevronRight } from 'lucide-react';

const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

interface TecnicoMeta {
  nome_tecnico: string;
  meta_faturamento: number;
}

interface OsRow {
  nome_vendedor: string | null;
  valor_total: number | null;
  os_codigo: string;
}

interface TecnicoResult {
  nome: string;
  meta: number;
  realizado: number;
  pct: number;
  osList: { codigo: string; valor: number }[];
}

export default function TvTecnicos() {
  const now = new Date();
  const [selectedDate, setSelectedDate] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const { year, month } = selectedDate;
  const mesLabel = `${meses[month - 1]} ${year}`;

  const navigateMonth = (dir: number) => {
    setSelectedDate(prev => {
      let m = prev.month + dir;
      let y = prev.year;
      if (m < 1) { m = 12; y--; }
      if (m > 12) { m = 1; y++; }
      const nowY = now.getFullYear();
      const nowM = now.getMonth() + 1;
      if (y > nowY || (y === nowY && m > nowM)) return prev;
      return { year: y, month: m };
    });
  };

  const isCurrentMonth = year === now.getFullYear() && month === now.getMonth() + 1;

  const start = `${year}-${String(month).padStart(2, '0')}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const end = `${year}-${String(month).padStart(2, '0')}-${lastDay}`;

  // Fetch metas dos técnicos
  const { data: metas = [], refetch: refetchMetas } = useQuery({
    queryKey: ['fin_metas_tecnicos'],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_metas_tecnicos')
        .select('nome_tecnico, meta_faturamento')
        .eq('ativo', true)
        .order('nome_tecnico');
      if (error) throw error;
      return (data || []) as TecnicoMeta[];
    },
    staleTime: 5 * 60 * 1000,
  });

  // Fetch OS do mês (executadas)
  const { data: osData = [], isLoading, refetch: refetchOs } = useQuery({
    queryKey: ['os_index_tecnicos', year, month],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('os_index')
        .select('nome_vendedor, valor_total, os_codigo')
        .gte('data_saida', start)
        .lte('data_saida', end);
      if (error) throw error;
      return (data || []) as OsRow[];
    },
    staleTime: 2 * 60 * 1000,
  });

  // Auto-refresh a cada 5 min
  useEffect(() => {
    const interval = setInterval(() => {
      refetchMetas();
      refetchOs();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refetchMetas, refetchOs]);

  // Agregar faturamento por técnico
  const resultados: TecnicoResult[] = useMemo(() => {
    const vendedorMap: Record<string, { total: number; osList: { codigo: string; valor: number }[] }> = {};
    for (const os of osData) {
      const nomeCompleto = os.nome_vendedor?.trim().toUpperCase();
      if (!nomeCompleto) continue;
      const primeiroNome = nomeCompleto.split(' ')[0];
      if (!vendedorMap[primeiroNome]) vendedorMap[primeiroNome] = { total: 0, osList: [] };
      const valor = os.valor_total ?? 0;
      vendedorMap[primeiroNome].total += valor;
      vendedorMap[primeiroNome].osList.push({ codigo: os.os_codigo, valor });
    }

    return metas.map(m => {
      const nomeUpper = m.nome_tecnico.trim().toUpperCase();
      const info = vendedorMap[nomeUpper] || { total: 0, osList: [] };
      const meta = m.meta_faturamento;
      const pct = meta > 0 ? info.total / meta : 0;
      return {
        nome: m.nome_tecnico,
        meta,
        realizado: info.total,
        pct,
        osList: info.osList.sort((a, b) => b.valor - a.valor),
      };
    }).sort((a, b) => b.pct - a.pct);
  }, [metas, osData]);

  const getEmoji = (pct: number) => {
    if (pct >= 1) return '🏆';
    if (pct >= 0.8) return '😄';
    if (pct >= 0.5) return '😐';
    return '😟';
  };

  const getBarColor = (pct: number) => {
    if (pct >= 1) return 'bg-emerald-500';
    if (pct >= 0.8) return 'bg-yellow-400';
    if (pct >= 0.5) return 'bg-orange-400';
    return 'bg-red-500';
  };

  const getTextColor = (pct: number) => {
    if (pct >= 1) return 'text-emerald-400';
    if (pct >= 0.8) return 'text-yellow-400';
    if (pct >= 0.5) return 'text-orange-400';
    return 'text-red-400';
  };

  if (isLoading) {
    return (
      <div className="min-h-screen bg-[#0a0e1a] flex items-center justify-center">
        <Loader2 className="h-12 w-12 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0e1a] text-white p-6 flex flex-col gap-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Trophy className="h-10 w-10 text-yellow-400" />
          <div>
            <h1 className="text-3xl font-black tracking-tight">Metas por Técnico</h1>
            <div className="flex items-center gap-3">
              <button onClick={() => navigateMonth(-1)} className="p-1 rounded hover:bg-white/10 transition-colors">
                <ChevronLeft className="h-5 w-5 text-white/50" />
              </button>
              <p className="text-lg text-white/50">{mesLabel}</p>
              <button
                onClick={() => navigateMonth(1)}
                disabled={isCurrentMonth}
                className="p-1 rounded hover:bg-white/10 transition-colors disabled:opacity-20 disabled:cursor-not-allowed"
              >
                <ChevronRight className="h-5 w-5 text-white/50" />
              </button>
            </div>
          </div>
        </div>
        <div className="text-sm text-white/30">
          Atualiza a cada 5 min
        </div>
      </div>

      {/* Grid de técnicos */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 flex-1">
        {resultados.map((t, i) => {
          const pctClamped = Math.min(t.pct, 1);
          return (
            <div
              key={t.nome}
              className={`relative rounded-2xl border p-5 flex flex-col justify-between transition-all ${
                t.pct >= 1
                  ? 'border-emerald-500/50 bg-emerald-500/10'
                  : t.pct >= 0.8
                  ? 'border-yellow-500/40 bg-yellow-500/5'
                  : t.pct >= 0.5
                  ? 'border-orange-500/30 bg-orange-500/5'
                  : 'border-red-500/30 bg-red-500/5'
              }`}
            >
              {/* Posição + Emoji */}
              <div className="flex items-center justify-between mb-3">
                <span className="text-4xl">{getEmoji(t.pct)}</span>
                {i < 3 && t.pct > 0 && (
                  <span className="text-xs font-bold bg-yellow-500/20 text-yellow-300 px-2 py-1 rounded-full">
                    TOP {i + 1}
                  </span>
                )}
              </div>

              {/* Nome */}
              <h2 className="text-xl font-bold tracking-tight mb-1">{t.nome}</h2>

              {/* Percentual */}
              <p className={`text-4xl font-black ${getTextColor(t.pct)}`}>
                {(t.pct * 100).toFixed(0)}%
              </p>

              {/* Barra de progresso */}
              <div className="mt-3 h-3 bg-white/10 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-all duration-700 ${getBarColor(t.pct)}`}
                  style={{ width: `${pctClamped * 100}%` }}
                />
              </div>

              {/* OS list */}
              <div className="mt-2 max-h-28 overflow-y-auto space-y-0.5 scrollbar-thin">
                {t.osList.map((os, idx) => (
                  <div key={idx} className="flex justify-between text-xs text-white/50">
                    <span>OS {os.codigo}</span>
                    <span>{formatBRL(os.valor)}</span>
                  </div>
                ))}
                {t.osList.length === 0 && (
                  <p className="text-xs text-white/30 italic">Sem OS no período</p>
                )}
              </div>

              {/* Meta */}
              <p className="text-sm font-semibold text-white/70 mt-2">
                {formatBRL(t.realizado)}
              </p>
              <p className="text-xs text-white/40">
                Meta: {formatBRL(t.meta)} • {t.osList.length} OS
              </p>
            </div>
          );
        })}
      </div>
    </div>
  );
}
