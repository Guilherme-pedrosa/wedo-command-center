import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CalendarIcon, Loader2, Truck, CheckCircle, AlertTriangle } from "lucide-react";
import { format, startOfMonth } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import toast from "react-hot-toast";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

interface FreteResultado {
  frete_codigo: string;
  frete_valor?: number;
  status: string;
  detalhe?: string;
  itens?: number;
  aplicados_em_tributos?: number;
  refs_faltantes?: string[];
  gc_jobs_enfileirados?: number;
}

interface RateioResponse {
  fretes_detectados: number;
  fretes_processados: number;
  ja_aplicados_ignorados: number;
  total_rateado: number;
  resultados: FreteResultado[];
}

export function RatearFreteDialog({ open, onOpenChange }: Props) {
  const [dataInicio, setDataInicio] = useState<Date>(startOfMonth(new Date()));
  const [dataFim, setDataFim] = useState<Date>(new Date());
  const [force, setForce] = useState(false);
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<RateioResponse | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("ratear-frete-compras", {
        body: {
          data_inicio: format(dataInicio, "yyyy-MM-dd"),
          data_fim: format(dataFim, "yyyy-MM-dd"),
          force,
        },
      });
      if (error) throw new Error(error.message);
      if (!data?.ok && data?.error) throw new Error(data.error);
      setResult(data as RateioResponse);
      if ((data?.fretes_processados ?? 0) === 0 && (data?.fretes_detectados ?? 0) === 0) {
        toast(`Nenhum pedido de frete encontrado no período.`);
      } else {
        toast.success(`${data.fretes_processados} frete(s) rateado(s) • total R$ ${(data.total_rateado || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}`);
      }
    } catch (err) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setRunning(false);
    }
  };

  const close = (v: boolean) => {
    if (running) return;
    if (!v) setResult(null);
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Truck className="h-5 w-5 text-primary" />
            Ratear frete de compras
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            Busca pedidos de compra no período que tenham o campo <strong className="text-foreground">"FRETE - Pedidos de Compras..."</strong> preenchido e rateia o valor total do frete entre os itens dos pedidos referenciados (proporcional ao valor do item).
          </p>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs font-medium">Data início</Label>
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
              <Label className="text-xs font-medium">Data fim</Label>
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

          <label className="flex items-start gap-2 text-xs text-muted-foreground cursor-pointer">
            <Checkbox checked={force} onCheckedChange={(v) => setForce(v === true)} disabled={running} className="mt-0.5" />
            <span>
              <strong className="text-foreground">Reaplicar fretes já rateados</strong> — reverte o rateio anterior e aplica de novo. Use se corrigiu o valor do frete ou os pedidos referenciados no GC.
            </span>
          </label>

          {result && (
            <div className="space-y-3 pt-1">
              <div className="grid grid-cols-4 gap-2 text-xs">
                <div className="rounded-md bg-muted/40 p-2 text-center">
                  <div className="text-muted-foreground">Detectados</div>
                  <div className="text-lg font-semibold">{result.fretes_detectados}</div>
                </div>
                <div className="rounded-md bg-emerald-500/10 p-2 text-center">
                  <div className="text-emerald-500">Rateados</div>
                  <div className="text-lg font-semibold text-emerald-500">{result.fretes_processados}</div>
                </div>
                <div className="rounded-md bg-muted/40 p-2 text-center">
                  <div className="text-muted-foreground">Já aplicados</div>
                  <div className="text-lg font-semibold">{result.ja_aplicados_ignorados}</div>
                </div>
                <div className="rounded-md bg-primary/10 p-2 text-center">
                  <div className="text-primary">Total R$</div>
                  <div className="text-sm font-semibold text-primary">{(result.total_rateado || 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</div>
                </div>
              </div>

              {result.resultados?.length > 0 && (
                <div className="rounded-md border border-border max-h-64 overflow-y-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-muted/40 sticky top-0">
                      <tr>
                        <th className="px-2 py-1.5 text-left">Frete</th>
                        <th className="px-2 py-1.5 text-right">Valor</th>
                        <th className="px-2 py-1.5 text-center">Itens</th>
                        <th className="px-2 py-1.5 text-center">Aplicados</th>
                        <th className="px-2 py-1.5 text-left">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.resultados.map((r, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-2 py-1.5 font-mono">{r.frete_codigo}</td>
                          <td className="px-2 py-1.5 text-right">{r.frete_valor ? `R$ ${r.frete_valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : "-"}</td>
                          <td className="px-2 py-1.5 text-center">{r.itens ?? "-"}</td>
                          <td className="px-2 py-1.5 text-center">{r.aplicados_em_tributos ?? "-"}</td>
                          <td className="px-2 py-1.5">
                            {r.status === "aplicado" ? (
                              <span className="inline-flex items-center gap-1 text-emerald-500">
                                <CheckCircle className="h-3 w-3" /> aplicado
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-amber-500" title={r.detalhe}>
                                <AlertTriangle className="h-3 w-3" /> {r.status}
                              </span>
                            )}
                            {r.refs_faltantes && r.refs_faltantes.length > 0 && (
                              <div className="text-[10px] text-amber-500/80">faltantes: {r.refs_faltantes.join(", ")}</div>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Truck className="h-4 w-4 mr-2" />}
            {running ? "Rateando..." : "Ratear frete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
