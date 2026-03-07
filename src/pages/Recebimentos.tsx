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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Receipt, Search, RefreshCw, Plus, Loader2, CalendarIcon, X } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatCurrency, formatDate } from "@/lib/format";
import { syncRecebimentos } from "@/api/syncService";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import toast from "react-hot-toast";

type Recebimento = {
  id: string;
  gc_id: string;
  gc_codigo: string | null;
  descricao: string | null;
  os_codigo: string | null;
  tipo: string | null;
  valor: number;
  nome_cliente: string | null;
  data_vencimento: string | null;
  liquidado: boolean | null;
  grupo_id: string | null;
};

export default function Recebimentos() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [tipo, setTipo] = useState("todos");
  const [showGrouped, setShowGrouped] = useState(false);
  const [showLiquidated, setShowLiquidated] = useState(false);
  const [overdueOnly, setOverdueOnly] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [groupName, setGroupName] = useState("");
  const [groupObs, setGroupObs] = useState("");
  const [groupDate, setGroupDate] = useState<Date | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  const { data: recebimentos, isLoading } = useQuery({
    queryKey: ["recebimentos"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("gc_recebimentos")
        .select("id, gc_id, gc_codigo, descricao, os_codigo, tipo, valor, nome_cliente, data_vencimento, liquidado, grupo_id")
        .order("data_vencimento", { ascending: true });
      if (error) throw error;
      return (data || []) as Recebimento[];
    },
  });

  const hoje = new Date().toISOString().split("T")[0];

  const filtered = useMemo(() => {
    if (!recebimentos) return [];
    return recebimentos.filter((r) => {
      if (!showLiquidated && r.liquidado) return false;
      if (!showGrouped && r.grupo_id) return false;
      if (overdueOnly && !(r.data_vencimento && r.data_vencimento < hoje && !r.liquidado)) return false;
      if (tipo !== "todos" && r.tipo !== tipo) return false;
      if (search) {
        const s = search.toLowerCase();
        if (
          !(r.nome_cliente?.toLowerCase().includes(s) ||
            r.descricao?.toLowerCase().includes(s) ||
            r.gc_codigo?.includes(s) ||
            r.os_codigo?.includes(s))
        ) return false;
      }
      return true;
    });
  }, [recebimentos, search, tipo, showGrouped, showLiquidated, overdueOnly, hoje]);

  const selectedItems = filtered.filter((r) => selected.has(r.id));
  const selectedTotal = selectedItems.reduce((s, r) => s + r.valor, 0);

  const canSelect = (r: Recebimento) => !r.liquidado && !r.grupo_id;

  const toggleAll = () => {
    const selectable = filtered.filter(canSelect);
    if (selected.size === selectable.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(selectable.map((r) => r.id)));
    }
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const handleSync = async () => {
    setSyncing(true);
    try {
      const result = await syncRecebimentos();
      toast.success(`Importados: ${result.importados} recebimentos`);
      queryClient.invalidateQueries({ queryKey: ["recebimentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setSyncing(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) return;
    setCreating(true);
    try {
      const items = filtered.filter((r) => selected.has(r.id));
      if (items.length === 0) return;

      const clienteId = items[0].nome_cliente;
      const total = items.reduce((s, r) => s + r.valor, 0);

      const { data: grupo, error: gErr } = await supabase
        .from("grupos_financeiros")
        .insert({
          nome: groupName,
          nome_cliente: clienteId,
          valor_total: total,
          qtd_itens: items.length,
          data_vencimento: groupDate ? format(groupDate, "yyyy-MM-dd") : null,
          observacao: groupObs || null,
        })
        .select()
        .single();

      if (gErr) throw gErr;

      const grupoItens = items.map((r) => ({
        grupo_id: grupo.id,
        gc_recebimento_id: r.gc_id,
        gc_codigo: r.gc_codigo,
        os_codigo: r.os_codigo,
        descricao: r.descricao,
        valor: r.valor,
        nome_cliente: r.nome_cliente,
      }));

      const { error: iErr } = await supabase.from("grupo_itens").insert(grupoItens);
      if (iErr) throw iErr;

      // Update gc_recebimentos with grupo_id
      const ids = items.map((r) => r.id);
      await supabase.from("gc_recebimentos").update({ grupo_id: grupo.id }).in("id", ids);

      toast.success(`Grupo criado com ${items.length} recebimentos · ${formatCurrency(total)}`);
      setSelected(new Set());
      setShowCreateGroup(false);
      setGroupName("");
      setGroupObs("");
      setGroupDate(undefined);
      queryClient.invalidateQueries({ queryKey: ["recebimentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar grupo");
    } finally {
      setCreating(false);
    }
  };

  const tipoBadge = (t: string | null) => {
    switch (t) {
      case "os": return <Badge variant="outline" className="bg-wedo-blue/10 text-wedo-blue border-wedo-blue/30 text-[10px]">OS</Badge>;
      case "venda": return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">Venda</Badge>;
      case "contrato": return <Badge variant="outline" className="bg-wedo-purple/10 text-wedo-purple border-wedo-purple/30 text-[10px]">Contrato</Badge>;
      default: return <Badge variant="outline" className="text-[10px]">Outro</Badge>;
    }
  };

  const statusBadge = (r: Recebimento) => {
    if (r.liquidado) return <Badge variant="outline" className="bg-wedo-green/10 text-wedo-green border-wedo-green/30 text-[10px]">Liquidado</Badge>;
    if (r.data_vencimento && r.data_vencimento < hoje) return <Badge variant="outline" className="bg-wedo-red/10 text-wedo-red border-wedo-red/30 text-[10px]">Vencido</Badge>;
    return <Badge variant="outline" className="bg-wedo-yellow/10 text-wedo-yellow border-wedo-yellow/30 text-[10px]">Pendente</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Recebimentos</h1>
          <p className="text-sm text-muted-foreground">Lançamentos a receber importados do GestãoClick</p>
        </div>
        <Button size="sm" variant="outline" onClick={handleSync} disabled={syncing}>
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sincronizar GC
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar cliente, descrição, OS..." value={search} onChange={(e) => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipo} onValueChange={setTipo}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="os">OS</SelectItem>
            <SelectItem value="venda">Venda</SelectItem>
            <SelectItem value="contrato">Contrato</SelectItem>
            <SelectItem value="outro">Outro</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="grouped" checked={showGrouped} onCheckedChange={setShowGrouped} />
          <Label htmlFor="grouped" className="text-xs text-muted-foreground">Agrupados</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="liquidated" checked={showLiquidated} onCheckedChange={setShowLiquidated} />
          <Label htmlFor="liquidated" className="text-xs text-muted-foreground">Liquidados</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="overdue" checked={overdueOnly} onCheckedChange={setOverdueOnly} />
          <Label htmlFor="overdue" className="text-xs text-muted-foreground">Vencidos</Label>
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left w-10">
                  <Checkbox
                    checked={filtered.filter(canSelect).length > 0 && selected.size === filtered.filter(canSelect).length}
                    onCheckedChange={toggleAll}
                  />
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Código</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">OS</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cliente</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Tipo</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Grupo</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={10} className="p-0">
                  <EmptyState
                    icon={Receipt}
                    title="Nenhum recebimento"
                    description="Importe os recebimentos do GestãoClick para visualizar aqui."
                    action={{ label: "Importar agora", onClick: handleSync }}
                  />
                </td></tr>
              ) : (
                filtered.map((r) => (
                  <tr key={r.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                    <td className="p-3">
                      {canSelect(r) ? (
                        <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} />
                      ) : (
                        <Checkbox disabled checked={false} />
                      )}
                    </td>
                    <td className="p-3 text-foreground font-mono text-xs">{r.gc_codigo}</td>
                    <td className="p-3 text-foreground max-w-[200px] truncate">{r.descricao}</td>
                    <td className="p-3 font-semibold text-wedo-blue">{r.os_codigo || "—"}</td>
                    <td className="p-3 text-foreground">{r.nome_cliente || "—"}</td>
                    <td className="p-3">{tipoBadge(r.tipo)}</td>
                    <td className="p-3 text-foreground">{r.data_vencimento ? formatDate(r.data_vencimento) : "—"}</td>
                    <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(r.valor)}</td>
                    <td className="p-3 text-center">{statusBadge(r)}</td>
                    <td className="p-3 text-center">
                      {r.grupo_id ? (
                        <Badge variant="outline" className="cursor-pointer text-[10px] bg-wedo-orange/10 text-wedo-orange border-wedo-orange/30" onClick={() => navigate(`/grupos`)}>
                          Em grupo
                        </Badge>
                      ) : "—"}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4 flex items-center justify-between z-50">
          <span className="text-sm text-foreground">
            {selected.size} selecionados · <span className="font-semibold">{formatCurrency(selectedTotal)}</span>
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
            <Button size="sm" onClick={() => {
              const items = filtered.filter((r) => selected.has(r.id));
              const nome = items[0]?.nome_cliente || "Grupo";
              setGroupName(`${nome} — ${format(new Date(), "dd/MM/yyyy")}`);
              setShowCreateGroup(true);
            }}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />
              Criar Grupo
            </Button>
          </div>
        </div>
      )}

      {/* Create Group Dialog */}
      <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Criar Grupo Financeiro</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Nome do grupo *</Label>
              <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="Ex: Grupo Cliente X" />
            </div>
            <div className="space-y-2">
              <Label>Data de vencimento</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start text-left font-normal">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {groupDate ? format(groupDate, "dd/MM/yyyy") : "Selecionar data"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0"><Calendar mode="single" selected={groupDate} onSelect={setGroupDate} locale={ptBR} /></PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2">
              <Label>Observação</Label>
              <Textarea value={groupObs} onChange={(e) => setGroupObs(e.target.value)} placeholder="Observação opcional" />
            </div>
            <div className="rounded-md bg-muted/50 p-3">
              <p className="text-xs text-muted-foreground mb-2">Resumo: {selected.size} recebimentos</p>
              <div className="max-h-32 overflow-y-auto space-y-1">
                {selectedItems.map((r) => (
                  <div key={r.id} className="flex justify-between text-xs">
                    <span className="text-foreground">{r.os_codigo || r.gc_codigo} — {r.nome_cliente}</span>
                    <span className="font-semibold text-foreground">{formatCurrency(r.valor)}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 pt-2 border-t border-border flex justify-between text-sm font-semibold text-foreground">
                <span>Total</span>
                <span>{formatCurrency(selectedTotal)}</span>
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateGroup(false)}>Cancelar</Button>
            <Button onClick={handleCreateGroup} disabled={creating || !groupName.trim()}>
              {creating ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : null}
              Criar Grupo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
