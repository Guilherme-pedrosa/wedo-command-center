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
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmarBaixaModal } from "@/components/financeiro/ConfirmarBaixaModal";
import { formatCurrency, formatDate, formatDateTime } from "@/lib/format";
import { syncByMonthChunks, atualizarRecebimentoGC, gcDelay, type SyncDateFilter } from "@/api/financeiro";
import { SyncPeriodDialog } from "@/components/financeiro/SyncPeriodDialog";
import { cn } from "@/lib/utils";
import {
  Receipt, Search, RefreshCw, Plus, Loader2, Zap, CalendarIcon,
  Eye, CheckCircle, XCircle, ChevronLeft, ChevronRight, FileText, Lock, Camera, ExternalLink, Link2, X,
  Download, FileSpreadsheet,
} from "lucide-react";
import * as XLSX from "xlsx";
import { SortableHeader, useSortConfig } from "@/components/financeiro/SortableHeader";
import { useNavigate } from "react-router-dom";
import { format } from "date-fns";
import { ptBR } from "date-fns/locale";
import toast from "react-hot-toast";
import html2canvas from "html2canvas";

const PAGE_SIZE = 50;
const GC_BASE = "https://gestaoclick.com";

export default function RecebimentosPage() {
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // Filters
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("todos");
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [origemFilter, setOrigemFilter] = useState("todos");
  const [pendenteBaixaGC, setPendenteBaixaGC] = useState(false);
  const [semGrupo, setSemGrupo] = useState(false);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [formaFilter, setFormaFilter] = useState("todos");
  
  // Sorting
  const { sort, handleSort, sortFn } = useSortConfig("data_vencimento", "asc");

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

  // New recebimento form
  const [newForm, setNewForm] = useState({
    descricao: "", valor: "", nome_cliente: "", data_vencimento: "",
    data_emissao: format(new Date(), "yyyy-MM-dd"), observacao: "",
    nfe_chave: "", nfe_numero: "",
  });
  const [saving, setSaving] = useState(false);

  const hoje = new Date().toISOString().split("T")[0];
  const fechamentoRef = useRef<HTMLDivElement>(null);

  const { data: recebimentos, isLoading } = useQuery({
    queryKey: ["fin-recebimentos"],
    queryFn: async () => {
      // Fetch all records (paginated to bypass 1000-row default limit)
      const allData: any[] = [];
      let from = 0;
      const batchSize = 1000;
      while (true) {
        const { data: batch, error } = await supabase
          .from("fin_recebimentos")
          .select("*")
          .order("data_vencimento", { ascending: true })
          .range(from, from + batchSize - 1);
        if (error) throw error;
        if (!batch || batch.length === 0) break;
        allData.push(...batch);
        if (batch.length < batchSize) break;
        from += batchSize;
      }
      const data = allData;
      return data || [];
    },
  });

  // Formas de pagamento for filter
  const { data: formasPagamento } = useQuery({
    queryKey: ["fin-formas-pagamento"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_formas_pagamento").select("id, nome").eq("ativo", true).order("nome");
      return data || [];
    },
  });

  // IDs conciliados (vinculados no extrato)
  const { data: conciliadoIds } = useQuery({
    queryKey: ["fin-recebimentos-conciliados"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_extrato_lancamentos")
        .select("lancamento_id")
        .in("tabela", ["fin_recebimentos", "recebimentos"]);
      return new Set((data || []).map((d: any) => d.lancamento_id));
    },
  });

  // OS index lookup for links
  const osCodes = useMemo(() => {
    if (!recebimentos) return [];
    const codes = new Set(recebimentos.map((r: any) => r.os_codigo).filter(Boolean));
    return [...codes];
  }, [recebimentos]);

  const { data: osIdMap } = useQuery({
    queryKey: ["os-index-map", osCodes],
    enabled: osCodes.length > 0,
    queryFn: async () => {
      const map: Record<string, string> = {};
      for (let i = 0; i < osCodes.length; i += 500) {
        const batch = osCodes.slice(i, i + 500);
        const { data } = await supabase
          .from("os_index")
          .select("os_id, os_codigo")
          .in("os_codigo", batch);
        (data || []).forEach((r: any) => { map[r.os_codigo] = r.os_id; });
      }
      return map;
    },
  });

  const { data: fechamentoItems, isLoading: loadingFechamento } = useQuery({
    queryKey: ["fin-recebimentos-fechamento", hoje],
    enabled: showFechamento,
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_recebimentos")
        .select("*, fin_formas_pagamento:forma_pagamento_id(nome)")
        .eq("data_liquidacao", hoje);
      return data || [];
    },
  });

  // Group by forma_pagamento for fechamento
  const fechamentoGrouped = useMemo(() => {
    if (!fechamentoItems) return {};
    const groups: Record<string, any[]> = {};
    fechamentoItems.forEach((r: any) => {
      const forma = r.fin_formas_pagamento?.nome || "Sem forma";
      if (!groups[forma]) groups[forma] = [];
      groups[forma].push(r);
    });
    return groups;
  }, [fechamentoItems]);

  const fechamentoTotal = useMemo(() => 
    (fechamentoItems || []).reduce((s: number, r: any) => s + Number(r.valor || 0), 0),
    [fechamentoItems]
  );

  const filtered = useMemo(() => {
    if (!recebimentos) return [];
    const base = recebimentos.filter((r: any) => {
      if (statusFilter !== "todos" && r.status !== statusFilter) return false;
      if (tipoFilter !== "todos" && r.tipo !== tipoFilter) return false;
      if (origemFilter !== "todos") {
        if (origemFilter === "gc" && r.origem === "manual") return false;
        if (origemFilter === "manual" && r.origem !== "manual") return false;
      }
      if (formaFilter !== "todos" && r.forma_pagamento_id !== formaFilter) return false;
      if (dateFrom && r.data_vencimento && r.data_vencimento < dateFrom) return false;
      if (dateTo && r.data_vencimento && r.data_vencimento > dateTo) return false;
      if (pendenteBaixaGC && !(r.pago_sistema && !r.gc_baixado)) return false;
      if (semGrupo && r.grupo_id) return false;
      if (search) {
        const s = search.toLowerCase();
        if (!(
          r.nome_cliente?.toLowerCase().includes(s) ||
          r.descricao?.toLowerCase().includes(s) ||
          r.gc_codigo?.includes(s) ||
          r.os_codigo?.includes(s)
        )) return false;
      }
      return true;
    });
    return sortFn(base);
  }, [recebimentos, search, statusFilter, tipoFilter, origemFilter, formaFilter, dateFrom, dateTo, pendenteBaixaGC, semGrupo, sort]);

  const totalPages = Math.ceil(filtered.length / PAGE_SIZE);
  const paged = filtered.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  const selectedItems = filtered.filter((r: any) => selected.has(r.id));
  const selectedTotal = selectedItems.reduce((s: number, r: any) => s + Number(r.valor || 0), 0);

  const canSelect = (r: any) => !r.liquidado && !r.grupo_id;
  const toggleAll = () => {
    const sel = paged.filter(canSelect);
    setSelected(selected.size === sel.length ? new Set() : new Set(sel.map((r: any) => r.id)));
  };
  const toggle = (id: string) => {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    setSelected(n);
  };

  const handleSync = async (
    filtros: { dataInicio: string; dataFim: string; incluirLiquidados: boolean },
    onProgress?: (atual: number, total: number) => void,
    onStep?: (etapa: string) => void
  ) => {
    setSyncing(true);
    try {
      const result = await syncByMonthChunks(filtros, onProgress, onStep, "recebimentos");
      toast.success(`Importados: ${result.importados} registros`);
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
      setShowSyncDialog(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro");
    } finally {
      setSyncing(false);
    }
  };

  const handleCreateGroup = async () => {
    if (!groupName.trim()) return;
    const items = selectedItems;
    const clientes = new Set(items.map((r: any) => r.nome_cliente || ""));
    if (clientes.size > 1) {
      toast.error("Não é possível criar grupo com clientes diferentes.");
      return;
    }
    setCreating(true);
    try {
      const total = items.reduce((s: number, r: any) => s + Number(r.valor || 0), 0);
      const { data: grupo, error: gErr } = await supabase.from("fin_grupos_receber").insert({
        nome: groupName,
        nome_cliente: (items[0] as any)?.nome_cliente,
        valor_total: total,
        itens_total: items.length,
        data_vencimento: groupDate ? format(groupDate, "yyyy-MM-dd") : null,
        observacao: groupObs || null,
      }).select().single();
      if (gErr) throw gErr;

      // Create items with snapshot
      const grupoItens = items.map((r: any) => ({
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
      await supabase.from("fin_recebimentos").update(updateData).in("id", items.map((r: any) => r.id));

      // Sync vencimento pro GC automaticamente
      if (groupDate) {
        const venc = format(groupDate, "yyyy-MM-dd");
        let gcSyncOk = 0;
        let gcSyncFail = 0;
        for (const r of items as any[]) {
          if (r.gc_id && r.gc_payload_raw) {
            try {
              await atualizarRecebimentoGC(r.gc_id, r.gc_payload_raw, { data_vencimento: venc });
              gcSyncOk++;
            } catch { gcSyncFail++; }
            await gcDelay();
          }
        }
        if (gcSyncFail > 0) {
          toast.error(`${gcSyncFail} recebimento(s) não atualizaram no GC`);
        } else if (gcSyncOk > 0) {
          toast(`${gcSyncOk} vencimento(s) atualizados no GC`, { icon: "✅" });
        }
      }

      toast.success(`Grupo criado com ${items.length} itens · ${formatCurrency(total)}`);
      setSelected(new Set());
      setShowCreateGroup(false);
      setGroupName("");
      setGroupObs("");
      setGroupDate(undefined);
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
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
      const { error } = await supabase.from("fin_recebimentos").insert({
        descricao: newForm.descricao,
        valor: parseFloat(newForm.valor),
        nome_cliente: newForm.nome_cliente || null,
        data_vencimento: newForm.data_vencimento || null,
        data_emissao: newForm.data_emissao || null,
        observacao: newForm.observacao || null,
        origem: "manual" as any,
        tipo: "outro",
        status: "pendente" as any,
        nfe_chave: newForm.nfe_chave || null,
        nfe_numero: newForm.nfe_numero || null,
      });
      if (error) throw error;
      toast.success("Recebimento criado");
      setShowNewDrawer(false);
      setNewForm({ descricao: "", valor: "", nome_cliente: "", data_vencimento: "", data_emissao: format(new Date(), "yyyy-MM-dd"), observacao: "", nfe_chave: "", nfe_numero: "" });
      queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar");
    } finally {
      setSaving(false);
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

  const getExportData = () => {
    const source = selected.size > 0 ? selectedItems : filtered;
    return source.map((r: any) => ({
      "Cód GC": r.gc_codigo || "",
      "OS": r.os_codigo || "",
      "Descrição": r.descricao || "",
      "Cliente": r.nome_cliente || "",
      "Valor": Number(r.valor || 0),
      "Vencimento": r.data_vencimento ? formatDate(r.data_vencimento) : "",
      "Status": r.status || "",
      "Liquidado": r.liquidado ? "Sim" : "Não",
      "Data Liquidação": r.data_liquidacao ? formatDate(r.data_liquidacao) : "",
      "Forma Pagamento": r.forma_pagamento_id || "",
      "Origem": r.origem || "",
      "NF": r.nfe_chave || "",
    }));
  };

  const handleExportExcel = () => {
    const data = getExportData();
    if (!data.length) return toast.error("Nenhum dado para exportar");
    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Recebimentos");
    XLSX.writeFile(wb, `recebimentos_${format(new Date(), "yyyy-MM-dd")}.xlsx`);
    toast.success("Excel exportado!");
  };

  const handleExportPDF = () => {
    const data = getExportData();
    if (!data.length) return toast.error("Nenhum dado para exportar");
    const total = data.reduce((s, r) => s + Number(r.Valor || 0), 0);
    const printWindow = window.open("", "_blank");
    if (!printWindow) return toast.error("Popup bloqueado");
    printWindow.document.write(`
      <html><head><title>Recebimentos</title>
      <style>
        body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #333; }
        h1 { font-size: 16px; margin-bottom: 4px; }
        .sub { font-size: 11px; color: #666; margin-bottom: 12px; }
        table { width: 100%; border-collapse: collapse; }
        th { background: #1a1a2e; color: #fff; padding: 6px 8px; text-align: left; font-size: 10px; }
        td { padding: 5px 8px; border-bottom: 1px solid #ddd; font-size: 10px; }
        tr:nth-child(even) { background: #f9f9f9; }
        .right { text-align: right; }
        .total { font-weight: bold; background: #f0f0f0; }
      </style></head><body>
      <h1>Relatório de Recebimentos</h1>
      <div class="sub">Gerado em ${format(new Date(), "dd/MM/yyyy HH:mm")} · ${data.length} registros · Total: ${formatCurrency(total)}</div>
      <table>
        <thead><tr>
          <th>Cód GC</th><th>OS</th><th>Descrição</th><th>Cliente</th>
          <th class="right">Valor</th><th>Vencimento</th><th>Status</th>
        </tr></thead>
        <tbody>
          ${data.map(r => `<tr>
            <td>${r["Cód GC"]}</td><td>${r.OS}</td><td>${r["Descrição"]}</td><td>${r.Cliente}</td>
            <td class="right">${formatCurrency(r.Valor)}</td><td>${r.Vencimento}</td><td>${r.Status}</td>
          </tr>`).join("")}
          <tr class="total"><td colspan="4">Total</td><td class="right">${formatCurrency(total)}</td><td colspan="2"></td></tr>
        </tbody>
      </table></body></html>
    `);
    printWindow.document.close();
    setTimeout(() => printWindow.print(), 500);
  };

  const statusBadge = (r: any) => {
    const s = r.status;
    if (s === "pago") return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px]">Pago</Badge>;
    if (s === "vencido" || (!r.liquidado && r.data_vencimento && r.data_vencimento < hoje))
      return <Badge variant="outline" className="bg-destructive/10 text-destructive border-destructive/30 text-[10px]">Vencido</Badge>;
    if (s === "cancelado") return <Badge variant="outline" className="text-[10px]">Cancelado</Badge>;
    return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px]">Pendente</Badge>;
  };

  const baixaGCBadge = (r: any) => {
    if (r.gc_baixado) return <span className="text-emerald-500 text-[10px]">✅ Baixado</span>;
    if (r.pago_sistema && !r.gc_baixado)
      return <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px] animate-pulse">⚡ Baixar GC</Badge>;
    return <span className="text-muted-foreground text-[10px]">—</span>;
  };

  const openDetail = (r: any) => {
    setDetailItem(r);
    setShowDetailDrawer(true);
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Recebimentos</h1>
          <p className="text-sm text-muted-foreground">
            {filtered.length} lançamento{filtered.length !== 1 ? "s" : ""} encontrado{filtered.length !== 1 ? "s" : ""}
            {selected.size > 0 && (
              <span className="ml-2 text-primary font-semibold">
                · {selected.size} selecionado{selected.size !== 1 ? "s" : ""} · {formatCurrency(selectedTotal)}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={handleExportPDF} title="Exportar PDF">
            <Download className="h-3.5 w-3.5 mr-1.5" />
            PDF
          </Button>
          <Button size="sm" variant="outline" onClick={handleExportExcel} title="Exportar Excel">
            <FileSpreadsheet className="h-3.5 w-3.5 mr-1.5" />
            Excel
          </Button>
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
          <Input placeholder="Buscar cliente, descrição, OS..." value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} className="pl-9" />
        </div>
        <SearchableSelect
          value={statusFilter}
          onValueChange={v => { setStatusFilter(v || "todos"); setPage(0); }}
          options={[
            { value: "todos", label: "Todos" },
            { value: "pendente", label: "Pendente" },
            { value: "pago", label: "Pago" },
            { value: "vencido", label: "Vencido" },
            { value: "cancelado", label: "Cancelado" },
          ]}
          placeholder="Status"
          searchPlaceholder="Buscar status..."
          className="w-[130px] h-9"
        />
        <SearchableSelect
          value={tipoFilter}
          onValueChange={v => { setTipoFilter(v || "todos"); setPage(0); }}
          options={[
            { value: "todos", label: "Tipo: Todos" },
            { value: "os", label: "OS" },
            { value: "venda", label: "Venda" },
            { value: "contrato", label: "Contrato" },
          ]}
          placeholder="Tipo"
          searchPlaceholder="Buscar tipo..."
          className="w-[120px] h-9"
        />
        <SearchableSelect
          value={origemFilter}
          onValueChange={v => { setOrigemFilter(v || "todos"); setPage(0); }}
          options={[
            { value: "todos", label: "Origem: Todos" },
            { value: "gc", label: "GestãoClick" },
            { value: "manual", label: "Manual" },
          ]}
          placeholder="Origem"
          searchPlaceholder="Buscar origem..."
          className="w-[120px] h-9"
        />
        <SearchableSelect
          value={formaFilter}
          onValueChange={v => { setFormaFilter(v || "todos"); setPage(0); }}
          options={[
            { value: "todos", label: "Forma: Todas" },
            ...(formasPagamento || []).map((f: any) => ({ value: f.id, label: f.nome })),
          ]}
          placeholder="Forma Pgto"
          searchPlaceholder="Buscar forma..."
          className="w-[180px] h-9"
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">De:</Label>
          <Input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setPage(0); }} className="w-[150px] h-9" />
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs text-muted-foreground whitespace-nowrap">Até:</Label>
          <Input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setPage(0); }} className="w-[150px] h-9" />
        </div>
        {(dateFrom || dateTo) && (
          <Button size="sm" variant="ghost" onClick={() => { setDateFrom(""); setDateTo(""); setPage(0); }}>
            <X className="h-3.5 w-3.5 mr-1" /> Limpar datas
          </Button>
        )}
        <div className="flex items-center gap-2">
          <Switch id="baixa-gc" checked={pendenteBaixaGC} onCheckedChange={v => { setPendenteBaixaGC(v); setPage(0); }} />
          <Label htmlFor="baixa-gc" className="text-xs text-muted-foreground">Pendente baixa GC</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="sem-grupo" checked={semGrupo} onCheckedChange={v => { setSemGrupo(v); setPage(0); }} />
          <Label htmlFor="sem-grupo" className="text-xs text-muted-foreground">Sem grupo</Label>
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="p-3 text-left w-10">
                  <Checkbox
                    checked={paged.filter(canSelect).length > 0 && paged.filter(canSelect).every((r: any) => selected.has(r.id))}
                    onCheckedChange={toggleAll}
                  />
                </th>
                <SortableHeader label="Cód GC" sortKey="gc_codigo" currentSort={sort} onSort={handleSort} className="text-left" />
                <SortableHeader label="OS" sortKey="os_codigo" currentSort={sort} onSort={handleSort} className="text-left" />
                <SortableHeader label="Descrição" sortKey="descricao" currentSort={sort} onSort={handleSort} className="text-left" />
                <SortableHeader label="Cliente" sortKey="nome_cliente" currentSort={sort} onSort={handleSort} className="text-left" />
                <SortableHeader label="Valor" sortKey="valor" currentSort={sort} onSort={handleSort} className="text-right" />
                <SortableHeader label="Vencimento" sortKey="data_vencimento" currentSort={sort} onSort={handleSort} className="text-left" />
                <SortableHeader label="Status" sortKey="status" currentSort={sort} onSort={handleSort} className="text-center" />
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Conciliado</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">NF</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Baixa GC</th>
                <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Ações</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr><td colSpan={12} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto text-muted-foreground" /></td></tr>
              ) : paged.length === 0 ? (
                <tr><td colSpan={12}><EmptyState icon={Receipt} title="Nenhum recebimento" description="Sincronize os dados do GC ou crie manualmente." action={{ label: "Sincronizar", onClick: () => setShowSyncDialog(true) }} /></td></tr>
              ) : paged.map((r: any) => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                  <td className="p-3">
                    {canSelect(r) ? <Checkbox checked={selected.has(r.id)} onCheckedChange={() => toggle(r.id)} /> : <Checkbox disabled checked={false} />}
                  </td>
                  <td className="p-3 font-mono text-xs text-foreground">
                    {r.gc_id ? (
                      <a href={`${GC_BASE}/movimentacoes_financeiras/visualizar_recebimento/${r.gc_id}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-primary hover:underline">
                        {r.gc_codigo || r.gc_id}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    ) : (
                      <span>{r.gc_codigo || "\u2014"}</span>
                    )}
                  </td>
                  <td className="p-3 font-semibold text-primary">
                    {r.os_codigo ? (
                      osIdMap?.[r.os_codigo] ? (
                        <a href={`${GC_BASE}/ordens_servicos/visualizar/${osIdMap[r.os_codigo]}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 hover:underline">
                          {r.os_codigo}
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      ) : (
                        <span>{r.os_codigo}</span>
                      )
                    ) : "—"}
                  </td>
                  <td className="p-3 text-foreground max-w-[200px] truncate">{r.descricao}</td>
                  <td className="p-3 text-foreground">{r.nome_cliente || "—"}</td>
                  <td className="p-3 text-right font-semibold text-foreground">{formatCurrency(Number(r.valor))}</td>
                  <td className="p-3 text-foreground">{r.data_vencimento ? formatDate(r.data_vencimento) : "—"}</td>
                  <td className="p-3 text-center">{statusBadge(r)}</td>
                  <td className="p-3 text-center">
                    {conciliadoIds?.has(r.id) ? (
                      <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px]">
                        <Link2 className="h-3 w-3 mr-1" />Sim
                      </Badge>
                    ) : (
                      <span className="text-muted-foreground text-[10px]">{"\u2014"}</span>
                    )}
                  </td>
                  <td className="p-3 text-center">
                    {r.nfe_chave ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <FileText className="h-4 w-4 text-emerald-500 mx-auto cursor-help" />
                          </TooltipTrigger>
                          <TooltipContent>
                            <p className="font-mono text-xs">{r.nfe_chave}</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <span className="text-muted-foreground text-[10px]">—</span>
                    )}
                  </td>
                  <td className="p-3 text-center">{baixaGCBadge(r)}</td>
                  <td className="p-3 text-center">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => openDetail(r)}>
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
            <span className="text-xs text-muted-foreground">
              Página {page + 1} de {totalPages} · {filtered.length} resultados
            </span>
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
          <span className="text-sm text-foreground">
            {selected.size} selecionados · <span className="font-semibold">{formatCurrency(selectedTotal)}</span>
          </span>
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Limpar</Button>
            {selectedItems.every((r: any) => !r.grupo_id) && (
              <Button size="sm" onClick={() => {
                // Validate same client
                const clientes = new Set(selectedItems.map((r: any) => r.nome_cliente || ""));
                if (clientes.size > 1) {
                  toast.error("Não é possível criar grupo com clientes diferentes. Selecione itens do mesmo cliente.");
                  return;
                }
                setGroupName(`${(selectedItems[0] as any)?.nome_cliente || "Grupo"} — ${format(new Date(), "dd/MM/yyyy")}`);
                setShowCreateGroup(true);
              }}>
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
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" className="w-full justify-start">
                    <CalendarIcon className="mr-2 h-4 w-4" />
                    {groupDate ? format(groupDate, "dd/MM/yyyy") : "Selecionar"}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0">
                  <Calendar mode="single" selected={groupDate} onSelect={setGroupDate} locale={ptBR} className={cn("p-3 pointer-events-auto")} />
                </PopoverContent>
              </Popover>
            </div>
            <div className="space-y-2"><Label>Observação</Label><Textarea value={groupObs} onChange={e => setGroupObs(e.target.value)} /></div>
            <div className="bg-muted/50 rounded-md p-3 text-sm font-semibold text-foreground flex justify-between">
              <span>{selected.size} itens</span>
              <span>{formatCurrency(selectedTotal)}</span>
            </div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowCreateGroup(false)}>Cancelar</Button>
            <Button onClick={handleCreateGroup} disabled={creating || !groupName.trim()}>
              {creating && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Criar Grupo
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Fechamento do Dia Dialog */}
      <Dialog open={showFechamento} onOpenChange={setShowFechamento}>
        <DialogContent className="sm:max-w-2xl max-h-[80vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Recebimentos do Dia — {format(new Date(), "dd/MM/yyyy", { locale: ptBR })}</DialogTitle>
          </DialogHeader>
          <div ref={fechamentoRef} className="space-y-4 p-4 bg-background">
            <h2 className="text-lg font-bold text-center">Recebimentos do Dia — {format(new Date(), "dd/MM/yyyy")}</h2>
            {loadingFechamento ? (
              <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div>
            ) : Object.keys(fechamentoGrouped).length === 0 ? (
              <p className="text-center text-muted-foreground py-8">Nenhum recebimento liquidado hoje.</p>
            ) : (
              Object.entries(fechamentoGrouped).map(([forma, items]) => (
                <div key={forma} className="space-y-2">
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase border-b pb-1">{forma}</h3>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-muted-foreground">
                        <th className="text-left pb-1">Cliente</th>
                        <th className="text-left pb-1">Descrição</th>
                        <th className="text-left pb-1">OS/GC</th>
                        <th className="text-right pb-1">Valor</th>
                        <th className="text-center pb-1">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(items as any[]).map((r: any) => (
                        <tr key={r.id} className="border-b border-border/30">
                          <td className="py-1">{r.nome_cliente || "—"}</td>
                          <td className="py-1 truncate max-w-[150px]">{r.descricao}</td>
                          <td className="py-1 font-mono text-[10px]">{r.os_codigo || r.gc_codigo || "—"}</td>
                          <td className="py-1 text-right font-medium">{formatCurrency(Number(r.valor))}</td>
                          <td className="py-1 text-center">{statusBadge(r)}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold">
                        <td colSpan={3} className="pt-1">Subtotal {forma}</td>
                        <td className="pt-1 text-right">{formatCurrency((items as any[]).reduce((s, r) => s + Number(r.valor || 0), 0))}</td>
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
        onOpenChange={(o) => { if (!o) { setShowBaixa(false); queryClient.invalidateQueries({ queryKey: ["fin-recebimentos"] }); } }}
        titulo="Baixa Irreversível no GestãoClick"
        tipoLancamento="recebimento"
        itens={selectedItems.map((r: any) => ({
          id: r.id, descricao: r.descricao, valor: Number(r.valor),
          gc_id: r.gc_id || "", gc_payload_raw: r.gc_payload_raw, gc_baixado: r.gc_baixado,
        }))}
        onConfirmar={async () => {}}
      />

      {/* New Recebimento Drawer */}
      <Sheet open={showNewDrawer} onOpenChange={setShowNewDrawer}>
        <SheetContent className="w-[400px] sm:w-[480px] overflow-y-auto">
          <SheetHeader><SheetTitle>Novo Recebimento Manual</SheetTitle></SheetHeader>
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
              <Label>Cliente</Label>
              <Input value={newForm.nome_cliente} onChange={e => setNewForm(f => ({ ...f, nome_cliente: e.target.value }))} placeholder="Nome do cliente" />
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
              <Label>Chave NF-e (opcional)</Label>
              <Input value={newForm.nfe_chave} onChange={e => setNewForm(f => ({ ...f, nfe_chave: e.target.value }))} placeholder="44 dígitos" />
            </div>
            <div className="space-y-2">
              <Label>Número NF-e (opcional)</Label>
              <Input value={newForm.nfe_numero} onChange={e => setNewForm(f => ({ ...f, nfe_numero: e.target.value }))} placeholder="Número da nota" />
            </div>
            <div className="space-y-2">
              <Label>Observação</Label>
              <Textarea value={newForm.observacao} onChange={e => setNewForm(f => ({ ...f, observacao: e.target.value }))} />
            </div>
            <Button className="w-full" onClick={handleSaveNew} disabled={saving || !newForm.descricao || !newForm.valor}>
              {saving ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : null}
              Salvar Recebimento
            </Button>
          </div>
        </SheetContent>
      </Sheet>

      {/* Detail Drawer */}
      <Sheet open={showDetailDrawer} onOpenChange={setShowDetailDrawer}>
        <SheetContent className="w-[450px] sm:w-[550px] overflow-y-auto">
          {detailItem && (
            <>
              <SheetHeader><SheetTitle>Detalhe do Recebimento</SheetTitle></SheetHeader>
              <div className="mt-6 space-y-5">
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-muted-foreground text-xs">Código GC</span>
                    {detailItem.gc_codigo ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="font-mono font-medium text-foreground flex items-center gap-1">
                              {detailItem.gc_codigo}
                              <Lock className="h-3 w-3 text-muted-foreground" />
                            </p>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Referência protegida — gerada automaticamente via GC</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <p className="font-mono font-medium text-foreground">—</p>
                    )}
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">OS</span>
                    {detailItem.os_codigo ? (
                      <TooltipProvider>
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <p className="font-semibold text-primary flex items-center gap-1">
                              {detailItem.os_codigo}
                              <Lock className="h-3 w-3 text-muted-foreground" />
                            </p>
                          </TooltipTrigger>
                          <TooltipContent>
                            <p>Referência protegida — gerada automaticamente via GC</p>
                          </TooltipContent>
                        </Tooltip>
                      </TooltipProvider>
                    ) : (
                      <p className="font-semibold text-primary">—</p>
                    )}
                  </div>
                  <div className="col-span-2">
                    <span className="text-muted-foreground text-xs">Descrição</span>
                    <p className="text-foreground">{detailItem.descricao}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Cliente</span>
                    <p className="text-foreground">{detailItem.nome_cliente || "—"}</p>
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
                    <div className="mt-1">{statusBadge(detailItem)}</div>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Origem</span>
                    <p className="text-foreground">{detailItem.origem || "—"}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground text-xs">Tipo</span>
                    <p className="text-foreground">{detailItem.tipo || "—"}</p>
                  </div>
                </div>

                {/* NF-e Section */}
                {(detailItem.nfe_chave || detailItem.nfe_numero) && (
                  <div className="rounded-lg border border-border p-4 space-y-2">
                    <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
                      <FileText className="h-4 w-4" /> Nota Fiscal
                    </h4>
                    {detailItem.nfe_numero && (
                      <div>
                        <p className="text-muted-foreground text-xs">Número NF-e</p>
                        <p className="text-foreground">{detailItem.nfe_numero}</p>
                      </div>
                    )}
                    {detailItem.nfe_chave && (
                      <div>
                        <p className="text-muted-foreground text-xs">Chave NF-e</p>
                        <p className="font-mono text-xs break-all">{detailItem.nfe_chave}</p>
                      </div>
                    )}
                  </div>
                )}

                {/* GC Baixa status */}
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
                        Inter confirmou pagamento. Baixa no GC pendente.
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
                  <Button variant="outline" size="sm" onClick={() => { setShowDetailDrawer(false); navigate("/financeiro/grupos-receber"); }}>
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
        title="Sincronizar Recebimentos (GC)"
      />
    </div>
  );
}
