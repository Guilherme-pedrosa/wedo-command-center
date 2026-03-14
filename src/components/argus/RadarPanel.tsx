import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AlertTriangle, CheckCircle, Clock, DollarSign, RefreshCw, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";

const SEV_ORDER = ["critica", "alta", "media", "baixa", "info"];
const SEV_ICON_COLOR: Record<string, string> = {
  critica: "text-red-400",
  alta: "text-orange-400",
  media: "text-yellow-400",
  baixa: "text-blue-400",
  info: "text-muted-foreground",
};

export function RadarPanel() {
  const qc = useQueryClient();
  const [running, setRunning] = useState(false);

  const { data: alertas = [], refetch } = useQuery({
    queryKey: ["fin_alertas"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_alertas")
        .select("*")
        .in("status", ["aberto", "em_analise"])
        .order("created_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data;
    },
  });

  const sorted = [...alertas].sort(
    (a, b) => SEV_ORDER.indexOf(a.severidade) - SEV_ORDER.indexOf(b.severidade)
  );

  const totalImpacto = alertas.reduce((s, a) => s + (a.valor_impacto || 0), 0);

  const runRadar = async () => {
    setRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("fin-radar-daily", {
        body: { source: "manual" },
      });
      if (error) throw error;
      toast.success(
        `Radar concluído: ${data.alertas_criados} alertas, ${data.tarefas_criadas} tarefas`
      );
      refetch();
      qc.invalidateQueries({ queryKey: ["fin_tarefas"] });
      qc.invalidateQueries({ queryKey: ["fin_agent_runs"] });
    } catch (e: any) {
      toast.error(`Erro no radar: ${e.message}`);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">Visão geral de riscos</h3>
        <Button size="sm" variant="outline" onClick={runRadar} disabled={running} className="gap-1.5">
          {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
          {running ? "Varrendo…" : "Executar Radar"}
        </Button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <Card>
          <CardContent className="pt-4 flex items-center gap-3">
            <AlertTriangle className="h-8 w-8 text-red-400" />
            <div>
              <p className="text-2xl font-bold">{alertas.filter((a) => a.severidade === "critica").length}</p>
              <p className="text-xs text-muted-foreground">Alertas Críticos</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 flex items-center gap-3">
            <Clock className="h-8 w-8 text-yellow-400" />
            <div>
              <p className="text-2xl font-bold">{alertas.length}</p>
              <p className="text-xs text-muted-foreground">Alertas Abertos</p>
            </div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="pt-4 flex items-center gap-3">
            <DollarSign className="h-8 w-8 text-emerald-400" />
            <div>
              <p className="text-2xl font-bold">R$ {totalImpacto.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</p>
              <p className="text-xs text-muted-foreground">Impacto Total em Caixa</p>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Alertas por Severidade</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 max-h-[60vh] overflow-y-auto">
          {sorted.length === 0 && (
            <div className="flex flex-col items-center gap-2 text-muted-foreground py-8">
              <CheckCircle className="h-5 w-5" />
              <span>Nenhum alerta ativo — tudo em ordem!</span>
              <span className="text-xs">Clique em "Executar Radar" para iniciar a varredura.</span>
            </div>
          )}
          {sorted.map((a) => (
            <div key={a.id} className="flex items-start gap-3 p-3 rounded-md border bg-card">
              <AlertTriangle className={cn("h-4 w-4 mt-0.5 shrink-0", SEV_ICON_COLOR[a.severidade])} />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-medium">{a.titulo}</span>
                  <Badge variant="outline" className="text-[10px]">{a.tipo}</Badge>
                </div>
                {a.descricao && <p className="text-xs text-muted-foreground mt-0.5">{a.descricao}</p>}
              </div>
              {(a.valor_impacto || 0) > 0 && (
                <span className="text-xs font-mono whitespace-nowrap">
                  R$ {(a.valor_impacto || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
