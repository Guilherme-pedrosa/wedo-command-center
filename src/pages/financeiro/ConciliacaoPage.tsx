import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar } from "@/components/ui/calendar";
import { formatCurrency, formatDateTime } from "@/lib/format";
import { ArrowLeftRight, CheckCircle, Loader2, Wand2, RefreshCw, ExternalLink, FileText, Hash, Search, X, ChevronDown, ChevronUp, Download, CalendarIcon } from "lucide-react";
import { format, startOfMonth, endOfMonth, subMonths, startOfDay, endOfDay } from "date-fns";
import { cn } from "@/lib/utils";
import { ptBR } from "date-fns/locale";
import { SyncPeriodDialog } from "@/components/financeiro/SyncPeriodDialog";
import { syncByMonthChunks } from "@/api/financeiro";
import toast from "react-hot-toast";

const GC_BASE = "https://app.gestaoclick.com.br";

// Build month options: current + last 5 months + "all"
function buildMonthOptions() {
  const opts = [{ value: "all", label: "Todos os meses" }];
  const now = new Date();
  for (let i = 0; i < 6; i++) {
    const d = subMonths(now, i);
    opts.push({
      value: format(d, "yyyy-MM"),
      label: format(d, "MMMM yyyy", { locale: ptBR }).replace(/^\w/, c => c.toUpperCase()),
    });
  }
  return opts;
}

const monthOptions = buildMonthOptions();

// GC link helpers
const gcOsLink = (osCode: string) => `${GC_BASE}/ordens_servicos/${osCode}`;
const gcRecebimentoLink = (gcId: string) => `${GC_BASE}/recebimentos/${gcId}`;
const gcPagamentoLink = (gcId: string) => `${GC_BASE}/pagamentos/${gcId}`;

function GCLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-0.5 text-primary hover:underline" onClick={e => e.stopPropagation()}>
      {children}
      <ExternalLink className="h-2.5 w-2.5" />
    </a>
  );
}

