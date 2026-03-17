import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { EmptyState } from "@/components/EmptyState";
import { formatCurrency, formatDateTime, formatDate } from "@/lib/format";
import { buscarExtratoInter, extrairNomeDaDescricao } from "@/api/financeiro";
import { syncRecebimentos, syncPagamentos } from "@/api/syncService";
import {
  Building2, RefreshCw, Loader2, CalendarIcon, Download, CloudDownload,
  Wand2, Brain, ArrowLeftRight, CheckCircle, ChevronDown, ChevronUp,
  Search, X, ExternalLink, Hash, FileText, Send, Sparkles, Zap,
  AlertTriangle, MessageSquare, Banknote, Link2, Undo2, Eye,
} from "lucide-react";
import { format, subDays, subMonths, startOfMonth, endOfMonth, startOfDay, endOfDay } from "date-fns";
import { ptBR } from "date-fns/locale";
import { cn } from "@/lib/utils";
import toast from "react-hot-toast";

const GC_BASE = "https://gestaoclick.com";
const gcOsLink = (osCode: string) => `${GC_BASE}/ordens_servicos/${osCode}`;
const gcRecebimentoLink = (gcId: string) => `${GC_BASE}/movimentacoes_financeiras/visualizar_recebimento/${gcId}`;
const gcPagamentoLink = (gcId: string) => `${GC_BASE}/movimentacoes_financeiras/visualizar_pagamento/${gcId}`;
const gcCompraLink = (numero: string) => `${GC_BASE}/compras/visualizar_compra/${numero}`;

const extractCompraNumero = (descricao?: string): string | null => {
  if (!descricao) return null;
  const match = descricao.match(/Compra de n[ºo°]\s*(\d+)/i);
  return match ? match[1] : null;
};

const EXCECAO_RULES = ["SEM_PAR_GC", "TRANSFERENCIA_INTERNA", "PIX_DEVOLVIDO_MANUAL"];

const ruleLabels: Record<string, string> = {
  SEM_PAR_GC: "Sem Par GC", TRANSFERENCIA_INTERNA: "Transf. Interna", PIX_DEVOLVIDO_MANUAL: "PIX Devolvido",
  LINK_JA_PAGO_GC: "Rastreabilidade", MATCH_VALOR_DATA: "Valor+Data", MATCH_VALOR_NOME: "Valor+Nome",
  MATCH_GRUPO_RECEBER: "Grupo Receber", MATCH_GRUPO_PAGAR: "Grupo Pagar", MATCH_AGENDA: "Agenda",
  NOME_VALOR_EXATO: "Nome+Valor", CNPJ_VALOR_EXATO: "CNPJ+Valor", CNPJ_VALOR_TOLERANCIA: "CNPJ~Valor",
  PIX_KEY_VALOR: "PIX+Valor", REGRA_0_MAX_CONFIANCA: "Máx. Confiança", SOMA_PARCELAS: "Soma Parcelas",
  MANUAL: "Manual", MANUAL_VINCULO: "Vínculo Manual", MANUAL_SOMA: "Soma Manual N:N", MANUAL_SOMA_JUROS: "Juros Adiantamento", AI_GPT5: "IA GPT-5", SUGESTAO_ACEITA: "Sugestão Aceita",
};

function buildMonthOptions() {
  const opts = [{ value: "all", label: "Todos os meses" }];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = subMonths(now, i);
    opts.push({ value: format(d, "yyyy-MM"), label: format(d, "MMMM yyyy", { locale: ptBR }).replace(/^\w/, c => c.toUpperCase()) });
  }
  opts.push({ value: "custom", label: "Período personalizado" });
  return opts;
}
const monthOptions = buildMonthOptions();

function GCLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline" onClick={e => e.stopPropagation()}>
      {children}<ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}

const AI_SHORTCUTS = [
  { label: "Analisar tudo", cmd: "analisa tudo" },
  { label: "Só créditos", cmd: "analisa créditos" },
  { label: "Só débitos", cmd: "analisa débitos" },
  { label: "Mercado Pago", cmd: "concilia Mercado Pago" },
  { label: "PIX sem match", cmd: "concilia PIX" },
];

