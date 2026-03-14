import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { TrendingUp, TrendingDown, Loader2, RefreshCw, AlertTriangle } from "lucide-react";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";

interface ForecastWeek {
  semana: string;
  inicio: string;
  fim: string;
  entradas: number;
  saidas: number;
  saldo_projetado: number;
  itens_entrada: any[];
  itens_saida: any[];
}

const formatBRL = (v: number) =>
  new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(v);

const formatShortDate = (d: string) => {
  const [, m, day] = d.split("-");
  return `${day}/${m}`;
};

export function ForecastPanel() {
  const [running, setRunning] = useState(false);
  const [expandedWeek, setExpandedWeek] = useState<string | null>(null);

  const { data, refetch, isLoading } = useQuery({
    queryKey: ["fin_forecast"],
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("fin-forecast-cashflow");
      if (error) throw error;
      return data as {
        saldo_inicial: number;
        semanas: ForecastWeek[];
        semanas_risco: any[];
      };
    },
    staleTime: 10 * 60 * 1000,
    retry: 1,
  });

  const runForecast = async () => {
    setRunning(true);
    try {
      await refetch();
      toast.success("Projeção atualizada");
    } catch (e: any) {
      toast.error(`Erro: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  const semanas = data?.semanas || [];
  const risco = data?.semanas_risco || [];
  const saldoInicial = data?.saldo_inicial || 0;
  const minSaldo = semanas.length > 0 ? Math.min(...semanas.map(s => s.saldo_projetado)) : 0;
  const maxSaldo = semanas.length > 0 ? Math.max(...semanas.map(s => s.saldo_projetado)) : 0;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Projeção de caixa — 13 semanas</h3>
        <Button size="sm" variant="outline" onClick={runForecast} disabled={running || isLoading} className="gap-1.5">
          {running || isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {running || isLoading ? "Projetando…" : "Atualizar Projeção"}
        </Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Saldo Atual</p>
            <p className="text-xl font-bold">{formatBRL(saldoInicial)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4">
            <p className="text-xs text-muted-foreground">Menor Saldo Projetado</p>
            <p className={cn("text-xl font-bold", minSaldo < 0 ? "text-red-400" : "")}>
              {formatBRL(minSaldo)}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 flex items-center gap-2">
            <AlertTriangle className={cn("h-5 w-5", risco.length > 0 ? "text-red-400" : "text-emerald-400")} />
            <div>
              <p className="text-xl font-bold">{risco.length}</p>
              <p className="text-xs text-muted-foreground">Semanas com Risco</p>
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Bar chart - simple visual */}
      {semanas.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Fluxo Semanal</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="space-y-1">
              {semanas.map((s) => {
                const range = maxSaldo - Math.min(minSaldo, 0);
                const pct = range > 0 ? ((s.saldo_projetado - Math.min(minSaldo, 0)) / range) * 100 : 50;
                const isRisk = s.saldo_projetado < 0 || risco.some(r => r.inicio === s.inicio);
                const isExpanded = expandedWeek === s.semana;

                return (
                  <div key={s.semana}>
                    <button
                      onClick={() => setExpandedWeek(isExpanded ? null : s.semana)}
                      className="w-full flex items-center gap-2 py-1.5 hover:bg-accent/50 rounded px-1 transition-colors"
                    >
                      <span className="text-xs w-8 shrink-0 font-mono text-muted-foreground">{s.semana}</span>
                      <span className="text-[10px] w-16 shrink-0 text-muted-foreground">
                        {formatShortDate(s.inicio)}
                      </span>
                      <div className="flex-1 h-5 bg-muted rounded-sm overflow-hidden relative">
                        <div
                          className={cn(
                            "h-full rounded-sm transition-all",
                            isRisk ? "bg-red-500/70" : "bg-emerald-500/70"
                          )}
                          style={{ width: `${Math.max(pct, 2)}%` }}
                        />
                      </div>
                      <div className="flex items-center gap-1 w-28 justify-end shrink-0">
                        {s.entradas > 0 && (
                          <span className="text-[10px] text-emerald-400">+{formatBRL(s.entradas)}</span>
                        )}
                      </div>
                      <div className="flex items-center gap-1 w-28 justify-end shrink-0">
                        {s.saidas > 0 && (
                          <span className="text-[10px] text-red-400">-{formatBRL(s.saidas)}</span>
                        )}
                      </div>
                      <span className={cn("text-xs font-mono w-28 text-right shrink-0 font-medium", isRisk ? "text-red-400" : "")}>
                        {formatBRL(s.saldo_projetado)}
                      </span>
                    </button>

                    {isExpanded && (
                      <div className="ml-10 mb-2 p-2 rounded border bg-card/50 text-xs space-y-1">
                        {s.itens_entrada.length > 0 && (
                          <div>
                            <p className="font-medium text-emerald-400 mb-0.5">Entradas:</p>
                            {s.itens_entrada.map((i: any) => (
                              <div key={i.id} className="flex justify-between text-muted-foreground">
                                <span>{i.cliente || i.descricao}</span>
                                <span>{formatBRL(i.valor)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {s.itens_saida.length > 0 && (
                          <div>
                            <p className="font-medium text-red-400 mb-0.5">Saídas:</p>
                            {s.itens_saida.map((i: any) => (
                              <div key={i.id} className="flex justify-between text-muted-foreground">
                                <span>{i.fornecedor || i.descricao}</span>
                                <span>{formatBRL(i.valor)}</span>
                              </div>
                            ))}
                          </div>
                        )}
                        {s.itens_entrada.length === 0 && s.itens_saida.length === 0 && (
                          <p className="text-muted-foreground">Sem movimentações previstas</p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardContent>
        </Card>
      )}

      {semanas.length === 0 && !isLoading && (
        <Card>
          <CardContent className="py-8 text-center text-muted-foreground text-sm">
            Clique em "Atualizar Projeção" para gerar a previsão de caixa.
          </CardContent>
        </Card>
      )}
    </div>
  );
}
