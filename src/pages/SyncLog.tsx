import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { EmptyState } from "@/components/EmptyState";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from "@/components/ui/sheet";
import { ScrollText, Search, Download, Loader2, Eye } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatDateTime } from "@/lib/format";

type LogEntry = {
  id: string;
  tipo: string;
  referencia_id: string | null;
  referencia_tipo: string | null;
  status: string | null;
  payload: unknown;
  resposta: unknown;
  erro: string | null;
  duracao_ms: number | null;
  created_at: string | null;
};

export default function SyncLog() {
  const [search, setSearch] = useState("");
  const [tipo, setTipo] = useState("todos");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [selectedLog, setSelectedLog] = useState<LogEntry | null>(null);
  const [page, setPage] = useState(0);
  const pageSize = 20;

  const { data, isLoading } = useQuery({
    queryKey: ["sync-log", tipo, statusFilter, search, page],
    queryFn: async () => {
      let query = supabase
        .from("sync_log")
        .select("*", { count: "exact" })
        .order("created_at", { ascending: false })
        .range(page * pageSize, (page + 1) * pageSize - 1);

      if (tipo !== "todos") query = query.eq("tipo", tipo);
      if (statusFilter !== "todos") query = query.eq("status", statusFilter);
      if (search) query = query.or(`referencia_id.ilike.%${search}%,tipo.ilike.%${search}%`);

      const { data, error, count } = await query;
      if (error) throw error;
      return { logs: (data || []) as LogEntry[], total: count || 0 };
    },
  });

  const logs = data?.logs || [];
  const total = data?.total || 0;
  const totalPages = Math.ceil(total / pageSize);

  const handleExportCSV = () => {
    if (!logs.length) return;
    const headers = ["Data/Hora", "Tipo", "Referência", "Status", "Duração (ms)", "Erro"];
    const rows = logs.map((l) => [
      l.created_at ? formatDateTime(l.created_at) : "",
      l.tipo,
      l.referencia_id || "",
      l.status || "",
      String(l.duracao_ms || ""),
      l.erro || "",
    ]);
    const csv = [headers, ...rows].map((r) => r.map((c) => `"${c}"`).join(",")).join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sync_log_${new Date().toISOString().split("T")[0]}.csv`;
    a.click();
  };

  const statusBadge = (s: string | null) => {
    if (s === "success") return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">success</Badge>;
    if (s === "error") return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">error</Badge>;
    return <Badge variant="outline" className="bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30 text-[10px]">{s || "—"}</Badge>;
  };

  const tipoBadge = (t: string) => {
    const colors: Record<string, string> = {
      gc_import: "bg-wedo-blue/10 text-wedo-blue border-wedo-blue/30",
      gc_baixa: "bg-wedo-purple/10 text-wedo-purple border-wedo-purple/30",
      inter_cobranca: "bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30",
      inter_pix: "bg-wedo-green/10 text-wedo-green border-wedo-green/30",
    };
    return <Badge variant="outline" className={`${colors[t] || ""} text-[10px]`}>{t}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Log de Sincronização</h1>
          <p className="text-sm text-muted-foreground">Histórico de todas as operações com APIs externas</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleExportCSV}>
          <Download className="h-3.5 w-3.5 mr-1.5" /> Exportar CSV
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar referência..." value={search} onChange={(e) => { setSearch(e.target.value); setPage(0); }} className="pl-9" />
        </div>
        <Select value={tipo} onValueChange={(v) => { setTipo(v); setPage(0); }}>
          <SelectTrigger className="w-[200px]"><SelectValue placeholder="Tipo" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="gc_import">Importação GC</SelectItem>
            <SelectItem value="gc_baixa">Baixa GC</SelectItem>
            <SelectItem value="inter_cobranca">Cobrança Inter</SelectItem>
            <SelectItem value="inter_pix">PIX Inter</SelectItem>
          </SelectContent>
        </Select>
        <Select value={statusFilter} onValueChange={(v) => { setStatusFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[140px]"><SelectValue placeholder="Status" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="success">Success</SelectItem>
            <SelectItem value="error">Error</SelectItem>
            <SelectItem value="partial">Partial</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Data/Hora</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Tipo</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Referência</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Duração</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Detalhes</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
              ) : logs.length === 0 ? (
                <tr><td colSpan={6} className="p-0">
                  <EmptyState icon={ScrollText} title="Nenhum log registrado" description="Os logs aparecerão conforme as sincronizações forem executadas." />
                </td></tr>
              ) : (
                logs.map((log) => (
                  <tr key={log.id} className="border-b border-border hover:bg-muted/30">
                    <td className="p-3 text-foreground text-xs">{log.created_at ? formatDateTime(log.created_at) : "—"}</td>
                    <td className="p-3">{tipoBadge(log.tipo)}</td>
                    <td className="p-3 text-foreground text-xs font-mono truncate max-w-[150px]">{log.referencia_id || "—"}</td>
                    <td className="p-3 text-center">{statusBadge(log.status)}</td>
                    <td className="p-3 text-right text-foreground text-xs">{log.duracao_ms ? `${log.duracao_ms}ms` : "—"}</td>
                    <td className="p-3 text-center">
                      <Button size="sm" variant="ghost" onClick={() => setSelectedLog(log)}>
                        <Eye className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex items-center justify-between">
          <p className="text-xs text-muted-foreground">{total} registros · Página {page + 1} de {totalPages}</p>
          <div className="flex gap-2">
            <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</Button>
            <Button size="sm" variant="outline" disabled={page >= totalPages - 1} onClick={() => setPage(page + 1)}>Próxima</Button>
          </div>
        </div>
      )}

      {/* Detail Sheet */}
      <Sheet open={!!selectedLog} onOpenChange={(open) => !open && setSelectedLog(null)}>
        <SheetContent side="right" className="w-full sm:max-w-lg overflow-y-auto">
          <SheetHeader>
            <SheetTitle>Detalhes do Log</SheetTitle>
            <SheetDescription>{selectedLog?.tipo} — {selectedLog?.created_at ? formatDateTime(selectedLog.created_at) : ""}</SheetDescription>
          </SheetHeader>
          {selectedLog && (
            <div className="mt-6 space-y-4">
              <div className="flex gap-2">{statusBadge(selectedLog.status)} {tipoBadge(selectedLog.tipo)}</div>
              {selectedLog.erro && (
                <div className="rounded-md bg-wedo-red/10 p-3 text-xs text-wedo-red">{selectedLog.erro}</div>
              )}
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Payload</h4>
                <pre className="rounded-md bg-muted/50 p-3 text-xs text-foreground overflow-auto max-h-48">
                  {JSON.stringify(selectedLog.payload, null, 2)}
                </pre>
              </div>
              <div>
                <h4 className="text-xs font-semibold text-muted-foreground uppercase mb-1">Resposta</h4>
                <pre className="rounded-md bg-muted/50 p-3 text-xs text-foreground overflow-auto max-h-48">
                  {JSON.stringify(selectedLog.resposta, null, 2)}
                </pre>
              </div>
            </div>
          )}
        </SheetContent>
      </Sheet>
    </div>
  );
}
