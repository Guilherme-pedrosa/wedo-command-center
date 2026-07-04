import { useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { CalendarIcon, Loader2, RefreshCw, CheckCircle } from "lucide-react";
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

interface Result {
  compras: number;
  produtos: number;
  xmls: number;
  pendentes: number;
  fretes_processados?: number;
  fretes_ignorados?: number;
  frete_valor_total?: number;
}

export function SyncNFPorPeriodoDialog({ open, onOpenChange, onDone }: Props) {
  const [dataInicio, setDataInicio] = useState<Date>(startOfMonth(new Date()));
  const [dataFim, setDataFim] = useState<Date>(new Date());
  const [apenasSemNf, setApenasSemNf] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState<Result | null>(null);

  const handleRun = async () => {
    setRunning(true);
    setResult(null);
    setProgress("Iniciando...");
    try {
      let offset = 0;
      const batchSize = 60;
      let totalCompras = 0;
      let totalProdutos = 0;
      let totalXmls = 0;
      let totalPendentes = 0;

      while (true) {
        const { data, error } = await supabase.functions.invoke("sync-nfe-entrada", {
          body: {
            offset,
            batch_size: batchSize,
            data_inicio: format(dataInicio, "yyyy-MM-dd"),
            data_fim: format(dataFim, "yyyy-MM-dd"),
            apenas_sem_nf: apenasSemNf,
            // Reindex só no primeiro lote pra não estourar tempo
            skip_reindex: offset > 0,
          },
        });
        if (error) throw new Error(error.message);

        totalCompras = data.total_compras || totalCompras;
        totalProdutos += data.upserted || 0;
        totalXmls += data.xmls_lidos || 0;
        totalPendentes += data.pendentes_registrados || 0;
        const processed = Math.min(offset + (data.processed || 0), totalCompras);
        setProgress(`${processed}/${totalCompras} pedidos processados`);

        if (!data.has_more) break;
        offset = data.next_offset;
      }

      setProgress("Rateando fretes do período...");
      let fretesProcessados = 0;
      let fretesIgnorados = 0;
      let freteValorTotal = 0;
      try {
        const { data: freteData, error: freteErr } = await supabase.functions.invoke("ratear-frete-compras", {
          body: {
            data_inicio: format(dataInicio, "yyyy-MM-dd"),
            data_fim: format(dataFim, "yyyy-MM-dd"),
          },
        });
        if (freteErr) throw new Error(freteErr.message);
        fretesProcessados = freteData?.fretes_processados || 0;
        fretesIgnorados = freteData?.ja_aplicados_ignorados || 0;
        freteValorTotal = freteData?.total_rateado || 0;
      } catch (fe) {
        // não bloqueia o resultado do sync principal
        console.warn("Falha no rateio de frete:", fe);
      }

      setResult({
        compras: totalCompras,
        produtos: totalProdutos,
        xmls: totalXmls,
        pendentes: totalPendentes,
        fretes_processados: fretesProcessados,
        fretes_ignorados: fretesIgnorados,
        frete_valor_total: freteValorTotal,
      });
      toast.success(
        `Sincronizado: ${totalProdutos} produto(s) de ${totalCompras} pedido(s)` +
          (fretesProcessados > 0 ? ` • ${fretesProcessados} frete(s) rateado(s)` : ""),
      );
      onDone?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      toast.error(`Erro: ${msg}`);
      setProgress("");
    } finally {
      setRunning(false);
    }
  };

  const close = (v: boolean) => {
    if (running) return;
    if (!v) { setResult(null); setProgress(""); }
    onOpenChange(v);
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="h-5 w-5 text-primary" />
            Sincronizar NFs por período
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <p className="text-xs text-muted-foreground">
            Varre os <strong className="text-foreground">pedidos de compra</strong> no período abaixo e, para cada um, procura o XML da NF correspondente para atualizar os tributos dos produtos. Não altera vínculos existentes que não conseguirem ser re-pareados.
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
            <Checkbox
              checked={apenasSemNf}
              onCheckedChange={(v) => setApenasSemNf(v === true)}
              disabled={running}
              className="mt-0.5"
            />
            <span>
              <strong className="text-foreground">Só pedidos sem NF vinculada</strong> — ignora pedidos cujos produtos já têm tributos NF gravados. Útil pra rodadas incrementais rápidas.
            </span>
          </label>

          {progress && (
            <div className="rounded-md bg-muted/40 border border-border p-2 text-xs text-muted-foreground flex items-center gap-2">
              {running && <Loader2 className="h-3 w-3 animate-spin" />}
              {progress}
            </div>
          )}

          {result && (
            <div className="grid grid-cols-4 gap-2 text-xs pt-1">
              <div className="rounded-md bg-muted/40 p-2 text-center">
                <div className="text-muted-foreground">Pedidos</div>
                <div className="text-lg font-semibold text-foreground">{result.compras}</div>
              </div>
              <div className="rounded-md bg-emerald-500/10 p-2 text-center">
                <div className="text-emerald-500">Produtos</div>
                <div className="text-lg font-semibold text-emerald-500">{result.produtos}</div>
              </div>
              <div className="rounded-md bg-primary/10 p-2 text-center">
                <div className="text-primary">XMLs</div>
                <div className="text-lg font-semibold text-primary">{result.xmls}</div>
              </div>
              <div className="rounded-md bg-amber-500/10 p-2 text-center">
                <div className="text-amber-500">Pendentes</div>
                <div className="text-lg font-semibold text-amber-500">{result.pendentes}</div>
              </div>
            </div>
          )}

          {result && result.produtos > 0 && (
            <div className="flex items-center gap-2 text-xs text-emerald-500">
              <CheckCircle className="h-3.5 w-3.5" /> Sincronização concluída.
            </div>
          )}

          {result && (result.fretes_processados ?? 0) + (result.fretes_ignorados ?? 0) > 0 && (
            <div className="rounded-md border border-border bg-muted/20 p-2 text-xs text-muted-foreground">
              <strong className="text-foreground">Rateio de frete:</strong> {result.fretes_processados} pedido(s) de frete aplicado(s)
              {result.fretes_ignorados ? `, ${result.fretes_ignorados} já aplicado(s) anteriormente` : ""}
              {result.frete_valor_total ? ` • total rateado R$ ${result.frete_valor_total.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}` : ""}.
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)} disabled={running}>
            {result ? "Fechar" : "Cancelar"}
          </Button>
          <Button onClick={handleRun} disabled={running}>
            {running ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
            {running ? "Sincronizando..." : "Sincronizar"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
