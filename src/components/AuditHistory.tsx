import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Loader2, History } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";

interface AuditHistoryProps {
  tableName: string;
  recordId: string | number;
  limit?: number;
}

const ACTION_COLOR: Record<string, string> = {
  INSERT: "bg-emerald-500/20 text-emerald-600 border-emerald-500/30",
  UPDATE: "bg-blue-500/20 text-blue-600 border-blue-500/30",
  DELETE: "bg-destructive/20 text-destructive border-destructive/30",
};

export function AuditHistory({ tableName, recordId, limit = 50 }: AuditHistoryProps) {
  const { data, isLoading } = useQuery({
    queryKey: ["audit-history", tableName, recordId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("audit_trail")
        .select("*")
        .eq("table_name", tableName)
        .eq("record_id", String(recordId))
        .order("created_at", { ascending: false })
        .limit(limit);
      if (error) throw error;
      return data ?? [];
    },
  });

  if (isLoading) {
    return (
      <div className="flex justify-center p-4">
        <Loader2 className="h-5 w-5 animate-spin" />
      </div>
    );
  }

  if (!data?.length) {
    return (
      <div className="text-sm text-muted-foreground p-4 text-center">
        <History className="h-5 w-5 mx-auto mb-2 opacity-50" />
        Nenhum histórico registrado para este item.
      </div>
    );
  }

  return (
    <ScrollArea className="h-[400px]">
      <div className="space-y-3 pr-3">
        {data.map((entry: any) => (
          <div key={entry.id} className="border border-border rounded-md p-3 text-sm space-y-2">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Badge variant="secondary" className={ACTION_COLOR[entry.action] ?? ""}>
                  {entry.action}
                </Badge>
                <span className="font-medium">{entry.user_email ?? "sistema"}</span>
                {entry.user_role && (
                  <span className="text-xs text-muted-foreground">({entry.user_role})</span>
                )}
              </div>
              <span className="text-xs text-muted-foreground">
                {new Date(entry.created_at).toLocaleString("pt-BR", { timeZone: "America/Sao_Paulo" })}
              </span>
            </div>
            {entry.diff && Object.keys(entry.diff).length > 0 && (
              <div className="text-xs space-y-1 bg-muted/30 rounded p-2">
                {Object.entries(entry.diff).map(([field, change]: any) => (
                  <div key={field} className="flex gap-2">
                    <span className="font-mono text-muted-foreground min-w-[120px]">{field}:</span>
                    <span className="text-destructive line-through truncate max-w-[200px]">
                      {JSON.stringify(change.before)}
                    </span>
                    <span className="text-emerald-600 truncate max-w-[200px]">
                      → {JSON.stringify(change.after)}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}
