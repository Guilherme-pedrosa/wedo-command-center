/**
 * DespesasAuvoPanel.tsx
 * Lista despesas Auvo, sincroniza por período e concilia com transações de fatura de cartão.
 * Conciliação híbrida: sugestões automáticas por valor exato + janela de ±N dias, vinculação manual.
 */
import { useState, useMemo, useCallback } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  RefreshCw, Loader2, Link2, Unlink, CheckCircle2, AlertCircle, Search, Sparkles, Paperclip, FileDown, FileSpreadsheet,
} from "lucide-react";
import { format, parseISO, addDays, subDays } from "date-fns";
import toast from "react-hot-toast";
import * as XLSX from "xlsx";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";

interface AuvoExpense {
  id: string;
  auvo_id: number;
  type_id: number | null;
  type_name: string | null;
  user_to_name: string | null;
  expense_date: string;
  amount: number | null;
  description: string | null;
  attachment_url: string | null;
  conciliado: boolean;
  conciliado_em: string | null;
  fatura_transacao_id: string | null;
  match_method: string | null;
}

interface FaturaTransacao {
  id: string;
  fatura_id: string;
  data_transacao: string;
  descricao: string;
  valor: number;
}

const fmt = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (s: string | null) => s ? format(parseISO(s), "dd/MM/yy") : "—";
const TOLERANCE = 0.02;
const WINDOW_DAYS = 5;

