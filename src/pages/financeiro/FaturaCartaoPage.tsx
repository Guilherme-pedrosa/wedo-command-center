import { useState, useMemo, useCallback } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Textarea } from "@/components/ui/textarea";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { toast } from "sonner";
import {
  CreditCard, Plus, RefreshCw, CheckCircle2, AlertCircle,
  Upload, Trash2, Link2, Unlink, ChevronDown, ChevronUp,
} from "lucide-react";
import { format, parseISO, differenceInDays } from "date-fns";

// ─── Tipos ──────────────────────────────────────────────────────────────────
interface Cartao {
  id: string;
  nome: string;
  bandeira: string;
  ultimos_digitos?: string;
  banco?: string;
  dia_fechamento?: number;
  dia_vencimento?: number;
  ativo: boolean;
}
interface Fatura {
  id: string;
  cartao_id: string;
  mes_referencia: string;
  data_fechamento?: string;
  data_vencimento?: string;
  valor_total: number;
  valor_conciliado: number;
  status: string;
  fin_cartoes?: Cartao;
}
interface FaturaTransacao {
  id: string;
  fatura_id: string;
  data_transacao: string;
  descricao: string;
  valor: number;
  categoria?: string;
  conciliado: boolean;
  lancamento_id?: string;
  reconciliation_rule?: string;
  conciliado_em?: string;
}
interface Pagamento {
  id: string;
  descricao: string;
  valor: number;
  data_vencimento: string;
  data_competencia?: string;
  nome_fornecedor?: string;
  status: string;
  cartao_id?: string;
}

// ─── Motor de Conciliação (sem IA) ──────────────────────────────────────────
const SCORE_AUTO = 0.85;

function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function stringSimilarity(a: string, b: string): number {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (na === nb) return 1;
  const longer = na.length > nb.length ? na : nb;
  const shorter = na.length <= nb.length ? na : nb;
  if (longer.length === 0) return 1;
  let matches = 0;
  for (let i = 0; i < shorter.length; i++) {
    if (longer.includes(shorter[i])) matches++;
  }
  return matches / longer.length;
}
function dateDiffAbs(d1: string, d2: string): number {
  try {
    return Math.abs(differenceInDays(parseISO(d1), parseISO(d2)));
  } catch { return 999; }
}

interface MatchResult {
  lancamentoId: string;
  score: number;
  rule: string;
}

function scoreMatch(
  t: FaturaTransacao,
  p: Pagamento,
): MatchResult | null {
  const valorT = Math.abs(t.valor);
  const valorP = Math.abs(p.valor);
  const diff = dateDiffAbs(t.data_transacao, p.data_vencimento || p.data_competencia || "");
  const valorExato = Math.abs(valorT - valorP) < 0.01;
  const valorTol = Math.abs(valorT - valorP) / Math.max(valorT, 1) <= 0.02;
  const simScore = stringSimilarity(t.descricao, p.descricao || p.nome_fornecedor || "");

  if (valorExato && diff <= 3) {
    return { lancamentoId: p.id, score: 0.95, rule: "VALOR_DATA" };
  }
  if (valorExato && simScore >= 0.65) {
    return { lancamentoId: p.id, score: 0.88, rule: "DESCRICAO_VALOR" };
  }
  if (valorExato && diff <= 7) {
    return { lancamentoId: p.id, score: 0.80, rule: "VALOR_DATA7" };
  }
  if (valorTol && diff <= 5) {
    return { lancamentoId: p.id, score: 0.65, rule: "VALOR_TOLERANCIA" };
  }
  return null;
}

function runReconciliation(
  transacoes: FaturaTransacao[],
  pagamentos: Pagamento[],
): Map<string, MatchResult> {
  const results = new Map<string, MatchResult>();
  const usedPagamentos = new Set<string>();

  const pendentes = transacoes.filter(t => !t.conciliado);

  for (const t of pendentes) {
    let bestMatch: (MatchResult & { t: FaturaTransacao }) | null = null;

    for (const p of pagamentos) {
      if (usedPagamentos.has(p.id)) continue;
      const m = scoreMatch(t, p);
      if (!m) continue;
      if (!bestMatch || m.score > bestMatch.score) {
        bestMatch = { ...m, t };
      }
    }

    if (bestMatch && bestMatch.score >= 0.60) {
      results.set(t.id, {
        lancamentoId: bestMatch.lancamentoId,
        score: bestMatch.score,
        rule: bestMatch.rule,
      });
      if (bestMatch.score >= SCORE_AUTO) {
        usedPagamentos.add(bestMatch.lancamentoId);
      }
    }
  }

  return results;
}

