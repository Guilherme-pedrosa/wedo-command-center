import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatTimeAgo, formatDate } from "@/lib/format";
import { syncRecebimentosGC, syncPagamentosGC } from "@/api/financeiro";
import {
  Receipt, AlertTriangle, CheckCircle, CreditCard, RefreshCw,
  TrendingUp, Loader2, ArrowRight, Layers, Zap, FileWarning, CalendarClock,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { format, subMonths } from "date-fns";
import { ptBR } from "date-fns/locale";

export default function FinDashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const hoje = new Date().toISOString().split("T")[0];
  const mesAtual = format(new Date(), "yyyy-MM");

  const { data: recebimentos } = useQuery({
    queryKey: ["fin-dash-recebimentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_recebimentos").select("valor, liquidado, status, data_vencimento, data_liquidacao, pago_sistema, gc_baixado");
      return data || [];
    },
  });

  const { data: pagamentos } = useQuery({
    queryKey: ["fin-dash-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_pagamentos").select("valor, liquidado, status, data_vencimento, data_liquidacao, pago_sistema, gc_baixado");
      return data || [];
    },
  });

  const { data: gruposInterPendentes } = useQuery({
    queryKey: ["fin-dash-grupos-inter"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_grupos_receber").select("id, nome, valor_total, inter_pago_em, gc_baixado").not("inter_pago_em", "is", null).eq("gc_baixado", false);
      return data || [];
    },
  });

  const { data: extratoNaoReconciliado } = useQuery({
    queryKey: ["fin-dash-extrato"],
    queryFn: async () => {
      const { count } = await supabase.from("fin_extrato_inter").select("*", { count: "exact", head: true }).eq("reconciliado", false);
      return count || 0;
    },
  });

  const { data: recentLogs } = useQuery({
    queryKey: ["fin-dash-logs"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_sync_log").select("*").order("created_at", { ascending: false }).limit(10);
      return data || [];
    },
  });

  // Stats
  const totalAReceber = recebimentos?.filter(r => !r.liquidado).reduce((s, r) => s + Number(r.valor || 0), 0) || 0;
  const totalAPagar = pagamentos?.filter(p => !p.liquidado).reduce((s, p) => s + Number(p.valor || 0), 0) || 0;
  const vencidosReceber = recebimentos?.filter(r => !r.liquidado && r.data_vencimento && r.data_vencimento < hoje).length || 0;
  const vencidosPagar = pagamentos?.filter(p => !p.liquidado && p.data_vencimento && p.data_vencimento < hoje).length || 0;
  const recebidoMes = recebimentos?.filter(r => r.liquidado && r.data_liquidacao?.startsWith(mesAtual)).reduce((s, r) => s + Number(r.valor || 0), 0) || 0;
  const pagoMes = pagamentos?.filter(p => p.liquidado && p.data_liquidacao?.startsWith(mesAtual)).reduce((s, p) => s + Number(p.valor || 0), 0) || 0;
  const saldoLiquido = totalAReceber - totalAPagar;
  const baixasPendentesGC = recebimentos?.filter(r => r.pago_sistema && !r.gc_baixado).length || 0;

  // Chart
  const chartData = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(new Date(), 5 - i);
    const key = format(d, "yyyy-MM");
    const label = format(d, "MMM", { locale: ptBR });
    const rec = recebimentos?.filter(r => r.liquidado && r.data_liquidacao?.startsWith(key)).reduce((s, r) => s + Number(r.valor || 0), 0) || 0;
    const pag = pagamentos?.filter(p => p.liquidado && p.data_liquidacao?.startsWith(key)).reduce((s, p) => s + Number(p.valor || 0), 0) || 0;
    return { name: label, recebimentos: rec, pagamentos: pag };
  });

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const [r, p] = await Promise.all([syncRecebimentosGC(), syncPagamentosGC()]);
      toast.success(`Sync: ${r.importados} recebimentos, ${p.importados} pagamentos`);
      queryClient.invalidateQueries({ queryKey: ["fin-dash"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setSyncing(false);
    }
  };

  const StatCard = ({ title, value, subtitle, icon: Icon, color }: { title: string; value: string; subtitle?: string; icon: any; color: string }) => (
    <div className="rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-xs text-muted-foreground">{title}</span>
        <Icon className={`h-4 w-4 text-wedo-${color}`} />
      </div>
      <p className="text-lg font-bold text-foreground">{value}</p>
      {subtitle && <p className="text-[10px] text-muted-foreground mt-1">{subtitle}</p>}
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard Financeiro</h1>
          <p className="text-sm text-muted-foreground">Visão consolidada do módulo financeiro</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleSyncAll} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sincronizar Tudo
        </Button>
      </div>

      {/* Alert banner */}
      {gruposInterPendentes && gruposInterPendentes.length > 0 && (
        <div className="rounded-lg bg-wedo-orange/10 border border-wedo-orange/30 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-wedo-orange" />
            <span className="text-sm text-foreground">
              <strong>{gruposInterPendentes.length}</strong> grupo(s) com pagamento Inter confirmado aguardando baixa no GC
            </span>
          </div>
          <Button variant="outline" size="sm" onClick={() => navigate("/financeiro/grupos-receber")}>
            Ver grupos <ArrowRight className="h-3 w-3 ml-1" />
          </Button>
        </div>
      )}

      {/* Stats grid */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard title="A Receber" value={formatCurrency(totalAReceber)} icon={Receipt} color="blue" />
        <StatCard title="A Pagar" value={formatCurrency(totalAPagar)} icon={CreditCard} color="purple" />
        <StatCard title="Vencidos (Receber)" value={String(vencidosReceber)} icon={AlertTriangle} color="red" />
        <StatCard title="Vencidos (Pagar)" value={String(vencidosPagar)} icon={AlertTriangle} color="red" />
        <StatCard title="Recebido (mês)" value={formatCurrency(recebidoMes)} icon={CheckCircle} color="green" />
        <StatCard title="Pago (mês)" value={formatCurrency(pagoMes)} icon={TrendingUp} color="green" />
        <StatCard title="Saldo Líquido" value={formatCurrency(saldoLiquido)} icon={TrendingUp} color={saldoLiquido >= 0 ? "green" : "red"} />
        <StatCard title="Baixas pendentes GC" value={String(baixasPendentesGC)} subtitle={`Extrato ñ reconciliado: ${extratoNaoReconciliado}`} icon={FileWarning} color="orange" />
      </div>

      {/* Charts */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Recebimentos vs Pagamentos (6 meses)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(215 28% 25%)" />
              <XAxis dataKey="name" tick={{ fill: "hsl(215 20% 65%)", fontSize: 12 }} />
              <YAxis tick={{ fill: "hsl(215 20% 65%)", fontSize: 12 }} />
              <Tooltip contentStyle={{ background: "hsl(217 33% 17%)", border: "1px solid hsl(215 28% 25%)", borderRadius: 8, color: "hsl(210 40% 96%)" }} formatter={(v: number) => formatCurrency(v)} />
              <Bar dataKey="recebimentos" fill="hsl(217 91% 60%)" radius={[4, 4, 0, 0]} />
              <Bar dataKey="pagamentos" fill="hsl(270 65% 60%)" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Últimas Atividades</h3>
          {recentLogs && recentLogs.length > 0 ? (
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {recentLogs.map((log: any) => (
                <div key={log.id} className="flex items-center gap-3 p-2 rounded-md text-xs">
                  <Badge variant="outline" className={log.status === "success" ? "bg-wedo-green/10 text-wedo-green border-wedo-green/30" : log.status === "error" ? "bg-wedo-red/10 text-wedo-red border-wedo-red/30" : "bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30"}>
                    {log.status}
                  </Badge>
                  <span className="text-muted-foreground flex-1 truncate">{log.tipo}</span>
                  <span className="text-muted-foreground">{log.created_at ? formatTimeAgo(log.created_at) : ""}</span>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhuma atividade registrada.</p>
          )}
        </div>
      </div>
    </div>
  );
}
