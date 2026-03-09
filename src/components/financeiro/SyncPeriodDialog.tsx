import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { CalendarIcon, Loader2, RefreshCw } from "lucide-react";
import { format, subMonths, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";

interface SyncPeriodDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSync: (filtros: { dataInicio: string; dataFim: string; incluirLiquidados: boolean }, onProgress?: (atual: number, total: number) => void) => Promise<void>;
  title?: string;
  loading?: boolean;
}

export function SyncPeriodDialog({ open, onOpenChange, onSync, title = "Sincronizar com Gest\u00e3oClick", loading }: SyncPeriodDialogProps) {
  const [dataInicio, setDataInicio] = useState<Date>(startOfMonth(subMonths(new Date(), 1)));
  const [dataFim, setDataFim] = useState<Date>(new Date());
  const [incluirLiquidados, setIncluirLiquidados] = useState(false);
  const [progress, setProgress] = useState<{ atual: number; total: number } | null>(null);

  const handleSync = async () => {
    setProgress({ atual: 0, total: 0 });
    await onSync(
      {
        dataInicio: format(dataInicio, "yyyy-MM-dd"),
        dataFim: format(dataFim, "yyyy-MM-dd"),
        incluirLiquidados,
      },
      (atual, total) => setProgress({ atual, total })
    );
    setProgress(null);
  };

  const pct = progress && progress.total > 0 ? Math.round((progress.atual / progress.total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!loading) onOpenChange(v); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5" />
            {title}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-sm text-muted-foreground">
            {`Selecione o per\u00edodo de vencimento para buscar os lan\u00e7amentos do Gest\u00e3oClick.`}
          </p>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">{`Data in\u00edcio`}</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={loading}>
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
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={loading}>
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

          <div className="flex items-center gap-2">
            <Switch
              id="incluir-liquidados"
              checked={incluirLiquidados}
              onCheckedChange={setIncluirLiquidados}
              disabled={loading}
            />
            <Label htmlFor="incluir-liquidados" className="text-sm">
              {`Incluir liquidados (j\u00e1 pagos)`}
            </Label>
          </div>

          {/* Progress bar */}
          {loading && progress && (
            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>Importando registros...</span>
                <span className="font-mono">
                  {progress.atual} / {progress.total > 0 ? progress.total : "?"} ({progress.total > 0 ? pct : 0}%)
                </span>
              </div>
              <Progress value={progress.total > 0 ? pct : undefined} className="h-2" />
              {progress.total === 0 && (
                <p className="text-[11px] text-muted-foreground">Buscando registros do GestãoClick...</p>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancelar
          </Button>
          <Button onClick={handleSync} disabled={loading}>
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            Sincronizar
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
