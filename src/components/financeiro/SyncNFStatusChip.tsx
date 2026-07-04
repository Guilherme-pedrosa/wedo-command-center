import { Loader2, CheckCircle, AlertTriangle, Clock, Search } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { ptBR } from "date-fns/locale";
import { Link } from "react-router-dom";
import { useSyncNFEstado } from "@/hooks/useSyncNFEstado";

export function SyncNFStatusChip() {
  const estado = useSyncNFEstado();

  if (estado.running) {
    return (
      <div className="inline-flex items-center gap-1.5 rounded-md border border-primary/40 bg-primary/10 px-2 py-1 text-xs text-primary">
        <Loader2 className="h-3 w-3 animate-spin" />
        <span className="font-medium">Sincronizando NFs</span>
        {estado.progress && <span className="text-primary/80">• {estado.progress}</span>}
      </div>
    );
  }

  if (estado.lastError) {
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-md border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive"
        title={estado.lastError}
      >
        <AlertTriangle className="h-3 w-3" />
        <span>Última sync falhou{estado.lastFinishedAt ? ` há ${formatDistanceToNow(new Date(estado.lastFinishedAt), { locale: ptBR })}` : ""}</span>
      </div>
    );
  }

  if (estado.lastResult && estado.lastFinishedAt) {
    const r = estado.lastResult;
    return (
      <div
        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/40 bg-emerald-500/10 px-2 py-1 text-xs text-emerald-600 dark:text-emerald-400"
        title={`Período: ${r.dataInicio} → ${r.dataFim}\n${r.compras} pedidos, ${r.produtos} produtos, ${r.xmls} XMLs, ${r.pendentes} pendentes\n${r.fretes_processados} fretes rateados (R$ ${r.frete_valor_total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })})`}
      >
        <CheckCircle className="h-3 w-3" />
        <span>
          Última sync há {formatDistanceToNow(new Date(estado.lastFinishedAt), { locale: ptBR })}
          <span className="text-emerald-600/70 dark:text-emerald-400/70"> • {r.produtos} produtos</span>
          {r.fretes_processados > 0 && (
            <span className="text-emerald-600/70 dark:text-emerald-400/70"> • {r.fretes_processados} fretes</span>
          )}
        </span>
      </div>
    );
  }

  return (
    <div className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
      <Clock className="h-3 w-3" />
      <span>Nenhuma sincronização registrada</span>
    </div>
  );
}
