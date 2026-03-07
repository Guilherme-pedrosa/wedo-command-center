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
import { syncRecebimentosGC } from "@/api/financeiro";
import { ConfirmarBaixaModal } from "@/components/financeiro/ConfirmarBaixaModal";
import { baixarRecebimentoNoGC } from "@/api/financeiro";
import { Receipt, Search, RefreshCw, Plus, Loader2, Zap } from "lucide-react";
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

export default function RecebimentosPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [tipoFilter, setTipoFilter] = useState("todos");
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

  const { data: recebimentos, isLoading } = useQuery({
    queryKey: ["fin-recebimentos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_recebimentos")
        .select("*")
        .order("data_vencimento", { ascending: true })
        .limit(500);
      if (error) throw error;
      return data || [];
    },
  });

  const filtered = useMemo(() => {
    if (!recebimentos) return [];
    return recebimentos.filter((r: any) => {
      if (statusFilter !== "todos" && r.status !== statusFilter) return false;
      if (tipoFilter !== "todos" && r.tipo !== tipoFilter) return false;
      if (pendenteBaixaGC && !(r.pago_sistema && !r.gc_baixado)) return false;
      if (semGrupo && r.grupo_id) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!(r.nome_cliente?.toLowerCase().includes(s) || r.descricao?.toLowerCase().includes(s) || r.gc_codigo?.includes(s) || r.os_codigo?.includes(s))) return false;
      }
      return true;
    });
  }, [recebimentos, search, statusFilter, tipoFilter, pendenteBaixaGC, semGrupo]);

  const selectedItems = filtered.filter((r: any) => selected.has(r.id));
  const selectedTotal = selectedItems.reduce((s, r: any) => s + Number(r.valor || 0), 0);

  const canSelect = (r: any) => !r.liquidado && !r.grupo_id;
  const toggleAll = () => {
    const sel = filtered.filter(canSelect);
    setSelected(selected.size === sel.length ? new Set() : new Set(sel.map((r: any) => r.id)));
  };
  const toggle = (id: string) => { const n = new Set(selected); n.has(id) ? n.delete(id) : n.add(id); setSelected(n); };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncRecebimentosGC();
      toast.success(`Importados: ${result.importados} recebimentos`);
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setSyncing(false); }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) return;
    setCreating(true);
    try {
      const items = selectedItems;
      const total = items.reduce((s, r: any) => s + Number(r.valor || 0), 0);
      const { data: grupo, error: gErr } = await supabase.from("fin_grupos_receber").insert({
        nome: groupName, nome_cliente: (items[0] as any)?.nome_cliente, valor_total: total,
        itens_total: items.length, data_vencimento: groupDate ? format(groupDate, "yyyy-MM-dd") : null, observacao: groupObs || null,
      }).select().single();
      if (gErr) throw gErr;

      const grupoItens = items.map((r: any) => ({ grupo_id: (grupo as any).id, recebimento_id: r.id, valor: Number(r.valor) }));
      await supabase.from("fin_grupo_receber_itens").insert(grupoItens);
      await supabase.from("fin_recebimentos").update({ grupo_id: (grupo as any).id }).in("id", items.map((r: any) => r.id));

      toast.success(`Grupo criado com ${items.length} itens · ${formatCurrency(total)}`);
      setSelected(new Set()); setShowCreateGroup(false); setGroupName(""); setGroupObs(""); setGroupDate(undefined);
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setCreating(false); }
  };

  const statusBadge = (r: any) => {
    const s = r.status;
    if (s === "pago") return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">Pago</Badge>;
    if (s === "vencido" || (!r.liquidado && r.data_vencimento && r.data_vencimento < hoje)) return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">Vencido</Badge>;
    if (s === "cancelado") return <Badge variant="outline" className="text-[10px]">Cancelado</Badge>;
    return <Badge variant="outline" className="bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 text-[10px]">Pendente</Badge>;
  };

  const baixaGCBadge = (r: any) => {
    if (r.gc_baixado) return <span className="text-wedo-green text-[10px]">✅ Baixado</span>;
    if (r.pago_sistema && !r.gc_baixado) return <Badge variant="outline" className="bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30 text-[10px] animate-pulse">⚡ Baixar GC</Badge>;
    return <span className="text-muted-foreground text-[10px]">—</span>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Recebimentos</h1>
          <p className="text-sm text-muted-foreground">Lançamentos a receber (fin_recebimentos)</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sincronizar GC
        </Button>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar cliente, descrição, OS..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={setStatusFilter}>
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="pendente">Pendente</SelectItem>
            <SelectItem value="pago">Pago</SelectItem>
            <SelectItem value="vencido">Vencido</SelectItem>
            <SelectItem value="cancelado">Cancelado</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-[120px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="os">OS</SelectItem>
            <SelectItem value="venda">Venda</SelectItem>
            <SelectItem value="contrato">Contrato</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="baixa-gc" checked={pendenteBaixaGC} onCheckedChange={setPendenteBaixaGC} />
          <Label htmlFor="baixa-gc" className="text-xs text-muted-foreground">Pendente baixa GC</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="sem-grupo" checked={semGrupo} onCheckedChange={setSemGrupo} />
          <Label htmlFor="sem-grupo" className="text-xs text-muted-foreground">Sem grupo</Label>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left w-10"><Checkbox checked={filtered.filter(canSelect).length > 0 && selected.size === filtered.filter(canSelect).length} onCheckedChange={toggleAll} /></th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cód GC</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">OS</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cliente</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Baixa GC</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Grupo</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10}><EmptyState icon={Receipt} title="Nenhum recebimento" description="Sincronize os dados do GC." action={{ label: "Sincronizar", onClick: handleSync }} /></td></tr>
              ) : filtered.map((r: any) => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                  <td className="p-3">{canSelect(r) ? <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} /> : <Checkbox disabled checked={false} />}</td>
                  <td className="p-3 font-mono text-xs text-foreground">{r.gc_codigo || "—"}</td>
                  <td className="p-3 font-semibold text-wedo-blue">{r.os_codigo || "—"}</td>
                  <td className="p-3 text-foreground max-w-[200px] truncate">{r.descricao}</td>
                  <td className="p-3 text-foreground">{r.nome_cliente || "—"}</td>
                  <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(Number(r.valor))}</td>
                  <td className="p-3 text-foreground">{r.data_vencimento ? formatDate(r.data_vencimento) : "—"}</td>
                  <td className="p-3 text-center">{statusBadge(r)}</td>
                  <td className="p-3 text-center">{baixaGCBadge(r)}</td>
                  <td className="p-3 text-center">{r.grupo_id ? <Badge variant="outline" className="cursor-pointer text-[10px] bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30" onClick={() => navigate("/financeiro/grupos-receber")}>Em grupo</Badge> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4 flex items-center justify-between z-50">
          <span className="text-sm text-foreground">{selected.size} selecionados · <span className="font-semibold">{formatCurrency(selectedTotal)}</span></span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
            {selectedItems.every((r: any) => !r.grupo_id) && (
              <Button size="sm" onClick={() => { setGroupName(`${(selectedItems[0] as any)?.nome_cliente || "Grupo"} — ${format(new Date(), "dd/MM/yyyy")}`); setShowCreateGroup(true); }}>
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Criar Grupo
              </Button>
            )}
            {selectedItems.some((r: any) => r.pago_sistema && !r.gc_baixado) && (
              <Button size="sm" variant="destructive" onClick={() => setShowBaixa(true)}>
                <Zap className="h-3.5 w-3.5 mr-1.5" /> Baixar no GC
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Create Group Dialog */}
      <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Criar Grupo de Recebimentos</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Nome *</Label><Input value={groupName} onChange={e => setGroupName(e.target.value)} /></div>
            <div className="space-y-2">
              <Label>Vencimento</Label>
              <Popover><PopoverTrigger asChild><Button variant="outline" className="w-full justify-start"><CalendarIcon className="mr-2 h-4 w-4" />{groupDate ? format(groupDate, "dd/MM/yyyy") : "Selecionar"}</Button></PopoverTrigger>
              <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={groupDate} onSelect={setGroupDate} locale={ptBR} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover>
            </div>
            <div className="space-y-2"><Label>Observação</Label><Textarea value={groupObs} onChange={e => setGroupObs(e.target.value)} /></div>
            <div className="bg-muted/50 rounded-md p-3 text-sm font-semibold text-foreground flex justify-between"><span>{selected.size} itens</span><span>{formatCurrency(selectedTotal)}</span></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateGroup(false)}>Cancelar</Button>
            <Button onClick={handleCreateGroup} disabled={creating || !groupName.trim()}>{creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Criar Grupo</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Baixa Modal */}
      <ConfirmarBaixaModal
        open={showBaixa}
        onClose={() => { setShowBaixa(false); queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] }); }}
        titulo="Baixa Irreversível no GestãoClick"
        itens={selectedItems.map((r: any) => ({ descricao: r.descricao, valor: Number(r.valor), gc_baixado: r.gc_baixado }))}
        valorTotal={selectedTotal}
        onConfirmar={async (dataLiq) => {
          for (const r of selectedItems as any[]) {
            if (r.gc_id && r.gc_payload_raw && !r.gc_baixado) {
              await baixarRecebimentoNoGC(r.gc_id, r.gc_payload_raw, dataLiq);
              await supabase.from("fin_recebimentos").update({ gc_baixado: true, gc_baixado_em: new Date().toISOString(), liquidado: true, status: "pago", data_liquidacao: dataLiq }).eq("id", r.id);
            }
          }
        }}
      />
    </div>
  );
}
