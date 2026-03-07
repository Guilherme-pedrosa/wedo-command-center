import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { EmptyState } from "@/components/EmptyState";
import { formatCurrency, formatDate } from "@/lib/format";
import { syncPagamentosGC, baixarPagamentoNoGC } from "@/api/financeiro";
import { ConfirmarBaixaModal } from "@/components/financeiro/ConfirmarBaixaModal";
import { CreditCard, Search, RefreshCw, Plus, Loader2, Zap } from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon } from "lucide-react";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";

export default function PagamentosPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [pendenteBaixaGC, setPendenteBaixaGC] = useState(false);
  const [semGrupo, setSemGrupo] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showBaixa, setShowBaixa] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupObs, setGroupObs] = useState("");
  const [groupDate, setGroupDate] = useState<Date | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const hoje = new Date().toISOString().split("T")[0];

  const { data: pagamentos, isLoading } = useQuery({
    queryKey: ["fin-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_pagamentos").select("*").order("data_vencimento", { ascending: true }).limit(500);
      return data || [];
    },
  });

  const filtered = useMemo(() => {
    if (!pagamentos) return [];
    return pagamentos.filter((p: any) => {
      if (statusFilter !== "todos" && p.status !== statusFilter) return false;
      if (pendenteBaixaGC && !(p.pago_sistema && !p.gc_baixado)) return false;
      if (semGrupo && p.grupo_id) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!(p.nome_fornecedor?.toLowerCase().includes(s) || p.descricao?.toLowerCase().includes(s) || p.gc_codigo?.includes(s))) return false;
      }
      return true;
    });
  }, [pagamentos, search, statusFilter, pendenteBaixaGC, semGrupo]);

  const selectedItems = filtered.filter((p: any) => selected.has(p.id));
  const selectedTotal = selectedItems.reduce((s, p: any) => s + Number(p.valor || 0), 0);
  const canSelect = (p: any) => !p.liquidado && !p.grupo_id;

  const handleSync = async () => {
    setSyncing(true);
    try {
      const r = await syncPagamentosGC();
      toast.success(`Importados: ${r.importados} pagamentos`);
      queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setSyncing(false); }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) return;
    setCreating(true);
    try {
      const items = selectedItems;
      const total = items.reduce((s, p: any) => s + Number(p.valor || 0), 0);
      const { data: grupo, error: gErr } = await supabase.from("fin_grupos_pagar").insert({
        nome: groupName, nome_fornecedor: (items[0] as any)?.nome_fornecedor, valor_total: total,
        itens_total: items.length, data_vencimento: groupDate ? format(groupDate, "yyyy-MM-dd") : null, observacao: groupObs || null,
      }).select().single();
      if (gErr) throw gErr;
      const grupoItens = items.map((p: any) => ({ grupo_id: (grupo as any).id, pagamento_id: p.id, valor: Number(p.valor) }));
      await supabase.from("fin_grupo_pagar_itens").insert(grupoItens);
      await supabase.from("fin_pagamentos").update({ grupo_id: (grupo as any).id }).in("id", items.map((p: any) => p.id));
      toast.success(`Grupo criado com ${items.length} itens`);
      setSelected(new Set()); setShowCreateGroup(false);
      queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setCreating(false); }
  };

  const statusBadge = (p: any) => {
    if (p.status === "pago") return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">Pago</Badge>;
    if (p.status === "vencido" || (!p.liquidado && p.data_vencimento && p.data_vencimento < hoje)) return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">Vencido</Badge>;
    return <Badge variant="outline" className="bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 text-[10px]">Pendente</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div><h1 className="text-2xl font-bold text-foreground">Pagamentos</h1><p className="text-sm text-muted-foreground">Lançamentos a pagar</p></div>
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>{syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}Sincronizar GC</Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm"><Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" /><Input placeholder="Buscar fornecedor, descrição..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" /></div>
        <Select value={statusFilter} onValueChange={setStatusFilter}><SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="pendente">Pendente</SelectItem><SelectItem value="pago">Pago</SelectItem><SelectItem value="vencido">Vencido</SelectItem></SelectContent></Select>
        <div className="flex items-center gap-2"><Switch id="baixa-gc-p" checked={pendenteBaixaGC} onCheckedChange={setPendenteBaixaGC} /><Label htmlFor="baixa-gc-p" className="text-xs text-muted-foreground">Pendente baixa GC</Label></div>
        <div className="flex items-center gap-2"><Switch id="sem-grupo-p" checked={semGrupo} onCheckedChange={setSemGrupo} /><Label htmlFor="sem-grupo-p" className="text-xs text-muted-foreground">Sem grupo</Label></div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-border bg-muted/50">
              <th className="p-3 w-10"><Checkbox checked={filtered.filter(canSelect).length > 0 && selected.size === filtered.filter(canSelect).length} onCheckedChange={() => { const s = filtered.filter(canSelect); setSelected(selected.size === s.length ? new Set() : new Set(s.map((p: any) => p.id))); }} /></th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cód GC</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
              <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
              <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
              <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Baixa GC</th>
            </tr></thead>
            <tbody>
              {isLoading ? <tr><td colSpan={8} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
              : filtered.length === 0 ? <tr><td colSpan={8}><EmptyState icon={CreditCard} title="Nenhum pagamento" description="Sincronize os dados." action={{ label: "Sincronizar", onClick: handleSync }} /></td></tr>
              : filtered.map((p: any) => (
                <tr key={p.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3">{canSelect(p) ? <Checkbox checked={selected.has(p.id)} onCheckedChange={() => { const n = new Set(selected); n.has(p.id) ? n.delete(p.id) : n.add(p.id); setSelected(n); }} /> : <Checkbox disabled />}</td>
                  <td className="p-3 font-mono text-xs">{p.gc_codigo || "—"}</td>
                  <td className="p-3 max-w-[200px] truncate">{p.descricao}</td>
                  <td className="p-3">{p.nome_fornecedor || "—"}</td>
                  <td className="p-3 text-right font-semibold">{formatCurrency(Number(p.valor))}</td>
                  <td className="p-3">{p.data_vencimento ? formatDate(p.data_vencimento) : "—"}</td>
                  <td className="p-3 text-center">{statusBadge(p)}</td>
                  <td className="p-3 text-center">{p.gc_baixado ? <span className="text-wedo-green text-[10px]">✅</span> : p.pago_sistema ? <Badge variant="outline" className="bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30 text-[10px] animate-pulse">⚡</Badge> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4 flex items-center justify-between z-50">
          <span className="text-sm">{selected.size} selecionados · <span className="font-semibold">{formatCurrency(selectedTotal)}</span></span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
            <Button size="sm" onClick={() => { setGroupName(`Pagamentos — ${format(new Date(), "dd/MM/yyyy")}`); setShowCreateGroup(true); }}><Plus className="h-3.5 w-3.5 mr-1.5" />Criar Grupo</Button>
            {selectedItems.some((p: any) => p.pago_sistema && !p.gc_baixado) && <Button size="sm" variant="destructive" onClick={() => setShowBaixa(true)}><Zap className="h-3.5 w-3.5 mr-1.5" />Baixar GC</Button>}
          </div>
        </div>
      )}

      <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
        <DialogContent className="sm:max-w-lg"><DialogHeader><DialogTitle>Criar Grupo de Pagamentos</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Nome *</Label><Input value={groupName} onChange={e => setGroupName(e.target.value)} /></div>
            <div className="space-y-2"><Label>Vencimento</Label><Popover><PopoverTrigger asChild><Button variant="outline" className="w-full justify-start"><CalendarIcon className="mr-2 h-4 w-4" />{groupDate ? format(groupDate, "dd/MM/yyyy") : "Selecionar"}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={groupDate} onSelect={setGroupDate} locale={ptBR} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover></div>
            <div className="space-y-2"><Label>Observação</Label><Textarea value={groupObs} onChange={e => setGroupObs(e.target.value)} /></div>
            <div className="bg-muted/50 rounded-md p-3 text-sm font-semibold flex justify-between"><span>{selected.size} itens</span><span>{formatCurrency(selectedTotal)}</span></div>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => setShowCreateGroup(false)}>Cancelar</Button><Button onClick={handleCreateGroup} disabled={creating || !groupName.trim()}>{creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Criar</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmarBaixaModal open={showBaixa} onClose={() => { setShowBaixa(false); queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] }); }}
        titulo="Baixa de Pagamentos no GC" itens={selectedItems.map((p: any) => ({ descricao: p.descricao, valor: Number(p.valor), gc_baixado: p.gc_baixado }))} valorTotal={selectedTotal}
        onConfirmar={async (dataLiq) => { for (const p of selectedItems as any[]) { if (p.gc_id && p.gc_payload_raw && !p.gc_baixado) { await baixarPagamentoNoGC(p.gc_id, p.gc_payload_raw, dataLiq); await supabase.from("fin_pagamentos").update({ gc_baixado: true, gc_baixado_em: new Date().toISOString(), liquidado: true, status: "pago", data_liquidacao: dataLiq }).eq("id", p.id); } } }} />
    </div>
  );
}
