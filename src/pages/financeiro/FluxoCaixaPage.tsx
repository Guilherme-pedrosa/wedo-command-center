import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { formatCurrency } from "@/lib/format";
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar } from "recharts";
import { format, eachDayOfInterval, subDays } from "date-fns";
import { ptBR } from "date-fns/locale";

export default function FluxoCaixaPage() {
  const { data: recebimentos } = useQuery({
    queryKey: ["fluxo-rec"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_recebimentos").select("valor, data_vencimento, data_liquidacao, liquidado");
      return data || [];
    },
  });

  const { data: pagamentos } = useQuery({
    queryKey: ["fluxo-pag"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_pagamentos").select("valor, data_vencimento, data_liquidacao, liquidado");
      return data || [];
    },
  });

  const hoje = new Date();
  const dias = eachDayOfInterval({ start: subDays(hoje, 30), end: hoje });

  const chartData = dias.map(d => {
    const key = format(d, "yyyy-MM-dd");
    const label = format(d, "dd/MM", { locale: ptBR });
    const entradas = recebimentos?.filter((r: any) => r.liquidado && r.data_liquidacao === key).reduce((s, r: any) => s + Number(r.valor || 0), 0) || 0;
    const saidas = pagamentos?.filter((p: any) => p.liquidado && p.data_liquidacao === key).reduce((s, p: any) => s + Number(p.valor || 0), 0) || 0;
    return { name: label, entradas, saidas, saldo: entradas - saidas };
  });

  // Accumulated balance
  let acum = 0;
  const acumData = chartData.map(d => { acum += d.saldo; return { ...d, acumulado: acum }; });

  const totalEntradas = chartData.reduce((s, d) => s + d.entradas, 0);
  const totalSaidas = chartData.reduce((s, d) => s + d.saidas, 0);

  return (
    <div className="space-y-6">
      <div><h1 className="text-2xl font-bold text-foreground">Fluxo de Caixa</h1><p className="text-sm text-muted-foreground">Últimos 30 dias — entradas vs saídas</p></div>

      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-border bg-card p-4"><span className="text-xs text-muted-foreground">Entradas</span><p className="text-lg font-bold text-wedo-green">{formatCurrency(totalEntradas)}</p></div>
        <div className="rounded-lg border border-border bg-card p-4"><span className="text-xs text-muted-foreground">Saídas</span><p className="text-lg font-bold text-wedo-red">{formatCurrency(totalSaidas)}</p></div>
        <div className="rounded-lg border border-border bg-card p-4"><span className="text-xs text-muted-foreground">Saldo período</span><p className={`text-lg font-bold ${totalEntradas - totalSaidas >= 0 ? "text-wedo-green" : "text-wedo-red"}`}>{formatCurrency(totalEntradas - totalSaidas)}</p></div>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold mb-4">Entradas vs Saídas</h3>
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(215 28% 25%)" />
            <XAxis dataKey="name" tick={{ fill: "hsl(215 20% 65%)", fontSize: 10 }} />
            <YAxis tick={{ fill: "hsl(215 20% 65%)", fontSize: 10 }} />
            <Tooltip contentStyle={{ background: "hsl(217 33% 17%)", border: "1px solid hsl(215 28% 25%)", borderRadius: 8, color: "hsl(210 40% 96%)" }} formatter={(v: number) => formatCurrency(v)} />
            <Bar dataKey="entradas" fill="hsl(142 71% 45%)" radius={[2, 2, 0, 0]} />
            <Bar dataKey="saidas" fill="hsl(0 84% 60%)" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      <div className="rounded-lg border border-border bg-card p-6">
        <h3 className="text-sm font-semibold mb-4">Saldo Acumulado</h3>
        <ResponsiveContainer width="100%" height={250}>
          <LineChart data={acumData}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(215 28% 25%)" />
            <XAxis dataKey="name" tick={{ fill: "hsl(215 20% 65%)", fontSize: 10 }} />
            <YAxis tick={{ fill: "hsl(215 20% 65%)", fontSize: 10 }} />
            <Tooltip contentStyle={{ background: "hsl(217 33% 17%)", border: "1px solid hsl(215 28% 25%)", borderRadius: 8, color: "hsl(210 40% 96%)" }} formatter={(v: number) => formatCurrency(v)} />
            <Line type="monotone" dataKey="acumulado" stroke="hsl(217 91% 60%)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
