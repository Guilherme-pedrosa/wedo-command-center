import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { CalendarIcon, Loader2, CloudUpload, AlertTriangle, CheckCircle, XCircle } from "lucide-react";
import { format, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import toast from "react-hot-toast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDone?: () => void;
}

interface ResultRow {
  lancamento_id: string;
  tabela: string;
  ok: boolean;
  erro?: string;
  gc_id?: string;
}

interface BaixaResponse {
  ok: boolean;
  processados: number;
  sucesso: number;
  falha: number;
  resultados: ResultRow[];
  error?: string;
}

export function BaixarGCDialog({ open, onOpenChange, onDone }: Props) {
  const [dataInicio, setDataInicio] = useState<Date>(startOfMonth(new Date()));
  const [dataFim, setDataFim] = useState<Date>(new Date());
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<BaixaResponse | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("argus-baixa-confirmada", {
        body: {
          mode: "auto",
          dataInicio: format(dataInicio, "yyyy-MM-dd"),
          dataFim: format(dataFim, "yyyy-MM-dd"),
        },
      });
      if (error) throw new Error(error.message);
      const r = data as BaixaResponse;
      setResult(r);
      if (r.processados === 0) {
        toast("Nenhum lançamento conciliado pendente de baixa neste período.", { icon: "ℹ️" });
      } else if (r.falha === 0) {
        toast.success(`${r.sucesso} lançamento(s) baixado(s) no GC!`);
      } else {
        toast.error(`${r.sucesso} OK / ${r.falha} falha(s). Veja detalhes abaixo.`);
      }
      onDone?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Erro ao baixar: ${msg}`);
      setResult({ ok: false, processados: 0, sucesso: 0, falha: 0, resultados: [], error: msg });
    } finally {
      setRunning(false);
    }
  };

  const close = (v: boolean) => {
    if (running) return;
    if (!v) setResult(null);
    onOpenChange(v);
  };

  const falhas = result?.resultados.filter((r) => !r.ok) ?? [];

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <CloudUpload className="h-5 w-5 text-primary" />
            Baixar Financeiros no GC
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="rounded-md bg-muted/40 border border-border p-3 text-xs text-muted-foreground space-y-1">
            <p className="flex items-start gap-1.5">
              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5 text-amber-500" />
              <span>
                Esta ação <strong className="text-foreground">baixa diretamente no GestãoClick</strong> todos os recebimentos e pagamentos já <strong className="text-foreground">conciliados no extrato</strong> (vinculados a transações do Inter) cuja data esteja dentro do período abaixo, e que ainda não foram baixados no GC.
              </span>
            </p>
            <p className="pl-5">
              Diferente do <em>Sincronizar GC</em> (que apenas importa dados), esta operação <strong className="text-destructive">grava no GC</strong> e não pode ser desfeita.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Data início (extrato)</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={running}>
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
              <Label className="text-xs font-medium">Data fim (extrato)</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className={cn("w-full justify-start text-left font-normal text-sm")} disabled={running}>
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

          {result && (
            <div className="space-y-2 pt-2 border-t border-border">
              <div className="grid grid-cols-3 gap-2 text-xs">
                <div className="rounded-md bg-muted/40 p-2 text-center">
                  <div className="text-muted-foreground">Processados</div>
                  <div className="text-lg font-semibold text-foreground">{result.processados}</div>
                </div>
                <div className="rounded-md bg-emerald-500/10 p-2 text-center">
                  <div className="text-emerald-500">Sucesso</div>
                  <div className="text-lg font-semibold text-emerald-500">{result.sucesso}</div>
                </div>
                <div className="rounded-md bg-destructive/10 p-2 text-center">
                  <div className="text-destructive">Falha</div>
                  <div className="text-lg font-semibold text-destructive">{result.falha}</div>
                </div>
              </div>

              {falhas.length > 0 && (
                <div className="max-h-40 overflow-y-auto space-y-1 rounded-md border border-border p-2">
                  {falhas.map((r, i) => (
                    <div key={i} className="flex items-start gap-2 text-[11px] text-destructive">
                      <XCircle className="h-3 w-3 shrink-0 mt-0.5" />
                      <span className="font-mono">{r.gc_id ?? r.lancamento_id.slice(0, 8)}</span>
                      <span className="opacity-75">{r.erro}</span>
                    </div>
                  ))}
                </div>
              )}

              {result.processados > 0 && result.falha === 0 && (
                <div className="flex items-center gap-2 text-xs text-emerald-500">
                  <CheckCircle className="h-3.5 w-3.5" /> Todas as baixas foram concluídas com sucesso.
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={running}>
            {result ? "Fechar" : "Cancelar"}
          </Button>
          <Button onClick={handleRun} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <CloudUpload className="h-4 w-4 mr-2" />}
            {running ? "Baixando..." : "Baixar no GC"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