export default function ExtratoBancoPage() {
  const queryClient = useQueryClient();
  const [mesExtrato, setMesExtrato] = useState("all");
  const [dateFrom, setDateFrom] = useState(new Date("2024-10-01"));
  const [dateTo, setDateTo] = useState(endOfMonth(new Date()));
  const [fetching, setFetching] = useState(false);
  const [syncingGC, setSyncingGC] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [tipoFilter, setTipoFilter] = useState("todos");
  const [reconcFilter, setReconcFilter] = useState("todos");
  const [searchTerm, setSearchTerm] = useState("");

  // Expanded row for manual linking
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [expandedItem, setExpandedItem] = useState<any>(null);
  const [searchLanc, setSearchLanc] = useState("");
  const [multiMode, setMultiMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [taxaAdiantamento, setTaxaAdiantamento] = useState<string>("");
  const [batchLinking, setBatchLinking] = useState(false);

  // Auto-reconcile suggestions
  const [autoSuggestions, setAutoSuggestions] = useState<any[]>([]);
  const [autoReview, setAutoReview] = useState<any[]>([]);
  const [autoSugOpen, setAutoSugOpen] = useState(false);
  const [sugVinculando, setSugVinculando] = useState<string | null>(null);
  const [sugVinculados, setSugVinculados] = useState<Set<string>>(new Set());

  // Confirm dialog
  const [showConfirm, setShowConfirm] = useState(false);
  const [selectedExtrato, setSelectedExtrato] = useState<any>(null);
  const [selectedLanc, setSelectedLanc] = useState<any>(null);
  const [linking, setLinking] = useState(false);

  // AI — inline per-row
  const [aiTargetId, setAiTargetId] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [aiResult, setAiResult] = useState<any>(null);
  const [aiVinculando, setAiVinculando] = useState<string | null>(null);
  const [aiVinculados, setAiVinculados] = useState<Set<string>>(new Set());

  // AI — bulk panel
  const [aiPanelOpen, setAiPanelOpen] = useState(false);
  const [aiPanelCmd, setAiPanelCmd] = useState("");
  const [aiPanelLoading, setAiPanelLoading] = useState(false);
  const [aiPanelResult, setAiPanelResult] = useState<any>(null);

  // Reconciliation detail for reconciled items
  const [detailItem, setDetailItem] = useState<any>(null);
  const [detailLancs, setDetailLancs] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [desfazendo, setDesfazendo] = useState(false);

  const handleMesChange = (val: string) => {
    setMesExtrato(val);
    if (val === "all") { setDateFrom(new Date("2024-10-01")); setDateTo(endOfMonth(new Date())); }
    else if (val !== "custom") {
      // Use BRT offset to avoid UTC conversion issues
      const base = new Date(val + "-01T00:00:00-03:00");
      setDateFrom(startOfMonth(base));
      setDateTo(endOfMonth(base));
    }
  };

  // ALL extrato (reconciled + unreconciled)
  // Use explicit BRT offset strings to avoid UTC drift
  const queryDateFrom = useMemo(() => {
    const d = new Date(dateFrom);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}T00:00:00-03:00`;
  }, [dateFrom]);

  const queryDateTo = useMemo(() => {
    const d = new Date(dateTo);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}T23:59:59-03:00`;
  }, [dateTo]);

  const { data: extrato, isLoading } = useQuery({
    queryKey: ["extrato-unified", queryDateFrom, queryDateTo],
    queryFn: async () => {
      const PAGE_SIZE = 500;
      let allData: any[] = [];
      let offset = 0;
      let hasMore = true;
      while (hasMore) {
        const { data, error } = await supabase
          .from("fin_extrato_inter")
          .select("*")
          .gte("data_hora", queryDateFrom)
          .lte("data_hora", queryDateTo)
          .order("data_hora", { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);
        if (error) throw error;
        if (!data || data.length < PAGE_SIZE) { allData = [...allData, ...(data || [])]; hasMore = false; }
        else { allData = [...allData, ...data]; offset += PAGE_SIZE; if (allData.length >= 3000) hasMore = false; }
      }
      return allData;
    },
  });

  // Recebimentos for manual linking
  const { data: recebimentosNL } = useQuery({
    queryKey: ["conc-recebimentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_recebimentos")
        .select("id, descricao, valor, nome_cliente, data_vencimento, status, os_codigo, gc_codigo, gc_id, nf_numero, nfe_numero, liquidado, pago_sistema")
        .not("status", "eq", "cancelado").order("data_vencimento", { ascending: false }).limit(1000);
      return data || [];
    },
  });

  const { data: pagamentosNL } = useQuery({
    queryKey: ["conc-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_pagamentos")
        .select("id, descricao, valor, nome_fornecedor, data_vencimento, status, os_codigo, gc_codigo, gc_id, nf_numero, nfe_chave, liquidado, pago_sistema")
        .not("status", "eq", "cancelado").order("data_vencimento", { ascending: false }).limit(1000);
      return data || [];
    },
  });

  const filtered = useMemo(() => {
    return (extrato || []).filter((e: any) => {
      if (tipoFilter !== "todos" && e.tipo !== tipoFilter) return false;
      if (reconcFilter === "sim" && !e.reconciliado) return false;
      if (reconcFilter === "nao" && e.reconciliado) return false;
      if (reconcFilter === "excecao" && !EXCECAO_RULES.includes(e.reconciliation_rule)) return false;
      if (searchTerm) {
        const s = searchTerm.toLowerCase();
        const fields = [e.nome_contraparte, e.contrapartida, e.descricao, e.cpf_cnpj, e.end_to_end_id, e.chave_pix].filter(Boolean).join(" ").toLowerCase();
        if (!fields.includes(s)) return false;
      }
      return true;
    });
  }, [extrato, tipoFilter, reconcFilter, searchTerm]);

  const totalCredito = filtered.filter((e: any) => e.tipo === "CREDITO").reduce((s: number, e: any) => s + Number(e.valor || 0), 0);
  const totalDebito = filtered.filter((e: any) => e.tipo === "DEBITO").reduce((s: number, e: any) => s + Number(e.valor || 0), 0);
  const totalReconciliado = filtered.filter((e: any) => e.reconciliado).length;
  const totalNaoReconciliado = filtered.filter((e: any) => !e.reconciliado && !EXCECAO_RULES.includes(e.reconciliation_rule)).length;
  const pctConciliado = filtered.length > 0 ? Math.round((totalReconciliado / filtered.length) * 100) : 0;

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["extrato-unified"] });
    queryClient.invalidateQueries({ queryKey: ["conc-recebimentos"] });
    queryClient.invalidateQueries({ queryKey: ["conc-pagamentos"] });
  };

  const handleFetch = async () => {
    setFetching(true);
    try {
      const txs = await buscarExtratoInter(format(dateFrom, "yyyy-MM-dd"), format(dateTo, "yyyy-MM-dd"));
      toast.success(`${txs.length} transações processadas`);
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro ao buscar extrato"); }
    finally { setFetching(false); }
  };

  const handleSyncGC = async () => {
    setSyncingGC(true);
    try {
      const [r, p] = await Promise.all([syncRecebimentos(), syncPagamentos()]);
      toast.success(`GC sincronizado: ${r.importados} receb., ${p.importados} pagam.`);
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro ao sincronizar GC"); }
    finally { setSyncingGC(false); }
  };

  const handleAutoReconcile = async () => {
    setAutoRunning(true);
    try {
      const { data, error } = await supabase.functions.invoke("reconciliation-engine", { body: {} });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Erro");
      
      // Store suggestions for user review
      const review = data.review || [];
      const unmatchedWithSug = (data.unmatched || []).filter((u: any) => u.sugestoes?.length > 0 || u.sugestao_nn);
      setAutoReview(review);
      setAutoSuggestions(unmatchedWithSug);
      setSugVinculados(new Set());
      if (review.length > 0 || unmatchedWithSug.length > 0) setAutoSugOpen(true);
      
      toast.success(`Conciliação: ${data.stats.auto} auto, ${review.length} revisão, ${unmatchedWithSug.length} sugestões`);
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro na conciliação"); }
    finally { setAutoRunning(false); }
  };

  // Toggle expand for manual linking (unreconciled)
  const handleExpandRow = (e: any) => {
    if (expandedId === e.id) { setExpandedId(null); setSearchLanc(""); setMultiMode(false); setSelectedIds(new Set()); setTaxaAdiantamento(""); }
    else { setExpandedId(e.id); setExpandedItem(e); setSearchLanc(""); setMultiMode(false); setSelectedIds(new Set()); setTaxaAdiantamento(""); }
  };

  // Searched lancamentos for expanded row
  const searchedLancamentos = useMemo(() => {
    if (!expandedId || !expandedItem) return { recebimentos: [], pagamentos: [] };
    const isCredito = expandedItem.tipo === "CREDITO";
    const q = searchLanc.toLowerCase().trim();
    const filterFn = (l: any) => {
      if (!q) return true;
      const fields = [l.descricao, l.nome_cliente, l.nome_fornecedor, l.os_codigo, l.gc_codigo, l.nf_numero, String(l.valor)].filter(Boolean).join(" ").toLowerCase();
      const numQ = parseFloat(q.replace(",", "."));
      if (!isNaN(numQ) && Math.abs(Number(l.valor) - numQ) < 0.01) return true;
      return fields.includes(q);
    };
    if (isCredito) return { recebimentos: (recebimentosNL || []).filter(filterFn).slice(0, 50), pagamentos: [] };
    return { recebimentos: [], pagamentos: (pagamentosNL || []).filter(filterFn).slice(0, 50) };
  }, [expandedId, expandedItem, searchLanc, recebimentosNL, pagamentosNL]);

  // Multi-select: computed sum and diff
  const multiSelectedItems = useMemo(() => {
    if (!multiMode || selectedIds.size === 0 || !expandedItem) return [];
    const isCredito = expandedItem.tipo === "CREDITO";
    const pool = isCredito ? (recebimentosNL || []) : (pagamentosNL || []);
    return pool.filter((l: any) => selectedIds.has(l.id));
  }, [multiMode, selectedIds, expandedItem, recebimentosNL, pagamentosNL]);

  const multiSoma = multiSelectedItems.reduce((s: number, l: any) => s + Math.abs(Number(l.valor)), 0);
  const multiExtValor = expandedItem ? Math.abs(Number(expandedItem.valor)) : 0;
  const multiDiff = multiExtValor - multiSoma;
  const multiExato = Math.abs(multiDiff) <= 0.01;
  const multiTemTaxa = !multiExato && multiDiff < 0; // extrato < soma = taxa deducted

  const toggleSelected = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const handleBatchReconcile = async () => {
    if (!expandedItem || selectedIds.size === 0) return;
    setBatchLinking(true);
    try {
      const taxa = taxaAdiantamento ? parseFloat(taxaAdiantamento.replace(",", ".")) : undefined;
      const { data, error } = await supabase.functions.invoke("manual-reconcile-batch", {
        body: {
          extrato_id: expandedItem.id,
          lancamento_ids: Array.from(selectedIds),
          taxa_adiantamento_pct: taxa && taxa > 0 ? taxa : undefined,
        },
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Erro");
      const msg = data.juros
        ? `Conciliado ${data.conciliados} títulos + juros R$ ${data.juros.valor.toFixed(2)}`
        : `Conciliado ${data.conciliados} títulos (soma exata)`;
      toast.success(msg);
      setExpandedId(null); setMultiMode(false); setSelectedIds(new Set()); setTaxaAdiantamento("");
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setBatchLinking(false); }
  };

  const handleVincular = async () => {
    if (!selectedExtrato || !selectedLanc) return;
    setLinking(true);
    try {
      const now = new Date().toISOString();
      const table = selectedLanc._tipo === "receber" ? "fin_recebimentos" : "fin_pagamentos";
      const tabela = selectedLanc._tipo === "receber" ? "recebimentos" : "pagamentos";
      await supabase.from("fin_extrato_inter").update({ reconciliado: true, lancamento_id: selectedLanc.id, reconciliado_em: now, reconciliation_rule: "MANUAL" }).eq("id", selectedExtrato.id);
      await supabase.from(table).update({ pago_sistema: true, pago_sistema_em: now, status: "pago" }).eq("id", selectedLanc.id);
      await supabase.from("fin_extrato_lancamentos").upsert({ extrato_id: selectedExtrato.id, lancamento_id: selectedLanc.id, tabela, valor_alocado: Number(selectedLanc.valor), reconciliation_rule: "MANUAL" }, { onConflict: "extrato_id,lancamento_id,tabela" });
      toast.success("Vinculado!");
      setShowConfirm(false); setSelectedExtrato(null); setSelectedLanc(null); setExpandedId(null);
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setLinking(false); }
  };

  // Build auto-command from transaction context
  const buildAutoCommand = (e: any) => {
    const parts: string[] = [];
    const tipo = e.tipo === "CREDITO" ? "crédito" : "débito";
    parts.push(`Encontre o match para este ${tipo} de ${formatCurrency(Number(e.valor))}`);
    if (e.nome_contraparte || e.contrapartida) parts.push(`de "${e.nome_contraparte || e.contrapartida}"`);
    if (e.cpf_cnpj) parts.push(`(doc: ${e.cpf_cnpj})`);
    if (e.descricao) parts.push(`descrição: "${e.descricao}"`);
    if (e.data_hora) parts.push(`data: ${formatDateTime(e.data_hora)}`);
    if (e.chave_pix) parts.push(`chave PIX: ${e.chave_pix}`);
    if (e.end_to_end_id) parts.push(`E2E: ${e.end_to_end_id}`);
    return parts.join(", ");
  };

  // AI analysis — single row
  const handleAiAnalyze = async (extratoId: string, item?: any) => {
    const autoCmd = item ? buildAutoCommand(item) : null;
    setAiTargetId(extratoId);
    setAiLoading(true);
    setAiResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("ai-reconciliation", {
        body: { command: autoCmd, extratoIds: [extratoId] },
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Erro");
      setAiResult(data);
      toast.success(`ARGUS: ${data.stats.sugestoes_total} sugestões`);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro IA"); }
    finally { setAiLoading(false); }
  };

  // AI analysis — bulk panel
  const handleAiPanelAnalyze = async (cmd: string) => {
    setAiPanelLoading(true);
    setAiPanelResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("ai-reconciliation", {
        body: { command: cmd || null },
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Erro");
      setAiPanelResult(data);
      toast.success(`ARGUS: ${data.stats.sugestoes_total} sugestões encontradas`);
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro IA"); }
    finally { setAiPanelLoading(false); }
  };

  const handleAiVincular = async (candidato: any, extratoId: string) => {
    setAiVinculando(extratoId + candidato.lancamento_id);
    try {
      const now = new Date().toISOString();
      const table = candidato.lancamento_tipo === "recebimento" ? "fin_recebimentos" : "fin_pagamentos";
      const tabela = candidato.lancamento_tipo === "recebimento" ? "recebimentos" : "pagamentos";
      await supabase.from("fin_extrato_inter").update({ reconciliado: true, lancamento_id: candidato.lancamento_id, reconciliado_em: now, reconciliation_rule: "AI_GPT5" }).eq("id", extratoId);
      await supabase.from(table).update({ pago_sistema: true, pago_sistema_em: now, status: "pago" }).eq("id", candidato.lancamento_id);
      await supabase.from("fin_extrato_lancamentos").upsert({ extrato_id: extratoId, lancamento_id: candidato.lancamento_id, tabela, valor_alocado: candidato.valor_lancamento, reconciliation_rule: "AI_GPT5" }, { onConflict: "extrato_id,lancamento_id,tabela" });
      setAiVinculados(prev => new Set([...prev, extratoId]));
      toast.success("Vinculado via ARGUS!");
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setAiVinculando(null); }
  };

  // Accept a suggestion from auto-reconcile
  const handleAcceptSuggestion = async (extratoId: string, sug: any) => {
    const key = extratoId + sug.lancamento_id;
    setSugVinculando(key);
    try {
      const now = new Date().toISOString();
      const table = sug.lancamento_tipo === "recebimento" ? "fin_recebimentos" : "fin_pagamentos";
      const tabela = sug.lancamento_tipo === "recebimento" ? "recebimentos" : "pagamentos";
      await supabase.from("fin_extrato_inter").update({ reconciliado: true, lancamento_id: sug.lancamento_id, reconciliado_em: now, reconciliation_rule: "SUGESTAO_ACEITA" }).eq("id", extratoId);
      await supabase.from(table).update({ pago_sistema: true, pago_sistema_em: now, status: "pago" }).eq("id", sug.lancamento_id);
      await supabase.from("fin_extrato_lancamentos").upsert({ extrato_id: extratoId, lancamento_id: sug.lancamento_id, tabela, valor_alocado: sug.valor, reconciliation_rule: "SUGESTAO_ACEITA" }, { onConflict: "extrato_id,lancamento_id,tabela" });
      setSugVinculados(prev => new Set([...prev, extratoId]));
      toast.success("Sugestão aceita e vinculada!");
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro ao vincular"); }
    finally { setSugVinculando(null); }
  };

  // Open detail for reconciled items — full fields like history page
  const openReconciledDetail = async (item: any) => {
    setDetailItem(item);
    setDetailLancs([]);
    setDetailLoading(true);
    try {
      const { data: links } = await supabase.from("fin_extrato_lancamentos").select("lancamento_id, tabela, valor_alocado, reconciliation_rule").eq("extrato_id", item.id);

      const pagamentoFields = "id, gc_id, gc_codigo, descricao, valor, data_vencimento, data_liquidacao, data_competencia, liquidado, status, gc_baixado, gc_baixado_em, os_codigo, nome_fornecedor, plano_contas_id, centro_custo_id, conta_bancaria_id, forma_pagamento_id, origem, tipo, nf_numero, nfe_chave";
      const recebimentoFields = "id, gc_id, gc_codigo, descricao, valor, data_vencimento, data_liquidacao, data_competencia, liquidado, status, gc_baixado, gc_baixado_em, os_codigo, nome_cliente, plano_contas_id, centro_custo_id, conta_bancaria_id, forma_pagamento_id, origem, tipo, nf_numero, nfe_chave";

      const fetchLanc = async (id: string, tab: string) => {
        const isPag = tab === "pagamentos" || tab === "fin_pagamentos";
        const { data } = await supabase.from(isPag ? "fin_pagamentos" : "fin_recebimentos")
          .select(isPag ? pagamentoFields : recebimentoFields)
          .eq("id", id).single();
        return data ? { ...(data as any), _tabela: isPag ? "fin_pagamentos" : "fin_recebimentos" } : null;
      };

      if (links?.length) {
        const results: any[] = [];
        for (const l of links) {
          const r = await fetchLanc(l.lancamento_id, l.tabela as string);
          if (r) results.push({ ...r, _valor_alocado: l.valor_alocado, _rule: l.reconciliation_rule });
        }
        setDetailLancs(results);
      } else if (item.lancamento_id) {
        const tab = item.tipo === "DEBITO" ? "pagamentos" : "recebimentos";
        const r = await fetchLanc(item.lancamento_id, tab);
        if (r) setDetailLancs([{ ...r, _valor_alocado: null, _rule: item.reconciliation_rule }]);
      }
    } catch (e) { console.error(e); }
    finally { setDetailLoading(false); }
  };

  // Desfazer conciliação — same as history page
  const handleDesfazerConciliacao = async (item: any) => {
    if (!confirm("Tem certeza que deseja desfazer esta conciliação? O extrato voltará para 'não conciliado'.")) return;
    setDesfazendo(true);
    try {
      await supabase.from("fin_extrato_lancamentos").delete().eq("extrato_id", item.id);
      for (const lanc of detailLancs) {
        if (lanc._tabela === "fin_pagamentos") {
          await supabase.from("fin_pagamentos").update({ pago_sistema: false, pago_sistema_em: null, status: "pendente" }).eq("id", lanc.id);
        } else if (lanc._tabela === "fin_recebimentos") {
          await supabase.from("fin_recebimentos").update({ pago_sistema: false, pago_sistema_em: null, status: "pendente" }).eq("id", lanc.id);
        }
      }
      await supabase.from("fin_extrato_inter").update({ reconciliado: false, reconciliado_em: null, reconciliation_rule: null, lancamento_id: null }).eq("id", item.id);
      await supabase.from("fin_sync_log").insert({ tipo: "conciliacao_desfeita", referencia_id: item.id, status: "success", payload: { extrato_id: item.id, lancamentos: detailLancs.map((l: any) => l.id) } });
      toast.success("Conciliação desfeita com sucesso");
      setDetailItem(null); setDetailLancs([]);
      invalidateAll();
    } catch (err) { toast.error("Erro ao desfazer: " + (err instanceof Error ? err.message : "erro desconhecido")); }
    finally { setDesfazendo(false); }
  };

  const labelContraparte = (e: any) => e.nome_contraparte || e.contrapartida || extrairNomeDaDescricao(e.descricao) || "—";
  const diff = selectedExtrato && selectedLanc ? Math.abs(Number(selectedExtrato.valor) - Number(selectedLanc.valor)) : 0;

  const renderGCMeta = (l: any, tipo: "receber" | "pagar") => {
    const chips: React.ReactNode[] = [];
    if (l.os_codigo) chips.push(<GCLink key="os" href={gcOsLink(l.os_codigo)}><Hash className="h-2.5 w-2.5" />OS {l.os_codigo}</GCLink>);
    if (l.gc_codigo) chips.push(<GCLink key="gc" href={tipo === "receber" ? gcRecebimentoLink(l.gc_codigo) : gcPagamentoLink(l.gc_codigo)}>GC {l.gc_codigo}</GCLink>);
    if (l.nf_numero) chips.push(<span key="nf" className="inline-flex items-center gap-0.5 text-muted-foreground"><FileText className="h-2.5 w-2.5" />NF {l.nf_numero}</span>);
    return chips.length ? <div className="flex flex-wrap gap-2 mt-0.5">{chips}</div> : null;
  };

  // Render candidato card (shared between inline and panel)
  const renderCandidatoCard = (c: any, extratoId: string, idx: number) => {
    const isVinculado = aiVinculados.has(extratoId);
    const confColor = c.confianca === "ALTA" ? "green" : (c.confianca === "MEDIA" || c.confianca === "MÉDIA") ? "yellow" : "red";
    const canConfirm = c.confianca === "ALTA" || c.confianca === "MEDIA" || c.confianca === "MÉDIA";
    return (
      <div key={idx} className={cn(
        "rounded-md border p-2.5 space-y-1.5 text-xs",
        isVinculado ? "opacity-50 border-green-500/30" :
          confColor === "green" ? "border-green-500/30 bg-green-500/5" :
          confColor === "yellow" ? "border-yellow-500/30 bg-yellow-500/5" :
          "border-red-500/30 bg-red-500/5"
      )}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 flex-wrap min-w-0">
            <Badge variant="outline" className={`text-[9px] shrink-0 ${
              confColor === "green" ? "text-green-600 bg-green-500/10" :
              confColor === "yellow" ? "text-yellow-600 bg-yellow-500/10" :
              "text-red-500 bg-red-500/10"
            }`}>
              {c.confianca} ({c.confianca_pct}%)
            </Badge>
            <span className="font-medium truncate">{c.lancamento_resumo}</span>
            <span className="font-bold text-primary shrink-0">{formatCurrency(c.valor_lancamento)}</span>
            {c.diferenca > 0.01 && <span className="text-yellow-600 text-[10px] shrink-0">Δ {formatCurrency(c.diferenca)}</span>}
          </div>
          {!isVinculado && canConfirm && (
            <Button size="sm" variant={confColor === "green" ? "default" : "outline"} className="h-6 text-[10px] shrink-0" 
              onClick={() => handleAiVincular(c, extratoId)} disabled={aiVinculando === extratoId + c.lancamento_id}>
              {aiVinculando === extratoId + c.lancamento_id ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : <CheckCircle className="h-3 w-3 mr-1" />}Confirmar
            </Button>
          )}
          {isVinculado && <Badge className="text-[9px] bg-green-600 shrink-0">✓ Vinculado</Badge>}
        </div>
        <div className="flex flex-wrap gap-1">
          {c.evidencias?.map((ev: string, i: number) => (
            <span key={i} className="text-[9px] bg-muted/50 rounded px-1.5 py-0.5">{ev}</span>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Extrato & Conciliação</h1>
          <p className="text-sm text-muted-foreground">Transações do Banco Inter com conciliação e assistente ARGUS</p>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Popover>
            <PopoverTrigger asChild>
              <Button disabled={fetching} variant="outline" size="sm" className="gap-1.5">
                {fetching ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}Importar Inter
                <ChevronDown className="h-3 w-3 ml-0.5" />
              </Button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start">
              <div className="space-y-0.5">
                {[7, 15, 30, 60, 90].map(d => (
                  <Button key={d} variant="ghost" size="sm" className="w-full justify-start text-sm h-8"
                    onClick={async () => {
                      const now = new Date();
                      const from = subDays(now, d);
                      setDateFrom(from);
                      setDateTo(now);
                      setMesExtrato("custom");
                      setFetching(true);
                      try {
                        const txs = await buscarExtratoInter(format(from, "yyyy-MM-dd"), format(now, "yyyy-MM-dd"));
                        toast.success(`${txs.length} transações processadas (${d} dias)`);
                        invalidateAll();
                      } catch (err) { toast.error(err instanceof Error ? err.message : "Erro ao buscar extrato"); }
                      finally { setFetching(false); }
                    }}
                    disabled={fetching}>
                    Últimos {d} dias
                  </Button>
                ))}
              </div>
            </PopoverContent>
          </Popover>
          <Button onClick={handleSyncGC} disabled={syncingGC} variant="outline" size="sm" className="gap-1.5">
            {syncingGC ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CloudDownload className="h-3.5 w-3.5" />}Sincronizar GC
          </Button>
          <Button onClick={handleAutoReconcile} disabled={autoRunning} variant="outline" size="sm" className="gap-1.5">
            {autoRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Wand2 className="h-3.5 w-3.5" />}Conciliação Auto
          </Button>
          <Button onClick={() => setAiPanelOpen(!aiPanelOpen)} variant={aiPanelOpen ? "default" : "outline"} size="sm" className="gap-1.5">
            <Brain className="h-3.5 w-3.5" />ARGUS IA
          </Button>
          <Button onClick={() => { invalidateAll(); toast.success("Atualizado"); }} variant="ghost" size="sm" className="gap-1.5">
            <RefreshCw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      {/* AI Panel (collapsible) */}
      {aiPanelOpen && (
        <div className="rounded-lg border border-primary/30 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center gap-2">
            <Brain className="h-4 w-4 text-primary" />
            <span className="font-semibold text-sm text-primary">ARGUS — Assistente de Conciliação</span>
            <Button size="sm" variant="ghost" className="h-6 text-[10px] ml-auto" onClick={() => { setAiPanelOpen(false); setAiPanelResult(null); }}>
              <X className="h-3 w-3" />
            </Button>
          </div>
          
          {/* Command input */}
          <div className="flex gap-2">
            <div className="relative flex-1">
              <MessageSquare className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                placeholder="Digite um comando... ex: 'analisa PIX de hoje', 'concilia Mercado Pago', 'OS 1234'"
                value={aiPanelCmd}
                onChange={e => setAiPanelCmd(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && aiPanelCmd.trim()) handleAiPanelAnalyze(aiPanelCmd.trim()); }}
                className="pl-8 h-9 text-sm"
              />
            </div>
            <Button size="sm" className="h-9 gap-1.5" onClick={() => handleAiPanelAnalyze(aiPanelCmd.trim())} disabled={aiPanelLoading}>
              {aiPanelLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Send className="h-3.5 w-3.5" />}Enviar
            </Button>
          </div>

          {/* Shortcut buttons */}
          <div className="flex flex-wrap gap-1.5">
            {AI_SHORTCUTS.map(s => (
              <Button key={s.cmd} size="sm" variant="outline" className="h-7 text-[11px] gap-1" onClick={() => { setAiPanelCmd(s.cmd); handleAiPanelAnalyze(s.cmd); }} disabled={aiPanelLoading}>
                <Sparkles className="h-3 w-3" />{s.label}
              </Button>
            ))}
          </div>

          {/* Loading state */}
          {aiPanelLoading && (
            <div className="flex items-center gap-2 py-4 justify-center text-primary">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm font-medium">ARGUS analisando...</span>
            </div>
          )}

          {/* Results */}
          {aiPanelResult && !aiPanelLoading && (
            <div className="space-y-3">
              {/* General analysis */}
              {aiPanelResult.analise_geral && (
                <div className="rounded-md bg-muted/50 p-2.5 text-xs text-muted-foreground">{aiPanelResult.analise_geral}</div>
              )}

              {/* Stats bar */}
              <div className="flex items-center gap-3 flex-wrap text-[11px]">
                <span className="text-muted-foreground">{aiPanelResult.stats?.extratos_analisados} analisados</span>
                {aiPanelResult.stats?.alta_confianca > 0 && <Badge variant="outline" className="text-[9px] bg-green-500/10 text-green-600">🟢 {aiPanelResult.stats.alta_confianca} ALTA</Badge>}
                {aiPanelResult.stats?.media_confianca > 0 && <Badge variant="outline" className="text-[9px] bg-yellow-500/10 text-yellow-600">🟡 {aiPanelResult.stats.media_confianca} MÉDIA</Badge>}
                {aiPanelResult.stats?.baixa_confianca > 0 && <Badge variant="outline" className="text-[9px] bg-red-500/10 text-red-500">🔴 {aiPanelResult.stats.baixa_confianca} BAIXA</Badge>}
              </div>

              {/* Suggestions */}
              {aiPanelResult.sugestoes?.length > 0 && (
                <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                  {aiPanelResult.sugestoes.map((s: any, sIdx: number) => (
                    <div key={sIdx} className="rounded-md border border-border p-3 space-y-2">
                      <div className="flex items-center gap-2 text-xs">
                        <Badge variant="outline" className="text-[9px]">{s.extrato_resumo}</Badge>
                      </div>
                      {s.candidatos?.map((c: any, cIdx: number) => renderCandidatoCard(c, s.extrato_id, cIdx))}
                    </div>
                  ))}
                </div>
              )}

              {/* Sem match */}
              {aiPanelResult.sem_match?.length > 0 && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Sem match</p>
                  {aiPanelResult.sem_match.map((sm: any, i: number) => (
                    <div key={i} className="text-[10px] text-muted-foreground bg-muted/30 rounded px-2 py-1">
                      {typeof sm === "string" ? sm : <><span className="font-medium">{sm.extrato_resumo}</span> — {sm.classificacao}: {sm.motivo}</>}
                    </div>
                  ))}
                </div>
              )}

              {/* Alertas */}
              {aiPanelResult.alertas?.length > 0 && (
                <div className="rounded-md border border-yellow-500/30 bg-yellow-500/5 p-2.5 space-y-1">
                  <div className="flex items-center gap-1 text-[10px] font-semibold text-yellow-600"><AlertTriangle className="h-3 w-3" />Alertas</div>
                  {aiPanelResult.alertas.map((a: string, i: number) => <p key={i} className="text-[10px] text-yellow-700">{a}</p>)}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Auto-reconcile Suggestions Panel */}
      {autoSugOpen && (autoReview.length > 0 || autoSuggestions.length > 0) && (
        <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-yellow-600" />
              <span className="font-semibold text-sm text-yellow-700">Sugestões de Conciliação</span>
              <Badge variant="outline" className="text-[10px] text-yellow-600 border-yellow-500/30">
                {autoReview.length + autoSuggestions.length} itens
              </Badge>
            </div>
            <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => { setAutoSugOpen(false); setAutoReview([]); setAutoSuggestions([]); }}>
              <X className="h-3 w-3" />
            </Button>
          </div>

          <div className="space-y-2 max-h-[50vh] overflow-y-auto">
            {/* Review items (engine found a candidate but needs confirmation) */}
            {autoReview.map((r: any, idx: number) => {
              const isVinculado = sugVinculados.has(r.extrato_id);
              return (
                <div key={`rev-${idx}`} className={cn("rounded-md border p-3 space-y-2 text-xs", isVinculado ? "opacity-40 border-green-500/30" : "border-yellow-500/20 bg-card")}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <Badge variant="outline" className="text-[9px] text-yellow-600 bg-yellow-500/10">Revisão</Badge>
                        <span className="font-medium">{r.contrapartida || r.descricao_extrato}</span>
                        <span className="font-bold text-primary">{formatCurrency(Math.abs(Number(r.valor)))}</span>
                        <span className="text-muted-foreground">{r.data_hora ? format(new Date(r.data_hora), "dd/MM") : ""}</span>
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-0.5">{r.motivo}</p>
                    </div>
                  </div>
                  {r.melhor && !isVinculado && (
                    <div className="rounded bg-muted/50 p-2 flex items-center justify-between gap-2">
                      <div>
                        <span className="font-medium">{r.melhor.descricao}</span>
                        <span className="ml-2 font-bold text-primary">{formatCurrency(Number(r.melhor.valor))}</span>
                        <span className="ml-2 text-muted-foreground">{r.melhor.nome}</span>
                        {r.melhor.rule && <Badge variant="outline" className="text-[8px] ml-2">{ruleLabels[r.melhor.rule] || r.melhor.rule}</Badge>}
                      </div>
                      <Button size="sm" className="h-6 text-[10px] gap-1 shrink-0"
                        disabled={sugVinculando === r.extrato_id + r.melhor.id}
                        onClick={() => handleAcceptSuggestion(r.extrato_id, {
                          lancamento_id: r.melhor.id,
                          lancamento_tipo: r.tipo === "DEBITO" ? "pagamento" : "recebimento",
                          valor: r.melhor.valor,
                        })}>
                        {sugVinculando === r.extrato_id + r.melhor.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                        Aceitar
                      </Button>
                    </div>
                  )}
                  {r.candidatos?.length > 0 && !isVinculado && (
                    <div className="space-y-1">
                      {r.candidatos.map((c: any, ci: number) => (
                        <div key={ci} className="rounded bg-muted/50 p-2 flex items-center justify-between gap-2">
                          <div>
                            <span className="font-medium">{c.descricao}</span>
                            <span className="ml-2 font-bold text-primary">{formatCurrency(Number(c.valor))}</span>
                            <span className="ml-2 text-muted-foreground">{c.nome}</span>
                          </div>
                          <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 shrink-0"
                            disabled={sugVinculando === r.extrato_id + c.id}
                            onClick={() => handleAcceptSuggestion(r.extrato_id, {
                              lancamento_id: c.id,
                              lancamento_tipo: r.tipo === "DEBITO" ? "pagamento" : "recebimento",
                              valor: c.valor,
                            })}>
                            {sugVinculando === r.extrato_id + c.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                            Aceitar
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                  {isVinculado && <Badge className="text-[9px] bg-green-600">✓ Vinculado</Badge>}
                </div>
              );
            })}

            {/* Unmatched items with approximate suggestions */}
            {autoSuggestions.map((u: any, idx: number) => {
              const isVinculado = sugVinculados.has(u.extrato_id);
              const isNn = u.sugestao_nn && u.candidatos_nn?.length > 0;
              return (
                <div key={`sug-${idx}`} className={cn("rounded-md border p-3 space-y-2 text-xs", isVinculado ? "opacity-40 border-green-500/30" : "border-border bg-card")}>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className={cn("text-[9px]", isNn ? "text-orange-400 border-orange-400/40" : "text-muted-foreground")}>
                      {isNn ? `N:N (${u.candidatos_nn.length} títulos)` : "Sugestão"}
                    </Badge>
                    <span className="font-medium">{u.contrapartida || u.descricao_extrato}</span>
                    <span className="font-bold text-primary">{formatCurrency(Math.abs(Number(u.valor)))}</span>
                    {u.cpf_cnpj && <span className="text-[10px] text-muted-foreground">{u.cpf_cnpj}</span>}
                    <span className="text-muted-foreground">{u.data_hora ? format(new Date(u.data_hora), "dd/MM") : ""}</span>
                  </div>

                  {/* N:N suggestion — show candidate summary and button to open N:N mode */}
                  {!isVinculado && isNn && (
                    <div className="rounded bg-orange-500/10 p-2 space-y-2">
                      <div className="flex items-center justify-between gap-2">
                        <div className="text-[10px] text-muted-foreground">
                          <span className="font-medium text-foreground">Soma candidatos:</span> {formatCurrency(u.soma_candidatos)}
                          {u.diferenca_nn > 0.01 && <span className="ml-2 text-yellow-600">Δ {formatCurrency(u.diferenca_nn)}</span>}
                        </div>
                        <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 shrink-0 border-orange-400/40 text-orange-400 hover:bg-orange-400/10"
                          onClick={() => {
                            // Find the extrato in list and expand it in N:N mode
                            setExpandedId(u.extrato_id);
                            setExpandedItem({ id: u.extrato_id, tipo: u.tipo, valor: u.valor, nome_contraparte: u.contrapartida, cpf_cnpj: u.cpf_cnpj, data_hora: u.data_hora });
                            setSearchLanc(u.contrapartida?.split(" ")[0] || "");
                            setMultiMode(true);
                            setSelectedIds(new Set());
                            setTaxaAdiantamento("");
                            setAutoSugOpen(false);
                          }}>
                          <ArrowLeftRight className="h-3 w-3" /> Abrir N:N
                        </Button>
                      </div>
                      <div className="max-h-28 overflow-y-auto space-y-1">
                        {u.candidatos_nn.slice(0, 8).map((c: any, ci: number) => (
                          <div key={ci} className="flex items-center gap-2 text-[10px]">
                            {c.doc_match && <span className="text-green-500">CNPJ✓</span>}
                            <span className="truncate max-w-[200px]">{c.descricao}</span>
                            <span className="font-bold text-primary">{formatCurrency(c.valor)}</span>
                            <span className="text-muted-foreground">{c.nome?.substring(0, 25)}</span>
                          </div>
                        ))}
                        {u.candidatos_nn.length > 8 && <span className="text-[9px] text-muted-foreground">+{u.candidatos_nn.length - 8} mais</span>}
                      </div>
                    </div>
                  )}

                  {/* 1:1 suggestions */}
                  {!isVinculado && !isNn && u.sugestoes?.map((s: any, si: number) => (
                    <div key={si} className="rounded bg-muted/50 p-2 space-y-1">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-medium">{s.descricao}</span>
                            <span className="font-bold text-primary">{formatCurrency(s.valor)}</span>
                            {s.nome && <span className="text-muted-foreground">{s.nome}</span>}
                            {s.gc_codigo && <span className="text-muted-foreground">GC {s.gc_codigo}</span>}
                            {s.os_codigo && <span className="text-muted-foreground">OS {s.os_codigo}</span>}
                            {s.diferenca > 0.01 && <span className="text-yellow-600">Δ {formatCurrency(s.diferenca)}</span>}
                          </div>
                          <div className="flex flex-wrap gap-1 mt-1">
                            {s.evidencias?.map((ev: string, ei: number) => (
                              <span key={ei} className="text-[9px] bg-primary/10 text-primary rounded px-1.5 py-0.5">{ev}</span>
                            ))}
                            <span className="text-[9px] text-muted-foreground">Score: {s.score}</span>
                          </div>
                        </div>
                        <Button size="sm" variant="outline" className="h-6 text-[10px] gap-1 shrink-0"
                          disabled={sugVinculando === u.extrato_id + s.lancamento_id}
                          onClick={() => handleAcceptSuggestion(u.extrato_id, s)}>
                          {sugVinculando === u.extrato_id + s.lancamento_id ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                          Aceitar
                        </Button>
                      </div>
                    </div>
                  ))}
                  {isVinculado && <Badge className="text-[9px] bg-green-600">✓ Vinculado</Badge>}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Stats + Filters */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="rounded-md bg-accent/30 px-3 py-1.5 text-xs"><span className="text-muted-foreground">Créditos:</span> <span className="font-semibold text-green-500">{formatCurrency(totalCredito)}</span></div>
        <div className="rounded-md bg-accent/30 px-3 py-1.5 text-xs"><span className="text-muted-foreground">Débitos:</span> <span className="font-semibold text-red-500">{formatCurrency(totalDebito)}</span></div>
        <div className="rounded-md bg-accent/30 px-3 py-1.5 text-xs"><span className="text-muted-foreground">Saldo:</span> <span className="font-semibold">{formatCurrency(totalCredito - totalDebito)}</span></div>
        <div className="rounded-md bg-accent/30 px-3 py-1.5 text-xs"><span className="text-muted-foreground">Conciliado:</span> <span className="font-semibold">{pctConciliado}%</span></div>
        <Badge variant="outline" className="text-[10px] bg-green-500/10 text-green-500">✅ {totalReconciliado}</Badge>
        <Badge variant="outline" className="text-[10px] bg-red-500/10 text-red-500">❌ {totalNaoReconciliado}</Badge>

        <SearchableSelect
          value={mesExtrato}
          onValueChange={handleMesChange}
          options={monthOptions.map(o => ({ value: o.value, label: o.label }))}
          placeholder="Mês"
          searchPlaceholder="Buscar mês..."
          className="w-[150px] h-8 text-xs"
        />
        <div className="flex items-center gap-1">
          <Popover><PopoverTrigger asChild><Button variant="outline" size="sm" className="h-8 text-xs gap-1"><CalendarIcon className="h-3 w-3" />{format(dateFrom, "dd/MM/yy")}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={dateFrom} onSelect={d => { if (d) { setDateFrom(startOfDay(d)); setMesExtrato("custom"); } }} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover>
          <span className="text-xs text-muted-foreground">→</span>
          <Popover><PopoverTrigger asChild><Button variant="outline" size="sm" className="h-8 text-xs gap-1"><CalendarIcon className="h-3 w-3" />{format(dateTo, "dd/MM/yy")}</Button></PopoverTrigger><PopoverContent className="w-auto p-0"><Calendar mode="single" selected={dateTo} onSelect={d => { if (d) { setDateTo(endOfDay(d)); setMesExtrato("custom"); } }} className={cn("p-3 pointer-events-auto")} /></PopoverContent></Popover>
        </div>
        <SearchableSelect
          value={tipoFilter}
          onValueChange={v => setTipoFilter(v || "todos")}
          options={[
            { value: "todos", label: "Todos" },
            { value: "CREDITO", label: "Crédito" },
            { value: "DEBITO", label: "Débito" },
          ]}
          placeholder="Tipo"
          searchPlaceholder="Buscar..."
          className="w-[100px] h-8 text-xs"
        />
        <SearchableSelect
          value={reconcFilter}
          onValueChange={v => setReconcFilter(v || "todos")}
          options={[
            { value: "todos", label: "Todos" },
            { value: "sim", label: "✅ Conciliado" },
            { value: "nao", label: "❌ Pendente" },
            { value: "excecao", label: "⚠️ Exceção" },
          ]}
          placeholder="Conciliação"
          searchPlaceholder="Buscar..."
          className="w-[140px] h-8 text-xs"
        />
        <div className="relative">
          <Search className="absolute left-2 top-2 h-3.5 w-3.5 text-muted-foreground" />
          <Input placeholder="Buscar..." value={searchTerm} onChange={ev => setSearchTerm(ev.target.value)} className="pl-7 h-8 w-[180px] text-xs" />
        </div>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-border bg-muted/50">
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Data/Hora</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Tipo</th>
            <th className="p-3 text-right text-xs font-medium text-muted-foreground uppercase">Valor</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Contraparte</th>
            <th className="p-3 text-left text-xs font-medium text-muted-foreground uppercase">Descrição</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase">Status</th>
            <th className="p-3 text-center text-xs font-medium text-muted-foreground uppercase w-[80px]">Ações</th>
          </tr></thead>
          <tbody>
            {isLoading ? (
              <tr><td colSpan={7} className="p-8 text-center"><Loader2 className="h-6 w-6 animate-spin mx-auto" /></td></tr>
            ) : !filtered.length ? (
              <tr><td colSpan={7}><EmptyState icon={Building2} title="Sem transações" description="Importe o extrato do Inter." /></td></tr>
            ) : filtered.map((e: any) => {
              const isReconciled = e.reconciliado && !EXCECAO_RULES.includes(e.reconciliation_rule);
              const isException = EXCECAO_RULES.includes(e.reconciliation_rule);
              const isPending = !e.reconciliado && !isException;
              const isExpanded = expandedId === e.id;
              const isAiTarget = aiTargetId === e.id && aiResult;

              return (
                <tr key={e.id} className="border-b border-border group">
                  <td colSpan={7} className="p-0">
                    {/* Main row */}
                    <div className={cn("grid grid-cols-[120px_70px_100px_1fr_1fr_120px_80px] items-center p-3 transition-colors", isExpanded ? "bg-primary/5" : "hover:bg-muted/30")}>
                      <div className="text-xs text-muted-foreground">{e.data_hora ? formatDateTime(e.data_hora) : "—"}</div>
                      <div className="text-center"><Badge variant="outline" className={`text-[10px] ${e.tipo === "CREDITO" ? "bg-green-500/10 text-green-500" : "bg-red-500/10 text-red-500"}`}>{e.tipo}</Badge></div>
                      <div className="text-right font-semibold text-sm">{formatCurrency(Number(e.valor))}</div>
                      <div className="px-2">
                        <span className="font-medium text-foreground text-xs">{labelContraparte(e)}</span>
                        {e.cpf_cnpj && <span className="text-[10px] text-muted-foreground ml-2">{e.cpf_cnpj}</span>}
                      </div>
                      <div className="text-muted-foreground truncate text-xs px-2" title={e.descricao}>{e.descricao || "—"}</div>
                      <div className="text-center flex items-center justify-center gap-1">
                        {isReconciled && (
                          <>
                            <span className="text-green-500 text-sm">✅</span>
                            <Badge variant="outline" className="text-[9px] bg-primary/10 text-primary border-primary/30">
                              {ruleLabels[e.reconciliation_rule] || e.reconciliation_rule || "OK"}
                            </Badge>
                          </>
                        )}
                        {isException && (
                          <>
                            <span className="text-yellow-500 text-sm">⚠️</span>
                            <Badge variant="outline" className="text-[9px] bg-yellow-500/10 text-yellow-600 border-yellow-500/30">
                              {ruleLabels[e.reconciliation_rule] || e.reconciliation_rule}
                            </Badge>
                          </>
                        )}
                        {isPending && <span className="text-red-500 text-sm">❌</span>}
                      </div>
                      <div className="flex items-center justify-center gap-1">
                        {isReconciled && (
                          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openReconciledDetail(e)} title="Ver detalhes">
                            <ChevronDown className="h-3.5 w-3.5" />
                          </Button>
                        )}
                        {isPending && (
                          <>
                            <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => handleExpandRow(e)} title="Vincular manualmente">
                              {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ArrowLeftRight className="h-3.5 w-3.5" />}
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-7 w-7 text-primary"
                              onClick={() => handleAiAnalyze(e.id, e)}
                              disabled={aiLoading && aiTargetId === e.id}
                              title="⚡ Pedir ARGUS IA"
                            >
                              {aiLoading && aiTargetId === e.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
                            </Button>
                          </>
                        )}
                      </div>
                    </div>

                    {/* AI suggestions inline */}
                    {isAiTarget && isPending && (
                      <div className="px-4 pb-3 bg-primary/5 space-y-2 border-t border-primary/20">
                        <div className="flex items-center gap-2 pt-2">
                          <Brain className="h-3.5 w-3.5 text-primary" />
                          <span className="text-xs font-semibold text-primary">Sugestões ARGUS</span>
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] ml-auto" onClick={() => { setAiTargetId(null); setAiResult(null); }}>
                            <X className="h-3 w-3" />
                          </Button>
                        </div>
                        {aiResult.analise_geral && <p className="text-[10px] text-muted-foreground bg-muted/50 rounded p-2">{aiResult.analise_geral}</p>}
                        {aiResult.sugestoes?.length > 0 ? aiResult.sugestoes.map((s: any, sIdx: number) => (
                          <div key={sIdx} className="space-y-1.5">
                            {s.candidatos?.map((c: any, cIdx: number) => renderCandidatoCard(c, s.extrato_id, cIdx))}
                          </div>
                        )) : <p className="text-[10px] text-muted-foreground">Nenhuma sugestão encontrada pelo ARGUS.</p>}
                        
                        {/* Sem match inline */}
                        {aiResult.sem_match?.length > 0 && (
                          <div className="text-[10px] text-muted-foreground bg-muted/30 rounded px-2 py-1">
                            {aiResult.sem_match.map((sm: any, i: number) => (
                              <span key={i}>{typeof sm === "string" ? sm : `${sm.classificacao}: ${sm.motivo}`}</span>
                            ))}
                          </div>
                        )}

                        {/* Alertas inline */}
                        {aiResult.alertas?.length > 0 && (
                          <div className="text-[10px] text-yellow-600 bg-yellow-500/5 rounded px-2 py-1 flex items-start gap-1">
                            <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
                            <div>{aiResult.alertas.map((a: string, i: number) => <p key={i}>{a}</p>)}</div>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Expanded: manual linking */}
                    {isExpanded && isPending && (
                      <div className="px-4 pb-3 bg-muted/10 space-y-2 border-t border-border">
                        <div className="flex items-center gap-2 pt-2">
                          <div className="relative flex-1">
                            <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-muted-foreground" />
                            <Input placeholder={`Buscar ${e.tipo === "CREDITO" ? "recebimento" : "pagamento"}...`} value={searchLanc} onChange={ev => setSearchLanc(ev.target.value)} className="pl-8 h-8 text-xs" autoFocus />
                          </div>
                          <Button size="sm" variant={multiMode ? "default" : "outline"} className="h-8 text-[10px] gap-1 shrink-0" onClick={() => { setMultiMode(!multiMode); setSelectedIds(new Set()); setTaxaAdiantamento(""); }}>
                            <CheckCircle className="h-3 w-3" />{multiMode ? "Modo N:N ativo" : "Conciliar N:N"}
                          </Button>
                        </div>

                        {/* Multi-select summary bar */}
                        {multiMode && selectedIds.size > 0 && (
                          <div className="rounded-md border border-primary/30 bg-primary/5 p-2.5 space-y-2">
                            <div className="flex items-center justify-between text-xs">
                              <div className="flex items-center gap-3">
                                <span className="text-muted-foreground">{selectedIds.size} selecionados</span>
                                <span className="font-semibold">Soma: <span className="text-primary">{formatCurrency(multiSoma)}</span></span>
                                <span className="text-muted-foreground">Extrato: {formatCurrency(multiExtValor)}</span>
                                {multiExato ? (
                                  <Badge className="text-[9px] bg-green-600">✅ Soma exata</Badge>
                                ) : (
                                  <Badge variant="outline" className={cn("text-[9px]", multiTemTaxa ? "text-yellow-600 border-yellow-500/30" : "text-red-500 border-red-500/30")}>
                                    Δ {formatCurrency(Math.abs(multiDiff))} {multiTemTaxa ? "(taxa)" : ""}
                                  </Badge>
                                )}
                              </div>
                            </div>
                            {/* Fee input when there's a difference */}
                            {multiTemTaxa && (
                              <div className="flex items-center gap-2">
                                <span className="text-[10px] text-muted-foreground shrink-0">Taxa adiantamento (%):</span>
                                <Input
                                  value={taxaAdiantamento}
                                  onChange={ev => setTaxaAdiantamento(ev.target.value)}
                                  placeholder="ex: 2.5"
                                  className="h-7 text-xs w-24"
                                />
                                <span className="text-[10px] text-muted-foreground">
                                  = R$ {Math.abs(multiDiff).toFixed(2)} de juros
                                </span>
                              </div>
                            )}
                            <Button
                              size="sm"
                              className="h-7 text-xs gap-1.5 w-full"
                              disabled={batchLinking || (!multiExato && !taxaAdiantamento)}
                              onClick={handleBatchReconcile}
                            >
                              {batchLinking ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle className="h-3 w-3" />}
                              Conciliar por soma ({selectedIds.size} títulos)
                            </Button>
                          </div>
                        )}

                        <div className="space-y-1 max-h-[30vh] overflow-y-auto">
                          {(e.tipo === "CREDITO" ? searchedLancamentos.recebimentos : searchedLancamentos.pagamentos).map((l: any) => (
                            <div key={l.id}
                              onClick={() => {
                                if (multiMode) { toggleSelected(l.id); }
                                else { setSelectedExtrato(e); setSelectedLanc({ ...l, _tipo: e.tipo === "CREDITO" ? "receber" : "pagar" }); setShowConfirm(true); }
                              }}
                              className={cn(
                                "p-2 rounded-md border cursor-pointer text-xs transition-colors",
                                multiMode && selectedIds.has(l.id) ? "border-primary bg-primary/10" : "border-border hover:bg-primary/10 hover:border-primary"
                              )}>
                              <div className="flex items-center gap-2">
                                {multiMode && (
                                  <Checkbox checked={selectedIds.has(l.id)} className="h-3.5 w-3.5" onClick={ev => ev.stopPropagation()} onCheckedChange={() => toggleSelected(l.id)} />
                                )}
                                <div className="flex-1 min-w-0">
                                  <div className="font-medium">{l.descricao}</div>
                                  <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                                    <span className="font-bold text-primary">{formatCurrency(Number(l.valor))}</span>
                                    <span className="text-muted-foreground">{l.nome_cliente || l.nome_fornecedor}</span>
                                    {l.gc_codigo && <span className="text-muted-foreground">GC {l.gc_codigo}</span>}
                                    {l.os_codigo && <span className="text-muted-foreground">OS {l.os_codigo}</span>}
                                    {l.liquidado && <Badge variant="secondary" className="text-[9px] h-4">Liquidado</Badge>}
                                  </div>
                                  {renderGCMeta(l, e.tipo === "CREDITO" ? "receber" : "pagar")}
                                </div>
                              </div>
                            </div>
                          ))}
                          {!(e.tipo === "CREDITO" ? searchedLancamentos.recebimentos : searchedLancamentos.pagamentos).length && (
                            <p className="text-[10px] text-muted-foreground text-center py-2">{searchLanc ? "Nenhum resultado" : "Digite para buscar"}</p>
                          )}
                        </div>
                        {/* Quick exception buttons */}
                        <div className="flex gap-2 pt-1 border-t border-border">
                          {[{ rule: "SEM_PAR_GC", label: "Sem par no GC" }, { rule: "TRANSFERENCIA_INTERNA", label: "Transf. interna" }, { rule: "PIX_DEVOLVIDO_MANUAL", label: "PIX devolvido" }].map(x => (
                            <Button key={x.rule} size="sm" variant="ghost" className="text-[10px] h-6" onClick={async () => {
                              await supabase.from("fin_extrato_inter").update({ reconciliation_rule: x.rule }).eq("id", e.id);
                              toast.success(`Classificado: ${x.label}`);
                              setExpandedId(null); invalidateAll();
                            }}>{x.label}</Button>
                          ))}
                        </div>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Reconciled detail dialog — full 3-section layout like history page */}
      <Dialog open={!!detailItem} onOpenChange={o => { if (!o) { setDetailItem(null); setDetailLancs([]); } }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader><DialogTitle>Detalhes da Conciliação</DialogTitle></DialogHeader>
          {detailItem && (
            <div className="space-y-4">
              {/* SEÇÃO 1: Transação Bancária */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Banknote className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-foreground">Transação Bancária (Extrato Inter)</h3>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm">
                  <DetailRow label="ID Extrato" value={detailItem.id} mono />
                  <DetailRow label="Contraparte" value={labelContraparte(detailItem)} bold />
                  <DetailRow label="CPF/CNPJ" value={detailItem.cpf_cnpj} mono />
                  <DetailRow label="Tipo" value={<Badge variant="outline">{detailItem.tipo}</Badge>} />
                  <DetailRow label="Tipo Transação" value={detailItem.tipo_transacao} />
                  <DetailRow label="Valor Extrato" value={formatCurrency(Math.abs(Number(detailItem.valor || 0)))} bold />
                  <DetailRow label="Descrição" value={detailItem.descricao} />
                  <DetailRow label="Data/Hora" value={detailItem.data_hora ? formatDateTime(detailItem.data_hora) : "—"} />
                  {detailItem.end_to_end_id && <DetailRow label="E2E ID" value={detailItem.end_to_end_id} mono small />}
                  {detailItem.chave_pix && <DetailRow label="Chave PIX" value={detailItem.chave_pix} mono small />}
                  {detailItem.codigo_barras && <DetailRow label="Cód. Barras" value={detailItem.codigo_barras} mono small />}
                  {detailItem.contrapartida && <DetailRow label="Contrapartida" value={detailItem.contrapartida} />}
                </div>
              </div>

              <Separator />

              {/* SEÇÃO 2: Dados da Conciliação */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Link2 className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-foreground">Dados da Conciliação</h3>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm">
                  <DetailRow label="Regra" value={
                    detailItem.reconciliation_rule ? (
                      <Badge variant="secondary">{ruleLabels[detailItem.reconciliation_rule] || detailItem.reconciliation_rule}</Badge>
                    ) : "—"
                  } />
                  <DetailRow label="Conciliado em" value={detailItem.reconciliado_em ? formatDateTime(detailItem.reconciliado_em) : "—"} />
                </div>
              </div>

              <Separator />

              {/* SEÇÃO 3: Lançamentos GC Vinculados */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <FileText className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-foreground">Financeiro GC Vinculado</h3>
                </div>

                {detailLoading ? (
                  <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Carregando lançamentos...
                  </div>
                ) : detailLancs.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-3">Nenhum lançamento vinculado encontrado.</p>
                ) : (
                  <div className="space-y-3">
                    {detailLancs.map((lanc: any, idx: number) => (
                      <div key={idx} className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                          <Badge variant="outline" className="text-[10px]">{lanc._tabela === "fin_recebimentos" ? "Recebimento" : "Pagamento"}</Badge>
                          <div className="flex items-center gap-2">
                            {lanc.gc_id && (
                              <a href={lanc._tabela === "fin_recebimentos" ? gcRecebimentoLink(lanc.gc_id) : gcPagamentoLink(lanc.gc_id)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">
                                Financeiro GC {lanc.gc_codigo || ""} <ExternalLink className="h-3 w-3" />
                              </a>
                            )}
                            {(() => { const n = extractCompraNumero(lanc.descricao); return n ? <a href={gcCompraLink(n)} target="_blank" rel="noopener noreferrer" className="flex items-center gap-1 text-xs text-primary hover:underline">Pedido Compra nº {n} <ExternalLink className="h-3 w-3" /></a> : null; })()}
                          </div>
                        </div>
                        <DetailRow label="Cód GC" value={lanc.gc_codigo || "—"} mono />
                        <DetailRow label="Descrição" value={lanc.descricao} />
                        <DetailRow label={lanc._tabela === "fin_recebimentos" ? "Cliente" : "Fornecedor"} value={lanc.nome_cliente || lanc.nome_fornecedor || "—"} />
                        <DetailRow label="Valor" value={formatCurrency(Number(lanc.valor || 0))} bold />
                        <DetailRow label="Valor Alocado" value={lanc._valor_alocado ? formatCurrency(Number(lanc._valor_alocado)) : "—"} />
                        <DetailRow label="Vencimento" value={lanc.data_vencimento ? formatDate(lanc.data_vencimento) : "—"} />
                        <DetailRow label="Liquidação" value={lanc.data_liquidacao ? formatDate(lanc.data_liquidacao) : "—"} />
                        <DetailRow label="Status" value={
                          <Badge variant={lanc.liquidado ? "default" : "outline"} className="text-[10px]">
                            {lanc.status || (lanc.liquidado ? "pago" : "pendente")}
                          </Badge>
                        } />
                        <DetailRow label="Baixado GC" value={lanc.gc_baixado ? "✅ Sim" : "❌ Não"} />
                        {lanc.os_codigo && <DetailRow label="OS" value={lanc.os_codigo} />}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Botão Desfazer */}
              {detailItem.reconciliado && (
                <div className="pt-2">
                  <Separator className="mb-4" />
                  <Button
                    variant="destructive"
                    className="w-full gap-2"
                    disabled={desfazendo || detailLoading}
                    onClick={() => handleDesfazerConciliacao(detailItem)}
                  >
                    {desfazendo ? <Loader2 className="h-4 w-4 animate-spin" /> : <Undo2 className="h-4 w-4" />}
                    Desfazer Conciliação
                  </Button>
                </div>
              )}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Confirm linking dialog */}
      <Dialog open={showConfirm} onOpenChange={o => { if (!o) setShowConfirm(false); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Vincular transação</DialogTitle></DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-md bg-muted/50 p-3">
              <strong>Extrato:</strong> {selectedExtrato?.tipo} · {formatCurrency(Number(selectedExtrato?.valor))}
              <p className="text-xs mt-1 font-medium">{selectedExtrato && labelContraparte(selectedExtrato)}</p>
            </div>
            <div className="flex justify-center"><ArrowLeftRight className="h-5 w-5 text-muted-foreground" /></div>
            <div className="rounded-md bg-muted/50 p-3">
              <strong>Lançamento:</strong> {selectedLanc?.descricao} · {formatCurrency(Number(selectedLanc?.valor))}
              {selectedLanc && renderGCMeta(selectedLanc, selectedLanc._tipo === "receber" ? "receber" : "pagar")}
            </div>
            {diff <= 0.01 ? <div className="text-green-500 text-xs flex items-center gap-1"><CheckCircle className="h-3 w-3" />Valores compatíveis</div> : <div className="text-yellow-600 text-xs">⚠️ Diferença de {formatCurrency(diff)}</div>}
            <p className="text-xs text-muted-foreground">Nota: isto NÃO faz baixa no GC. Apenas marca como pago no sistema.</p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setShowConfirm(false); setSelectedExtrato(null); setSelectedLanc(null); }}>Cancelar</Button>
            <Button onClick={handleVincular} disabled={linking}>{linking && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Vincular</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Helper component ──
function DetailRow({ label, value, mono, bold, small }: { label: string; value: any; mono?: boolean; bold?: boolean; small?: boolean }) {
  if (!value && value !== 0) return null;
  return (
    <div className="grid grid-cols-3 gap-2">
      <span className="text-muted-foreground">{label}</span>
      <span className={`col-span-2 ${mono ? "font-mono" : ""} ${bold ? "font-bold" : ""} ${small ? "text-xs break-all" : ""}`}>
        {value}
      </span>
    </div>
  );
}