export default function DespesasAuvoPanel() {
  const qc = useQueryClient();
  const today = format(new Date(), "yyyy-MM-dd");
  const monthStart = today.slice(0, 8) + "01";

  const [dataInicio, setDataInicio] = useState(monthStart);
  const [dataFim, setDataFim] = useState(today);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | "pending" | "matched">("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [exporting, setExporting] = useState<null | "pdf" | "xlsx">(null);
  const [syncing, setSyncing] = useState(false);
  const [matchTarget, setMatchTarget] = useState<AuvoExpense | null>(null);
  const [matchSearch, setMatchSearch] = useState("");

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["auvo_expenses_sync"] });
  }, [qc]);

  // ─── Queries ──────────────────────────────────────────────────────────────
  const { data: despesas = [], isLoading } = useQuery<AuvoExpense[]>({
    queryKey: ["auvo_expenses_sync", dataInicio, dataFim],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("auvo_expenses_sync")
        .select("*")
        .gte("expense_date", dataInicio)
        .lte("expense_date", dataFim)
        .order("expense_date", { ascending: false })
        .limit(2000);
      if (error) throw error;
      return (data ?? []) as unknown as AuvoExpense[];
    },
  });

  // Para o matcher: trazer transações de fatura no período (±5 dias para folga)
  const { data: faturaTransacoes = [] } = useQuery<FaturaTransacao[]>({
    queryKey: ["fin_fatura_transacoes_window", dataInicio, dataFim],
    queryFn: async () => {
      const from = format(subDays(parseISO(dataInicio), WINDOW_DAYS), "yyyy-MM-dd");
      const to = format(addDays(parseISO(dataFim), WINDOW_DAYS), "yyyy-MM-dd");
      const { data, error } = await supabase
        .from("fin_fatura_transacoes")
        .select("id, fatura_id, data_transacao, descricao, valor")
        .gte("data_transacao", from)
        .lte("data_transacao", to)
        .limit(5000);
      if (error) throw error;
      return (data ?? []) as unknown as FaturaTransacao[];
    },
  });

  const transById = useMemo(() => {
    const m = new Map<string, FaturaTransacao>();
    for (const t of faturaTransacoes) m.set(t.id, t);
    return m;
  }, [faturaTransacoes]);

  // ─── Auto-suggestions ─────────────────────────────────────────────────────
  // Sugere a transação não vinculada de melhor match (valor exato + data mais próxima).
  const suggestions = useMemo(() => {
    const linkedTransIds = new Set(
      despesas.filter(d => d.fatura_transacao_id).map(d => d.fatura_transacao_id!)
    );
    const out = new Map<string, FaturaTransacao>();
    for (const d of despesas) {
      if (d.conciliado || d.fatura_transacao_id) continue;
      if (d.amount == null) continue;
      const target = Math.abs(d.amount);
      const dDate = parseISO(d.expense_date).getTime();
      let best: { t: FaturaTransacao; score: number } | null = null;
      for (const t of faturaTransacoes) {
        if (linkedTransIds.has(t.id)) continue;
        const v = Math.abs(Number(t.valor));
        if (Math.abs(v - target) > TOLERANCE) continue;
        const diff = Math.abs(parseISO(t.data_transacao).getTime() - dDate) / 86400000;
        if (diff > WINDOW_DAYS) continue;
        const score = diff;
        if (!best || score < best.score) best = { t, score };
      }
      if (best) out.set(d.id, best.t);
    }
    return out;
  }, [despesas, faturaTransacoes]);

  // ─── Stats & filter ───────────────────────────────────────────────────────
  // distinct types for filter
  const tipos = useMemo(() => {
    const s = new Set<string>();
    for (const d of despesas) if (d.type_name) s.add(d.type_name);
    return Array.from(s).sort();
  }, [despesas]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return despesas.filter(d => {
      if (statusFilter === "pending" && d.conciliado) return false;
      if (statusFilter === "matched" && !d.conciliado) return false;
      if (typeFilter !== "all" && (d.type_name ?? "") !== typeFilter) return false;
      if (q) {
        const hay = `${d.description ?? ""} ${d.user_to_name ?? ""} ${d.type_name ?? ""}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [despesas, search, statusFilter, typeFilter]);

  const stats = useMemo(() => {
    const total = despesas.reduce((s, d) => s + (d.amount ?? 0), 0);
    const conc = despesas.filter(d => d.conciliado);
    const totalConc = conc.reduce((s, d) => s + (d.amount ?? 0), 0);
    return {
      count: despesas.length,
      countConc: conc.length,
      total,
      totalConc,
      pendentes: despesas.length - conc.length,
      sugestoes: suggestions.size,
    };
  }, [despesas, suggestions]);

  // ─── Sync ─────────────────────────────────────────────────────────────────
  const handleSync = async () => {
    setSyncing(true);
    try {
      const { data, error } = await supabase.functions.invoke("sync-auvo-expenses", {
        body: { data_inicio: dataInicio, data_fim: dataFim, todos: true },
      });
      if (error) throw error;
      toast.success(`Sincronizado: ${data?.synced ?? 0} despesas.`);
      invalidate();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao sincronizar Auvo.");
    } finally {
      setSyncing(false);
    }
  };

  // ─── Vínculo ──────────────────────────────────────────────────────────────
  const vincular = async (auvoId: string, transacaoId: string, method: string) => {
    try {
      const { error } = await supabase
        .from("auvo_expenses_sync")
        .update({
          fatura_transacao_id: transacaoId,
          conciliado: true,
          conciliado_em: new Date().toISOString(),
          match_method: method,
        } as any)
        .eq("id", auvoId);
      if (error) throw error;
      invalidate();
      toast.success("Despesa vinculada.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao vincular.");
    }
  };

  const desvincular = async (auvoId: string) => {
    try {
      const { error } = await supabase
        .from("auvo_expenses_sync")
        .update({
          fatura_transacao_id: null,
          conciliado: false,
          conciliado_em: null,
          match_method: null,
        } as any)
        .eq("id", auvoId);
      if (error) throw error;
      invalidate();
      toast.success("Vínculo removido.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao desvincular.");
    }
  };

  const aceitarSugestao = async (d: AuvoExpense) => {
    const sug = suggestions.get(d.id);
    if (!sug) return;
    await vincular(d.id, sug.id, "AUTO_VALOR_DATA");
  };

  const aceitarTodasSugestoes = async () => {
    if (suggestions.size === 0) return;
    if (!confirm(`Aceitar ${suggestions.size} sugestão(ões) automaticamente?`)) return;
    let ok = 0;
    for (const [auvoId, sug] of suggestions) {
      const { error } = await supabase
        .from("auvo_expenses_sync")
        .update({
          fatura_transacao_id: sug.id,
          conciliado: true,
          conciliado_em: new Date().toISOString(),
          match_method: "AUTO_VALOR_DATA_BULK",
        } as any)
        .eq("id", auvoId);
      if (!error) ok++;
    }
    invalidate();
    toast.success(`${ok} despesa(s) vinculada(s).`);
  };

  // ─── Match dialog candidates ──────────────────────────────────────────────
  const matchCandidates = useMemo(() => {
    if (!matchTarget) return [] as FaturaTransacao[];
    const linkedTransIds = new Set(
      despesas.filter(d => d.fatura_transacao_id && d.id !== matchTarget.id).map(d => d.fatura_transacao_id!)
    );
    const target = matchTarget.amount != null ? Math.abs(matchTarget.amount) : null;
    const tDate = parseISO(matchTarget.expense_date).getTime();
    const q = matchSearch.trim().toLowerCase();
    return faturaTransacoes
      .filter(t => !linkedTransIds.has(t.id))
      .filter(t => {
        if (q) return t.descricao.toLowerCase().includes(q);
        return true;
      })
      .map(t => {
        const v = Math.abs(Number(t.valor));
        const diffValor = target != null ? Math.abs(v - target) : 999999;
        const diffDias = Math.abs(parseISO(t.data_transacao).getTime() - tDate) / 86400000;
        return { t, diffValor, diffDias };
      })
      .sort((a, b) => (a.diffValor - b.diffValor) || (a.diffDias - b.diffDias))
      .slice(0, 100)
      .map(x => x.t);
  }, [matchTarget, matchSearch, faturaTransacoes, despesas]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-end gap-3 flex-wrap">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Data início</label>
          <Input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)} className="w-[160px]" />
        </div>
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">Data fim</label>
          <Input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)} className="w-[160px]" />
        </div>
        <Button onClick={handleSync} disabled={syncing} size="sm">
          {syncing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1.5" />}
          Sincronizar Auvo
        </Button>
        {suggestions.size > 0 && (
          <Button onClick={aceitarTodasSugestoes} size="sm" variant="outline">
            <Sparkles className="h-3.5 w-3.5 mr-1.5" />
            Aceitar {suggestions.size} sugestão(ões)
          </Button>
        )}
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-4 gap-3">
        {[
          { label: "Total despesas", value: fmt(stats.total), sub: `${stats.count} item(ns)` },
          { label: "Conciliadas", value: fmt(stats.totalConc), sub: `${stats.countConc}` },
          { label: "Pendentes", value: fmt(stats.total - stats.totalConc), sub: `${stats.pendentes}` },
          { label: "Sugestões auto", value: String(stats.sugestoes), sub: `±${TOLERANCE.toFixed(2)} / ±${WINDOW_DAYS}d` },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="pt-3 pb-2">
              <p className="text-[11px] text-muted-foreground">{k.label}</p>
              <p className="text-lg font-bold text-foreground">{k.value}</p>
              <p className="text-[10px] text-muted-foreground">{k.sub}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filtros lista */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input className="pl-8" placeholder="Buscar descrição, responsável, tipo..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1">
          {(["all", "pending", "matched"] as const).map(s => (
            <Button key={s} size="sm" variant={statusFilter === s ? "default" : "outline"} onClick={() => setStatusFilter(s)}>
              {s === "all" ? "Todas" : s === "pending" ? "Pendentes" : "Conciliadas"}
            </Button>
          ))}
        </div>
      </div>

      {/* Tabela */}
      {isLoading ? (
        <div className="flex justify-center py-12"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>
      ) : filtered.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-sm text-muted-foreground">Nenhuma despesa no período. Clique em "Sincronizar Auvo".</CardContent></Card>
      ) : (
        <div className="rounded-md border border-border overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[80px]">Data</TableHead>
                <TableHead className="w-[120px]">Tipo</TableHead>
                <TableHead>Descrição / Responsável</TableHead>
                <TableHead className="text-right w-[100px]">Valor</TableHead>
                <TableHead className="w-[280px]">Status / Match</TableHead>
                <TableHead className="w-[180px] text-right">Ações</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map(d => {
                const sug = !d.conciliado ? suggestions.get(d.id) : undefined;
                const linkedTrans = d.fatura_transacao_id ? transById.get(d.fatura_transacao_id) : undefined;
                return (
                  <TableRow key={d.id}>
                    <TableCell className="text-xs">{fmtDate(d.expense_date)}</TableCell>
                    <TableCell className="text-xs">{d.type_name ?? "—"}</TableCell>
                    <TableCell>
                      <p className="text-xs font-medium">{d.description ?? "—"}</p>
                      {d.user_to_name && <p className="text-[10px] text-muted-foreground">{d.user_to_name}</p>}
                      {d.attachment_url && (
                        <a href={d.attachment_url} target="_blank" rel="noopener noreferrer" className="text-[10px] text-primary inline-flex items-center gap-0.5 mt-0.5">
                          <Paperclip className="h-2.5 w-2.5" /> anexo
                        </a>
                      )}
                    </TableCell>
                    <TableCell className="text-right text-xs font-medium">{fmt(d.amount ?? 0)}</TableCell>
                    <TableCell>
                      {d.conciliado && linkedTrans ? (
                        <div className="space-y-0.5">
                          <Badge className="bg-emerald-600 text-white text-[9px]">
                            <CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Conciliada
                          </Badge>
                          <p className="text-[10px] text-muted-foreground truncate max-w-[260px]" title={linkedTrans.descricao}>
                            → {linkedTrans.descricao} · {fmtDate(linkedTrans.data_transacao)}
                          </p>
                          {d.match_method && <p className="text-[9px] text-muted-foreground">{d.match_method}</p>}
                        </div>
                      ) : d.conciliado ? (
                        <Badge className="bg-emerald-600 text-white text-[9px]"><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Conciliada</Badge>
                      ) : sug ? (
                        <div className="space-y-0.5">
                          <Badge className="bg-amber-500/20 text-amber-700 text-[9px]"><Sparkles className="h-2.5 w-2.5 mr-0.5" />Sugestão</Badge>
                          <p className="text-[10px] text-muted-foreground truncate max-w-[260px]" title={sug.descricao}>
                            ≈ {sug.descricao} · {fmtDate(sug.data_transacao)} · {fmt(Math.abs(Number(sug.valor)))}
                          </p>
                        </div>
                      ) : (
                        <Badge variant="outline" className="text-muted-foreground text-[9px]"><AlertCircle className="h-2.5 w-2.5 mr-0.5" />Pendente</Badge>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      {d.conciliado ? (
                        <Button size="sm" variant="ghost" onClick={() => desvincular(d.id)}>
                          <Unlink className="h-3 w-3 mr-1" />Desvincular
                        </Button>
                      ) : (
                        <div className="flex justify-end gap-1">
                          {sug && (
                            <Button size="sm" variant="default" onClick={() => aceitarSugestao(d)}>
                              <CheckCircle2 className="h-3 w-3 mr-1" />Aceitar
                            </Button>
                          )}
                          <Button size="sm" variant="outline" onClick={() => { setMatchTarget(d); setMatchSearch(""); }}>
                            <Link2 className="h-3 w-3 mr-1" />Vincular
                          </Button>
                        </div>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {/* Match dialog */}
      <Dialog open={!!matchTarget} onOpenChange={v => { if (!v) setMatchTarget(null); }}>
        <DialogContent className="max-w-2xl">
          <DialogHeader><DialogTitle>Vincular Despesa Auvo à Transação da Fatura</DialogTitle></DialogHeader>
          {matchTarget && (
            <div className="space-y-3">
              <Card>
                <CardContent className="pt-3 pb-3 space-y-1">
                  <p className="text-xs text-muted-foreground">Despesa Auvo</p>
                  <p className="text-sm font-medium">{matchTarget.description ?? "—"}</p>
                  <p className="text-xs text-muted-foreground">
                    {fmtDate(matchTarget.expense_date)} · {matchTarget.user_to_name ?? "—"} · {fmt(matchTarget.amount ?? 0)}
                  </p>
                </CardContent>
              </Card>
              <div className="relative">
                <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
                <Input className="pl-8" placeholder="Buscar transação por descrição..." value={matchSearch} onChange={e => setMatchSearch(e.target.value)} />
              </div>
              <div className="max-h-[400px] overflow-auto rounded-md border border-border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead className="w-[80px]">Data</TableHead>
                      <TableHead>Descrição</TableHead>
                      <TableHead className="text-right w-[110px]">Valor</TableHead>
                      <TableHead className="text-right w-[60px]">Δ</TableHead>
                      <TableHead className="w-[60px]"></TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {matchCandidates.length === 0 ? (
                      <TableRow><TableCell colSpan={5} className="text-center text-xs text-muted-foreground py-6">Nenhuma transação encontrada.</TableCell></TableRow>
                    ) : matchCandidates.map(t => {
                      const target = matchTarget.amount != null ? Math.abs(matchTarget.amount) : 0;
                      const diff = Math.abs(Number(t.valor)) - target;
                      return (
                        <TableRow key={t.id} className="cursor-pointer hover:bg-muted/30">
                          <TableCell className="text-xs">{fmtDate(t.data_transacao)}</TableCell>
                          <TableCell><p className="text-xs">{t.descricao}</p></TableCell>
                          <TableCell className="text-right text-xs">{fmt(Math.abs(Number(t.valor)))}</TableCell>
                          <TableCell className="text-right text-[10px] text-muted-foreground">
                            {diff === 0 ? "✓" : (diff > 0 ? "+" : "") + diff.toFixed(2)}
                          </TableCell>
                          <TableCell>
                            <Button size="icon" variant="ghost" className="h-6 w-6"
                              onClick={async () => { await vincular(matchTarget.id, t.id, "MANUAL"); setMatchTarget(null); }}>
                              <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                            </Button>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setMatchTarget(null)}>Fechar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
