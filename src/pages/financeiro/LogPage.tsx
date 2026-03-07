import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { formatDateTime, formatTimeAgo } from "@/lib/format";
import { ScrollText, Loader2, Eye } from "lucide-react";

export default function LogPage() {
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [selectedLog, setSelectedLog] = useState<any>(null);

  const { data: logs, isLoading } = useQuery({
    queryKey: ["fin-sync-log", tipoFilter],
    queryFn: async () => {
      let q = supabase.from("fin_sync_log").select("*").order("created_at", { ascending: false }).limit(100);
      if (tipoFilter !== "todos") q = q.eq("tipo", tipoFilter);
      const { data } = await q;
      return data || [];
    },
  });

  const { data: tipos } = useQuery({
    queryKey: ["fin-sync-log-tipos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_sync_log").select("tipo").limit(100);
      const unique = [...new Set(data?.map((d: any) => d.tipo))];
      return unique;
    },
  });

  const statusColor = (s: string) => {
    if (s === "success") return "bg-wedo-green/10 text-wedo-green border-wedo-green/30";
    if (s === "error") return "bg-wedo-red/10 text-wedo-red border-wedo-red/30";
    if (s === "partial") return "bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30";
    return "bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30";
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Log de Sincronização</h1><p className="text-sm text-muted-foreground">Histórico de operações do módulo financeiro</p></div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-[220px]"><SelectValue placeholder="Filtrar tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            {tipos?.map((t: any) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Data</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Tipo</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Ref.</th>
            <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Duração</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
          </tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            : !logs?.length ? <tr><td colSpan={6} className="p-8 text-center text-muted-foreground">Nenhum log</td></tr>
            : logs.map((l: any) => (
              <tr key={l.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 text-xs">{l.created_at ? formatTimeAgo(l.created_at) : "—"}</td>
                <td className="p-3 font-mono text-xs">{l.tipo}</td>
                <td className="p-3 text-center"><Badge variant="outline" className={`${statusColor(l.status)} text-[10px]`}>{l.status}</Badge></td>
                <td className="p-3 text-xs text-muted-foreground truncate max-w-[150px]">{l.referencia_id || "—"}</td>
                <td className="p-3 text-right text-xs">{l.duracao_ms ? `${l.duracao_ms}ms` : "—"}</td>
                <td className="p-3 text-center"><Button variant="ghost" size="sm" className="h-7" onClick={() => setSelectedLog(l)}><Eye className="h-3 w-3" /></Button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <Sheet open={!!selectedLog} onOpenChange={o => !o && setSelectedLog(null)}>
        <SheetContent className="w-[500px] overflow-y-auto">
          {selectedLog && (
            <><SheetHeader><SheetTitle>Detalhes do Log</SheetTitle></SheetHeader>
              <div className="mt-6 space-y-4 text-sm">
                <div><span className="text-muted-foreground">Tipo:</span> <span className="font-mono">{selectedLog.tipo}</span></div>
                <div><span className="text-muted-foreground">Status:</span> <Badge variant="outline" className={`${statusColor(selectedLog.status)} text-[10px]`}>{selectedLog.status}</Badge></div>
                <div><span className="text-muted-foreground">Data:</span> {selectedLog.created_at ? formatDateTime(selectedLog.created_at) : "—"}</div>
                <div><span className="text-muted-foreground">Duração:</span> {selectedLog.duracao_ms ? `${selectedLog.duracao_ms}ms` : "—"}</div>
                {selectedLog.erro && <div className="rounded-md bg-destructive/10 p-3 text-xs text-destructive"><strong>Erro:</strong> {selectedLog.erro}</div>}
                {selectedLog.payload && <div><span className="text-muted-foreground">Payload:</span><pre className="mt-1 text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-48">{JSON.stringify(selectedLog.payload, null, 2)}</pre></div>}
                {selectedLog.resposta && <div><span className="text-muted-foreground">Resposta:</span><pre className="mt-1 text-xs bg-muted/50 rounded-md p-3 overflow-x-auto max-h-48">{JSON.stringify(selectedLog.resposta, null, 2)}</pre></div>}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
