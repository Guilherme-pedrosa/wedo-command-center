import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Loader2, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { formatCurrency } from "@/lib/format";
import { cn } from "@/lib/utils";

interface BaixaItem {
  descricao: string;
  valor: number;
  gc_baixado: boolean;
}

interface Props {
  open: boolean;
  onClose: () => void;
  titulo: string;
  itens: BaixaItem[];
  valorTotal: number;
  onConfirmar: (dataLiquidacao: string) => Promise<void>;
}

export function ConfirmarBaixaModal({ open, onClose, titulo, itens, valorTotal, onConfirmar }: Props) {
  const [confirmText, setConfirmText] = useState("");
  const [dataLiq, setDataLiq] = useState<Date>(new Date());
  const [executing, setExecuting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendentes = itens.filter(i => !i.gc_baixado);
  const canConfirm = confirmText === "CONFIRMAR" && dataLiq && !executing;

  const handleConfirm = async () => {
    setExecuting(true);
    setError(null);
    try {
      await onConfirmar(format(dataLiq, "yyyy-MM-dd"));
      setDone(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExecuting(false);
    }
  };

  const handleClose = () => {
    if (executing) return;
    setConfirmText("");
    setDone(false);
    setError(null);
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={e => executing && e.preventDefault()}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="h-5 w-5 text-destructive" />
            {titulo}
          </DialogTitle>
        </DialogHeader>

        <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive">
          Esta operação <strong>NÃO pode ser desfeita</strong> via sistema. O GestãoClick não permite estorno via API.
        </div>

        <div className="max-h-48 overflow-y-auto rounded-md border border-border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50 sticky top-0">
              <tr>
                <th className="p-2 text-left text-muted-foreground">Descrição</th>
                <th className="p-2 text-right text-muted-foreground">Valor</th>
                <th className="p-2 text-center text-muted-foreground">Status</th>
              </tr>
            </thead>
            <tbody>
              {itens.map((item, i) => (
                <tr key={i} className="border-t border-border">
                  <td className="p-2 text-foreground truncate max-w-[200px]">{item.descricao}</td>
                  <td className="p-2 text-right text-foreground font-medium">{formatCurrency(item.valor)}</td>
                  <td className="p-2 text-center">
                    {item.gc_baixado ? (
                      <span className="text-wedo-green flex items-center justify-center gap-1"><CheckCircle className="h-3 w-3" /> Baixado</span>
                    ) : (
                      <span className="text-wedo-orange">⏳ Pendente</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between text-sm font-semibold text-foreground bg-muted/50 rounded-md p-3">
          <span>Total ({pendentes.length} pendente{pendentes.length !== 1 ? "s" : ""})</span>
          <span>{formatCurrency(valorTotal)}</span>
        </div>

        {!done && (
          <>
            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Data de liquidação *</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(dataLiq, "dd/MM/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar mode="single" selected={dataLiq} onSelect={d => d && setDataLiq(d)} locale={ptBR} className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Digite CONFIRMAR para prosseguir</Label>
              <Input value={confirmText} onChange={e => setConfirmText(e.target.value)} placeholder="CONFIRMAR" disabled={executing} />
            </div>

            {executing && <Progress value={50} className="h-2" />}

            <Button variant="destructive" className="w-full" onClick={handleConfirm} disabled={!canConfirm}>
              {executing ? <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processando...</> : "Enviar Baixa para GC"}
            </Button>
          </>
        )}

        {done && (
          <div className="space-y-3">
            <div className="rounded-md bg-wedo-green/10 border border-wedo-green/30 p-3 text-sm text-wedo-green flex items-center gap-2">
              <CheckCircle className="h-4 w-4" /> Baixa concluída com sucesso!
            </div>
            <Button variant="outline" className="w-full" onClick={handleClose}>Fechar</Button>
          </div>
        )}

        {error && (
          <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 text-sm text-destructive flex items-center gap-2">
            <XCircle className="h-4 w-4" /> {error}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
