import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CalendarIcon, Loader2, RefreshCw } from "lucide-react";
import { format, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";
import { startSyncNFPeriodo } from "@/lib/syncNFPeriodoManager";
import { useSyncNFEstado } from "@/hooks/useSyncNFEstado";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

export function SyncNFPorPeriodoDialog({ open, onOpenChange, onDone }: Props) {
  const [dataInicio, setDataInicio] = useState<Date>(startOfMonth(new Date()));
  const [dataFim, setDataFim] = useState<Date>(new Date());
  const [apenasSemNf, setApenasSemNf] = useState(false);
  const estado = useSyncNFEstado();

  const handleRun = () => {
    const started = startSyncNFPeriodo({ dataInicio, dataFim, apenasSemNf, onDone });
    if (!started) {
      toast.error("Já existe uma sincronização em andamento.");
      return;
    }
    toast(
      `Sincronização iniciada em segundo plano — você pode continuar usando o sistema.`,
      { icon: "🔄" },
    );
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            Sincronizar NFs por período
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            Roda em <strong className="text-foreground">segundo plano</strong>. Varre os pedidos de compra do período, casa com XMLs de NF e rateia frete automaticamente. Você pode fechar essa janela e continuar trabalhando.
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Data início</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={estado.running}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(dataInicio, "dd/MM/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dataInicio} onSelect={(d) => d && setDataInicio(d)} locale={ptBR} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Data fim</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={estado.running}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(dataFim, "dd/MM/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dataFim} onSelect={(d) => d && setDataFim(d)} locale={ptBR} className="p-3 pointer-events-auto" />
                </PopoverContent>
              </Popover>
            </div>
          </div>

          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox
              checked={apenasSemNf}
              onCheckedChange={(v) => setApenasSemNf(v === true)}
              disabled={estado.running}
              className="mt-0.5"
            />
            <span>
              <strong className="text-foreground">Só pedidos sem NF vinculada</strong> — ignora pedidos cujos produtos já têm tributos NF gravados. Útil pra rodadas incrementais rápidas.
            </span>
          </label>

          {estado.running && (
            <div className="rounded-md bg-primary/10 border border-primary/30 p-2 text-xs text-primary flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Já em execução: {estado.progress || "iniciando..."}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Fechar
          </Button>
          <Button onClick={handleRun} disabled={estado.running}>
            {estado.running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            {estado.running ? "Em execução..." : "Iniciar em segundo plano"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