// ─── Componente Principal ────────────────────────────────────────────────────
export default function FaturaCartaoPage() {
  const queryClient = useQueryClient();
  const [cartaoSel, setCartaoSel] = useState("all");
  const [mesSel, setMesSel] = useState("");
  const [showCartaoDialog, setShowCartaoDialog] = useState(false);
  const [showFaturaDialog, setShowFaturaDialog] = useState(false);
  const [showTransacaoDialog, setShowTransacaoDialog] = useState(false);
  const [showCsvDialog, setShowCsvDialog] = useState(false);
  const [expandedFatura, setExpandedFatura] = useState<string | null>(null);
  const [matchPreview, setMatchPreview] = useState<Map<string, MatchResult>>(new Map());
  const [reconciling, setReconciling] = useState(false);
  const [csvText, setCsvText] = useState("");
  const [csvFaturaId, setCsvFaturaId] = useState<string | null>(null);

  // Form states
  const [novoCartao, setNovoCartao] = useState({
    nome: "", bandeira: "VISA", ultimos_digitos: "",
    banco: "", dia_fechamento: 5, dia_vencimento: 15,
  });
  const [novaFatura, setNovaFatura] = useState({
    cartao_id: "", mes_referencia: format(new Date(), "yyyy-MM"),
    data_vencimento: "", valor_total: "",
  });
  const [novaTransacao, setNovaTransacao] = useState({
    fatura_id: "", data_transacao: "", descricao: "", valor: "", categoria: "",
  });

  // ─── Queries ──────────────────────────────────────────────────────────────
  const { data: cartoes = [] } = useQuery<Cartao[]>({
    queryKey: ["fin_cartoes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_cartoes").select("*").eq("ativo", true).order("nome");
      if (error) throw error;
      return (data || []) as unknown as Cartao[];
    },
  });

  const { data: faturas = [], isLoading: loadingFaturas } = useQuery<Fatura[]>({
    queryKey: ["fin_fatura_cartao", cartaoSel, mesSel],
    queryFn: async () => {
      let q = supabase
        .from("fin_fatura_cartao")
        .select("*, fin_cartoes(*)")
        .order("mes_referencia", { ascending: false });
      if (cartaoSel !== "all") q = q.eq("cartao_id", cartaoSel);
      if (mesSel) q = q.eq("mes_referencia", mesSel);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as Fatura[];
    },
  });

  const { data: transacoes = [] } = useQuery<FaturaTransacao[]>({
    queryKey: ["fin_fatura_transacoes", expandedFatura],
    queryFn: async () => {
      if (!expandedFatura) return [];
      const { data, error } = await supabase
        .from("fin_fatura_transacoes")
        .select("*")
        .eq("fatura_id", expandedFatura)
        .order("data_transacao");
      if (error) throw error;
      return (data || []) as unknown as FaturaTransacao[];
    },
    enabled: !!expandedFatura,
  });

  const { data: pagamentosCartao = [] } = useQuery<Pagamento[]>({
    queryKey: ["pagamentos_cartao_conc", cartaoSel],
    queryFn: async () => {
      let q = supabase
        .from("fin_pagamentos")
        .select("id,descricao,valor,data_vencimento,data_competencia,nome_fornecedor,status,cartao_id")
        .in("status", ["pendente", "pago"])
        .limit(500);
      if (cartaoSel !== "all") q = q.eq("cartao_id", cartaoSel);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as unknown as Pagamento[];
    },
  });

  // ─── Mutations ────────────────────────────────────────────────────────────
  const criarCartao = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fin_cartoes").insert([novoCartao as any]);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fin_cartoes"] });
      toast.success("Cartão cadastrado.");
      setShowCartaoDialog(false);
      setNovoCartao({ nome: "", bandeira: "VISA", ultimos_digitos: "", banco: "", dia_fechamento: 5, dia_vencimento: 15 });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const criarFatura = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fin_fatura_cartao").insert([{
        cartao_id: novaFatura.cartao_id,
        mes_referencia: novaFatura.mes_referencia,
        data_vencimento: novaFatura.data_vencimento || null,
        valor_total: Number(novaFatura.valor_total) || 0,
      } as any]);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fin_fatura_cartao"] });
      toast.success("Fatura criada.");
      setShowFaturaDialog(false);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const criarTransacao = useMutation({
    mutationFn: async () => {
      const { error } = await supabase.from("fin_fatura_transacoes").insert([{
        fatura_id: novaTransacao.fatura_id,
        data_transacao: novaTransacao.data_transacao,
        descricao: novaTransacao.descricao,
        valor: Number(novaTransacao.valor),
        categoria: novaTransacao.categoria || null,
      } as any]);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["fin_fatura_transacoes"] });
      toast.success("Transação adicionada.");
      setShowTransacaoDialog(false);
      setNovaTransacao({ fatura_id: "", data_transacao: "", descricao: "", valor: "", categoria: "" });
    },
    onError: (e: Error) => toast.error(e.message),
  });

  // ─── Reconciliação ────────────────────────────────────────────────────────
  const handlePreview = useCallback(() => {
    if (!transacoes.length || !pagamentosCartao.length) {
      toast.warning("Sem transações ou pagamentos para comparar.");
      return;
    }
    const result = runReconciliation(transacoes, pagamentosCartao);
    setMatchPreview(result);
    const auto = [...result.values()].filter(r => r.score >= SCORE_AUTO).length;
    toast.info(`${result.size} matches encontrados — ${auto} confirmação automática, ${result.size - auto} para revisão.`);
  }, [transacoes, pagamentosCartao]);

  const handleApplyReconciliation = useCallback(async () => {
    if (!matchPreview.size) return;
    setReconciling(true);
    const now = new Date().toISOString();
    let ok = 0;

    for (const [transacaoId, match] of matchPreview.entries()) {
      if (match.score < SCORE_AUTO) continue;
      try {
        await supabase.from("fin_fatura_transacoes").update({
          conciliado: true,
          lancamento_id: match.lancamentoId,
          reconciliation_rule: match.rule,
          conciliado_em: now,
        } as any).eq("id", transacaoId);
        ok++;
      } catch {/* ignora falha individual */}
    }

    if (expandedFatura) {
      const total = transacoes
        .filter(t => t.conciliado || (matchPreview.get(t.id)?.score ?? 0) >= SCORE_AUTO)
        .reduce((s, t) => s + t.valor, 0);
      await supabase.from("fin_fatura_cartao")
        .update({ valor_conciliado: total } as any).eq("id", expandedFatura);
    }

    queryClient.invalidateQueries({ queryKey: ["fin_fatura_transacoes"] });
    queryClient.invalidateQueries({ queryKey: ["fin_fatura_cartao"] });
    setMatchPreview(new Map());
    setReconciling(false);
    toast.success(`${ok} transações conciliadas automaticamente.`);
  }, [matchPreview, transacoes, expandedFatura, queryClient]);

  const handleManualLink = async (transacaoId: string, pagamentoId: string) => {
    const now = new Date().toISOString();
    await supabase.from("fin_fatura_transacoes").update({
      conciliado: true, lancamento_id: pagamentoId,
      reconciliation_rule: "MANUAL", conciliado_em: now,
    } as any).eq("id", transacaoId);
    queryClient.invalidateQueries({ queryKey: ["fin_fatura_transacoes"] });
    toast.success("Vínculo manual salvo.");
  };

  const handleDesvincular = async (transacaoId: string) => {
    await supabase.from("fin_fatura_transacoes").update({
      conciliado: false, lancamento_id: null,
      reconciliation_rule: null, conciliado_em: null,
    } as any).eq("id", transacaoId);
    queryClient.invalidateQueries({ queryKey: ["fin_fatura_transacoes"] });
    toast.info("Vínculo removido.");
  };

  // ─── Import CSV ───────────────────────────────────────────────────────────
  const handleImportCSV = useCallback(async () => {
    if (!csvFaturaId || !csvText.trim()) return;
    const lines = csvText.trim().split("\n").slice(1);
    const rows = lines.map(l => {
      const cols = l.split(";");
      return {
        fatura_id: csvFaturaId,
        data_transacao: cols[0]?.trim(),
        descricao: cols[1]?.trim() || "",
        valor: parseFloat((cols[2] || "0").replace(",", ".")),
        categoria: cols[3]?.trim() || null,
      };
    }).filter(r => r.data_transacao && r.valor);

    const rowsFormatted = rows.map(r => ({
      ...r,
      data_transacao: r.data_transacao.includes("/")
        ? r.data_transacao.split("/").reverse().join("-")
        : r.data_transacao,
    }));

    const { error } = await supabase.from("fin_fatura_transacoes").insert(rowsFormatted as any);
    if (error) { toast.error(error.message); return; }

    queryClient.invalidateQueries({ queryKey: ["fin_fatura_transacoes"] });
    toast.success(`${rowsFormatted.length} transações importadas.`);
    setShowCsvDialog(false);
    setCsvText("");
  }, [csvFaturaId, csvText, queryClient]);

  // ─── Utils ────────────────────────────────────────────────────────────────
  const statusBadge = (s: string) => {
    const map: Record<string, string> = {
      aberta: "bg-blue-500/10 text-blue-600 border-blue-500/20",
      fechada: "bg-yellow-500/10 text-yellow-600 border-yellow-500/20",
      paga: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20",
    };
    return <Badge variant="outline" className={map[s] || ""}>{s.toUpperCase()}</Badge>;
  };

  const scoreBadge = (score: number) => {
    if (score >= SCORE_AUTO) return <Badge className="bg-emerald-600 text-white text-[9px]">{(score * 100).toFixed(0)}% AUTO</Badge>;
    return <Badge variant="outline" className="text-yellow-600 border-yellow-500/30 text-[9px]">{(score * 100).toFixed(0)}% REVISAR</Badge>;
  };

  const formatBRL = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  // ─── Stats ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => {
    const total = faturas.reduce((s: number, f) => s + f.valor_total, 0);
    const conciliado = faturas.reduce((s: number, f) => s + (f.valor_conciliado || 0), 0);
    const pendente = total - conciliado;
    return { total, conciliado, pendente };
  }, [faturas]);

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <CreditCard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Conciliação de Fatura de Cartão</h1>
            <p className="text-sm text-muted-foreground">Vincule transações da fatura aos lançamentos do ERP</p>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          <Button variant="outline" size="sm" onClick={() => setShowCartaoDialog(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Novo Cartão
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowFaturaDialog(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Nova Fatura
          </Button>
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-3 gap-4">
        {[
          { label: "Total em Faturas", value: stats.total, color: "text-foreground" },
          { label: "Conciliado", value: stats.conciliado, color: "text-emerald-600" },
          { label: "Pendente", value: stats.pendente, color: "text-destructive" },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className={`text-xl font-bold ${k.color}`}>{formatBRL(k.value)}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Filtros */}
      <div className="flex gap-3 items-center">
        <Select value={cartaoSel} onValueChange={setCartaoSel}>
          <SelectTrigger className="w-[220px]">
            <SelectValue placeholder="Filtrar cartão" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">Todos os cartões</SelectItem>
            {cartoes.map(c => (
              <SelectItem key={c.id} value={c.id}>
                {c.nome} •••{c.ultimos_digitos}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          type="month" value={mesSel}
          onChange={e => setMesSel(e.target.value)}
          placeholder="Mês"
          className="w-[160px]"
        />
      </div>

      {/* Tabela de Faturas */}
      {loadingFaturas ? (
        <p className="text-muted-foreground text-center py-8">Carregando faturas…</p>
      ) : faturas.length === 0 ? (
        <p className="text-muted-foreground text-center py-8">Nenhuma fatura encontrada.</p>
      ) : (
        <div className="space-y-2">
          {faturas.map(f => {
            const isExpanded = expandedFatura === f.id;
            const pct = f.valor_total > 0 ? Math.min(100, Math.round((f.valor_conciliado / f.valor_total) * 100)) : 0;

            return (
              <Card key={f.id} className="overflow-hidden">
                {/* Linha da fatura */}
                <div
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedFatura(isExpanded ? null : f.id)}
                >
                  <div className="flex items-center gap-3">
                    <CreditCard className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm text-foreground">{f.fin_cartoes?.nome || "—"} •••{f.fin_cartoes?.ultimos_digitos}</p>
                      <p className="text-xs text-muted-foreground">
                        {f.mes_referencia} • Vence {f.data_vencimento ? format(parseISO(f.data_vencimento), "dd/MM/yy") : "—"}
                      </p>
                    </div>
                    {statusBadge(f.status)}
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="font-semibold text-foreground">{formatBRL(f.valor_total)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatBRL(f.valor_conciliado || 0)} conciliados ({pct}%)
                      </p>
                    </div>
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>

                {/* Painel de transações */}
                {isExpanded && (
                  <div className="border-t border-border p-4 space-y-3 bg-muted/10">
                    {/* Ações da fatura */}
                    <div className="flex gap-2 flex-wrap">
                      <Button size="sm" variant="outline" onClick={() => {
                        setNovaTransacao(prev => ({ ...prev, fatura_id: f.id }));
                        setShowTransacaoDialog(true);
                      }}>
                        <Plus className="h-3.5 w-3.5 mr-1" /> Transação Manual
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => {
                        setCsvFaturaId(f.id);
                        setShowCsvDialog(true);
                      }}>
                        <Upload className="h-3.5 w-3.5 mr-1" /> Importar CSV
                      </Button>
                      <Button size="sm" variant="outline" onClick={handlePreview}>
                        <RefreshCw className="h-3.5 w-3.5 mr-1" /> Pré-visualizar Matches
                      </Button>
                      <Button size="sm" onClick={handleApplyReconciliation} disabled={reconciling || !matchPreview.size}>
                        <CheckCircle2 className="h-3.5 w-3.5 mr-1" />
                        Aplicar Automático ({[...matchPreview.values()].filter(r => r.score >= SCORE_AUTO).length})
                      </Button>
                    </div>

                    {/* Tabela de transações */}
                    {transacoes.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-4">Nenhuma transação. Adicione manualmente ou importe CSV.</p>
                    ) : (
                      <div className="rounded-md border border-border overflow-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[90px]">Data</TableHead>
                              <TableHead>Descrição</TableHead>
                              <TableHead className="text-right w-[110px]">Valor</TableHead>
                              <TableHead className="w-[100px]">Status</TableHead>
                              <TableHead className="w-[120px]">Regra</TableHead>
                              <TableHead className="w-[110px]">Match Preview</TableHead>
                              <TableHead className="w-[50px]"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {transacoes.map(t => {
                              const preview = matchPreview.get(t.id);
                              return (
                                <TableRow key={t.id}>
                                  <TableCell className="text-xs">
                                    {format(parseISO(t.data_transacao), "dd/MM/yy")}
                                  </TableCell>
                                  <TableCell className="text-xs">{t.descricao}</TableCell>
                                  <TableCell className="text-right text-xs font-medium">{formatBRL(t.valor)}</TableCell>
                                  <TableCell>
                                    {t.conciliado
                                      ? <Badge className="bg-emerald-600 text-white text-[9px]"><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />Conciliado</Badge>
                                      : <Badge variant="outline" className="text-muted-foreground text-[9px]"><AlertCircle className="h-2.5 w-2.5 mr-0.5" />Pendente</Badge>
                                    }
                                  </TableCell>
                                  <TableCell className="text-[10px] text-muted-foreground">
                                    {t.reconciliation_rule || "—"}
                                  </TableCell>
                                  <TableCell>
                                    {preview && !t.conciliado ? scoreBadge(preview.score) : "—"}
                                  </TableCell>
                                  <TableCell>
                                    <div className="flex gap-1">
                                      {t.conciliado && (
                                        <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleDesvincular(t.id)} title="Desvincular">
                                          <Unlink className="h-3 w-3" />
                                        </Button>
                                      )}
                                    </div>
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Dialogs ─────────────────────────────────────────────────────── */}

      {/* Novo Cartão */}
      <Dialog open={showCartaoDialog} onOpenChange={setShowCartaoDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cadastrar Cartão</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Nome do cartão" value={novoCartao.nome} onChange={e => setNovoCartao(p => ({ ...p, nome: e.target.value }))} />
            <Select value={novoCartao.bandeira} onValueChange={v => setNovoCartao(p => ({ ...p, bandeira: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["VISA", "MASTERCARD", "ELO", "AMEX", "HIPERCARD"].map(b =>
                  <SelectItem key={b} value={b}>{b}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input placeholder="Últimos 4 dígitos" value={novoCartao.ultimos_digitos} onChange={e => setNovoCartao(p => ({ ...p, ultimos_digitos: e.target.value }))} />
            <Input placeholder="Banco" value={novoCartao.banco} onChange={e => setNovoCartao(p => ({ ...p, banco: e.target.value }))} />
            <div className="grid grid-cols-2 gap-3">
              <Input type="number" placeholder="Dia fechamento" value={novoCartao.dia_fechamento} onChange={e => setNovoCartao(p => ({ ...p, dia_fechamento: +e.target.value }))} />
              <Input type="number" placeholder="Dia vencimento" value={novoCartao.dia_vencimento} onChange={e => setNovoCartao(p => ({ ...p, dia_vencimento: +e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCartaoDialog(false)}>Cancelar</Button>
            <Button onClick={() => criarCartao.mutate()} disabled={!novoCartao.nome}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova Fatura */}
      <Dialog open={showFaturaDialog} onOpenChange={setShowFaturaDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Nova Fatura</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Select value={novaFatura.cartao_id} onValueChange={v => setNovaFatura(p => ({ ...p, cartao_id: v }))}>
              <SelectTrigger><SelectValue placeholder="Selecione o cartão" /></SelectTrigger>
              <SelectContent>
                {cartoes.map(c => <SelectItem key={c.id} value={c.id}>{c.nome} •••{c.ultimos_digitos}</SelectItem>)}
              </SelectContent>
            </Select>
            <Input type="month" value={novaFatura.mes_referencia} onChange={e => setNovaFatura(p => ({ ...p, mes_referencia: e.target.value }))} />
            <Input type="date" placeholder="Data vencimento" value={novaFatura.data_vencimento} onChange={e => setNovaFatura(p => ({ ...p, data_vencimento: e.target.value }))} />
            <Input type="number" placeholder="Valor total" value={novaFatura.valor_total} onChange={e => setNovaFatura(p => ({ ...p, valor_total: e.target.value }))} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFaturaDialog(false)}>Cancelar</Button>
            <Button onClick={() => criarFatura.mutate()} disabled={!novaFatura.cartao_id}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova Transação Manual */}
      <Dialog open={showTransacaoDialog} onOpenChange={setShowTransacaoDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adicionar Transação</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input type="date" value={novaTransacao.data_transacao} onChange={e => setNovaTransacao(p => ({ ...p, data_transacao: e.target.value }))} />
            <Input placeholder="Descrição" value={novaTransacao.descricao} onChange={e => setNovaTransacao(p => ({ ...p, descricao: e.target.value }))} />
            <Input type="number" placeholder="Valor" value={novaTransacao.valor} onChange={e => setNovaTransacao(p => ({ ...p, valor: e.target.value }))} />
            <Input placeholder="Categoria (opcional)" value={novaTransacao.categoria} onChange={e => setNovaTransacao(p => ({ ...p, categoria: e.target.value }))} />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTransacaoDialog(false)}>Cancelar</Button>
            <Button onClick={() => criarTransacao.mutate()} disabled={!novaTransacao.descricao || !novaTransacao.valor}>Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV */}
      <Dialog open={showCsvDialog} onOpenChange={setShowCsvDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Importar Transações via CSV</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <p className="text-xs font-medium text-foreground">Formato: data_transacao;descricao;valor;categoria</p>
            <p className="text-[10px] text-muted-foreground">Separador: ponto e vírgula. Data: DD/MM/AAAA ou AAAA-MM-DD. Valor: use vírgula ou ponto decimal.</p>
          </div>
          <Textarea
            rows={10} placeholder="Cole o CSV aqui..."
            value={csvText} onChange={e => setCsvText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCsvDialog(false)}>Cancelar</Button>
            <Button onClick={handleImportCSV} disabled={!csvText.trim()}>Importar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
