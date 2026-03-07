import { useState, useCallback } from "react";
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
import { baixarRecebimentoNoGC, baixarPagamentoNoGC, gcDelay } from "@/api/financeiro";
import { supabase } from "@/integrations/supabase/client";
import toast from "react-hot-toast";

export interface BaixaItem {
  id: string;
  descricao: string;
  valor: number;
  gc_id: string;
  gc_payload_raw?: Record<string, unknown>;
  gc_baixado?: boolean;
}

interface ItemResult {
  gc_id: string;
  descricao: string;
  ok: boolean;
  erro?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  titulo: string;
  itens: BaixaItem[];
  tipoLancamento: "recebimento" | "pagamento";
  onConfirmar: (dataLiquidacao: string, itens: BaixaItem[]) => Promise<void>;
}

export function ConfirmarBaixaModal({ open, onOpenChange, titulo, itens, tipoLancamento, onConfirmar }: Props) {
  const [confirmText, setConfirmText] = useState("");
  const [dataLiq, setDataLiq] = useState<Date>(new Date());
  const [executing, setExecuting] = useState(false);
  const [done, setDone] = useState(false);
  const [currentItem, setCurrentItem] = useState(0);
  const [results, setResults] = useState<ItemResult[]>([]);

  const pendentes = itens.filter(i => !i.gc_baixado);
  const canConfirm = confirmText === "CONFIRMAR" && dataLiq && !executing && pendentes.length > 0;

  const handleConfirm = useCallback(async () => {
    setExecuting(true);
    setResults([]);
    setCurrentItem(0);
    const dataStr = format(dataLiq, "yyyy-MM-dd");

    try {
      await onConfirmar(dataStr, pendentes);
    } catch {
      // onConfirmar handles its own errors
    }

    // Process items one by one for progress feedback
    const itemResults: ItemResult[] = [];
    for (let i = 0; i < pendentes.length; i++) {
      const item = pendentes[i];
      setCurrentItem(i + 1);

      if (!item.gc_id || !item.gc_payload_raw) {
        itemResults.push({ gc_id: item.gc_id, descricao: item.descricao, ok: false, erro: "Sem gc_id ou payload" });
        continue;
      }

      try {
        if (tipoLancamento === "recebimento") {
          await baixarRecebimentoNoGC(item.gc_id, item.gc_payload_raw, dataStr);
        } else {
          await baixarPagamentoNoGC(item.gc_id, item.gc_payload_raw, dataStr);
        }

        // Update supabase
        const table = tipoLancamento === "recebimento" ? "fin_recebimentos" : "fin_pagamentos";
        await supabase.from(table).update({
          gc_baixado: true,
          gc_baixado_em: new Date().toISOString(),
          liquidado: true,
          status: "pago" as any,
          data_liquidacao: dataStr,
        }).eq("gc_id", item.gc_id);

        itemResults.push({ gc_id: item.gc_id, descricao: item.descricao, ok: true });
      } catch (e) {
        const erro = e instanceof Error ? e.message : String(e);
        itemResults.push({ gc_id: item.gc_id, descricao: item.descricao, ok: false, erro });
      }

      setResults([...itemResults]);
      if (i < pendentes.length - 1) await gcDelay();
    }

    const successCount = itemResults.filter(r => r.ok).length;
    const failCount = itemResults.filter(r => !r.ok).length;

    if (failCount === 0) {
      toast.success(`Baixa concluída: ${successCount} item(ns) processado(s)`);
    } else {
      toast.error(`${failCount} item(ns) falharam. Verifique o Log API.`);
    }

    setDone(true);
    setExecuting(false);
  }, [dataLiq, pendentes, tipoLancamento, onConfirmar]);

  const handleClose = (isOpen: boolean) => {
    if (executing) return;
    if (!isOpen) {
      setConfirmText("");
      setDone(false);
      setResults([]);
      setCurrentItem(0);
    }
    onOpenChange(isOpen);
  };

  const progressPercent = pendentes.length > 0 ? (currentItem / pendentes.length) * 100 : 0;
  const valorTotal = pendentes.reduce((sum, i) => sum + i.valor, 0);

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

        {/* Items table */}
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
              {itens.map((item) => {
                const result = results.find(r => r.gc_id === item.gc_id);
                return (
                  <tr key={item.id} className="border-t border-border">
                    <td className="p-2 text-foreground truncate max-w-[200px]">{item.descricao}</td>
                    <td className="p-2 text-right text-foreground font-medium">{formatCurrency(item.valor)}</td>
                    <td className="p-2 text-center">
                      {item.gc_baixado ? (
                        <span className="text-emerald-500 flex items-center justify-center gap-1 text-[10px]">
                          <CheckCircle className="h-3 w-3" /> Já baixado
                        </span>
                      ) : result?.ok ? (
                        <span className="text-emerald-500 flex items-center justify-center gap-1 text-[10px]">
                          <CheckCircle className="h-3 w-3" /> OK
                        </span>
                      ) : result && !result.ok ? (
                        <span className="text-destructive flex items-center justify-center gap-1 text-[10px]" title={result.erro}>
                          <XCircle className="h-3 w-3" /> Erro
                        </span>
                      ) : (
                        <span className="text-muted-foreground text-[10px]">⏳ Pendente</span>
                      )}
                    </td>
                  </tr>
                );
              })}
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
                  <Button variant="outline" className="w-full justify-start text-left font-normal" disabled={executing}>
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {format(dataLiq, "dd/MM/yyyy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dataLiq}
                    onSelect={d => d && setDataLiq(d)}
                    locale={ptBR}
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">Digite CONFIRMAR para prosseguir</Label>
              <Input
                value={confirmText}
                onChange={e => setConfirmText(e.target.value)}
                placeholder="CONFIRMAR"
                disabled={executing}
              />
            </div>

            {executing && (
              <div className="space-y-1">
                <Progress value={progressPercent} className="h-2" />
                <p className="text-xs text-muted-foreground text-center">
                  Processando item {currentItem} de {pendentes.length}...
                </p>
              </div>
            )}

            <Button
              variant="destructive"
              className="w-full"
              onClick={handleConfirm}
              disabled={!canConfirm}
            >
              {executing ? (
                <><Loader2 className="h-4 w-4 mr-2 animate-spin" /> Processando...</>
              ) : (
                "Enviar Baixa para GC"
              )}
            </Button>
          </>
        )}

        {done && (
          <div className="space-y-3">
            {results.length > 0 && (
              <div className="max-h-32 overflow-y-auto space-y-1">
                {results.map((r, i) => (
                  <div key={i} className={cn(
                    "flex items-center gap-2 text-xs p-1.5 rounded",
                    r.ok ? "bg-emerald-500/10 text-emerald-500" : "bg-destructive/10 text-destructive"
                  )}>
                    {r.ok ? <CheckCircle className="h-3 w-3 shrink-0" /> : <XCircle className="h-3 w-3 shrink-0" />}
                    <span className="truncate">{r.gc_id} — {r.descricao}</span>
                    {r.erro && <span className="ml-auto text-[10px] opacity-75 truncate max-w-[120px]">{r.erro}</span>}
                  </div>
                ))}
              </div>
            )}

            {results.some(r => !r.ok) && (
              <div className="rounded-md bg-destructive/10 border border-destructive/30 p-3 text-xs text-destructive">
                {results.filter(r => !r.ok).length} item(ns) falharam. Verifique o Log API em /financeiro/log.
              </div>
            )}

            <Button variant="outline" className="w-full" onClick={() => handleClose(false)}>
              Fechar
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
