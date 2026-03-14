import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, X, Loader2 } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import toast from "react-hot-toast";

export function AprovacaoPanel() {
  const qc = useQueryClient();

  const { data: aprovacoes = [] } = useQuery({
    queryKey: ["fin_aprovacoes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_aprovacoes")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data;
    },
  });

  const decidir = useMutation({
    mutationFn: async ({ id, status }: { id: string; status: "aprovado" | "recusado" }) => {
      const { data, error } = await supabase.functions.invoke("fin-approve-action", {
        body: { aprovacao_id: id, decisao: status, aprovado_por: "admin" },
      });
      if (error) throw error;
      return data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["fin_aprovacoes"] });
      qc.invalidateQueries({ queryKey: ["fin_tarefas"] });
      qc.invalidateQueries({ queryKey: ["fin_alertas"] });
      qc.invalidateQueries({ queryKey: ["fin_agent_runs"] });
      const msg = data?.executado
        ? "Aprovado e executado com sucesso"
        : "Decisão registrada";
      toast.success(msg);
    },
    onError: (e: any) => toast.error(e.message || "Erro ao processar"),
  });

  const pendentes = aprovacoes.filter((a) => a.status === "pendente");
  const historico = aprovacoes.filter((a) => a.status !== "pendente");

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Pendentes ({pendentes.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {pendentes.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-6">Nenhuma aprovação pendente.</p>
          )}
          {pendentes.map((a) => (
            <div key={a.id} className="p-3 rounded-md border bg-card space-y-2">
              <div className="flex items-center gap-3">
                <div className="flex-1 min-w-0">
                  <span className="text-sm font-medium">{a.tipo_acao}</span>
                  {(a.valor ?? 0) > 0 && (
                    <span className="ml-2 text-xs text-muted-foreground">
                      R$ {(a.valor ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                    </span>
                  )}
                  {a.justificativa && <p className="text-xs text-muted-foreground">{a.justificativa}</p>}
                </div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-emerald-400 border-emerald-500/30"
                    disabled={decidir.isPending}
                    onClick={() => decidir.mutate({ id: a.id, status: "aprovado" })}
                  >
                    {decidir.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-red-400 border-red-500/30"
                    disabled={decidir.isPending}
                    onClick={() => decidir.mutate({ id: a.id, status: "recusado" })}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              </div>

              {/* Before/After comparison */}
              {(a.estado_anterior || a.payload_proposto) && (
                <div className="grid grid-cols-2 gap-2 text-[10px]">
                  {a.estado_anterior && (
                    <div className="p-1.5 rounded bg-red-500/10 border border-red-500/20">
                      <p className="font-medium text-red-400 mb-0.5">Antes</p>
                      <pre className="whitespace-pre-wrap text-muted-foreground overflow-auto max-h-20">
                        {JSON.stringify(a.estado_anterior, null, 1)}
                      </pre>
                    </div>
                  )}
                  {a.payload_proposto && (
                    <div className="p-1.5 rounded bg-emerald-500/10 border border-emerald-500/20">
                      <p className="font-medium text-emerald-400 mb-0.5">Depois</p>
                      <pre className="whitespace-pre-wrap text-muted-foreground overflow-auto max-h-20">
                        {JSON.stringify(a.payload_proposto, null, 1)}
                      </pre>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Histórico</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 max-h-[40vh] overflow-y-auto">
          {historico.map((a) => (
            <div key={a.id} className="flex items-center gap-3 p-2 rounded-md border bg-card/50 text-sm">
              <Badge variant={a.status === "aprovado" ? "default" : "destructive"} className="text-[10px]">
                {a.status}
              </Badge>
              <span>{a.tipo_acao}</span>
              {(a.valor ?? 0) > 0 && (
                <span className="text-xs text-muted-foreground">
                  R$ {(a.valor ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </span>
              )}
              {a.decidido_em && (
                <span className="text-xs text-muted-foreground ml-auto">
                  {format(new Date(a.decidido_em), "dd/MM HH:mm", { locale: ptBR })}
                </span>
              )}
            </div>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}
