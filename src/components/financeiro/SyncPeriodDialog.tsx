import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { CalendarIcon, Loader2, RefreshCw, CheckCircle, AlertTriangle } from "lucide-react";
import { format, subMonths, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";

export interface SyncProgress {
  etapa: string;
  atual: number;
  total: number;
}

interface SyncPeriodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSync: (
    filtros: { dataInicio: string; dataFim: string; incluirLiquidados: boolean },
    onProgress?: (atual: number, total: number) => void,
    onStep?: (etapa: string) => void
  ) => Promise<void>;
  title?: string;
  loading?: boolean;
}

export function SyncPeriodDialog({ open, onOpenChange, onSync, title = "Sincronizar com GestãoClick", loading }: SyncPeriodDialogProps) {
  const [dataInicio, setDataInicio] = useState<Date>(new Date(2025, 11, 1)); // Dec 2025
  const [dataFim, setDataFim] = useState<Date>(new Date());
  // incluirLiquidados always true — we always import all records
  const [progress, setProgress] = useState<SyncProgress | null>(null);
  const [etapasConcluidas, setEtapasConcluidas] = useState<string[]>([]);
  const [syncResult, setSyncResult] = useState<string | null>(null);
  const [running, setRunning] = useState(false);

  const handleSync = async () => {
    setProgress({ etapa: "Iniciando...", atual: 0, total: 0 });
    setEtapasConcluidas([]);
    setSyncResult(null);
    setRunning(true);
    
    const onStep = (etapa: string) => {
      setProgress(prev => {
        if (prev?.etapa && prev.etapa !== etapa) {
          setEtapasConcluidas(old => [...old, prev.etapa]);
        }
        return { etapa, atual: 0, total: 0 };
      });
    };

    const onProgress = (atual: number, total: number) => {
      setProgress(prev => ({ etapa: prev?.etapa || "Importando...", atual, total }));
    };

    try {
      await onSync(
        {
          dataInicio: format(dataInicio, "yyyy-MM-dd"),
          dataFim: format(dataFim, "yyyy-MM-dd"),
          incluirLiquidados: true, // Always import all records
        },
        onProgress,
        onStep
      );
      setProgress(null);
      setSyncResult("✅ Sincronização concluída! Verifique os dados nas páginas de Recebimentos e Pagamentos.");
    } catch (err) {
      setProgress(null);
      setSyncResult("⚠️ Erro na sincronização. Tente novamente com um período menor.");
    } finally {
      setRunning(false);
      setEtapasConcluidas([]);
    }
  };

  const isDisabled = loading || running;
  const pct = progress && progress.total > 0 ? Math.round((progress.atual / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!isDisabled) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            Selecione o período de vencimento para buscar os lançamentos do GestãoClick.
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Data início</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={isDisabled}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(dataInicio, "dd/MM/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dataInicio} onSelect={(d) => d && setDataInicio(d)} locale={ptBR} />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Data fim</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={isDisabled}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(dataFim, "dd/MM/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dataFim} onSelect={(d) => d && setDataFim(d)} locale={ptBR} />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <p className="text-[11px] text-muted-foreground flex items-start gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
            O filtro usa a data de vencimento do GestãoClick. Todos os lançamentos do período serão importados (abertos e pagos), exceto os cancelados localmente.
          </p>

          {/* Progress section — no dependency on external loading prop */}
          {progress && (
            <div className="space-y-3 pt-2 border-t border-border">
              {/* Etapas concluídas */}
              {etapasConcluidas.map((etapa, i) => (
                <div key={i} className="flex items-center gap-2 text-xs text-emerald-500">
                  <CheckCircle className="h-3.5 w-3.5 flex-shrink-0" />
                  <span>{etapa}</span>
                </div>
              ))}

              {/* Etapa atual */}
              <div className="flex items-center gap-2 text-sm font-medium text-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin flex-shrink-0" />
                <span>{progress.etapa}</span>
              </div>

              {/* Barra de progresso */}
              {progress.total > 0 ? (
                <div className="space-y-1">
                  <Progress value={pct} className="h-2" />
                  <div className="flex items-center justify-between text-[11px] text-muted-foreground">
                    <span>{progress.atual} de {progress.total} registros</span>
                    <span className="font-mono">{pct}%</span>
                  </div>
                </div>
              ) : (
                <div className="space-y-1">
                  <Progress className="h-2" />
                  <p className="text-[11px] text-muted-foreground">Buscando registros do GestãoClick...</p>
                </div>
              )}
            </div>
          )}

          {/* Result section */}
          {!progress && syncResult && (
            <div className="rounded-md border border-border bg-muted/30 p-3 text-sm text-foreground">
              {syncResult}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isDisabled}>
            {syncResult ? "Fechar" : "Cancelar"}
          </Button>
          <Button onClick={handleSync} disabled={isDisabled}>
            {isDisabled ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sincronizar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
