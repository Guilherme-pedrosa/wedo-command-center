import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { StatCard } from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatTimeAgo } from "@/lib/format";
import { syncRecebimentos, syncPagamentos } from "@/api/syncService";
import {
  Receipt, Layers, AlertTriangle, CheckCircle, CreditCard, RefreshCw,
  TrendingUp, Database, Loader2, ArrowRight,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer,
} from "recharts";
import { format, subMonths, startOfMonth, endOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";

export default function Dashboard() {
  const navigate = useNavigate();
  const [syncing, setSyncing] = useState(false);

  // ─── Queries ──────────────────────────────────────────────────────
  const { data: recebimentos } = useQuery({
    queryKey: ["dashboard-recebimentos"],
    queryFn: async () => {
      const { data } = await supabase.from("gc_recebimentos").select("valor, liquidado, data_vencimento, data_liquidacao, data_competencia");
      return data || [];
    },
  });

  const { data: pagamentos } = useQuery({
    queryKey: ["dashboard-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase.from("gc_pagamentos").select("valor, liquidado, data_vencimento, data_liquidacao");
      return data || [];
    },
  });

  const { data: gruposAguardando } = useQuery({
    queryKey: ["dashboard-grupos-aguardando"],
    queryFn: async () => {
      const { count } = await supabase.from("grupos_financeiros").select("*", { count: "exact", head: true }).eq("status", "aguardando_pagamento");
      return count || 0;
    },
  });

  const { data: gruposVencendo } = useQuery({
    queryKey: ["dashboard-grupos-vencendo"],
    queryFn: async () => {
      const hoje = new Date().toISOString().split("T")[0];
      const em7dias = new Date(Date.now() + 7 * 86400000).toISOString().split("T")[0];
      const { data } = await supabase
        .from("grupos_financeiros")
        .select("id, nome, nome_cliente, valor_total, data_vencimento, status")
        .gte("data_vencimento", hoje)
        .lte("data_vencimento", em7dias)
        .neq("status", "pago")
        .neq("status", "cancelado")
        .order("data_vencimento")
        .limit(5);
      return data || [];
    },
  });

  const { data: recentLogs } = useQuery({
    queryKey: ["dashboard-logs"],
    queryFn: async () => {
      const { data } = await supabase.from("sync_log").select("*").order("created_at", { ascending: false }).limit(10);
      return data || [];
    },
  });

  // ─── Stats ────────────────────────────────────────────────────────
  const hoje = new Date();
  const mesAtual = format(hoje, "yyyy-MM");

  const totalAReceber = recebimentos?.filter((r) => !r.liquidado).reduce((s, r) => s + (r.valor || 0), 0) || 0;
  const countAReceber = recebimentos?.filter((r) => !r.liquidado).length || 0;
  const vencidos = recebimentos?.filter((r) => !r.liquidado && r.data_vencimento && r.data_vencimento < hoje.toISOString().split("T")[0]) || [];
  const totalVencido = vencidos.reduce((s, r) => s + (r.valor || 0), 0);
  const recebidoMes = recebimentos?.filter((r) => r.liquidado && r.data_liquidacao?.startsWith(mesAtual)).reduce((s, r) => s + (r.valor || 0), 0) || 0;
  const countRecebidoMes = recebimentos?.filter((r) => r.liquidado && r.data_liquidacao?.startsWith(mesAtual)).length || 0;
  const totalAPagar = pagamentos?.filter((p) => !p.liquidado).reduce((s, p) => s + (p.valor || 0), 0) || 0;
  const countAPagar = pagamentos?.filter((p) => !p.liquidado).length || 0;
  const pagoMes = pagamentos?.filter((p) => p.liquidado && p.data_liquidacao?.startsWith(mesAtual)).reduce((s, p) => s + (p.valor || 0), 0) || 0;
  const countPagoMes = pagamentos?.filter((p) => p.liquidado && p.data_liquidacao?.startsWith(mesAtual)).length || 0;

  // ─── Charts ───────────────────────────────────────────────────────
  const chartData = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(hoje, 5 - i);
    const key = format(d, "yyyy-MM");
    const label = format(d, "MMM", { locale: ptBR });
    const rec = recebimentos?.filter((r) => r.liquidado && r.data_liquidacao?.startsWith(key)).reduce((s, r) => s + (r.valor || 0), 0) || 0;
    const pag = pagamentos?.filter((p) => p.liquidado && p.data_liquidacao?.startsWith(key)).reduce((s, p) => s + (p.valor || 0), 0) || 0;
    return { name: label, recebimentos: rec, pagamentos: pag };
  });

  // ─── Sync ─────────────────────────────────────────────────────────
  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      const [r, p] = await Promise.all([syncRecebimentos(), syncPagamentos()]);
      toast.success(`Sincronizado: ${r.importados} recebimentos, ${p.importados} pagamentos`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro na sincronização");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Visão geral do ARGUS</p>
        </div>
        <Button variant="outline" size="sm" onClick={handleSyncAll} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sincronizar Tudo
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        <StatCard title="A Receber" value={totalAReceber} count={countAReceber} icon={Receipt} color="blue" />
        <StatCard title="Aguardando PIX" value={0} count={gruposAguardando || 0} icon={Layers} color="orange" />
        <StatCard title="Vencido" value={totalVencido} count={vencidos.length} icon={AlertTriangle} color="red" />
        <StatCard title="Recebido (mês)" value={recebidoMes} count={countRecebidoMes} icon={CheckCircle} color="green" />
        <StatCard title="A Pagar" value={totalAPagar} count={countAPagar} icon={CreditCard} color="purple" />
        <StatCard title="Pago (mês)" value={pagoMes} count={countPagoMes} icon={TrendingUp} color="green" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Recebimentos por Mês</h3>
          {chartData.some((d) => d.recebimentos > 0) ? (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(215 28% 25%)" />
                <XAxis dataKey="name" tick={{ fill: "hsl(215 20% 65%)", fontSize: 12 }} />
                <YAxis tick={{ fill: "hsl(215 20% 65%)", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{ background: "hsl(217 33% 17%)", border: "1px solid hsl(215 28% 25%)", borderRadius: 8, color: "hsl(210 40% 96%)" }}
                  formatter={(value: number) => formatCurrency(value)}
                />
                <Bar dataKey="recebimentos" fill="hsl(217 91% 60%)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-60 flex items-center justify-center text-muted-foreground text-sm">
              Sincronize os dados para visualizar
            </div>
          )}
        </div>

        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Pagamentos por Mês</h3>
          {chartData.some((d) => d.pagamentos > 0) ? (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={chartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(215 28% 25%)" />
                <XAxis dataKey="name" tick={{ fill: "hsl(215 20% 65%)", fontSize: 12 }} />
                <YAxis tick={{ fill: "hsl(215 20% 65%)", fontSize: 12 }} />
                <Tooltip
                  contentStyle={{ background: "hsl(217 33% 17%)", border: "1px solid hsl(215 28% 25%)", borderRadius: 8, color: "hsl(210 40% 96%)" }}
                  formatter={(value: number) => formatCurrency(value)}
                />
                <Line type="monotone" dataKey="pagamentos" stroke="hsl(270 65% 60%)" strokeWidth={2} dot={{ fill: "hsl(270 65% 60%)" }} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="h-60 flex items-center justify-center text-muted-foreground text-sm">
              Sincronize os dados para visualizar
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Grupos vencendo */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Grupos vencendo em 7 dias</h3>
            <Button variant="ghost" size="sm" onClick={() => navigate("/grupos")}>
              Ver todos <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
          {gruposVencendo && gruposVencendo.length > 0 ? (
            <div className="space-y-3">
              {gruposVencendo.map((g) => (
                <div key={g.id} className="flex items-center justify-between p-3 rounded-md bg-muted/50">
                  <div>
                    <p className="text-sm font-medium text-foreground">{g.nome}</p>
                    <p className="text-xs text-muted-foreground">{g.nome_cliente}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-foreground">{formatCurrency(g.valor_total)}</p>
                    <p className="text-xs text-muted-foreground">{g.data_vencimento}</p>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Nenhum grupo vencendo nos próximos 7 dias.</p>
          )}
        </div>

        {/* Últimas atividades */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Últimas Atividades</h3>
            <Button variant="ghost" size="sm" onClick={() => navigate("/log")}>
              Ver log <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
          {recentLogs && recentLogs.length > 0 ? (
            <div className="space-y-2">
              {recentLogs.map((log) => (
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
