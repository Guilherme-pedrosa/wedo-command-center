import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import { formatCurrency, formatDateTime, formatDate } from "@/lib/format";
import { CheckCircle, Search, Eye, ArrowLeftRight, TrendingUp, TrendingDown, AlertTriangle, ExternalLink, Link2, Loader2, Banknote, FileText, AlertCircle, Link } from "lucide-react";
import { Button } from "@/components/ui/button";
import { subMonths, startOfMonth, endOfMonth, format } from "date-fns";
import { ptBR } from "date-fns/locale";
import toast from "react-hot-toast";

const GC_BASE = "https://app.gestaoclick.com.br";
const gcRecebimentoLink = (gcId: string) => `${GC_BASE}/recebimentos/${gcId}`;
const gcPagamentoLink = (gcId: string) => `${GC_BASE}/pagamentos/${gcId}`;

const EXCECAO_RULES = ["SEM_PAR_GC", "TRANSFERENCIA_INTERNA", "PIX_DEVOLVIDO_MANUAL"];

const ruleLabels: Record<string, string> = {
  SEM_PAR_GC: "Sem Par GC",
  TRANSFERENCIA_INTERNA: "Transferência Interna",
  PIX_DEVOLVIDO_MANUAL: "PIX Devolvido",
  LINK_JA_PAGO_GC: "Rastreabilidade",
  MATCH_VALOR_DATA: "Valor + Data",
  MATCH_VALOR_NOME: "Valor + Nome",
  MATCH_GRUPO_RECEBER: "Grupo Receber",
  MATCH_GRUPO_PAGAR: "Grupo Pagar",
  MATCH_AGENDA: "Agenda",
  NOME_VALOR_EXATO: "Nome + Valor Exato",
  CNPJ_VALOR_EXATO: "CNPJ + Valor Exato",
  CNPJ_VALOR_TOLERANCIA: "CNPJ + Valor ~2%",
  PIX_KEY_VALOR: "Chave PIX + Valor",
  REGRA_0_MAX_CONFIANCA: "Máx. Confiança",
  SOMA_PARCELAS: "Soma Parcelas",
  DATA_PROXIMA: "Data Próxima",
  MANUAL_VINCULO: "Vínculo Manual",
};

