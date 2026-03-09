import { useState, useMemo, useRef, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmarBaixaModal } from "@/components/financeiro/ConfirmarBaixaModal";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { syncByMonthChunks, type SyncDateFilter } from "@/api/financeiro";
import { SyncPeriodDialog } from "@/components/financeiro/SyncPeriodDialog";
import { cn } from "@/lib/utils";
import {
  CreditCard, Search, RefreshCw, Plus, Loader2, Zap, CalendarIcon,
  Eye, CheckCircle, XCircle, ChevronLeft, ChevronRight, FileText, Camera, ExternalLink, Link2,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import toast from "react-hot-toast";
import html2canvas from "html2canvas";

const PAGE_SIZE = 50;
const GC_BASE = "https://gestaoclick.com";

export default function PagamentosPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [pendenteBaixaGC, setPendenteBaixaGC] = useState(false);
  const [semGrupo, setSemGrupo] = useState(false);

  // Selection
  const [selected, setSelected] = useState<Set<string>>(new Set());

  // UI state
  const [syncing, setSyncing] = useState(false);
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [showBaixa, setShowBaixa] = useState(false);
  const [showNewDrawer, setShowNewDrawer] = useState(false);
  const [showDetailDrawer, setShowDetailDrawer] = useState(false);
  const [detailItem, setDetailItem] = useState<any>(null);
  const [page, setPage] = useState(0);
  const [showFechamento, setShowFechamento] = useState(false);

  // Group creation
  const [groupName, setGroupName] = useState("");
  const [groupObs, setGroupObs] = useState("");
  const [groupDate, setGroupDate] = useState<Date | undefined>(undefined);
  const [creating, setCreating] = useState(false);

  // New form
  const [newForm, setNewForm] = useState({
    descricao: "", valor: "", nome_fornecedor: "", data_vencimento: "",
    data_emissao: format(new Date(), "yyyy-MM-dd"), chave_pix: "", observacao: "",
    aguardando_nf: false, nfe_chave: "",
  });
  const [saving, setSaving] = useState(false);

  const hoje = new Date().toISOString().split("T")[0];
  const fechamentoRef = useRef<HTMLDivElement>(null);

  const { data: pagamentos, isLoading } = useQuery({
    queryKey: ["fin-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_pagamentos")
        .select("*")
        .order("data_vencimento", { ascending: true })
        .limit(1000);
      return data || [];
    },
  });

  // IDs conciliados (vinculados no extrato)
  const { data: conciliadoIds } = useQuery({
    queryKey: ["fin-pagamentos-conciliados"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_extrato_lancamentos")
        .select("lancamento_id")
        .eq("tabela", "fin_pagamentos");
      return new Set((data || []).map((d: any) => d.lancamento_id));
    },
  });

  // Fechamento do dia query
  const { data: fechamentoItems, isLoading: loadingFechamento } = useQuery({
    queryKey: ["fin-pagamentos-fechamento", hoje],
    enabled: showFechamento,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_pagamentos")
        .select("*, fin_formas_pagamento:forma_pagamento_id(nome)")
        .eq("data_liquidacao", hoje);
      return data || [];
    },
  });

  // Group by forma_pagamento for fechamento
  const fechamentoGrouped = useMemo(() => {
    if (!fechamentoItems) return {};
    const groups: Record<string, any[]> = {};
    fechamentoItems.forEach((p: any) => {
      const forma = p.fin_formas_pagamento?.nome || "Sem forma";
      if (!groups[forma]) groups[forma] = [];
      groups[forma].push(p);
    });
    return groups;
  }, [fechamentoItems]);

  const fechamentoTotal = useMemo(() => 
    (fechamentoItems || []).reduce((s: number, p: any) => s + Number(p.valor || 0), 0),
    [fechamentoItems]
  );

  const filtered = useMemo(() => {
    if (!pagamentos) return [];
    return pagamentos.filter((p: any) => {
      if (statusFilter !== "todos" && p.status !== statusFilter) return false;
      if (tipoFilter !== "todos" && p.tipo !== tipoFilter) return false;
      if (pendenteBaixaGC && !(p.pago_sistema && !p.gc_baixado)) return false;
      if (semGrupo && p.grupo_id) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!(
          p.nome_fornecedor?.toLowerCase().includes(s) ||
          p.descricao?.toLowerCase().includes(s) ||
          p.gc_codigo?.includes(s)
        )) return false;
      }
      return true;
    });
  }, [pagamentos, search, statusFilter, tipoFilter, pendenteBaixaGC, semGrupo]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const selectedItems = filtered.filter((p: any) => selected.has(p.id));
  const selectedTotal = selectedItems.reduce((s: number, p: any) => s + Number(p.valor || 0), 0);
  const canSelect = (p: any) => !p.liquidado && !p.grupo_id;

  const handleSync = async (
    filtros: { dataInicio: string; dataFim: string; incluirLiquidados: boolean },
    onProgress?: (atual: number, total: number) => void,
    onStep?: (etapa: string) => void
  ) => {
    setSyncing(true);
    try {
      const result = await syncByMonthChunks(filtros, onProgress, onStep);
      toast.success(`Importados: ${result.importados} registros`);
      queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] });
      setShowSyncDialog(false);
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
      const items = selectedItems;
      const total = items.reduce((s: number, p: any) => s + Number(p.valor || 0), 0);
      const { data: grupo, error: gErr } = await supabase.from("fin_grupos_pagar").insert({
        nome: groupName,
        nome_fornecedor: (items[0] as any)?.nome_fornecedor,
        valor_total: total,
        itens_total: items.length,
        data_vencimento: groupDate ? format(groupDate, "yyyy-MM-dd") : null,
        observacao: groupObs || null,
      }).select().single();
      if (gErr) throw gErr;
      const grupoItens = items.map((p: any) => ({ grupo_id: (grupo as any).id, pagamento_id: p.id, valor: Number(p.valor) }));
      await supabase.from("fin_grupo_pagar_itens").insert(grupoItens);
      await supabase.from("fin_pagamentos").update({ grupo_id: (grupo as any).id }).in("id", items.map((p: any) => p.id));
      toast.success(`Grupo criado com ${items.length} itens`);
      setSelected(new Set());
      setShowCreateGroup(false);
      queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setCreating(false);
    }
  };

  const handleSaveNew = async () => {
    if (!newForm.descricao || !newForm.valor) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("fin_pagamentos").insert({
        descricao: newForm.descricao,
        valor: parseFloat(newForm.valor),
        nome_fornecedor: newForm.nome_fornecedor || null,
        data_vencimento: newForm.data_vencimento || null,
        data_emissao: newForm.data_emissao || null,
        observacao: newForm.observacao || null,
        origem: "manual" as any,
        tipo: "outro",
        status: "pendente" as any,
        aguardando_nf: newForm.aguardando_nf,
        nfe_chave: newForm.nfe_chave || null,
      });
      if (error) throw error;
      toast.success("Pagamento criado");
      setShowNewDrawer(false);
      setNewForm({ descricao: "", valor: "", nome_fornecedor: "", data_vencimento: "", data_emissao: format(new Date(), "yyyy-MM-dd"), chave_pix: "", observacao: "", aguardando_nf: false, nfe_chave: "" });
      queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
    }
  };

  const handleVincularNFe = async (id: string, nfeChave: string) => {
    const { error } = await supabase.from("fin_pagamentos").update({
      nfe_chave: nfeChave,
      nfe_vinculada_em: new Date().toISOString(),
      aguardando_nf: false,
    }).eq("id", id);
    if (error) {
      toast.error("Erro ao vincular NF-e");
    } else {
      toast.success("NF-e vinculada com sucesso");
      queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] });
    }
  };

  const handleCopyFechamento = async () => {
    if (!fechamentoRef.current) return;
    try {
      const canvas = await html2canvas(fechamentoRef.current, { backgroundColor: "#ffffff" });
      canvas.toBlob((blob) => {
        if (blob) {
          navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
          toast.success("Imagem copiada para a área de transferência!");
        }
      });
    } catch (err) {
      toast.error("Erro ao copiar imagem");
    }
  };

  const statusBadge = (p: any) => {
    if (p.status === "pago") return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px]">Pago</Badge>;
    if (p.status === "vencido" || (!p.liquidado && p.data_vencimento && p.data_vencimento < hoje))
      return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 text-[10px]">Vencido</Badge>;
    if (p.status === "cancelado") return <Badge variant="outline" className="text-[10px]">Cancelado</Badge>;
    return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px]">Pendente</Badge>;
  };

  const aguardandoNfBadge = (p: any) => {
    if (p.aguardando_nf && p.liquidado) {
      return <Badge variant="outline" className="bg-orange-500/10 text-orange-500 border-orange-500/30 text-[10px] ml-1">⏳ Ag. NF</Badge>;
    }
    return null;
  };

  const baixaGCBadge = (p: any) => {
    if (p.gc_baixado) return <span className="text-emerald-500 text-[10px]">✅ Baixado</span>;
    if (p.pago_sistema && !p.gc_baixado)
      return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px] animate-pulse">⚡</Badge>;
    return <span className="text-muted-foreground text-[10px]">—</span>;
  };

  const openDetail = (p: any) => { setDetailItem(p); setShowDetailDrawer(true); };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Pagamentos</h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length} lançamento{filtered.length !== 1 ? "s" : ""} encontrado{filtered.length !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={() => setShowFechamento(true)}>
            <FileText className="h-3.5 w-3.5 mr-1.5" />
            Fechamento do Dia
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowSyncDialog(true)} disabled={syncing}>
            {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
            Sync GC
          </Button>
          <Button size="sm" onClick={() => setShowNewDrawer(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Novo
          </Button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar fornecedor, descrição..." value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} className="pl-9" />
        </div>
        <Select value={statusFilter} onValueChange={v => { setStatusFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[130px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos</SelectItem>
            <SelectItem value="pendente">Pendente</SelectItem>
            <SelectItem value="pago">Pago</SelectItem>
            <SelectItem value="vencido">Vencido</SelectItem>
          </SelectContent>
        </Select>
        <Select value={tipoFilter} onValueChange={v => { setTipoFilter(v); setPage(0); }}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Tipo: Todos</SelectItem>
            <SelectItem value="os">OS</SelectItem>
            <SelectItem value="venda">Venda</SelectItem>
            <SelectItem value="contrato">Contrato</SelectItem>
            <SelectItem value="outro">Outro</SelectItem>
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2">
          <Switch id="baixa-gc-p" checked={pendenteBaixaGC} onCheckedChange={v => { setPendenteBaixaGC(v); setPage(0); }} />
          <Label htmlFor="baixa-gc-p" className="text-xs text-muted-foreground">Pendente baixa GC</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="sem-grupo-p" checked={semGrupo} onCheckedChange={v => { setSemGrupo(v); setPage(0); }} />
          <Label htmlFor="sem-grupo-p" className="text-xs text-muted-foreground">Sem grupo</Label>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 w-10">
                  <Checkbox
                    checked={paged.filter(canSelect).length > 0 && paged.filter(canSelect).every((p: any) => selected.has(p.id))}
                    onCheckedChange={() => {
                      const s = paged.filter(canSelect);
                      setSelected(s.every((p: any) => selected.has(p.id)) ? new Set() : new Set(s.map((p: any) => p.id)));
                    }}
                  />
                </th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Cód GC</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Fornecedor</th>
                <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
                <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Vencimento</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Conciliado</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Baixa GC</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={10} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
              ) : paged.length === 0 ? (
                <tr><td colSpan={10}><EmptyState icon={CreditCard} title="Nenhum pagamento" description="Sincronize os dados." action={{ label: "Sincronizar", onClick: () => setShowSyncDialog(true) }} /></td></tr>
              ) : paged.map((p: any) => (
                <tr key={p.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                  <td className="p-3">
                    {canSelect(p) ? <Checkbox checked={selected.has(p.id)} onCheckedChange={() => { const n = new Set(selected); n.has(p.id) ? n.delete(p.id) : n.add(p.id); setSelected(n); }} /> : <Checkbox disabled />}
                  </td>
                  <td className="p-3 font-mono text-xs">
                    {p.gc_id ? (
                      <a href={`${GC_BASE}/movimentacoes_financeiras/visualizar_pagamento/${p.gc_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        {p.gc_codigo || p.gc_id}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span>{p.gc_codigo || "\u2014"}</span>
                    )}
                  </td>
                  <td className="p-3 max-w-[200px] truncate text-foreground">{p.descricao}</td>
                  <td className="p-3 text-foreground">{p.nome_fornecedor || "\u2014"}</td>
                  <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(Number(p.valor))}</td>
                  <td className="p-3 text-foreground">{p.data_vencimento ? formatDate(p.data_vencimento) : "\u2014"}</td>
                  <td className="p-3 text-center">
                    <div className="flex items-center justify-center gap-1">
                      {statusBadge(p)}
                      {aguardandoNfBadge(p)}
                    </div>
                  </td>
                  <td className="p-3 text-center">
                    {conciliadoIds?.has(p.id) ? (
                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px]">
                        <Link2 className="h-3 w-3 mr-1" />Sim
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-[10px]">{"\u2014"}</span>
                    )}
                  </td>
                  <td className="p-3 text-center">{baixaGCBadge(p)}</td>
                  <td className="p-3 text-center">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openDetail(p)}>
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-border px-4 py-3">
            <span className="text-xs text-muted-foreground">Página {page + 1} de {totalPages} · {filtered.length} resultados</span>
            <div className="flex items-center gap-1">
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page === 0} onClick={() => setPage(p => p - 1)}>
                <ChevronLeft className="h-3.5 w-3.5" />
              </Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" disabled={page >= totalPages - 1} onClick={() => setPage(p => p + 1)}>
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        )}
      </div>

      {/* Selection bar */}
      {selected.size > 0 && (
        <div className="fixed bottom-0 left-0 right-0 bg-card border-t border-border p-4 flex items-center justify-between z-50">
          <span className="text-sm text-foreground">{selected.size} selecionados · <span className="font-semibold">{formatCurrency(selectedTotal)}</span></span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
            <Button size="sm" onClick={() => { setGroupName(`Pagamentos — ${format(new Date(), "dd/MM/yyyy")}`); setShowCreateGroup(true); }}>
              <Plus className="h-3.5 w-3.5 mr-1.5" />Criar Grupo
            </Button>
            {selectedItems.some((p: any) => p.pago_sistema && !p.gc_baixado) && (
              <Button size="sm" variant="destructive" onClick={() => setShowBaixa(true)}>
                <Zap className="h-3.5 w-3.5 mr-1.5" />Baixar GC
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Create Group Dialog */}
      <Dialog open={showCreateGroup} onOpenChange={setShowCreateGroup}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Criar Grupo de Pagamentos</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2"><Label>Nome *</Label><Input value={groupName} onChange={e => setGroupName(e.target.value)} /></div>
            <div className="space-y-2">
              <Label>Vencimento</Label>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start">
                    <CalendarIcon className="mr-2 h-4 w-4" />{groupDate ? format(groupDate, "dd/MM/yyyy") : "Selecionar"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={groupDate} onSelect={setGroupDate} locale={ptBR} className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2"><Label>Observação</Label><Textarea value={groupObs} onChange={e => setGroupObs(e.target.value)} /></div>
            <div className="bg-muted/50 rounded-md p-3 text-sm font-semibold flex justify-between text-foreground">
              <span>{selected.size} itens</span><span>{formatCurrency(selectedTotal)}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateGroup(false)}>Cancelar</Button>
            <Button onClick={handleCreateGroup} disabled={creating || !groupName.trim()}>
              {creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Criar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fechamento do Dia Dialog */}
      <Dialog open={showFechamento} onOpenChange={setShowFechamento}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Fechamento — {format(new Date(), "dd/MM/yyyy", { locale: ptBR })}</DialogTitle>
          </DialogHeader>
          <div ref={fechamentoRef} className="space-y-4 p-4 bg-background">
            <h2 className="text-lg font-bold text-center">Pagamentos do Dia — {format(new Date(), "dd/MM/yyyy")}</h2>
            {loadingFechamento ? (
              <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : Object.keys(fechamentoGrouped).length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Nenhum pagamento liquidado hoje.</p>
            ) : (
              Object.entries(fechamentoGrouped).map(([forma, items]) => (
                <div key={forma} className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase border-b pb-1">{forma}</h3>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left pb-1">Fornecedor</th>
                        <th className="text-left pb-1">Descrição</th>
                        <th className="text-right pb-1">Valor</th>
                        <th className="text-center pb-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(items as any[]).map((p: any) => (
                        <tr key={p.id} className="border-b border-border/30">
                          <td className="py-1">{p.nome_fornecedor || "—"}</td>
                          <td className="py-1 truncate max-w-[200px]">{p.descricao}</td>
                          <td className="py-1 text-right font-medium">{formatCurrency(Number(p.valor))}</td>
                          <td className="py-1 text-center">{statusBadge(p)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold">
                        <td colSpan={2} className="pt-1">Subtotal {forma}</td>
                        <td className="pt-1 text-right">{formatCurrency((items as any[]).reduce((s, p) => s + Number(p.valor || 0), 0))}</td>
                        <td></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              ))
            )}
            {Object.keys(fechamentoGrouped).length > 0 && (
              <div className="border-t-2 border-foreground pt-2 text-right">
                <span className="text-lg font-bold">Total Geral: {formatCurrency(fechamentoTotal)}</span>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={handleCopyFechamento}>
              <Camera className="h-3.5 w-3.5 mr-1.5" /> Copiar como imagem
            </Button>
            <Button variant="ghost" onClick={() => setShowFechamento(false)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Baixa Modal */}
      <ConfirmarBaixaModal
        open={showBaixa}
        onOpenChange={(o) => { if (!o) { setShowBaixa(false); queryClient.invalidateQueries({ queryKey: ["fin-pagamentos"] }); } }}
        titulo="Baixa de Pagamentos no GC"
        tipoLancamento="pagamento"
        itens={selectedItems.map((p: any) => ({
          id: p.id, descricao: p.descricao, valor: Number(p.valor),
          gc_id: p.gc_id || "", gc_payload_raw: p.gc_payload_raw, gc_baixado: p.gc_baixado,
        }))}
        onConfirmar={async () => {}}
      />

      {/* New Pagamento Drawer */}
      <Sheet open={showNewDrawer} onOpenChange={setShowNewDrawer}>
        <SheetContent className="w-[400px] sm:w-[480px] overflow-y-auto">
          <SheetHeader><SheetTitle>Novo Pagamento Manual</SheetTitle></SheetHeader>
          <div className="mt-6 space-y-4">
            <div className="space-y-2">
              <Label>Descrição *</Label>
              <Input value={newForm.descricao} onChange={e => setNewForm(f => ({ ...f, descricao: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Valor *</Label>
              <Input type="number" step="0.01" value={newForm.valor} onChange={e => setNewForm(f => ({ ...f, valor: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Fornecedor</Label>
              <Input value={newForm.nome_fornecedor} onChange={e => setNewForm(f => ({ ...f, nome_fornecedor: e.target.value }))} placeholder="Nome do fornecedor" />
            </div>
            <div className="space-y-2">
              <Label>Data de vencimento</Label>
              <Input type="date" value={newForm.data_vencimento} onChange={e => setNewForm(f => ({ ...f, data_vencimento: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Data de emissão</Label>
              <Input type="date" value={newForm.data_emissao} onChange={e => setNewForm(f => ({ ...f, data_emissao: e.target.value }))} />
            </div>
            <div className="space-y-2">
              <Label>Chave PIX (opcional)</Label>
              <Input value={newForm.chave_pix} onChange={e => setNewForm(f => ({ ...f, chave_pix: e.target.value }))} placeholder="CPF, CNPJ, email..." />
            </div>
            <div className="flex items-center gap-2">
              <Switch id="aguardando-nf" checked={newForm.aguardando_nf} onCheckedChange={v => setNewForm(f => ({ ...f, aguardando_nf: v }))} />
              <Label htmlFor="aguardando-nf" className="text-sm">Aguardando NF</Label>
            </div>
            {newForm.aguardando_nf && (
              <div className="space-y-2">
                <Label>Chave NF-e</Label>
                <Input value={newForm.nfe_chave} onChange={e => setNewForm(f => ({ ...f, nfe_chave: e.target.value }))} placeholder="44 dígitos da chave NF-e" />
              </div>
            )}
            <div className="space-y-2">
              <Label>Observação</Label>
              <Textarea value={newForm.observacao} onChange={e => setNewForm(f => ({ ...f, observacao: e.target.value }))} />
            </div>
            <Button className="w-full" onClick={handleSaveNew} disabled={saving || !newForm.descricao || !newForm.valor}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Salvar Pagamento
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Detail Drawer */}
      <Sheet open={showDetailDrawer} onOpenChange={setShowDetailDrawer}>
        <SheetContent className="w-[450px] sm:w-[550px] overflow-y-auto">
          {detailItem && (
            <>
              <SheetHeader><SheetTitle>Detalhe do Pagamento</SheetTitle></SheetHeader>
              <div className="mt-6 space-y-5">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground text-xs">Código GC</span>
                    <p className="font-mono font-medium text-foreground">{detailItem.gc_codigo || "—"}</p>
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground text-xs">Descrição</span>
                    <p className="text-foreground">{detailItem.descricao}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Fornecedor</span>
                    <p className="text-foreground">{detailItem.nome_fornecedor || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Valor</span>
                    <p className="font-semibold text-foreground">{formatCurrency(Number(detailItem.valor))}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Vencimento</span>
                    <p className="text-foreground">{detailItem.data_vencimento ? formatDate(detailItem.data_vencimento) : "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Status</span>
                    <div className="mt-1 flex items-center gap-1">
                      {statusBadge(detailItem)}
                      {aguardandoNfBadge(detailItem)}
                    </div>
                  </div>
                </div>

                {/* NF-e Section */}
                {(detailItem.aguardando_nf || detailItem.nfe_chave) && (
                  <div className="rounded-lg border border-border p-4 space-y-2">
                    <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <FileText className="h-4 w-4" /> Nota Fiscal
                    </h4>
                    {detailItem.nfe_chave ? (
                      <div className="text-sm">
                        <p className="text-muted-foreground text-xs">Chave NF-e</p>
                        <p className="font-mono text-xs break-all">{detailItem.nfe_chave}</p>
                        {detailItem.nfe_vinculada_em && (
                          <p className="text-[10px] text-muted-foreground mt-1">Vinculada em {formatDateTime(detailItem.nfe_vinculada_em)}</p>
                        )}
                      </div>
                    ) : detailItem.aguardando_nf ? (
                      <div className="space-y-2">
                        <p className="text-amber-500 text-sm">⏳ Aguardando NF-e</p>
                        <div className="flex gap-2">
                          <Input
                            placeholder="Cole a chave NF-e aqui..."
                            className="flex-1 text-xs"
                            onKeyDown={(e) => {
                              if (e.key === "Enter") {
                                const value = (e.target as HTMLInputElement).value;
                                if (value) handleVincularNFe(detailItem.id, value);
                              }
                            }}
                          />
                          <Button size="sm" variant="outline" onClick={(e) => {
                            const input = (e.target as HTMLElement).previousElementSibling as HTMLInputElement;
                            if (input?.value) handleVincularNFe(detailItem.id, input.value);
                          }}>Vincular</Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                )}

                <div className="rounded-lg border border-border p-4 space-y-2">
                  <h4 className="text-sm font-semibold text-foreground">Baixa GestãoClick</h4>
                  {detailItem.gc_baixado ? (
                    <div className="flex items-center gap-2 text-emerald-500 text-sm">
                      <CheckCircle className="h-4 w-4" />
                      Baixado em {detailItem.gc_baixado_em ? formatDateTime(detailItem.gc_baixado_em) : "—"}
                    </div>
                  ) : detailItem.pago_sistema ? (
                    <div className="space-y-3">
                      <div className="flex items-center gap-2 text-amber-500 text-sm">
                        <Zap className="h-4 w-4" />
                        Pagamento confirmado. Baixa no GC pendente.
                      </div>
                      <Button variant="destructive" size="sm" onClick={() => {
                        setShowDetailDrawer(false);
                        setSelected(new Set([detailItem.id]));
                        setTimeout(() => setShowBaixa(true), 200);
                      }}>
                        <Zap className="h-3.5 w-3.5 mr-1.5" /> Baixar no GC
                      </Button>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2 text-muted-foreground text-sm">
                      <XCircle className="h-4 w-4" /> Aguardando pagamento
                    </div>
                  )}
                </div>

                {detailItem.observacao && (
                  <div>
                    <span className="text-muted-foreground text-xs">Observação</span>
                    <p className="text-foreground text-sm mt-1">{detailItem.observacao}</p>
                  </div>
                )}

                {detailItem.grupo_id && (
                  <Button variant="outline" size="sm" onClick={() => { setShowDetailDrawer(false); navigate("/financeiro/grupos-pagar"); }}>
                    Ver Grupo
                  </Button>
                )}
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>

      <SyncPeriodDialog
        open={showSyncDialog}
        onOpenChange={setShowSyncDialog}
        onSync={handleSync}
        loading={syncing}
        title="Sincronizar Pagamentos (GC)"
      />
    </div>
  );
}
