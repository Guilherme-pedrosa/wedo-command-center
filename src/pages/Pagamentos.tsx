import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { EmptyState } from "@/components/EmptyState";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { CreditCard, Search, RefreshCw, Loader2, Plus } from "lucide-react";
import { formatCurrency, formatDate } from "@/lib/format";
import { syncPagamentos } from "@/api/syncService";
import toast from "react-hot-toast";

type Pagamento = {
  id: string;
  gc_id: string;
  gc_codigo: string | null;
  descricao: string | null;
  valor: number;
  nome_fornecedor: string | null;
  data_vencimento: string | null;
  liquidado: boolean | null;
};

export default function Pagamentos() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [showLiquidated, setShowLiquidated] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: pagamentos, isLoading } = useQuery({
    queryKey: ["pagamentos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gc_pagamentos")
        .select("id, gc_id, gc_codigo, descricao, valor, nome_fornecedor, data_vencimento, liquidado")
        .order("data_vencimento", { ascending: true });
      if (error) throw error;
      return (data || []) as Pagamento[];
    },
  });

  const hoje = new Date().toISOString().split("T")[0];

  const filtered = useMemo(() => {
    if (!pagamentos) return [];
    return pagamentos.filter((p) => {
      if (!showLiquidated && p.liquidado) return false;
      if (overdueOnly && !(p.data_vencimento && p.data_vencimento < hoje && !p.liquidado)) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!(p.nome_fornecedor?.toLowerCase().includes(s) || p.descricao?.toLowerCase().includes(s) || p.gc_codigo?.includes(s))) return false;
      }
      return true;
    });
  }, [pagamentos, search, showLiquidated, overdueOnly, hoje]);

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncPagamentos();
      toast.success(`Importados: ${result.importados} pagamentos`);
      queryClient.invalidateQueries({ queryKey: ["pagamentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setSyncing(false);
    }
  };

  const statusBadge = (p: Pagamento) => {
    if (p.liquidado) return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">Pago</Badge>;
    if (p.data_vencimento && p.data_vencimento < hoje) return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">Vencido</Badge>;
    return <Badge variant="outline" className="bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 text-[10px]">Pendente</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Contas a Pagar</h1>
          <p className="text-sm text-muted-foreground">Lançamentos a pagar importados do GestãoClick</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sincronizar GC
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar fornecedor, descrição..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="liquidated-p" checked={showLiquidated} onCheckedChange={setShowLiquidated} />
          <Label htmlFor="liquidated-p" className="text-xs text-muted-foreground">Pagos</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="overdue-p" checked={overdueOnly} onCheckedChange={setOverdueOnly} />
          <Label htmlFor="overdue-p" className="text-xs text-muted-foreground">Vencidos</Label>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Código</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={6} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="p-0">
                  <EmptyState icon={CreditCard} title="Nenhum pagamento" description="Importe os pagamentos do GestãoClick para visualizar." action={{ label: "Importar agora", onClick: handleSync }} />
                </td></tr>
              ) : (
                filtered.map((p) => (
                  <tr key={p.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                    <td className="p-3 text-foreground font-mono text-xs">{p.gc_codigo}</td>
                    <td className="p-3 text-foreground max-w-[250px] truncate">{p.descricao}</td>
                    <td className="p-3 text-foreground">{p.nome_fornecedor || "—"}</td>
                    <td className="p-3 text-foreground">{p.data_vencimento ? formatDate(p.data_vencimento) : "—"}</td>
                    <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(p.valor)}</td>
                    <td className="p-3 text-center">{statusBadge(p)}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
