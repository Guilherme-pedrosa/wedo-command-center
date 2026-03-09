import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { buscarExtratoInter, extrairNomeDaDescricao } from "@/api/financeiro";
import { Building2, RefreshCw, Loader2 } from "lucide-react";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format, subDays } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";

export default function ExtratoBancoPage() {
  const queryClient = useQueryClient();
  const [dateFrom, setDateFrom] = useState<Date>(subDays(new Date(), 7));
  const [dateTo, setDateTo] = useState<Date>(new Date());
  const [fetching, setFetching] = useState(false);
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [reconcFilter, setReconcFilter] = useState("todos");

  const fromISO = format(dateFrom, "yyyy-MM-dd") + "T00:00:00";
  const toISO = format(dateTo, "yyyy-MM-dd") + "T23:59:59";

  const { data: extrato, isLoading } = useQuery({
    queryKey: ["fin-extrato", fromISO, toISO],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_extrato_inter")
        .select("*")
        .gte("data_hora", fromISO)
        .lte("data_hora", toISO)
        .order("data_hora", { ascending: false })
        .limit(2000);
      return data || [];
    },
  });

  const filtered = extrato?.filter((e: any) => {
    if (tipoFilter !== "todos" && e.tipo !== tipoFilter) return false;
    if (reconcFilter === "sim" && !e.reconciliado) return false;
    if (reconcFilter === "nao" && e.reconciliado) return false;
    return true;
  }) || [];

  const totalCredito = filtered.filter((e: any) => e.tipo === "CREDITO").reduce((s, e: any) => s + Number(e.valor || 0), 0);
  const totalDebito = filtered.filter((e: any) => e.tipo === "DEBITO").reduce((s, e: any) => s + Number(e.valor || 0), 0);

  const handleFetch = async () => {
    setFetching(true);
    try {
      const txs = await buscarExtratoInter(format(dateFrom, "yyyy-MM-dd"), format(dateTo, "yyyy-MM-dd"));
      toast.success(`${txs.length} transações processadas`);
      queryClient.invalidateQueries({ queryKey: ["fin-extrato"] });
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Erro ao buscar extrato";
      toast.error(msg, { duration: 6000 });
    }
    finally { setFetching(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div><h1 className="text-2xl font-bold text-foreground">Extrato Banco Inter</h1><p className="text-sm text-muted-foreground">Transações do extrato bancário</p></div>
        <div className="flex items-center gap-2">
          <Popover><PopoverTrigger asChild><Button variant="outline" size="sm"><CalendarIcon className="mr-2 h-3 w-3" />{format(dateFrom, "dd/MM")}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={dateFrom} onSelect={d => d && setDateFrom(d)} locale={ptBR} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover>
          <span className="text-muted-foreground text-sm">até</span>
          <Popover><PopoverTrigger asChild><Button variant="outline" size="sm"><CalendarIcon className="mr-2 h-3 w-3" />{format(dateTo, "dd/MM")}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={dateTo} onSelect={d => d && setDateTo(d)} locale={ptBR} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover>
          <Button size="sm" onClick={handleFetch} disabled={fetching}>{fetching ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}Buscar do Inter</Button>
        </div>
      </div>

      <div className="flex items-center gap-4">
        <div className="rounded-md bg-wedo-green/10 px-3 py-2 text-sm"><span className="text-muted-foreground">Créditos:</span> <span className="font-semibold text-wedo-green">{formatCurrency(totalCredito)}</span></div>
        <div className="rounded-md bg-wedo-red/10 px-3 py-2 text-sm"><span className="text-muted-foreground">Débitos:</span> <span className="font-semibold text-wedo-red">{formatCurrency(totalDebito)}</span></div>
        <div className="rounded-md bg-muted/50 px-3 py-2 text-sm"><span className="text-muted-foreground">Saldo:</span> <span className="font-semibold">{formatCurrency(totalCredito - totalDebito)}</span></div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}><SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="CREDITO">Crédito</SelectItem><SelectItem value="DEBITO">Débito</SelectItem></SelectContent></Select>
        <Select value={reconcFilter} onValueChange={setReconcFilter}><SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="sim">Reconciliado</SelectItem><SelectItem value="nao">Não reconciliado</SelectItem></SelectContent></Select>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Data/Hora</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Tipo</th>
            <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Remetente / Destinatário</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Reconciliado</th>
          </tr></thead>
          <tbody>
            {isLoading ? <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            : !filtered.length ? <tr><td colSpan={6}><EmptyState icon={Building2} title="Sem transações" description="Busque o extrato do Inter." /></td></tr>
            : filtered.map((e: any) => (
              <tr key={e.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 text-xs">{e.data_hora ? formatDateTime(e.data_hora) : "—"}</td>
                <td className="p-3 text-center"><Badge variant="outline" className={`text-[10px] ${e.tipo === "CREDITO" ? "bg-wedo-green/10 text-wedo-green" : "bg-wedo-red/10 text-wedo-red"}`}>{e.tipo}</Badge></td>
                <td className="p-3 text-right font-semibold">{formatCurrency(Number(e.valor))}</td>
                <td className="p-3">
                  <div className="flex flex-col">
                    <span className="font-medium text-foreground">{e.nome_contraparte || e.contrapartida || extrairNomeDaDescricao(e.descricao) || "—"}</span>
                    {e.cpf_cnpj && <span className="text-[10px] text-muted-foreground">{e.cpf_cnpj}</span>}
                  </div>
                </td>
                <td className="p-3 text-muted-foreground truncate max-w-[200px]">{e.descricao || "—"}</td>
                <td className="p-3 text-center">{e.reconciliado ? <span className="text-wedo-green">✅</span> : <span className="text-muted-foreground">❌</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