export default function ConciliacaoPage() {
  const queryClient = useQueryClient();
  const [selectedExtrato, setSelectedExtrato] = useState<any>(null);
  const [selectedLanc, setSelectedLanc] = useState<any>(null);
  const [showConfirm, setShowConfirm] = useState(false);
  const [linking, setLinking] = useState(false);
  const [autoRunning, setAutoRunning] = useState(false);
  const [autoResult, setAutoResult] = useState<any>(null);
  const [syncing, setSyncing] = useState(false);
  const [showSyncDialog, setShowSyncDialog] = useState(false);
  const [mesExtrato, setMesExtrato] = useState(format(new Date(), "yyyy-MM"));
  const [dateFrom, setDateFrom] = useState(startOfMonth(new Date()));
  const [dateTo, setDateTo] = useState(endOfMonth(new Date()));
  const [mesLanc, setMesLanc] = useState("all");
  const [searchLanc, setSearchLanc] = useState("");
  const [expandedExtrato, setExpandedExtrato] = useState<string | null>(null);

  const handleMesChange = (val: string) => {
    setMesExtrato(val);
    if (val !== "all") {
      const base = new Date(val + "-01");
      setDateFrom(startOfMonth(base));
      setDateTo(endOfMonth(base));
    }
  };

  // Extrato query — server-side date filter, paginated
  const { data: extratoNR } = useQuery({
    queryKey: ["conc-extrato", dateFrom.toISOString(), dateTo.toISOString()],
    queryFn: async () => {
      const PAGE_SIZE = 500;
      let allData: any[] = [];
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        const { data, error } = await supabase
          .from("fin_extrato_inter")
          .select("*")
          .eq("reconciliado", false)
          .is("reconciliation_rule", null)
          .gte("data_hora", dateFrom.toISOString())
          .lte("data_hora", dateTo.toISOString())
          .order("data_hora", { ascending: false })
          .range(offset, offset + PAGE_SIZE - 1);

        if (error) throw error;
        if (!data || data.length < PAGE_SIZE) {
          allData = [...allData, ...(data || [])];
          hasMore = false;
        } else {
          allData = [...allData, ...data];
          offset += PAGE_SIZE;
          if (allData.length >= 2000) hasMore = false;
        }
      }
      return allData;
    },
  });

  // Recebimentos — all non-cancelled for search
  const { data: recebimentosNL } = useQuery({
    queryKey: ["conc-recebimentos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_recebimentos")
        .select("id, descricao, valor, nome_cliente, data_vencimento, status, os_codigo, gc_codigo, gc_id, nf_numero, nfe_chave, nfe_numero, liquidado, pago_sistema")
        .not("status", "eq", "cancelado")
        .order("data_vencimento", { ascending: false })
        .limit(1000);
      return data || [];
    },
  });

  // Pagamentos — all non-cancelled for search
  const { data: pagamentosNL } = useQuery({
    queryKey: ["conc-pagamentos"],
    queryFn: async () => {
      const { data } = await supabase
        .from("fin_pagamentos")
        .select("id, descricao, valor, nome_fornecedor, data_vencimento, status, os_codigo, gc_codigo, gc_id, nf_numero, nfe_chave, liquidado, pago_sistema")
        .not("status", "eq", "cancelado")
        .order("data_vencimento", { ascending: false })
        .limit(1000);
      return data || [];
    },
  });



  const handleSelectExtrato = (e: any) => {
    if (expandedExtrato === e.id) {
      setExpandedExtrato(null);
      setSearchLanc("");
    } else {
      setExpandedExtrato(e.id);
      setSelectedExtrato(e);
      setSearchLanc("");
    }
  };

  // Search-filtered lancamentos for the expanded extrato
  const searchedLancamentos = useMemo(() => {
    if (!expandedExtrato || !selectedExtrato) return { recebimentos: [], pagamentos: [] };
    const isCredito = selectedExtrato.tipo === "CREDITO";
    const q = searchLanc.toLowerCase().trim();

    const filterFn = (l: any) => {
      if (!q) return true;
      const valorStr = Number(l.valor || 0).toFixed(2);
      const fields = [l.descricao, l.nome_cliente, l.nome_fornecedor, l.os_codigo, l.gc_codigo, l.nf_numero, l.nfe_numero, valorStr, String(l.valor)].filter(Boolean).join(" ").toLowerCase();
      // Also try matching as numeric value comparison
      const numQuery = parseFloat(q.replace(",", "."));
      if (!isNaN(numQuery) && Math.abs(Number(l.valor) - numQuery) < 0.01) return true;
      return fields.includes(q);
    };

    if (isCredito) {
      return { recebimentos: (recebimentosNL || []).filter(filterFn).slice(0, 50), pagamentos: [] };
    } else {
      return { recebimentos: [], pagamentos: (pagamentosNL || []).filter(filterFn).slice(0, 50) };
    }
  }, [expandedExtrato, selectedExtrato, searchLanc, recebimentosNL, pagamentosNL]);

  const invalidateAll = () => {
    queryClient.invalidateQueries({ queryKey: ["conc-extrato"] });
    queryClient.invalidateQueries({ queryKey: ["conc-recebimentos"] });
    queryClient.invalidateQueries({ queryKey: ["conc-pagamentos"] });
  };

  const handleVincular = async () => {
    if (!selectedExtrato || !selectedLanc) return;
    setLinking(true);
    try {
      await supabase.from("fin_extrato_inter").update({ reconciliado: true, lancamento_id: selectedLanc.id, reconciliado_em: new Date().toISOString(), reconciliation_rule: "MANUAL" }).eq("id", selectedExtrato.id);
      const table = selectedLanc._tipo === "receber" ? "fin_recebimentos" : "fin_pagamentos";
      await supabase.from(table).update({ pago_sistema: true, pago_sistema_em: new Date().toISOString() }).eq("id", selectedLanc.id);
      toast.success("Vinculado com sucesso");
      setSelectedExtrato(null); setSelectedLanc(null); setShowConfirm(false);
      invalidateAll();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Erro"); }
    finally { setLinking(false); }
  };

  const diff = selectedExtrato && selectedLanc ? Math.abs(Number(selectedExtrato.valor) - Number(selectedLanc.valor)) : 0;

  const handleAutoReconcile = async () => {
    setAutoRunning(true);
    setAutoResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("reconciliation-engine", { body: {} });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Erro desconhecido");
      setAutoResult(data);
      toast.success(`Conciliação: ${data.stats.auto} auto-baixas, ${data.stats.review} para revisão`);
      invalidateAll();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro na conciliação automática");
    } finally {
      setAutoRunning(false);
    }
  };

  const labelContraparte = (e: any) => {
    const nome = e.nome_contraparte ?? e.contrapartida ?? null;
    const tipoTx = e.tipo_transacao ?? e.tipo ?? "";
    if (nome && nome !== e.descricao) return `${tipoTx} — ${nome}`;
    if (nome) return nome;
    return e.descricao ?? tipoTx ?? "Sem identificação";
  };

  // Render GC metadata badges for a lancamento
  const renderGCMeta = (l: any, tipo: "receber" | "pagar") => {
    const chips: React.ReactNode[] = [];
    if (l.os_codigo) {
      chips.push(
        <GCLink key="os" href={gcOsLink(l.gc_id || l.os_codigo)}>
          <Hash className="h-2.5 w-2.5" />OS {l.os_codigo}
        </GCLink>
      );
    }
    if (l.gc_codigo) {
      const link = tipo === "receber" ? gcRecebimentoLink(l.gc_id || l.gc_codigo) : gcPagamentoLink(l.gc_id || l.gc_codigo);
      chips.push(
        <GCLink key="gc" href={link}>
          GC {l.gc_codigo}
        </GCLink>
      );
    }
    if (l.nf_numero || l.nfe_numero) {
      chips.push(
        <span key="nf" className="inline-flex items-center gap-0.5 text-muted-foreground">
          <FileText className="h-2.5 w-2.5" />NF {l.nf_numero || l.nfe_numero}
        </span>
      );
    }
    if (!chips.length) return null;
    return <div className="flex flex-wrap gap-2 mt-0.5">{chips}</div>;
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-2xl font-bold text-foreground">Conciliação</h1>
          <p className="text-sm text-muted-foreground">Vincule transações do extrato a lançamentos do sistema</p>
        </div>
        <div className="flex gap-2">
          <Button onClick={() => { invalidateAll(); toast.success("Dados recarregados"); }} variant="outline" size="sm" className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Atualizar
          </Button>
          <Button onClick={() => setShowSyncDialog(true)} disabled={syncing} size="sm" className="gap-2">
            {syncing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
            Sincronizar GC
          </Button>
          <Button onClick={handleAutoReconcile} disabled={autoRunning} variant="outline" className="gap-2">
            {autoRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />}
            Conciliação Automática
          </Button>
        </div>
      </div>

      {autoResult && (
        <div className="rounded-lg border border-border bg-card p-3 text-sm flex flex-wrap gap-4">
          <span className="text-wedo-green font-semibold">✅ {autoResult.stats.auto} auto-baixas</span>
          <span className="text-wedo-orange font-semibold">⏳ {autoResult.stats.review} revisão</span>
          <span className="text-muted-foreground">{autoResult.stats.unmatched} sem match</span>
          {autoResult.stats.errors > 0 && <span className="text-wedo-red">{autoResult.stats.errors} erros</span>}
        </div>
      )}

      {/* Single-panel: Extrato with expandable search */}
      <div className="rounded-lg border border-border bg-card p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold flex items-center gap-2">🏦 Extrato não reconciliado ({(extratoNR || []).length})</h3>
          <div className="flex items-center gap-2">
            <Select value={mesExtrato} onValueChange={handleMesChange}>
              <SelectTrigger className="w-[160px] h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {monthOptions.map(o => (
                  <SelectItem key={o.value} value={o.value} className="text-xs">{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="flex items-center gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
                    <CalendarIcon className="h-3 w-3" />
                    {format(dateFrom, "dd/MM/yy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateFrom}
                    onSelect={(d) => { if (d) { setDateFrom(startOfDay(d)); setMesExtrato("custom"); } }}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
              <span className="text-xs text-muted-foreground">→</span>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="outline" size="sm" className="h-8 text-xs gap-1">
                    <CalendarIcon className="h-3 w-3" />
                    {format(dateTo, "dd/MM/yy")}
                  </Button>
                </PopoverTrigger>
                <PopoverContent className="w-auto p-0" align="start">
                  <Calendar
                    mode="single"
                    selected={dateTo}
                    onSelect={(d) => { if (d) { setDateTo(endOfDay(d)); setMesExtrato("custom"); } }}
                    initialFocus
                    className={cn("p-3 pointer-events-auto")}
                  />
                </PopoverContent>
              </Popover>
            </div>
          </div>
        </div>
        <div className="space-y-2 max-h-[70vh] overflow-y-auto">
          {(extratoNR || []).map((e: any) => (
            <div key={e.id} className="rounded-md border border-border transition-colors">
              {/* Extrato row - clickable */}
              <div
                onClick={() => handleSelectExtrato(e)}
                className={`p-3 cursor-pointer transition-colors rounded-t-md ${expandedExtrato === e.id ? "bg-primary/10 border-b border-border" : "hover:bg-muted/30 rounded-b-md"}`}
              >
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-[10px] ${e.tipo === "CREDITO" ? "text-wedo-green" : "text-wedo-red"}`}>{e.tipo_transacao ?? e.tipo}</Badge>
                    <span className="text-xs font-medium text-foreground">{labelContraparte(e)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{formatCurrency(Number(e.valor))}</span>
                    {expandedExtrato === e.id ? <ChevronUp className="h-3.5 w-3.5 text-muted-foreground" /> : <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />}
                  </div>
                </div>
                <div className="flex items-center gap-3 mt-1">
                  {e.cpf_cnpj && <span className="text-[10px] text-muted-foreground">Doc: {e.cpf_cnpj}</span>}
                  {e.end_to_end_id && <span className="text-[10px] text-muted-foreground font-mono">E2E: {e.end_to_end_id}</span>}
                  <span className="text-[10px] text-muted-foreground">{e.data_hora ? formatDateTime(e.data_hora) : ""}</span>
                </div>
              </div>

              {/* Expanded: search & link financeiros */}
              {expandedExtrato === e.id && (
                <div className="p-3 space-y-3 bg-muted/20 rounded-b-md">
                  <div className="relative">
                    <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
                    <Input
                      placeholder={`Buscar ${e.tipo === "CREDITO" ? "recebimento" : "pagamento"} por descrição, OS, código, NF, valor...`}
                      value={searchLanc}
                      onChange={(ev) => setSearchLanc(ev.target.value)}
                      className="pl-8 h-8 text-xs"
                      autoFocus
                    />
                    {searchLanc && (
                      <button onClick={() => setSearchLanc("")} className="absolute right-2.5 top-2.5">
                        <X className="h-3.5 w-3.5 text-muted-foreground hover:text-foreground" />
                      </button>
                    )}
                  </div>

                  <div className="space-y-1 max-h-[40vh] overflow-y-auto">
                    {e.tipo === "CREDITO" ? (
                      <>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase px-1">
                          Recebimentos ({searchedLancamentos.recebimentos.length})
                        </p>
                        {searchedLancamentos.recebimentos.map((r: any) => (
                          <div
                            key={r.id}
                            onClick={() => {
                              setSelectedLanc({ ...r, _tipo: "receber" });
                              setShowConfirm(true);
                            }}
                            className="p-2 rounded-md border border-border cursor-pointer transition-colors text-xs hover:bg-primary/10 hover:border-primary"
                          >
                            <div className="flex justify-between items-start gap-2">
                              <span className="font-medium text-xs break-words" style={{ maxWidth: "60%" }}>{r.descricao}</span>
                              <span className="font-bold text-sm whitespace-nowrap text-primary shrink-0">{formatCurrency(Number(r.valor))}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-[10px] text-muted-foreground">{r.nome_cliente}</span>
                              {r.data_vencimento && <span className="text-[10px] text-muted-foreground">Venc: {r.data_vencimento}</span>}
                              {r.gc_codigo && <span className="text-[10px] text-muted-foreground">GC {r.gc_codigo}</span>}
                              {r.liquidado && <Badge variant="secondary" className="text-[9px] h-4">Liquidado</Badge>}
                              {r.pago_sistema && <Badge variant="secondary" className="text-[9px] h-4">Pago Sistema</Badge>}
                            </div>
                            {renderGCMeta(r, "receber")}
                          </div>
                        ))}
                        {!searchedLancamentos.recebimentos.length && (
                          <p className="text-[10px] text-muted-foreground text-center py-2">
                            {searchLanc ? "Nenhum resultado" : "Digite para buscar recebimentos"}
                          </p>
                        )}
                      </>
                    ) : (
                      <>
                        <p className="text-[10px] font-semibold text-muted-foreground uppercase px-1">
                          Pagamentos ({searchedLancamentos.pagamentos.length})
                        </p>
                        {searchedLancamentos.pagamentos.map((p: any) => (
                          <div
                            key={p.id}
                            onClick={() => {
                              setSelectedLanc({ ...p, _tipo: "pagar" });
                              setShowConfirm(true);
                            }}
                            className="p-2 rounded-md border border-border cursor-pointer transition-colors text-xs hover:bg-primary/10 hover:border-primary"
                          >
                            <div className="flex justify-between items-start gap-2">
                              <span className="font-medium text-xs break-words" style={{ maxWidth: "60%" }}>{p.descricao}</span>
                              <span className="font-bold text-sm whitespace-nowrap text-primary shrink-0">{formatCurrency(Number(p.valor))}</span>
                            </div>
                            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                              <span className="text-[10px] text-muted-foreground">{p.nome_fornecedor}</span>
                              {p.data_vencimento && <span className="text-[10px] text-muted-foreground">Venc: {p.data_vencimento}</span>}
                              {p.gc_codigo && <span className="text-[10px] text-muted-foreground">GC {p.gc_codigo}</span>}
                              {p.liquidado && <Badge variant="secondary" className="text-[9px] h-4">Liquidado</Badge>}
                              {p.pago_sistema && <Badge variant="secondary" className="text-[9px] h-4">Pago Sistema</Badge>}
                            </div>
                            {renderGCMeta(p, "pagar")}
                          </div>
                        ))}
                        {!searchedLancamentos.pagamentos.length && (
                          <p className="text-[10px] text-muted-foreground text-center py-2">
                            {searchLanc ? "Nenhum resultado" : "Digite para buscar pagamentos"}
                          </p>
                        )}
                      </>
                    )}
                  </div>

                  {/* Quick classification buttons */}
                  <div className="flex gap-2 pt-1 border-t border-border">
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[10px] h-6"
                      onClick={async () => {
                        await supabase.from("fin_extrato_inter").update({ reconciliation_rule: "SEM_PAR_GC" }).eq("id", e.id);
                        toast.success("Classificado como exceção (sem par no GC)");
                        setExpandedExtrato(null);
                        invalidateAll();
                      }}
                    >
                      Sem par no GC
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[10px] h-6"
                      onClick={async () => {
                        await supabase.from("fin_extrato_inter").update({ reconciliation_rule: "TRANSFERENCIA_INTERNA" }).eq("id", e.id);
                        toast.success("Classificado como transferência interna");
                        setExpandedExtrato(null);
                        invalidateAll();
                      }}
                    >
                      Transferência interna
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-[10px] h-6"
                      onClick={async () => {
                        await supabase.from("fin_extrato_inter").update({ reconciliation_rule: "PIX_DEVOLVIDO_MANUAL" }).eq("id", e.id);
                        toast.success("Classificado como PIX devolvido");
                        setExpandedExtrato(null);
                        invalidateAll();
                      }}
                    >
                      PIX devolvido
                    </Button>
                  </div>
                </div>
              )}
            </div>
          ))}
          {!(extratoNR || []).length && <p className="text-sm text-muted-foreground text-center py-8">Nenhuma transação neste período</p>}
        </div>
      </div>

      {/* Review Section */}
      {autoResult?.review?.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">🔍 Itens para Revisão ({autoResult.review.length})</h3>
          <div className="space-y-3 max-h-[50vh] overflow-y-auto">
            {autoResult.review.map((item: any, idx: number) => (
              <div key={idx} className="rounded-md border border-border p-3 space-y-2">
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-xs font-semibold text-foreground">
                      {item.contrapartida || item.descricao_extrato || "—"}
                    </p>
                    {item.cpf_cnpj && <p className="text-[10px] text-muted-foreground">Doc: {item.cpf_cnpj}</p>}
                    <p className="text-[10px] text-muted-foreground">{item.motivo}</p>
                    {item.data_hora && <p className="text-[10px] text-muted-foreground">{formatDateTime(item.data_hora)}</p>}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-[10px] ${item.tipo === "CREDITO" ? "text-wedo-green" : "text-wedo-red"}`}>{item.tipo}</Badge>
                    <span className="font-semibold text-sm">{formatCurrency(Number(item.valor))}</span>
                  </div>
                </div>

                {item.candidatos && (
                  <div className="space-y-1 pl-2 border-l-2 border-muted">
                    <p className="text-[10px] text-muted-foreground uppercase font-semibold">Candidatos ({item.candidatos.length})</p>
                    {item.candidatos.map((c: any) => (
                      <div key={c.id} className="flex items-center justify-between text-xs p-1.5 rounded hover:bg-muted/30 cursor-pointer group" onClick={() => {
                        const ext = extratoNR?.find((e: any) => e.id === item.extrato_id);
                        if (ext) {
                          setSelectedExtrato(ext);
                          const tipo = ext.tipo === "DEBITO" ? "pagar" : "receber";
                          setSelectedLanc({ id: c.id, descricao: c.descricao, valor: c.valor, nome_fornecedor: c.nome, nome_cliente: c.nome, _tipo: tipo });
                          setShowConfirm(true);
                        }
                      }}>
                        <div>
                          <span className="font-medium">{c.nome}</span>
                          <span className="text-muted-foreground ml-2">{c.descricao}</span>
                          {c.doc && <span className="text-[10px] text-muted-foreground ml-2">({c.doc})</span>}
                        </div>
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{formatCurrency(Number(c.valor))}</span>
                          <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px] opacity-0 group-hover:opacity-100">Vincular</Button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {item.melhor && !item.candidatos && (
                  <div className="pl-2 border-l-2 border-muted">
                    <div className="flex items-center justify-between text-xs p-1.5 rounded hover:bg-muted/30 cursor-pointer" onClick={() => {
                      const ext = extratoNR?.find((e: any) => e.id === item.extrato_id);
                      if (ext) {
                        setSelectedExtrato(ext);
                        const tipo = ext.tipo === "DEBITO" ? "pagar" : "receber";
                        setSelectedLanc({ id: item.melhor.id, descricao: item.melhor.descricao, valor: item.melhor.valor, nome_fornecedor: item.melhor.nome, nome_cliente: item.melhor.nome, _tipo: tipo });
                        setShowConfirm(true);
                      }
                    }}>
                      <div>
                        <span className="font-medium">{item.melhor.nome}</span>
                        <span className="text-muted-foreground ml-2">{item.melhor.descricao}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="font-semibold">{formatCurrency(Number(item.melhor.valor))}</span>
                        {item.melhor.rule && <Badge variant="secondary" className="text-[9px]">{item.melhor.rule}</Badge>}
                        <Button size="sm" variant="ghost" className="h-6 px-2 text-[10px]">Vincular</Button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Unmatched Section */}
      {autoResult?.unmatched?.length > 0 && (
        <div className="rounded-lg border border-border bg-card p-4 space-y-4">
          <h3 className="text-sm font-semibold flex items-center gap-2">❓ Sem Match ({autoResult.unmatched.length})</h3>
          <p className="text-[10px] text-muted-foreground">Transações do extrato sem lançamento compatível. Vincule manualmente.</p>
          <div className="space-y-2 max-h-[40vh] overflow-y-auto">
            {autoResult.unmatched.map((item: any, idx: number) => (
              <div key={idx} onClick={() => {
                const ext = extratoNR?.find((e: any) => e.id === item.extrato_id);
                if (ext) { setSelectedExtrato(ext); }
              }} className={`p-3 rounded-md border cursor-pointer transition-colors ${selectedExtrato?.id === item.extrato_id ? "border-primary bg-primary/10" : "border-border hover:bg-muted/30"}`}>
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-[10px] ${item.tipo === "CREDITO" ? "text-wedo-green" : "text-wedo-red"}`}>{item.tipo}</Badge>
                    <span className="text-xs font-medium truncate">{item.contrapartida || item.descricao_extrato || "—"}</span>
                  </div>
                  <span className="font-semibold text-sm">{formatCurrency(Number(item.valor))}</span>
                </div>
                {item.cpf_cnpj && <p className="text-[10px] text-muted-foreground mt-1">Doc: {item.cpf_cnpj}</p>}
                <p className="text-[10px] text-muted-foreground">{item.data_hora ? formatDateTime(item.data_hora) : ""}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Confirm dialog */}
      <Dialog open={showConfirm} onOpenChange={o => { if (!o) { setShowConfirm(false); } }}>
        <DialogContent><DialogHeader><DialogTitle>Vincular transação</DialogTitle></DialogHeader>
          <div className="space-y-4 text-sm">
            <div className="rounded-md bg-muted/50 p-3">
              <strong>Extrato:</strong> {selectedExtrato?.tipo} · {formatCurrency(Number(selectedExtrato?.valor))}
              <p className="text-xs mt-1 font-medium">{selectedExtrato?.nome_contraparte ?? selectedExtrato?.contrapartida ?? selectedExtrato?.descricao}</p>
              {selectedExtrato?.cpf_cnpj && <p className="text-[10px] text-muted-foreground">Doc: {selectedExtrato.cpf_cnpj}</p>}
              {selectedExtrato?.end_to_end_id && <p className="text-[10px] text-muted-foreground font-mono">E2E: {selectedExtrato.end_to_end_id}</p>}
            </div>
            <div className="flex justify-center"><ArrowLeftRight className="h-5 w-5 text-muted-foreground" /></div>
            <div className="rounded-md bg-muted/50 p-3">
              <strong>Lançamento:</strong> {selectedLanc?.descricao} · {formatCurrency(Number(selectedLanc?.valor))}
              {selectedLanc && renderGCMeta(selectedLanc, selectedLanc._tipo === "receber" ? "receber" : "pagar")}
            </div>
            {diff <= 0.01 ? <div className="text-wedo-green text-xs flex items-center gap-1"><CheckCircle className="h-3 w-3" />Valores compatíveis</div> : <div className="text-wedo-orange text-xs">⚠️ Diferença de {formatCurrency(diff)}</div>}
            <p className="text-xs text-muted-foreground">Nota: isto NÃO faz baixa no GC. Apenas marca como pago no sistema.</p>
          </div>
          <DialogFooter><Button variant="ghost" onClick={() => { setShowConfirm(false); setSelectedExtrato(null); setSelectedLanc(null); }}>Cancelar</Button><Button onClick={handleVincular} disabled={linking}>{linking && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Vincular</Button></DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Sync Period Dialog */}
      <SyncPeriodDialog
        open={showSyncDialog}
        onOpenChange={setShowSyncDialog}
        title="Sincronizar GestãoClick → Conciliação"
        loading={syncing}
        onSync={async (filtros, onProgress, onStep) => {
          setSyncing(true);
          try {
            const result = await syncByMonthChunks(filtros, onProgress, onStep);
            invalidateAll();
            toast.success(`Sincronizado: ${result.importados} registros importados`);
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Erro ao sincronizar");
            throw err;
          } finally {
            setSyncing(false);
            invalidateAll();
          }
        }}
      />
    </div>
  );
}
