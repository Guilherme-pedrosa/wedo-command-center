import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency, formatDate } from "@/lib/format";
import { atualizarRecebimentoGC, gcDelay } from "@/api/financeiro";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import { CalendarIcon, Loader2, Sparkles, Target, X } from "lucide-react";
import toast from "react-hot-toast";

interface SmartGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/** Find the subset of values whose sum is closest to (but ≤) target */
function findBestSubset(
  items: { id: string; valor: number }[],
  target: number
): { ids: Set<string>; total: number } {
  // Limit to avoid exponential blowup
  const MAX_ITEMS = 30;
  const sorted = [...items].sort((a, b) => b.valor - a.valor).slice(0, MAX_ITEMS);

  let bestIds: string[] = [];
  let bestSum = 0;
  const tolerance = 0.02; // R$ 0,02

  // Branch-and-bound DFS
  function search(idx: number, currentSum: number, chosen: string[]) {
    // Prune: if we're already close enough, stop
    if (Math.abs(currentSum - target) <= tolerance) {
      bestIds = [...chosen];
      bestSum = currentSum;
      return true; // exact match found
    }

    if (currentSum > bestSum && currentSum <= target + tolerance) {
      bestSum = currentSum;
      bestIds = [...chosen];
    }

    if (idx >= sorted.length) return false;

    // Pruning: remaining sum can't improve
    let remaining = 0;
    for (let i = idx; i < sorted.length; i++) remaining += sorted[i].valor;
    if (currentSum + remaining < bestSum) return false;

    for (let i = idx; i < sorted.length; i++) {
      const next = currentSum + sorted[i].valor;
      if (next <= target + tolerance) {
        chosen.push(sorted[i].id);
        if (search(i + 1, next, chosen)) return true;
        chosen.pop();
      }
    }
    return false;
  }

  search(0, 0, []);

  // Also try closest sum above target if nothing close was found
  // (skip — the user asked for "best sum to reach that value")

  return { ids: new Set(bestIds), total: bestSum };
}