export default function ConciliacaoHistoricoPage() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [tipoFilter, setTipoFilter] = useState<string>("todos");
  const [vinculoFilter, setVinculoFilter] = useState<string>("todos");
  const [detail, setDetail] = useState<any>(null);
  const [detailLancamentos, setDetailLancamentos] = useState<any[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [tab, setTab] = useState("conciliados");

  // Month filter
  const [mesSelecionado, setMesSelecionado] = useState("all");

  const monthOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [{ value: "all", label: "Todos os meses" }];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = subMonths(now, i);
      opts.push({ value: format(d, "yyyy-MM"), label: format(d, "MMMM yyyy", { locale: ptBR }).replace(/^\w/, c => c.toUpperCase()) });
    }
    return opts;
  }, []);

  const mesDateRange = useMemo(() => {
    if (mesSelecionado === "all") return null;
    const base = new Date(mesSelecionado + "-01");
    return { from: startOfMonth(base).toISOString(), to: endOfMonth(base).toISOString() };
  }, [mesSelecionado]);

  // Manual linking state
  const [showVincularDialog, setShowVincularDialog] = useState(false);
  const [vinculandoItem, setVinculandoItem] = useState<any>(null);
  const [vinculoForm, setVinculoForm] = useState({ descricao: "", os_codigo: "", gc_codigo: "", nfe_numero: "" });

  // CONCILIADOS REAIS
  const { data: items, isLoading } = useQuery({
    queryKey: ["conciliacao-historico", mesSelecionado],
    queryFn: async () => {
      let query = supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .eq("reconciliado", true)
        .not("reconciliation_rule", "in", '("SEM_PAR_GC","TRANSFERENCIA_INTERNA","PIX_DEVOLVIDO_MANUAL")');

      if (mesDateRange) {
        query = query.gte("reconciliado_em", mesDateRange.from).lte("reconciliado_em", mesDateRange.to);
      }

      const { data } = await query.order("reconciliado_em", { ascending: false }).limit(2000);
      return (data as any[]) || [];
    },
  });

  // NÃO CONCILIADO (exceções classificadas)
  const { data: excecoes, isLoading: isLoadingExc } = useQuery({
    queryKey: ["conciliacao-excecoes", mesSelecionado],
    queryFn: async () => {
      let query = supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .in("reconciliation_rule", EXCECAO_RULES);

      if (mesDateRange) {
        query = query.gte("reconciliado_em", mesDateRange.from).lte("reconciliado_em", mesDateRange.to);
      }

      const { data } = await query.order("reconciliado_em", { ascending: false }).limit(500);
      return (data as any[]) || [];
    },
  });

  // FINANCEIRO NÃO CONCILIADO (sem regra, não reconciliado)
  const { data: financeirosNaoConciliados, isLoading: isLoadingFinNaoConc } = useQuery({
    queryKey: ["conciliacao-financeiro-nao-conciliado", mesSelecionado],
    queryFn: async () => {
      let query = supabase
        .from("vw_conciliacao_extrato" as any)
        .select("*")
        .eq("reconciliado", false)
        .is("reconciliation_rule", null);

      if (mesDateRange) {
        query = query.gte("data_hora", mesDateRange.from).lte("data_hora", mesDateRange.to);
      }

      const { data } = await query.order("data_hora", { ascending: false }).limit(500);
      return (data as any[]) || [];
    },
  });

  // Fetch linked lancamentos when detail opens
  const openDetail = async (item: any) => {
    setDetail(item);
    setDetailLancamentos([]);
    if (!item.id) return;
    setDetailLoading(true);
    try {
      const { data: links } = await supabase
        .from("fin_extrato_lancamentos")
        .select("lancamento_id, tabela, valor_alocado, reconciliation_rule")
        .eq("extrato_id", item.id);

      if (!links?.length && item.lancamento_id) {
        // Fallback: conciliação 1:1 sem registro em fin_extrato_lancamentos
        // Tentar buscar em ambas as tabelas
        const isDebito = item.tipo === "DEBITO";
        const fallbackTable = isDebito ? "fin_pagamentos" : "fin_recebimentos";
        const { data: rec } = await supabase
          .from(fallbackTable as any)
          .select("id, gc_id, gc_codigo, descricao, valor, data_vencimento, data_liquidacao, data_competencia, liquidado, status, gc_baixado, gc_baixado_em, os_codigo, nome_cliente, nome_fornecedor, plano_contas_id, centro_custo_id, origem, tipo")
          .eq("id", item.lancamento_id)
          .single();
        if (rec) {
          setDetailLancamentos([{ ...(rec as any), _tabela: fallbackTable, _valor_alocado: null, _rule: item.reconciliation_rule }]);
        }
        setDetailLoading(false);
        return;
      }
      if (!links?.length) {
        setDetailLoading(false);
        return;
      }

      const results: any[] = [];
      for (const link of links) {
        // Engine stores "pagamentos"/"recebimentos", need full table name
        const rawTabela = link.tabela as string;
        const table = rawTabela.startsWith("fin_") ? rawTabela : `fin_${rawTabela}`;
        const { data: rec } = await supabase
          .from(table as "fin_recebimentos" | "fin_pagamentos")
          .select("id, gc_id, gc_codigo, descricao, valor, data_vencimento, data_liquidacao, data_competencia, liquidado, status, gc_baixado, gc_baixado_em, os_codigo, nome_cliente, nome_fornecedor, plano_contas_id, centro_custo_id, origem, tipo")
          .eq("id", link.lancamento_id)
          .single();
        if (rec) {
          results.push({ ...(rec as any), _tabela: table, _valor_alocado: link.valor_alocado, _rule: link.reconciliation_rule });
        }
      }
      setDetailLancamentos(results);
    } catch (e) {
      console.error("Erro ao buscar lançamentos vinculados:", e);
    } finally {
      setDetailLoading(false);
    }
  };

  // Manual linking handler
  const handleVincularManual = async () => {
    if (!vinculandoItem) return;
    const updatePayload: Record<string, any> = {
      reconciliado: true,
      reconciliation_rule: "MANUAL_VINCULO",
      reconciliado_em: new Date().toISOString(),
    };
    if (vinculoForm.descricao) updatePayload.descricao = vinculoForm.descricao;

    const { error } = await supabase
      .from("fin_extrato_inter")
      .update(updatePayload)
      .eq("id", vinculandoItem.id);

    if (!error) {
      toast.success("Vínculo registrado com sucesso");
      setShowVincularDialog(false);
      setVinculandoItem(null);
      queryClient.invalidateQueries({ queryKey: ["conciliacao-financeiro-nao-conciliado"] });
      queryClient.invalidateQueries({ queryKey: ["conciliacao-historico"] });
    } else {
      toast.error(`Erro ao vincular: ${error.message}`);
    }
  };

  const searchFilter = (i: any) => {
    if (!search) return true;
    const s = search.toLowerCase();
    return (
      i.nome_contraparte?.toLowerCase().includes(s) ||
      i.cpf_cnpj?.toLowerCase().includes(s) ||
      i.end_to_end_id?.toLowerCase().includes(s) ||
      i.descricao?.toLowerCase().includes(s) ||
      i.chave_pix?.toLowerCase().includes(s) ||
      i.contrapartida?.toLowerCase().includes(s)
    );
  };

  const filtered = (items || [])
    .filter((i: any) => tipoFilter === "todos" || i.tipo === tipoFilter)
    .filter((i: any) => {
      if (vinculoFilter === "todos") return true;
      if (vinculoFilter === "lancamento") return !!i.lancamento_id;
      if (vinculoFilter === "grupo_receber") return !!i.grupo_receber_id;
      if (vinculoFilter === "grupo_pagar") return !!i.grupo_pagar_id;
      if (vinculoFilter === "agenda") return !!i.agenda_id;
      return true;
    })
    .filter(searchFilter);

  const filteredExc = (excecoes || []).filter(searchFilter);
  const filteredFinNaoConc = (financeirosNaoConciliados || []).filter(searchFilter);

  // Stats
  const totalCredito = filtered.filter((i: any) => i.tipo === "CREDITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato || 0)), 0);
  const totalDebito = filtered.filter((i: any) => i.tipo === "DEBITO").reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato || 0)), 0);
  const totalExcecoes = (excecoes || []).reduce((s: number, i: any) => s + Math.abs(Number(i.valor_extrato || 0)), 0);

  const vinculoBadge = (item: any) => {
    if (item.grupo_receber_id) return <Badge variant="secondary" className="text-[10px]">Grupo Receber</Badge>;
    if (item.grupo_pagar_id) return <Badge variant="secondary" className="text-[10px]">Grupo Pagar</Badge>;
    if (item.agenda_id) return <Badge variant="secondary" className="text-[10px]">Agenda</Badge>;
    if (item.lancamento_id) return <Badge variant="secondary" className="text-[10px]">Lançamento</Badge>;
    return null;
  };

  const diferencaBadge = (item: any) => {
    if (item.exato) return <Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30 text-[10px]">Exato</Badge>;
    if (item.diferenca != null && item.diferenca !== 0) {
      const diff = Number(item.diferenca);
      return (
        <Badge variant="outline" className="bg-amber-500/10 text-amber-500 border-amber-500/30 text-[10px]">
          {diff > 0 ? "+" : ""}{formatCurrency(diff)}
        </Badge>
      );
    }
    return null;
  };

  const renderRow = (item: any, showDiferenca = true, showVinculo = true) => (
    <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
      {/* Data */}
      <div className="col-span-2 text-xs text-muted-foreground">
        {formatDateTime(item.reconciliado_em || item.data_hora)}
      </div>
      {/* Nome contraparte */}
      <div className="col-span-2 font-medium text-foreground truncate" title={item.nome_contraparte}>
        {item.nome_contraparte || "—"}
      </div>
      {/* CPF/CNPJ */}
      <div className="col-span-1 text-xs text-muted-foreground font-mono truncate" title={item.cpf_cnpj}>
        {item.cpf_cnpj || "—"}
      </div>
      {/* Tipo + Vínculo + GC links */}
      <div className="col-span-2 flex flex-wrap items-center gap-1">
        <Badge variant="outline" className="text-[10px]">{item.tipo}</Badge>
        {showVinculo && vinculoBadge(item)}
        {item.reconciliation_rule && !EXCECAO_RULES.includes(item.reconciliation_rule) && (
          <TooltipProvider>
            <Tooltip>
              <TooltipTrigger>
                <Badge variant="outline" className="text-[10px] bg-primary/10 text-primary border-primary/30">
                  <Link2 className="h-2.5 w-2.5 mr-0.5" />
                  {ruleLabels[item.reconciliation_rule] || item.reconciliation_rule}
                </Badge>
              </TooltipTrigger>
              <TooltipContent>Regra: {item.reconciliation_rule}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}
        {item.gc_codigo_vinculado && (
          <a
            href={item._tabela === "fin_recebimentos" ? gcRecebimentoLink(item.gc_codigo_vinculado) : gcPagamentoLink(item.gc_codigo_vinculado)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            GC {item.gc_codigo_vinculado} <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
      {/* Valor extrato */}
      <div className="col-span-1 text-right font-bold text-foreground">
        {formatCurrency(Math.abs(Number(item.valor_extrato || 0)))}
      </div>
      {/* Valor GC + Diferença */}
      {showDiferenca ? (
        <div className="col-span-2 flex items-center gap-2">
          {item.valor_gc != null && (
            <span className="text-xs text-muted-foreground">
              GC: {formatCurrency(Number(item.valor_gc))}
            </span>
          )}
          {item.qtd_parcelas != null && item.qtd_parcelas > 1 && (
            <Badge variant="outline" className="text-[10px]">{item.qtd_parcelas}x</Badge>
          )}
          {diferencaBadge(item)}
        </div>
      ) : (
        <div className="col-span-2" />
      )}
      {/* Ações */}
      <div className="col-span-2 flex items-center justify-end gap-1">
        <TooltipProvider>
          <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openDetail(item)}>
            <Eye className="h-3.5 w-3.5" />
          </Button>
        </TooltipProvider>
      </div>
    </div>
  );

  const renderExcRow = (item: any) => (
    <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
      <div className="col-span-2 text-xs text-muted-foreground">
        {formatDateTime(item.reconciliado_em || item.data_hora)}
      </div>
      <div className="col-span-2 font-medium text-foreground truncate" title={item.nome_contraparte}>
        {item.nome_contraparte || "—"}
      </div>
      <div className="col-span-1 text-xs text-muted-foreground font-mono truncate">
        {item.cpf_cnpj || "—"}
      </div>
      <div className="col-span-2 flex flex-wrap items-center gap-1">
        <Badge variant="destructive" className="text-[10px]">
          {ruleLabels[item.reconciliation_rule] || item.reconciliation_rule}
        </Badge>
        {item.gc_codigo_vinculado && (
          <a
            href={item._tabela === "fin_recebimentos" ? gcRecebimentoLink(item.gc_codigo_vinculado) : gcPagamentoLink(item.gc_codigo_vinculado)}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            GC {item.gc_codigo_vinculado} <ExternalLink className="h-2.5 w-2.5" />
          </a>
        )}
      </div>
      <div className="col-span-1 text-right font-bold text-foreground">
        {formatCurrency(Math.abs(Number(item.valor_extrato || 0)))}
      </div>
      <div className="col-span-2 text-xs text-muted-foreground truncate" title={item.descricao}>
        {item.descricao || "—"}
      </div>
      <div className="col-span-2 flex items-center justify-end gap-1">
        <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openDetail(item)}>
          <Eye className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Histórico de Conciliação</h1>
        <p className="text-sm text-muted-foreground">Registro detalhado de todas as transações reconciliadas</p>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        <div className="rounded-lg border border-border bg-card p-3">
          <p className="text-[10px] uppercase text-muted-foreground font-semibold">Total Conciliado</p>
          <p className="text-lg font-bold text-foreground">{filtered.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingUp className="h-3 w-3 text-emerald-500" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Créditos</p>
          </div>
          <p className="text-lg font-bold text-emerald-500">{formatCurrency(totalCredito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "CREDITO").length} transações</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <TrendingDown className="h-3 w-3 text-destructive" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Débitos</p>
          </div>
          <p className="text-lg font-bold text-destructive">{formatCurrency(totalDebito)}</p>
          <p className="text-[10px] text-muted-foreground">{filtered.filter((i: any) => i.tipo === "DEBITO").length} transações</p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <ArrowLeftRight className="h-3 w-3 text-primary" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Saldo Líquido</p>
          </div>
          <p className={`text-lg font-bold ${totalCredito - totalDebito >= 0 ? "text-emerald-500" : "text-destructive"}`}>
            {formatCurrency(totalCredito - totalDebito)}
          </p>
        </div>
        <div className="rounded-lg border border-border bg-card p-3">
          <div className="flex items-center gap-1">
            <AlertTriangle className="h-3 w-3 text-amber-500" />
            <p className="text-[10px] uppercase text-muted-foreground font-semibold">Não Conciliado</p>
          </div>
          <p className="text-lg font-bold text-amber-500">{(excecoes || []).length}</p>
          <p className="text-[10px] text-muted-foreground">{formatCurrency(totalExcecoes)}</p>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        {/* Month selector */}
        <Select value={mesSelecionado} onValueChange={setMesSelecionado}>
          <SelectTrigger className="w-[180px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            {monthOptions.map(opt => (
              <SelectItem key={opt.value} value={opt.value}>{opt.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="relative flex-1 min-w-[200px] max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input placeholder="Buscar nome, CPF/CNPJ, E2E ID, descrição, OS, G..." value={search} onChange={e => setSearch(e.target.value)} className="pl-9" />
        </div>
        <Select value={tipoFilter} onValueChange={setTipoFilter}>
          <SelectTrigger className="w-[140px]"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="todos">Todos tipos</SelectItem>
            <SelectItem value="CREDITO">Crédito</SelectItem>
            <SelectItem value="DEBITO">Débito</SelectItem>
          </SelectContent>
        </Select>
        {tab === "conciliados" && (
          <Select value={vinculoFilter} onValueChange={setVinculoFilter}>
            <SelectTrigger className="w-[160px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="todos">Todos vínculos</SelectItem>
              <SelectItem value="lancamento">Lançamento</SelectItem>
              <SelectItem value="grupo_receber">Grupo Receber</SelectItem>
              <SelectItem value="grupo_pagar">Grupo Pagar</SelectItem>
              <SelectItem value="agenda">Agenda</SelectItem>
            </SelectContent>
          </Select>
        )}
      </div>

      {/* Tabs */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="conciliados">Conciliados ({filtered.length})</TabsTrigger>
          <TabsTrigger value="excecoes">Não Conciliado ({filteredExc.length})</TabsTrigger>
          <TabsTrigger value="financeiro_nao_conciliado">Financeiro Não Conciliado ({filteredFinNaoConc.length})</TabsTrigger>
        </TabsList>

        <TabsContent value="conciliados" className="space-y-3">
          {isLoading ? (
            <p className="text-muted-foreground p-4">Carregando...</p>
          ) : filtered.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center">Nenhum registro conciliado encontrado.</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-card overflow-hidden">
              {/* Header */}
              <div className="grid grid-cols-12 items-center gap-2 p-3 bg-muted/50 text-[10px] uppercase font-semibold text-muted-foreground">
                <div className="col-span-2">Data</div>
                <div className="col-span-2">Contraparte</div>
                <div className="col-span-1">CPF/CNPJ</div>
                <div className="col-span-2">Tipo / Vínculo</div>
                <div className="col-span-1 text-right">Valor</div>
                <div className="col-span-2">GC / Dif.</div>
                <div className="col-span-2 text-right">Ações</div>
              </div>
              {filtered.map((item: any) => renderRow(item))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{filtered.length} registro(s) conciliado(s)</p>
        </TabsContent>

        <TabsContent value="excecoes" className="space-y-3">
          {/* Informational banner */}
          <div className="rounded-lg bg-amber-500/10 border border-amber-500/30 p-3 flex items-start gap-2">
            <AlertCircle className="h-4 w-4 text-amber-500 shrink-0 mt-0.5" />
            <div className="text-xs text-foreground">
              Estes lançamentos foram classificados manualmente como exceções e
              <strong> nunca serão reprocessados</strong> pelo motor de conciliação automática.
              Para reclassificar um item, use o botão de detalhes (ícone de olho) individual.
            </div>
          </div>

          {isLoadingExc ? (
            <p className="text-muted-foreground p-4">Carregando...</p>
          ) : filteredExc.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center">Nenhuma exceção encontrada.</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-card overflow-hidden">
              <div className="grid grid-cols-12 items-center gap-2 p-3 bg-muted/50 text-[10px] uppercase font-semibold text-muted-foreground">
                <div className="col-span-2">Data</div>
                <div className="col-span-2">Contraparte</div>
                <div className="col-span-1">CPF/CNPJ</div>
                <div className="col-span-2">Motivo</div>
                <div className="col-span-1 text-right">Valor</div>
                <div className="col-span-2">Descrição</div>
                <div className="col-span-2 text-right">Ações</div>
              </div>
              {filteredExc.map((item: any) => renderExcRow(item))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{filteredExc.length} registro(s) não conciliado(s)</p>
        </TabsContent>

        <TabsContent value="financeiro_nao_conciliado" className="space-y-3">
          {isLoadingFinNaoConc ? (
            <p className="text-muted-foreground p-4">Carregando...</p>
          ) : filteredFinNaoConc.length === 0 ? (
            <p className="text-muted-foreground p-4 text-center">Nenhum registro pendente.</p>
          ) : (
            <div className="divide-y divide-border rounded-md border border-border bg-card overflow-hidden">
              <div className="grid grid-cols-12 items-center gap-2 p-3 bg-muted/50 text-[10px] uppercase font-semibold text-muted-foreground">
                <div className="col-span-2">Data</div>
                <div className="col-span-2">Contraparte</div>
                <div className="col-span-1">CPF/CNPJ</div>
                <div className="col-span-2">Tipo</div>
                <div className="col-span-1 text-right">Valor</div>
                <div className="col-span-2">Descrição</div>
                <div className="col-span-2 text-right">Ações</div>
              </div>
              {filteredFinNaoConc.map((item: any) => (
                <div key={item.id} className="grid grid-cols-12 items-center gap-2 p-3 hover:bg-muted/30 transition-colors">
                  <div className="col-span-2 text-xs text-muted-foreground">{formatDateTime(item.data_hora)}</div>
                  <div className="col-span-2 font-medium text-foreground truncate">{item.nome_contraparte || "—"}</div>
                  <div className="col-span-1 text-xs text-muted-foreground font-mono truncate">{item.cpf_cnpj || "—"}</div>
                  <div className="col-span-2 flex flex-wrap items-center gap-1">
                    <Badge variant="outline" className="text-[10px]">{item.tipo}</Badge>
                    {item.gc_codigo_vinculado && (
                      <a
                        href={item._tabela === "fin_recebimentos" ? gcRecebimentoLink(item.gc_codigo_vinculado) : gcPagamentoLink(item.gc_codigo_vinculado)}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-0.5 text-[10px] text-primary hover:underline"
                        onClick={(e) => e.stopPropagation()}
                      >
                        GC {item.gc_codigo_vinculado} <ExternalLink className="h-2.5 w-2.5" />
                      </a>
                    )}
                  </div>
                  <div className="col-span-1 text-right font-bold text-foreground">{formatCurrency(Math.abs(Number(item.valor_extrato || 0)))}</div>
                  <div className="col-span-2 text-xs text-muted-foreground truncate" title={item.descricao}>{item.descricao || "—"}</div>
                  <div className="col-span-2 flex items-center justify-end gap-1">
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 text-[10px] gap-1"
                      onClick={() => {
                        setVinculandoItem(item);
                        setVinculoForm({ descricao: item.descricao ?? "", os_codigo: "", gc_codigo: "", nfe_numero: "" });
                        setShowVincularDialog(true);
                      }}
                    >
                      <Link className="h-3 w-3" />
                      Vincular
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7" onClick={() => openDetail(item)}>
                      <Eye className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
          <p className="text-xs text-muted-foreground">{filteredFinNaoConc.length} registro(s) pendente(s)</p>
        </TabsContent>
      </Tabs>

      {/* Detail Modal */}
      <Dialog open={!!detail} onOpenChange={() => { setDetail(null); setDetailLancamentos([]); }}>
        <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Detalhes da Conciliação</DialogTitle>
          </DialogHeader>
          {detail && (
            <div className="space-y-4">
              {/* SEÇÃO 1: Transação Bancária */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Banknote className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-foreground">Transação Bancária (Extrato Inter)</h3>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm">
                  <DetailRow label="ID Extrato" value={detail.id} mono />
                  <DetailRow label="Contraparte" value={detail.nome_contraparte} bold />
                  <DetailRow label="CPF/CNPJ" value={detail.cpf_cnpj} mono />
                  <DetailRow label="Tipo" value={<Badge variant="outline">{detail.tipo}</Badge>} />
                  <DetailRow label="Tipo Transação" value={detail.tipo_transacao} />
                  <DetailRow label="Valor Extrato" value={formatCurrency(Math.abs(Number(detail.valor_extrato || 0)))} bold />
                  <DetailRow label="Descrição" value={detail.descricao} />
                  <DetailRow label="Data/Hora" value={formatDateTime(detail.data_hora)} />
                  {detail.end_to_end_id && <DetailRow label="E2E ID" value={detail.end_to_end_id} mono small />}
                  {detail.chave_pix && <DetailRow label="Chave PIX" value={detail.chave_pix} mono small />}
                  {detail.codigo_barras && <DetailRow label="Cód. Barras" value={detail.codigo_barras} mono small />}
                  {detail.contrapartida && <DetailRow label="Contrapartida" value={detail.contrapartida} />}
                </div>
              </div>

              <Separator />

              {/* SEÇÃO 2: Conciliação */}
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <Link2 className="h-4 w-4 text-primary" />
                  <h3 className="font-semibold text-foreground">Dados da Conciliação</h3>
                </div>
                <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm">
                  <DetailRow label="Regra" value={
                    detail.reconciliation_rule ? (
                      <Badge variant="secondary">{ruleLabels[detail.reconciliation_rule] || detail.reconciliation_rule}</Badge>
                    ) : "—"
                  } />
                  <DetailRow label="Conciliado em" value={detail.reconciliado_em ? formatDateTime(detail.reconciliado_em) : "—"} />
                  {detail.valor_gc != null && <DetailRow label="Valor GC" value={formatCurrency(Number(detail.valor_gc))} bold />}
                  {detail.diferenca != null && detail.diferenca !== 0 && (
                    <DetailRow label="Diferença" value={diferencaBadge(detail)} />
                  )}
                  {detail.exato && <DetailRow label="Match" value={<Badge variant="outline" className="bg-emerald-500/10 text-emerald-500 border-emerald-500/30">Valor Exato</Badge>} />}
                  {detail.qtd_parcelas != null && detail.qtd_parcelas > 1 && (
                    <DetailRow label="Parcelas (N:N)" value={`${detail.qtd_parcelas} lançamentos vinculados`} />
                  )}
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
                ) : detailLancamentos.length === 0 ? (
                  <p className="text-sm text-muted-foreground p-3">Nenhum lançamento vinculado encontrado.</p>
                ) : (
                  <div className="space-y-3">
                    {detailLancamentos.map((lanc: any, idx: number) => (
                      <div key={idx} className="rounded-lg border border-border bg-muted/30 p-3 space-y-2 text-sm">
                        <div className="flex items-center justify-between">
                          <Badge variant="outline" className="text-[10px]">{lanc._tabela === "fin_recebimentos" ? "Recebimento" : "Pagamento"}</Badge>
                          {lanc.gc_codigo && (
                            <a
                              href={lanc._tabela === "fin_recebimentos" ? gcRecebimentoLink(lanc.gc_codigo) : gcPagamentoLink(lanc.gc_codigo)}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="flex items-center gap-1 text-xs text-primary hover:underline"
                            >
                              Abrir no GestãoClick <ExternalLink className="h-3 w-3" />
                            </a>
                          )}
                        </div>
                        <DetailRow label="ID Local" value={lanc.id} mono small />
                        <DetailRow label="GC ID" value={lanc.gc_id || "—"} mono />
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
                        {lanc.plano_contas_id && <DetailRow label="Plano Contas ID" value={lanc.plano_contas_id} mono small />}
                        {lanc.centro_custo_id && <DetailRow label="Centro Custo ID" value={lanc.centro_custo_id} mono small />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Manual Linking Dialog */}
      <Dialog open={showVincularDialog} onOpenChange={(v) => { if (!v) { setShowVincularDialog(false); setVinculandoItem(null); } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Vincular Lançamento Manualmente</DialogTitle>
            <DialogDescription>
              Informe a referência financeira correta para este lançamento do extrato bancário.
            </DialogDescription>
          </DialogHeader>
          {vinculandoItem && (
            <div className="space-y-4">
              <div className="rounded-lg border border-border bg-muted/30 p-3 space-y-1">
                <p className="text-sm font-medium text-foreground">Extrato: {vinculandoItem.descricao ?? "—"}</p>
                <p className="text-sm text-foreground">Valor: {new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(vinculandoItem.valor_extrato ?? vinculandoItem.valor ?? 0)}</p>
                <p className="text-xs text-muted-foreground">Data: {vinculandoItem.data_hora ? new Date(vinculandoItem.data_hora).toLocaleDateString("pt-BR") : "—"}</p>
                {vinculandoItem.cpf_cnpj && <p className="text-xs text-muted-foreground">Doc: {vinculandoItem.cpf_cnpj}</p>}
              </div>

              <div className="space-y-3">
                <div className="space-y-1.5">
                  <Label className="text-xs">Descrição correta</Label>
                  <Input
                    value={vinculoForm.descricao}
                    onChange={(e) => setVinculoForm(f => ({ ...f, descricao: e.target.value }))}
                    placeholder="Descrição do lançamento"
                  />
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Código OS</Label>
                    <Input
                      value={vinculoForm.os_codigo}
                      onChange={(e) => setVinculoForm(f => ({ ...f, os_codigo: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Código GC</Label>
                    <Input
                      value={vinculoForm.gc_codigo}
                      onChange={(e) => setVinculoForm(f => ({ ...f, gc_codigo: e.target.value }))}
                    />
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label className="text-xs">Número NF-e</Label>
                  <Input
                    value={vinculoForm.nfe_numero}
                    onChange={(e) => setVinculoForm(f => ({ ...f, nfe_numero: e.target.value }))}
                  />
                </div>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowVincularDialog(false)}>Cancelar</Button>
            <Button onClick={handleVincularManual}>Confirmar Vínculo</Button>
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
