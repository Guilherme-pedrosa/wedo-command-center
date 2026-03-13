// src/pages/TvTecnicos.tsx — TV: Metas de Faturamento por Técnico
import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { Loader2, Trophy, ChevronLeft, ChevronRight } from 'lucide-react';
import { TecnicoCard } from '@/components/tv-tecnicos/TecnicoCard';
import { RetornoDialog } from '@/components/tv-tecnicos/RetornoDialog';
import toast from 'react-hot-toast';

const meses = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];

const formatBRL = (v: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v);

interface TecnicoMeta { nome_tecnico: string; meta_faturamento: number; }
interface OsRow { nome_vendedor: string | null; valor_total: number | null; os_codigo: string; }
interface RetornoRow { os_codigo: string; tecnico_original: string; tecnico_retorno: string; valor: number; }

export default function TvTecnicos() {
  const now = new Date();
  const qc = useQueryClient();
  const [selectedDate, setSelectedDate] = useState({ year: now.getFullYear(), month: now.getMonth() + 1 });
  const { year, month } = selectedDate;
  const mesLabel = `${meses[month - 1]} ${year}`;

  // Auth state
  const [userId, setUserId] = useState<string | null>(null);
  useEffect(() => {
    supabase.auth.onAuthStateChange((_ev, session) => setUserId(session?.user?.id ?? null));
    supabase.auth.getSession().then(({ data }) => setUserId(data.session?.user?.id ?? null));
  }, []);
  const isLoggedIn = !!userId;

  // Retorno dialog state
  const [retornoTarget, setRetornoTarget] = useState<{ codigo: string; tecnico: string; valor: number } | null>(null);

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

  // Fetch metas
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

  // Fetch OS do mês
  const { data: osData = [], isLoading: loadingOs, refetch: refetchOs } = useQuery({
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

  // Fetch retornos do mês
  const { data: retornos = [], refetch: refetchRetornos } = useQuery({
    queryKey: ['fin_os_retornos', year, month],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('fin_os_retornos')
        .select('os_codigo, tecnico_original, tecnico_retorno, valor')
        .eq('ano', year)
        .eq('mes', month);
      if (error) throw error;
      return (data || []) as RetornoRow[];
    },
    staleTime: 2 * 60 * 1000,
  });

  // Auto-refresh
  useEffect(() => {
    const interval = setInterval(() => {
      refetchMetas();
      refetchOs();
      refetchRetornos();
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [refetchMetas, refetchOs, refetchRetornos]);

  // Mutations
  const addRetorno = useMutation({
    mutationFn: async (params: { os_codigo: string; tecnico_original: string; tecnico_retorno: string; valor: number }) => {
      const { error } = await supabase.from('fin_os_retornos').insert({
        os_codigo: params.os_codigo,
        tecnico_original: params.tecnico_original,
        tecnico_retorno: params.tecnico_retorno,
        valor: params.valor,
        ano: year,
        mes: month,
        created_by: userId,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_os_retornos', year, month] });
      toast.success('OS marcada como retorno');
    },
    onError: (e: any) => toast.error(e.message || 'Erro ao marcar retorno'),
  });

  const removeRetorno = useMutation({
    mutationFn: async (os_codigo: string) => {
      const { error } = await supabase
        .from('fin_os_retornos')
        .delete()
        .eq('os_codigo', os_codigo)
        .eq('ano', year)
        .eq('mes', month);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['fin_os_retornos', year, month] });
      toast.success('Retorno desfeito');
    },
    onError: (e: any) => toast.error(e.message || 'Erro ao desfazer'),
  });

  // Build retorno maps
  const retornoMap = useMemo(() => {
    const map: Record<string, RetornoRow> = {};
    for (const r of retornos) map[r.os_codigo] = r;
    return map;
  }, [retornos]);

  // Aggregate results with retorno logic
  const resultados = useMemo(() => {
    const vendedorMap: Record<string, { total: number; osList: { codigo: string; valor: number; isRetorno?: boolean; retornoFrom?: string }[] }> = {};

    for (const os of osData) {
      const nomeCompleto = os.nome_vendedor?.trim().toUpperCase();
      if (!nomeCompleto) continue;
      const primeiroNome = nomeCompleto.split(' ')[0];
      if (!vendedorMap[primeiroNome]) vendedorMap[primeiroNome] = { total: 0, osList: [] };
      const valor = os.valor_total ?? 0;
      const retorno = retornoMap[os.os_codigo];

      if (retorno) {
        // This OS is marked as retorno — show strikethrough, don't count value
        vendedorMap[primeiroNome].osList.push({ codigo: os.os_codigo, valor, isRetorno: true });
        // Add value to the retorno technician
        const tecRetorno = retorno.tecnico_retorno.trim().toUpperCase();
        if (!vendedorMap[tecRetorno]) vendedorMap[tecRetorno] = { total: 0, osList: [] };
        vendedorMap[tecRetorno].total += valor;
        vendedorMap[tecRetorno].osList.push({ codigo: os.os_codigo, valor, retornoFrom: primeiroNome });
      } else {
        vendedorMap[primeiroNome].total += valor;
        vendedorMap[primeiroNome].osList.push({ codigo: os.os_codigo, valor });
      }
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
        osList: info.osList.sort((a, b) => {
          if (a.isRetorno && !b.isRetorno) return 1;
          if (!a.isRetorno && b.isRetorno) return -1;
          return b.valor - a.valor;
        }),
      };
    }).sort((a, b) => b.pct - a.pct);
  }, [metas, osData, retornoMap]);

  const tecnicoNames = metas.map(m => m.nome_tecnico);

  if (loadingOs) {
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
          {isLoggedIn ? '🔓 Logado — clique em uma OS para marcar retorno' : 'Atualiza a cada 5 min'}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-4 flex-1">
        {resultados.map((t, i) => (
          <TecnicoCard
            key={t.nome}
            nome={t.nome}
            meta={t.meta}
            realizado={t.realizado}
            pct={t.pct}
            osList={t.osList}
            rank={i}
            isLoggedIn={isLoggedIn}
            onMarkRetorno={(codigo, valor) =>
              setRetornoTarget({ codigo, tecnico: t.nome, valor })
            }
            onUndoRetorno={(codigo) => removeRetorno.mutate(codigo)}
          />
        ))}
      </div>

      {/* Retorno Dialog */}
      {retornoTarget && (
        <RetornoDialog
          open
          onClose={() => setRetornoTarget(null)}
          osCodigo={retornoTarget.codigo}
          tecnicoOriginal={retornoTarget.tecnico}
          valor={retornoTarget.valor}
          tecnicos={tecnicoNames}
          onConfirm={(tecnicoRetorno) => {
            addRetorno.mutate({
              os_codigo: retornoTarget.codigo,
              tecnico_original: retornoTarget.tecnico.toUpperCase(),
              tecnico_retorno: tecnicoRetorno.toUpperCase(),
              valor: retornoTarget.valor,
            });
            setRetornoTarget(null);
          }}
        />
      )}
    </div>
  );
}