export function SmartGroupDialog({ open, onOpenChange }: SmartGroupDialogProps) {
  const queryClient = useQueryClient();

  const [clienteId, setClienteId] = useState("");
  const [valorAlvo, setValorAlvo] = useState("");
  const [groupName, setGroupName] = useState("");
  const [groupObs, setGroupObs] = useState("");
  const [groupDate, setGroupDate] = useState<Date | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [manualOverrides, setManualOverrides] = useState<Set<string>>(new Set());
  const [hasSearched, setHasSearched] = useState(false);
  const [valorOverrides, setValorOverrides] = useState<Record<string, string>>({});
  const [editingValor, setEditingValor] = useState<string | null>(null);

  // Clientes
  const { data: clientes = [] } = useQuery({
    queryKey: ["fin-clientes-smart"],
    enabled: open,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_clientes" as any)
        .select("gc_id, nome")
        .order("nome");
      return (data || []) as any[];
    },
  });

  // Recebimentos abertos do cliente selecionado
  const clienteNome = clientes.find((c: any) => c.gc_id === clienteId)?.nome || "";
  const { data: recebimentos = [], isLoading: loadingRec } = useQuery({
    queryKey: ["fin-recebimentos-smart", clienteId],
    enabled: !!clienteId && open,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_recebimentos")
        .select("id, descricao, valor, os_codigo, gc_codigo, gc_id, data_vencimento, nome_cliente, gc_payload_raw, liquidado, grupo_id, status")
        .eq("cliente_gc_id", clienteId)
        .is("grupo_id", null)
        .eq("liquidado", false)
        .order("data_vencimento", { ascending: true });
      return (data || []) as any[];
    },
  });

  const totalDisponivel = recebimentos.reduce((s: number, r: any) => s + Number(r.valor || 0), 0);

  // Run subset-sum
  const suggestion = useMemo(() => {
    if (!hasSearched || !valorAlvo || !recebimentos.length) return null;
    const target = parseFloat(valorAlvo.replace(/\./g, "").replace(",", "."));
    if (isNaN(target) || target <= 0) return null;

    const items = recebimentos.map((r: any) => ({ id: r.id, valor: Number(r.valor || 0) }));
    return findBestSubset(items, target);
  }, [recebimentos, valorAlvo, hasSearched]);

  // Selected items = suggestion ± manual overrides
  const selectedIds = useMemo(() => {
    if (!suggestion) return new Set<string>();
    const base = new Set(suggestion.ids);
    manualOverrides.forEach((id) => {
      if (base.has(id)) base.delete(id);
      else base.add(id);
    });
    return base;
  }, [suggestion, manualOverrides]);

  const selectedItems = recebimentos.filter((r: any) => selectedIds.has(r.id));
  
  const getItemValor = (r: any): number => {
    if (valorOverrides[r.id] !== undefined) {
      const parsed = parseFloat(valorOverrides[r.id].replace(/\./g, "").replace(",", "."));
      return isNaN(parsed) ? Number(r.valor || 0) : parsed;
    }
    return Number(r.valor || 0);
  };
  
  const selectedTotal = selectedItems.reduce((s: number, r: any) => s + getItemValor(r), 0);
  const targetNum = parseFloat((valorAlvo || "0").replace(/\./g, "").replace(",", ".")) || 0;
  const diff = selectedTotal - targetNum;

  const toggleItem = (id: string) => {
    const next = new Set(manualOverrides);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setManualOverrides(next);
  };

  const handleSearch = () => {
    if (!clienteId || !valorAlvo) return;
    setHasSearched(true);
    setManualOverrides(new Set());
    const target = parseFloat(valorAlvo.replace(/\./g, "").replace(",", "."));
    if (!isNaN(target) && target > 0) {
      setGroupName(`${clienteNome} — ${format(new Date(), "dd/MM/yyyy")}`);
    }
  };

  const handleCreate = async () => {
    if (!groupName.trim() || selectedItems.length === 0) return;
    setCreating(true);
    try {
      const total = selectedTotal;
      const { data: grupo, error: gErr } = await supabase.from("fin_grupos_receber").insert({
        nome: groupName,
        nome_cliente: clienteNome,
        cliente_gc_id: clienteId,
        valor_total: total,
        itens_total: selectedItems.length,
        data_vencimento: groupDate ? format(groupDate, "yyyy-MM-dd") : null,
        observacao: groupObs || null,
      }).select().single();
      if (gErr) throw gErr;

      const grupoItens = selectedItems.map((r: any) => ({
        grupo_id: (grupo as any).id,
        recebimento_id: r.id,
        valor: Number(r.valor),
        os_codigo_original: r.os_codigo || null,
        gc_os_id: r.gc_id || null,
        snapshot_valor: Number(r.valor),
        snapshot_data: r.data_vencimento || null,
      }));
      await supabase.from("fin_grupo_receber_itens").insert(grupoItens);

      const updateData: Record<string, any> = { grupo_id: (grupo as any).id };
      if (groupDate) updateData.data_vencimento = format(groupDate, "yyyy-MM-dd");
      await supabase.from("fin_recebimentos").update(updateData).in("id", selectedItems.map((r: any) => r.id));

      // Sync vencimento pro GC
      if (groupDate) {
        const venc = format(groupDate, "yyyy-MM-dd");
        for (const r of selectedItems as any[]) {
          if (r.gc_id && r.gc_payload_raw) {
            try {
              await atualizarRecebimentoGC(r.gc_id, r.gc_payload_raw, { data_vencimento: venc });
            } catch { /* ignore */ }
            await gcDelay();
          }
        }
      }

      toast.success(`Grupo criado com ${selectedItems.length} itens · ${formatCurrency(total)}`);
      queryClient.invalidateQueries({ queryKey: ["fin-grupos-receber"] });
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
      handleReset();
      onOpenChange(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar grupo");
    } finally {
      setCreating(false);
    }
  };

  const handleReset = () => {
    setClienteId("");
    setValorAlvo("");
    setGroupName("");
    setGroupObs("");
    setGroupDate(undefined);
    setManualOverrides(new Set());
    setHasSearched(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) handleReset(); onOpenChange(o); }}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-5 w-5 text-primary" />
            Agrupamento Inteligente
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 flex-1 overflow-hidden flex flex-col">
          {/* Step 1: Client + Target */}
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Cliente</Label>
              <SearchableSelect
                value={clienteId}
                onValueChange={(v) => { setClienteId(v || ""); setHasSearched(false); }}
                options={clientes.map((c: any) => ({ value: c.gc_id, label: c.nome }))}
                placeholder="Selecionar cliente"
                searchPlaceholder="Buscar cliente..."
                className="h-9"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Valor desejado (R$)</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="6.000,00"
                  value={valorAlvo}
                  onChange={(e) => { setValorAlvo(e.target.value); setHasSearched(false); }}
                  onKeyDown={(e) => e.key === "Enter" && handleSearch()}
                  className="h-9"
                />
                <Button size="sm" className="h-9 px-3" onClick={handleSearch} disabled={!clienteId || !valorAlvo || loadingRec}>
                  {loadingRec ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
                </Button>
              </div>
            </div>
          </div>

          {/* Info: available total */}
          {clienteId && recebimentos.length > 0 && (
            <div className="text-xs text-muted-foreground">
              {recebimentos.length} recebimentos em aberto · Total disponível: <span className="font-semibold text-foreground">{formatCurrency(totalDisponivel)}</span>
            </div>
          )}
          {clienteId && !loadingRec && recebimentos.length === 0 && (
            <div className="text-xs text-muted-foreground">Nenhum recebimento em aberto para este cliente.</div>
          )}

          {/* Results */}
          {hasSearched && suggestion && (
            <>
              {/* Summary */}
              <div className="rounded-lg border border-border bg-muted/30 p-3 flex items-center justify-between">
                <div className="text-sm">
                  <span className="text-muted-foreground">Melhor combinação:</span>{" "}
                  <span className="font-bold text-foreground">{formatCurrency(selectedTotal)}</span>
                  {" "}
                  <span className="text-xs text-muted-foreground">({selectedItems.length} itens)</span>
                </div>
                <div className="text-sm">
                  {Math.abs(diff) <= 0.02 ? (
                    <Badge variant="default" className="text-[10px] bg-emerald-500/10 text-emerald-500 border-emerald-500/30">Exato</Badge>
                  ) : diff < 0 ? (
                    <Badge variant="outline" className="text-[10px] text-amber-500 border-amber-500/30">
                      Falta {formatCurrency(Math.abs(diff))}
                    </Badge>
                  ) : (
                    <Badge variant="outline" className="text-[10px] text-blue-500 border-blue-500/30">
                      Excede {formatCurrency(diff)}
                    </Badge>
                  )}
                </div>
              </div>

              {/* Items list */}
              <ScrollArea className="flex-1 min-h-0 max-h-[280px] rounded-lg border border-border">
                <div className="divide-y divide-border">
                  {recebimentos.map((r: any) => {
                    const isSelected = selectedIds.has(r.id);
                    return (
                      <div
                        key={r.id}
                        className={cn(
                          "flex items-center gap-3 px-3 py-2 text-sm cursor-pointer transition-colors",
                          isSelected ? "bg-primary/5" : "hover:bg-muted/30"
                        )}
                        onClick={() => toggleItem(r.id)}
                      >
                        <Checkbox checked={isSelected} className="pointer-events-none" />
                        <div className="flex-1 min-w-0">
                          <div className="truncate text-xs text-foreground">{r.descricao}</div>
                          <div className="text-[10px] text-muted-foreground">
                            {r.os_codigo && `OS ${r.os_codigo} · `}
                            {r.data_vencimento && `Venc. ${formatDate(r.data_vencimento)}`}
                          </div>
                        </div>
                        <span className="font-semibold text-xs whitespace-nowrap">{formatCurrency(Number(r.valor))}</span>
                      </div>
                    );
                  })}
                </div>
              </ScrollArea>

              {/* Group metadata */}
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Nome do grupo *</Label>
                  <Input value={groupName} onChange={(e) => setGroupName(e.target.value)} className="h-9" />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-xs">Vencimento</Label>
                  <Popover>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="w-full h-9 justify-start text-sm">
                        <CalendarIcon className="mr-2 h-3.5 w-3.5" />
                        {groupDate ? format(groupDate, "dd/MM/yyyy") : "Selecionar"}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-0">
                      <Calendar mode="single" selected={groupDate} onSelect={setGroupDate} locale={ptBR} className="p-3 pointer-events-auto" />
                    </PopoverContent>
                  </Popover>
                </div>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Observação</Label>
                <Textarea value={groupObs} onChange={(e) => setGroupObs(e.target.value)} rows={2} />
              </div>
            </>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => { handleReset(); onOpenChange(false); }}>Cancelar</Button>
          {hasSearched && suggestion && (
            <Button onClick={handleCreate} disabled={creating || !groupName.trim() || selectedItems.length === 0}>
              {creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Criar Grupo · {formatCurrency(selectedTotal)}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
