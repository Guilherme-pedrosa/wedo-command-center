import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";

const STATUS_BADGE: Record<string, string> = {
  success: "bg-emerald-500/20 text-emerald-400",
  error: "bg-red-500/20 text-red-400",
  running: "bg-blue-500/20 text-blue-400",
  partial: "bg-yellow-500/20 text-yellow-400",
};

export function RunsPanel() {
  const { data: runs = [] } = useQuery({
    queryKey: ["fin_agent_runs"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_agent_runs")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Execuções do Agente</CardTitle>
      </CardHeader>
      <CardContent>
        {runs.length === 0 && (
          <p className="text-sm text-muted-foreground text-center py-8">Nenhuma execução registrada ainda.</p>
        )}
        <div className="space-y-2 max-h-[65vh] overflow-y-auto">
          {runs.map((r) => (
            <div key={r.id} className="flex items-center gap-3 p-3 rounded-md border bg-card">
              <Badge className={STATUS_BADGE[r.status] || ""}>{r.status}</Badge>
              <div className="flex-1 min-w-0">
                <span className="text-sm font-medium">{r.tipo}</span>
                {r.resumo && <p className="text-xs text-muted-foreground">{r.resumo}</p>}
              </div>
              <div className="text-right shrink-0">
                <p className="text-xs text-muted-foreground">
                  {r.created_at ? format(new Date(r.created_at), "dd/MM HH:mm", { locale: ptBR }) : "—"}
                </p>
                {r.duracao_ms != null && (
                  <p className="text-[10px] text-muted-foreground">{(r.duracao_ms / 1000).toFixed(1)}s</p>
                )}
              </div>
              <div className="text-xs text-muted-foreground space-x-2">
                {(r.alertas_criados ?? 0) > 0 && <span>⚠ {r.alertas_criados}</span>}
                {(r.tarefas_criadas ?? 0) > 0 && <span>📋 {r.tarefas_criadas}</span>}
                {(r.acoes_executadas ?? 0) > 0 && <span>✅ {r.acoes_executadas}</span>}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
