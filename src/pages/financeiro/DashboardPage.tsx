import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatCurrency, formatTimeAgo, formatDate } from "@/lib/format";
import { syncRecebimentosGC, syncPagamentosGC, syncFornecedoresGC, syncClientesGC } from "@/api/financeiro";
import {
  Receipt, AlertTriangle, CheckCircle, CreditCard, RefreshCw,
  TrendingUp, Loader2, ArrowRight, Zap, FileWarning, Eye,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import toast from "react-hot-toast";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend,
} from "recharts";
import { format, subMonths, startOfWeek, endOfWeek } from "date-fns";
import { ptBR } from "date-fns/locale";

export default function FinDashboardPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);
  const hoje = new Date().toISOString().split("T")[0];
  const mesAtual = format(new Date(), "yyyy-MM");
  const inicioSemana = format(startOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");
  const fimSemana = format(endOfWeek(new Date(), { weekStartsOn: 1 }), "yyyy-MM-dd");

  const { data: recebimentos } = useQuery({
    queryKey: ["fin-dash-recebimentos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_recebimentos")
        .select("id, valor, liquidado, status, data_vencimento, data_liquidacao, pago_sistema, gc_baixado, nome_cliente, descricao");
      return data || [];
    },
  });

  const { data: pagamentos } = useQuery({
    queryKey: ["fin-dash-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_pagamentos")
        .select("id, valor, liquidado, status, data_vencimento, data_liquidacao, pago_sistema, gc_baixado, nome_fornecedor, descricao");
      return data || [];
    },
  });

  const { data: gruposInterPendentes } = useQuery({
    queryKey: ["fin-dash-grupos-inter"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_grupos_receber")
        .select("id, nome, valor_total, inter_pago_em, gc_baixado")
        .not("inter_pago_em", "is", null)
        .eq("gc_baixado", false);
      return data || [];
    },
  });

  const { data: extratoNaoReconciliado } = useQuery({
    queryKey: ["fin-dash-extrato"],
    queryFn: async () => {
      const { count } = await supabase
        .from("fin_extrato_inter")
        .select("*", { count: "exact", head: true })
        .eq("reconciliado", false);
      return count || 0;
    },
  });

  const { data: recentLogs } = useQuery({
    queryKey: ["fin-dash-logs"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_sync_log")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(10);
      return data || [];
    },
  });

  // Vencimentos da semana (recebimentos pendentes)
  const vencimentosSemana = (recebimentos || []).filter(
    (r: any) => !r.liquidado && r.data_vencimento && r.data_vencimento >= inicioSemana && r.data_vencimento <= fimSemana
  ).sort((a: any, b: any) => (a.data_vencimento || "").localeCompare(b.data_vencimento || "")).slice(0, 10);

  // Stats
  const totalAReceber = recebimentos?.filter((r: any) => !r.liquidado).reduce((s: number, r: any) => s + Number(r.valor || 0), 0) || 0;
  const totalAPagar = pagamentos?.filter((p: any) => !p.liquidado).reduce((s: number, p: any) => s + Number(p.valor || 0), 0) || 0;
  const vencidosReceber = recebimentos?.filter((r: any) => !r.liquidado && r.data_vencimento && r.data_vencimento < hoje).length || 0;
  const vencidosPagar = pagamentos?.filter((p: any) => !p.liquidado && p.data_vencimento && p.data_vencimento < hoje).length || 0;
  const recebidoMes = recebimentos?.filter((r: any) => r.liquidado && r.data_liquidacao?.startsWith(mesAtual)).reduce((s: number, r: any) => s + Number(r.valor || 0), 0) || 0;
  const pagoMes = pagamentos?.filter((p: any) => p.liquidado && p.data_liquidacao?.startsWith(mesAtual)).reduce((s: number, p: any) => s + Number(p.valor || 0), 0) || 0;
  const saldoLiquido = totalAReceber - totalAPagar;
  const baixasPendentesGC = recebimentos?.filter((r: any) => r.pago_sistema && !r.gc_baixado).length || 0;

  // Chart data - 6 months
  const chartData = Array.from({ length: 6 }, (_, i) => {
    const d = subMonths(new Date(), 5 - i);
    const key = format(d, "yyyy-MM");
    const label = format(d, "MMM", { locale: ptBR });
    const rec = recebimentos?.filter((r: any) => r.liquidado && r.data_liquidacao?.startsWith(key)).reduce((s: number, r: any) => s + Number(r.valor || 0), 0) || 0;
    const pag = pagamentos?.filter((p: any) => p.liquidado && p.data_liquidacao?.startsWith(key)).reduce((s: number, p: any) => s + Number(p.valor || 0), 0) || 0;
    return { name: label, recebimentos: rec, pagamentos: pag };
  });

  const handleSyncAll = async () => {
    setSyncing(true);
    try {
      // Sync fornecedores/clientes first (needed for reconciliation CPF matching)
      const [f, c] = await Promise.all([syncFornecedoresGC(), syncClientesGC()]);
      const [r, p] = await Promise.all([syncRecebimentosGC(), syncPagamentosGC()]);
      toast.success(`Sync: ${r.importados} recebimentos, ${p.importados} pagamentos, ${f.importados} fornecedores, ${c.importados} clientes`);
      queryClient.invalidateQueries({ queryKey: ["fin-dash"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao sincronizar");
    } finally {
      setSyncing(false);
    }
  };

  const StatCard = ({ title, value, subtitle, icon: Icon, variant = "default" }: {
    title: string; value: string; subtitle?: string; icon: any; variant?: "default" | "success" | "danger" | "warning"
  }) => {
    const colorMap = {
      default: "text-primary",
      success: "text-emerald-500",
      danger: "text-destructive",
      warning: "text-amber-500",
    };
    return (
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-muted-foreground">{title}</span>
          <Icon className={`h-4 w-4 ${colorMap[variant]}`} />
        </div>
        <p className="text-lg font-bold text-foreground">{value}</p>
        {subtitle && <p className="text-[10px] text-muted-foreground mt-1">{subtitle}</p>}
      </div>
    );
  };

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
        <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <Zap className="h-5 w-5 text-amber-500" />
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
        <StatCard title="A Receber" value={formatCurrency(totalAReceber)} subtitle={vencidosReceber > 0 ? `${vencidosReceber} vencido(s)` : undefined} icon={Receipt} variant="default" />
        <StatCard title="A Pagar" value={formatCurrency(totalAPagar)} subtitle={vencidosPagar > 0 ? `${vencidosPagar} vencido(s)` : undefined} icon={CreditCard} variant="default" />
        <StatCard title="Recebido (mês)" value={formatCurrency(recebidoMes)} icon={CheckCircle} variant="success" />
        <StatCard title="Pago (mês)" value={formatCurrency(pagoMes)} icon={TrendingUp} variant="success" />
        <StatCard title="Saldo Líquido" value={formatCurrency(saldoLiquido)} icon={TrendingUp} variant={saldoLiquido >= 0 ? "success" : "danger"} />
        <StatCard title="Vencidos (Receber)" value={String(vencidosReceber)} icon={AlertTriangle} variant="danger" />
        <StatCard title="Vencidos (Pagar)" value={String(vencidosPagar)} icon={AlertTriangle} variant="danger" />
        <StatCard title="Baixas pendentes GC" value={String(baixasPendentesGC)} subtitle={`Extrato ñ reconciliado: ${extratoNaoReconciliado}`} icon={FileWarning} variant="warning" />
      </div>

      {/* Charts + Vencimentos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Bar Chart */}
        <div className="rounded-lg border border-border bg-card p-6">
          <h3 className="text-sm font-semibold text-foreground mb-4">Recebimentos vs Pagamentos (6 meses)</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
              <YAxis tick={{ fill: "hsl(var(--muted-foreground))", fontSize: 12 }} />
              <Tooltip
                contentStyle={{
                  background: "hsl(var(--card))",
                  border: "1px solid hsl(var(--border))",
                  borderRadius: 8,
                  color: "hsl(var(--foreground))",
                }}
                formatter={(v: number) => formatCurrency(v)}
              />
              <Legend />
              <Bar dataKey="recebimentos" name="Recebimentos" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              <Bar dataKey="pagamentos" name="Pagamentos" fill="hsl(var(--destructive))" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Vencimentos da semana */}
        <div className="rounded-lg border border-border bg-card p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-foreground">Vencimentos esta semana</h3>
            <Button variant="ghost" size="sm" onClick={() => navigate("/financeiro/recebimentos")} className="text-xs">
              Ver todos <ArrowRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
          {vencimentosSemana.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">Nenhum vencimento esta semana 🎉</p>
          ) : (
            <div className="space-y-2 max-h-[220px] overflow-y-auto">
              {vencimentosSemana.map((r: any) => (
                <div key={r.id} className="flex items-center gap-3 p-2.5 rounded-md border border-border hover:bg-muted/30 transition-colors">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-foreground truncate">{r.nome_cliente || "Sem cliente"}</p>
                    <p className="text-xs text-muted-foreground truncate">{r.descricao}</p>
                  </div>
                  <div className="text-right shrink-0">
                    <p className="text-sm font-semibold text-foreground">{formatCurrency(Number(r.valor))}</p>
                    <p className={`text-[10px] ${r.data_vencimento < hoje ? "text-destructive font-medium" : "text-muted-foreground"}`}>
                      {formatDate(r.data_vencimento)}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0" onClick={() => navigate("/financeiro/recebimentos")}>
                    <Eye className="h-3.5 w-3.5" />
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold text-foreground mb-4">Últimas Atividades</h3>
        {recentLogs && recentLogs.length > 0 ? (
          <div className="space-y-2 max-h-60 overflow-y-auto">
            {recentLogs.map((log: any) => (
              <div key={log.id} className="flex items-center gap-3 p-2 rounded-md text-xs">
                <Badge
                  variant="outline"
                  className={
                    log.status === "success"
                      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/30"
                      : log.status === "error"
                      ? "bg-destructive/10 text-destructive border-destructive/30"
                      : "bg-amber-500/10 text-amber-500 border-amber-500/30"
                  }
                >
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
  );
}
