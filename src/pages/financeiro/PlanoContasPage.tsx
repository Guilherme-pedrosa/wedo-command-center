import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { BookOpen, RefreshCw, Loader2 } from "lucide-react";
import { syncPlanoContasGC } from "@/api/financeiro";
import toast from "react-hot-toast";

export default function PlanoContasPage() {
  const queryClient = useQueryClient();
  const [syncing, setSyncing] = useState(false);

  const { data: plano, isLoading } = useQuery({
    queryKey: ["fin-plano-contas"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_plano_contas").select("*").order("codigo");
      return data || [];
    },
  });

  const handleSync = async () => {
    setSyncing(true);
    try {
      const res = await syncPlanoContasGC();
      toast.success(`Sincronizado: ${res.importados} contas importadas`);
      queryClient.invalidateQueries({ queryKey: ["fin-plano-contas"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao sincronizar");
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Plano de Contas</h1>
          <p className="text-sm text-muted-foreground">{"Categorias importadas do Gest\u00e3oClick"}</p>
        </div>
        <Button size="sm" onClick={handleSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          {"Sincronizar com Gest\u00e3oClick"}
        </Button>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">{"C\u00f3digo"}</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Nome</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Tipo</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ativo</th>
            </tr>
          </thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={4} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            ) : !plano?.length ? (
              <tr><td colSpan={4}>
                <EmptyState
                  icon={BookOpen}
                  title="Sem contas"
                  description={"Clique em 'Sincronizar com Gest\u00e3oClick' para importar o plano de contas."}
                />
              </td></tr>
            ) : (
              plano.map((c: any) => (
                <tr key={c.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 font-mono text-xs">{c.codigo || "\u2014"}</td>
                  <td className="p-3 font-medium">{c.nome}</td>
                  <td className="p-3 text-center">
                    <Badge variant="outline" className={`text-[10px] ${c.tipo === "receita" ? "text-wedo-green" : "text-wedo-red"}`}>
                      {c.tipo}
                    </Badge>
                  </td>
                  <td className="p-3 text-center">{c.ativo ? "\u2705" : "\u274c"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {plano && plano.length > 0 && (
        <p className="text-xs text-muted-foreground">{plano.length} conta(s) cadastrada(s)</p>
      )}
    </div>
  );
}
