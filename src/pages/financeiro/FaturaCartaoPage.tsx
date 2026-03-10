/**
 * FaturaCartaoPage.tsx — v2.0
 * Conciliação determinística de fatura de cartão de crédito
 * Motor: score-based, sem IA, sem Edge Function extra
 */
import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
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
import { Card, CardContent } from "@/components/ui/card";
import {
  Tooltip, TooltipContent, TooltipTrigger,
} from "@/components/ui/tooltip";
import toast from "react-hot-toast";
import {
  CreditCard, Plus, RefreshCw, CheckCircle2, AlertCircle,
  Upload, Unlink, ChevronDown, ChevronUp, Loader2, Info,
  Lock,
} from "lucide-react";
import { format, parseISO, differenceInDays } from "date-fns";

// ─── Tipos ────────────────────────────────────────────────────────────────────
interface Cartao {
  id: string;
  nome: string;
  bandeira: string;
  ultimos_digitos: string | null;
  banco: string | null;
  dia_fechamento: number | null;
  dia_vencimento: number | null;
  ativo: boolean;
}

interface Fatura {
  id: string;
  cartao_id: string;
  mes_referencia: string;
  data_fechamento: string | null;
  data_vencimento: string | null;
  valor_total: number;
  valor_conciliado: number;
  status: "aberta" | "fechada" | "paga";
  fin_cartoes: Cartao | null;
}

interface FaturaTransacao {
  id: string;
  fatura_id: string;
  data_transacao: string;
  descricao: string;
  valor: number;
  categoria: string | null;
  parcela_atual: number;
  total_parcelas: number;
  conciliado: boolean;
  lancamento_id: string | null;
  reconciliation_rule: string | null;
  conciliado_em: string | null;
}

interface Pagamento {
  id: string;
  descricao: string;
  valor: number;
  data_vencimento: string | null;
  data_competencia: string | null;
  nome_fornecedor: string | null;
  recipient_document: string | null;
  status: string | null;
  cartao_id: string | null;
}

interface MatchResult {
  lancamentoId: string;
  lancamentoDescricao: string;
  score: number;
  rule: string;
}

// ─── Motor de Conciliação ─────────────────────────────────────────────────────
const SCORE_AUTO = 0.85;

function normalize(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Jaccard similarity em nível de tokens (palavras).
 * Muito mais confiável que frequência de caracteres.
 */
function jaccardSimilarity(a: string, b: string): number {
  const setA = new Set(normalize(a).split(" ").filter(Boolean));
  const setB = new Set(normalize(b).split(" ").filter(Boolean));
  if (setA.size === 0 || setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

function dateDiff(d1: string | null, d2: string | null): number {
  if (!d1 || !d2) return 999;
  try {
    return Math.abs(differenceInDays(parseISO(d1), parseISO(d2)));
  } catch { return 999; }
}

function scoreMatch(t: FaturaTransacao, p: Pagamento): MatchResult | null {
  const valorT = t.valor;
  const valorP = Math.abs(p.valor);
  const valorExato = Math.abs(valorT - valorP) < 0.01;
  const valorTol = valorT > 0 && Math.abs(valorT - valorP) / valorT <= 0.02;

  // Compara com data_competencia primeiro (data real), depois data_vencimento
  const diffComp = dateDiff(t.data_transacao, p.data_competencia);
  const diffVenc = dateDiff(t.data_transacao, p.data_vencimento);
  const diffMin = Math.min(diffComp, diffVenc);

  const sim = jaccardSimilarity(t.descricao, [p.descricao, p.nome_fornecedor].filter(Boolean).join(" "));
  const label = `${p.descricao}${p.nome_fornecedor ? ` / ${p.nome_fornecedor}` : ""}`;

  if (valorExato && diffMin <= 3 && sim >= 0.4)
    return { lancamentoId: p.id, lancamentoDescricao: label, score: 0.97, rule: "VALOR_DATA_DESC" };
  if (valorExato && diffMin <= 3)
    return { lancamentoId: p.id, lancamentoDescricao: label, score: 0.92, rule: "VALOR_DATA" };
  if (valorExato && sim >= 0.50)
    return { lancamentoId: p.id, lancamentoDescricao: label, score: 0.87, rule: "VALOR_DESC" };
  if (valorExato && diffMin <= 7)
    return { lancamentoId: p.id, lancamentoDescricao: label, score: 0.78, rule: "VALOR_DATA7" };
  if (valorTol && diffMin <= 5)
    return { lancamentoId: p.id, lancamentoDescricao: label, score: 0.62, rule: "VALOR_TOL" };
  return null;
}

function runReconciliation(
  transacoes: FaturaTransacao[],
  pagamentos: Pagamento[],
): Map<string, MatchResult> {
  const results = new Map<string, MatchResult>();
  const usedPags = new Set<string>();
  const pendentes = transacoes.filter(t => !t.conciliado);

  for (const t of pendentes) {
    let best: MatchResult | null = null;
    for (const p of pagamentos) {
      if (usedPags.has(p.id)) continue;
      const m = scoreMatch(t, p);
      if (m && (!best || m.score > best.score)) best = m;
    }
    if (best && best.score >= 0.60) {
      results.set(t.id, best);
      if (best.score >= SCORE_AUTO) usedPags.add(best.lancamentoId);
    }
  }
  return results;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (s: string | null) => s ? format(parseISO(s), "dd/MM/yy") : "—";

/** Recalcula valor_conciliado APÓS as operações no banco */
async function recalcValorConciliado(faturaId: string) {
  const { data } = await supabase
    .from("fin_fatura_transacoes")
    .select("valor")
    .eq("fatura_id", faturaId)
    .eq("conciliado", true);
  const total = (data ?? []).reduce((s: number, r: { valor: number }) => s + r.valor, 0);
  await supabase.from("fin_fatura_cartao")
    .update({ valor_conciliado: total } as any)
    .eq("id", faturaId);
}

// ─── Componente ───────────────────────────────────────────────────────────────
export default function FaturaCartaoPage() {
  const qc = useQueryClient();

  const [cartaoSel, setCartaoSel] = useState("all");
  const [mesSel, setMesSel] = useState("");
  const [expandedFatura, setExpandedFatura] = useState<string | null>(null);
  const [matchPreview, setMatchPreview] = useState<Map<string, MatchResult>>(new Map());

  // Limpa preview ao trocar de fatura
  useEffect(() => { setMatchPreview(new Map()); }, [expandedFatura]);

  const [saving, setSaving] = useState(false);
  const [reconciling, setReconciling] = useState(false);
  const [importing, setImporting] = useState(false);

  const [showCartaoDialog, setShowCartaoDialog] = useState(false);
  const [showFaturaDialog, setShowFaturaDialog] = useState(false);
  const [showTransacaoDialog, setShowTransacaoDialog] = useState(false);
  const [showCsvDialog, setShowCsvDialog] = useState(false);
  const [activeFaturaId, setActiveFaturaId] = useState<string | null>(null);

  const [novoCartao, setNovoCartao] = useState({
    nome: "", bandeira: "VISA", ultimos_digitos: "", banco: "",
    dia_fechamento: 5, dia_vencimento: 15,
  });
  const [novaFatura, setNovaFatura] = useState({
    cartao_id: "", mes_referencia: format(new Date(), "yyyy-MM"),
    data_vencimento: "", valor_total: "",
  });
  const [novaTransacao, setNovaTransacao] = useState({
    data_transacao: "", descricao: "", valor: "",
    categoria: "", parcela_atual: "1", total_parcelas: "1",
  });
  const [csvText, setCsvText] = useState("");

  const invalidateAll = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["fin_fatura_cartao"] });
    qc.invalidateQueries({ queryKey: ["fin_fatura_transacoes"] });
  }, [qc]);

  // ─── Queries ──────────────────────────────────────────────────────────────
  const { data: cartoes = [] } = useQuery<Cartao[]>({
    queryKey: ["fin_cartoes"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_cartoes").select("*").eq("ativo", true).order("nome");
      if (error) throw error;
      return (data ?? []) as unknown as Cartao[];
    },
  });

  const { data: faturas = [], isLoading: loadingFaturas } = useQuery<Fatura[]>({
    queryKey: ["fin_fatura_cartao", cartaoSel, mesSel],
    queryFn: async () => {
      let q = supabase
        .from("fin_fatura_cartao")
        .select("*, fin_cartoes(*)")
        .order("mes_referencia", { ascending: false })
        .order("created_at", { ascending: false });
      if (cartaoSel !== "all") q = q.eq("cartao_id", cartaoSel);
      if (mesSel) q = q.eq("mes_referencia", mesSel);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Fatura[];
    },
  });

  const { data: transacoes = [], isLoading: loadingTransacoes } = useQuery<FaturaTransacao[]>({
    queryKey: ["fin_fatura_transacoes", expandedFatura],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_fatura_transacoes")
        .select("*")
        .eq("fatura_id", expandedFatura!)
        .order("data_transacao")
        .order("descricao");
      if (error) throw error;
      return (data ?? []) as unknown as FaturaTransacao[];
    },
    enabled: !!expandedFatura,
  });

  // Pagamentos escopados ao cartão da fatura expandida (sem conciliação cruzada)
  const faturaAtiva = useMemo(
    () => faturas.find(f => f.id === expandedFatura),
    [faturas, expandedFatura]
  );

  const { data: pagamentosPool = [], isLoading: loadingPagamentos } = useQuery<Pagamento[]>({
    queryKey: ["pagamentos_pool_fatura", faturaAtiva?.cartao_id ?? null],
    queryFn: async () => {
      if (!faturaAtiva?.cartao_id) return [];
      const { data, error } = await supabase
        .from("fin_pagamentos")
        .select("id,descricao,valor,data_vencimento,data_competencia,nome_fornecedor,recipient_document,status,cartao_id")
        .eq("cartao_id", faturaAtiva.cartao_id)
        .in("status", ["pendente", "pago"])
        .limit(500);
      if (error) throw error;
      return (data ?? []) as unknown as Pagamento[];
    },
    enabled: !!faturaAtiva?.cartao_id,
  });

  // ─── Stats ────────────────────────────────────────────────────────────────
  const stats = useMemo(() => ({
    total: faturas.reduce((s, f) => s + f.valor_total, 0),
    conciliado: faturas.reduce((s, f) => s + f.valor_conciliado, 0),
    faturas_abertas: faturas.filter(f => f.status === "aberta").length,
  }), [faturas]);

  // ─── Handlers ─────────────────────────────────────────────────────────────
  const handleCriarCartao = async () => {
    if (!novoCartao.nome) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("fin_cartoes").insert([novoCartao as any]);
      if (error) throw error;
      qc.invalidateQueries({ queryKey: ["fin_cartoes"] });
      toast.success("Cartão cadastrado.");
      setShowCartaoDialog(false);
      setNovoCartao({ nome: "", bandeira: "VISA", ultimos_digitos: "", banco: "", dia_fechamento: 5, dia_vencimento: 15 });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar cartão.");
    } finally { setSaving(false); }
  };

  const handleCriarFatura = async () => {
    if (!novaFatura.cartao_id) return;
    setSaving(true);
    try {
      const { error } = await supabase.from("fin_fatura_cartao").insert([{
        cartao_id: novaFatura.cartao_id,
        mes_referencia: novaFatura.mes_referencia,
        data_vencimento: novaFatura.data_vencimento || null,
        valor_total: Number(novaFatura.valor_total) || 0,
      } as any]);
      if (error) throw error;
      invalidateAll();
      toast.success("Fatura criada.");
      setShowFaturaDialog(false);
      setNovaFatura(prev => ({ ...prev, valor_total: "", data_vencimento: "" }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar fatura.");
    } finally { setSaving(false); }
  };

  const handleCriarTransacao = async () => {
    if (!activeFaturaId || !novaTransacao.descricao || !novaTransacao.valor) return;
    const fat = faturas.find(f => f.id === activeFaturaId);
    if (fat && fat.status !== "aberta") {
      toast.error(`Fatura ${fat.status}. Não é possível adicionar transações.`);
      return;
    }
    setSaving(true);
    try {
      const { error } = await supabase.from("fin_fatura_transacoes").insert([{
        fatura_id: activeFaturaId,
        data_transacao: novaTransacao.data_transacao,
        descricao: novaTransacao.descricao.trim().toUpperCase(),
        valor: Number(novaTransacao.valor),
        categoria: novaTransacao.categoria || null,
        parcela_atual: Number(novaTransacao.parcela_atual) || 1,
        total_parcelas: Number(novaTransacao.total_parcelas) || 1,
      } as any]);
      if (error) throw error;
      invalidateAll();
      toast.success("Transação adicionada.");
      setShowTransacaoDialog(false);
      setNovaTransacao({ data_transacao: "", descricao: "", valor: "", categoria: "", parcela_atual: "1", total_parcelas: "1" });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao salvar transação.");
    } finally { setSaving(false); }
  };

  // ─── Reconciliação ────────────────────────────────────────────────────────
  const handlePreview = useCallback(() => {
    if (loadingPagamentos) { toast("Aguarde o carregamento dos pagamentos..."); return; }
    if (!transacoes.length) { toast("Nenhuma transação nesta fatura."); return; }
    if (!pagamentosPool.length) {
      toast("Nenhum pagamento encontrado para este cartão.");
      return;
    }
    const result = runReconciliation(transacoes, pagamentosPool);
    setMatchPreview(result);
    const auto = [...result.values()].filter(r => r.score >= SCORE_AUTO).length;
    toast.success(`${result.size} matches — ${auto} automáticos · ${result.size - auto} para revisão`);
  }, [transacoes, pagamentosPool, loadingPagamentos]);

  const handleApplyReconciliation = async () => {
    if (!matchPreview.size) return;
    setReconciling(true);
    const now = new Date().toISOString();
    let ok = 0;
    const autoMatches = [...matchPreview.entries()].filter(([, m]) => m.score >= SCORE_AUTO);

    for (const [transacaoId, match] of autoMatches) {
      try {
        await supabase.from("fin_fatura_transacoes").update({
          conciliado: true,
          lancamento_id: match.lancamentoId,
          reconciliation_rule: match.rule,
          conciliado_em: now,
        } as any).eq("id", transacaoId);
        ok++;
      } catch { /* falha individual não quebra o batch */ }
    }

    // Recalcula APÓS as promises
    if (expandedFatura && ok > 0) {
      await recalcValorConciliado(expandedFatura);
    }

    invalidateAll();
    setMatchPreview(new Map());
    setReconciling(false);
    toast.success(`${ok} de ${autoMatches.length} transações conciliadas.`);
  };

  const handleConfirmManual = async (transacaoId: string, match: MatchResult) => {
    const now = new Date().toISOString();
    try {
      await supabase.from("fin_fatura_transacoes").update({
        conciliado: true,
        lancamento_id: match.lancamentoId,
        reconciliation_rule: "MANUAL_CONFIRM",
        conciliado_em: now,
      } as any).eq("id", transacaoId);

      if (expandedFatura) await recalcValorConciliado(expandedFatura);

      const newPreview = new Map(matchPreview);
      newPreview.delete(transacaoId);
      setMatchPreview(newPreview);
      invalidateAll();
      toast.success("Match confirmado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao confirmar.");
    }
  };

  const handleDesvincular = async (t: FaturaTransacao) => {
    try {
      await supabase.from("fin_fatura_transacoes").update({
        conciliado: false, lancamento_id: null,
        reconciliation_rule: null, conciliado_em: null,
      } as any).eq("id", t.id);

      // Decrementa valor_conciliado corretamente
      if (expandedFatura) await recalcValorConciliado(expandedFatura);

      invalidateAll();
      toast.success("Vínculo removido.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao desvincular.");
    }
  };

  // ─── Import CSV ───────────────────────────────────────────────────────────
  const handleImportCSV = async () => {
    if (!activeFaturaId || !csvText.trim()) return;
    const fat = faturas.find(f => f.id === activeFaturaId);
    if (fat && fat.status !== "aberta") {
      toast.error("Fatura não está aberta.");
      return;
    }
    setImporting(true);
    try {
      const lines = csvText.trim().split("\n");
      const dataLines = lines.filter(l => {
        const cols = l.split(";");
        return cols.length >= 3 && !isNaN(parseFloat(cols[2].replace(",", ".")));
      });
      if (!dataLines.length) { toast.error("Nenhuma linha válida."); setImporting(false); return; }

      const rows = dataLines.map(l => {
        const cols = l.split(";").map(c => c.trim().replace(/^"|"$/g, ""));
        const rawDate = cols[0] ?? "";
        const data_transacao = rawDate.includes("/")
          ? rawDate.split("/").reverse().join("-")
          : rawDate;
        return {
          fatura_id: activeFaturaId,
          data_transacao,
          descricao: (cols[1] ?? "SEM DESCRICAO").toUpperCase(),
          valor: parseFloat((cols[2] ?? "0").replace(",", ".")),
          categoria: cols[3] || null,
          parcela_atual: parseInt(cols[4] ?? "1") || 1,
          total_parcelas: parseInt(cols[5] ?? "1") || 1,
        };
      }).filter(r => r.valor > 0 && r.data_transacao.match(/^\d{4}-\d{2}-\d{2}$/));

      if (!rows.length) { toast.error("Nenhuma linha com data e valor válidos."); setImporting(false); return; }

      const { error } = await supabase.from("fin_fatura_transacoes").insert(rows as any);
      if (error) throw error;

      invalidateAll();
      toast.success(`${rows.length} transações importadas.`);
      setShowCsvDialog(false);
      setCsvText("");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao importar.");
    } finally { setImporting(false); }
  };

  // ─── Render Helpers ───────────────────────────────────────────────────────
  const statusColor: Record<string, string> = {
    aberta: "bg-blue-500/10 text-blue-700 border-blue-500/20",
    fechada: "bg-yellow-500/10 text-yellow-700 border-yellow-500/20",
    paga: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  };

  const scoreBadge = (score: number) => score >= SCORE_AUTO
    ? <Badge className="bg-emerald-600 text-white text-[9px]">{(score * 100).toFixed(0)}% AUTO</Badge>
    : <Badge variant="outline" className="text-yellow-600 border-yellow-500/30 text-[9px]">{(score * 100).toFixed(0)}% REVISAR</Badge>;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <CreditCard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Fatura de Cartão</h1>
            <p className="text-sm text-muted-foreground">Conciliação determinística — motor de regras</p>
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
          { label: "Total em Faturas", value: fmt(stats.total), sub: `${faturas.length} fatura(s)` },
          { label: "Conciliado", value: fmt(stats.conciliado), sub: stats.total > 0 ? `${Math.round(stats.conciliado / stats.total * 100)}%` : "0%" },
          { label: "Pendente", value: fmt(stats.total - stats.conciliado), sub: `${stats.faturas_abertas} abertas` },
        ].map(k => (
          <Card key={k.label}>
            <CardContent className="pt-4 pb-3">
              <p className="text-xs text-muted-foreground">{k.label}</p>
              <p className="text-xl font-bold text-foreground">{k.value}</p>
              <p className="text-[10px] text-muted-foreground">{k.sub}</p>
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
                {c.nome}{c.ultimos_digitos ? ` •••${c.ultimos_digitos}` : ""}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input type="month" value={mesSel} onChange={e => setMesSel(e.target.value)} className="w-[160px]" />
        {(cartaoSel !== "all" || mesSel) && (
          <Button variant="ghost" size="sm" onClick={() => { setCartaoSel("all"); setMesSel(""); }}>
            Limpar filtros
          </Button>
        )}
      </div>

      {/* Lista de Faturas */}
      {loadingFaturas ? (
        <div className="flex justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : faturas.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <CreditCard className="h-10 w-10 mx-auto text-muted-foreground mb-3" />
            <p className="text-muted-foreground">Nenhuma fatura encontrada.</p>
            <Button variant="outline" size="sm" className="mt-3" onClick={() => setShowFaturaDialog(true)}>
              Criar primeira fatura
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {faturas.map(f => {
            const isExpanded = expandedFatura === f.id;
            const pct = f.valor_total > 0
              ? Math.min(100, Math.round((f.valor_conciliado / f.valor_total) * 100))
              : 0;
            const isClosed = f.status !== "aberta";

            return (
              <Card key={f.id} className="overflow-hidden">
                <div
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedFatura(isExpanded ? null : f.id)}
                >
                  <div className="flex items-center gap-3">
                    <div className="flex items-center gap-1">
                      <CreditCard className="h-5 w-5 text-muted-foreground" />
                      {isClosed && <Lock className="h-3 w-3 text-muted-foreground" />}
                    </div>
                    <div>
                      <p className="font-medium text-sm text-foreground">
                        {f.fin_cartoes?.nome ?? "Cartão desconhecido"}
                        {f.fin_cartoes?.ultimos_digitos ? ` •••${f.fin_cartoes.ultimos_digitos}` : ""}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {f.mes_referencia}
                        {f.data_vencimento ? ` · vence ${fmtDate(f.data_vencimento)}` : ""}
                      </p>
                    </div>
                    <Badge variant="outline" className={statusColor[f.status] || ""}>{f.status.toUpperCase()}</Badge>
                  </div>

                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <p className="font-semibold text-foreground">{fmt(f.valor_total)}</p>
                      <p className="text-[10px] text-muted-foreground">
                        {fmt(f.valor_conciliado)} conciliados · {pct}%
                      </p>
                    </div>
                    <div className="w-20 h-1.5 bg-muted rounded-full overflow-hidden">
                      <div className="h-full bg-emerald-500 rounded-full transition-all" style={{ width: `${pct}%` }} />
                    </div>
                    {isExpanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                  </div>
                </div>

                {isExpanded && (
                  <div className="border-t border-border p-4 space-y-3 bg-muted/10">
                    {/* Toolbar */}
                    <div className="flex gap-2 flex-wrap">
                      {!isClosed && (
                        <>
                          <Button size="sm" variant="outline" onClick={() => {
                            setActiveFaturaId(f.id);
                            setNovaTransacao({ data_transacao: "", descricao: "", valor: "", categoria: "", parcela_atual: "1", total_parcelas: "1" });
                            setShowTransacaoDialog(true);
                          }}>
                            <Plus className="h-3.5 w-3.5 mr-1" /> Transação Manual
                          </Button>
                          <Button size="sm" variant="outline" onClick={() => {
                            setActiveFaturaId(f.id);
                            setCsvText("");
                            setShowCsvDialog(true);
                          }}>
                            <Upload className="h-3.5 w-3.5 mr-1" /> Importar CSV
                          </Button>
                        </>
                      )}
                      <Button size="sm" variant="outline" onClick={handlePreview} disabled={loadingPagamentos}>
                        {loadingPagamentos ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5 mr-1" />}
                        Pré-visualizar Matches
                      </Button>
                      {matchPreview.size > 0 && (
                        <Button size="sm" onClick={handleApplyReconciliation} disabled={reconciling}>
                          {reconciling ? <Loader2 className="h-3.5 w-3.5 mr-1 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5 mr-1" />}
                          Aplicar Automáticos ({[...matchPreview.values()].filter(r => r.score >= SCORE_AUTO).length})
                        </Button>
                      )}
                    </div>

                    {/* Tabela de transações */}
                    {loadingTransacoes ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : transacoes.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">
                        Nenhuma transação. Adicione manualmente ou importe CSV.
                      </p>
                    ) : (
                      <div className="rounded-md border border-border overflow-auto">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead className="w-[90px]">Data</TableHead>
                              <TableHead>Descrição</TableHead>
                              <TableHead className="text-right w-[110px]">Valor</TableHead>
                              <TableHead className="w-[100px]">Status</TableHead>
                              <TableHead className="w-[110px]">Regra</TableHead>
                              <TableHead className="w-[200px]">Match Preview</TableHead>
                              <TableHead className="w-[50px]"></TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {transacoes.map(t => {
                              const preview = matchPreview.get(t.id);
                              return (
                                <TableRow key={t.id}>
                                  <TableCell className="text-xs">{fmtDate(t.data_transacao)}</TableCell>
                                  <TableCell>
                                    <p className="text-xs font-medium">{t.descricao}</p>
                                    {t.total_parcelas > 1 && (
                                      <span className="text-[10px] text-muted-foreground">
                                        Parcela {t.parcela_atual}/{t.total_parcelas}
                                      </span>
                                    )}
                                  </TableCell>
                                  <TableCell className="text-right text-xs font-medium">{fmt(t.valor)}</TableCell>
                                  <TableCell>
                                    {t.conciliado
                                      ? <Badge className="bg-emerald-600 text-white text-[9px]"><CheckCircle2 className="h-2.5 w-2.5 mr-0.5" />OK</Badge>
                                      : <Badge variant="outline" className="text-muted-foreground text-[9px]"><AlertCircle className="h-2.5 w-2.5 mr-0.5" />Pendente</Badge>
                                    }
                                  </TableCell>
                                  <TableCell className="text-[10px] text-muted-foreground">
                                    {t.reconciliation_rule ?? "—"}
                                  </TableCell>
                                  <TableCell>
                                    {preview && !t.conciliado ? (
                                      <div className="flex items-center gap-1.5 flex-wrap">
                                        {scoreBadge(preview.score)}
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span className="text-[10px] text-muted-foreground truncate max-w-[100px] cursor-help">
                                              {preview.lancamentoDescricao}
                                            </span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            <p className="text-xs">{preview.lancamentoDescricao}</p>
                                          </TooltipContent>
                                        </Tooltip>
                                        {preview.score < SCORE_AUTO && (
                                          <Button
                                            variant="ghost" size="icon" className="h-5 w-5"
                                            onClick={() => handleConfirmManual(t.id, preview)}
                                            title="Confirmar match"
                                          >
                                            <CheckCircle2 className="h-3 w-3 text-emerald-600" />
                                          </Button>
                                        )}
                                      </div>
                                    ) : (
                                      <span className="text-[10px] text-muted-foreground">—</span>
                                    )}
                                  </TableCell>
                                  <TableCell>
                                    {t.conciliado && (
                                      <Tooltip>
                                        <TooltipTrigger asChild>
                                          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => handleDesvincular(t)}>
                                            <Unlink className="h-3 w-3" />
                                          </Button>
                                        </TooltipTrigger>
                                        <TooltipContent>Desvincular</TooltipContent>
                                      </Tooltip>
                                    )}
                                  </TableCell>
                                </TableRow>
                              );
                            })}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    {/* Resumo */}
                    {transacoes.length > 0 && (
                      <div className="flex justify-between text-xs text-muted-foreground px-1">
                        <span>{transacoes.filter(t => t.conciliado).length}/{transacoes.length} conciliadas</span>
                        <span>Restante: {fmt(transacoes.filter(t => !t.conciliado).reduce((s, t) => s + t.valor, 0))}</span>
                      </div>
                    )}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Dialogs ──────────────────────────────────────────────────────── */}

      {/* Cadastrar Cartão */}
      <Dialog open={showCartaoDialog} onOpenChange={setShowCartaoDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Cadastrar Cartão de Crédito</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <Input placeholder="Nome do cartão" value={novoCartao.nome} onChange={e => setNovoCartao(p => ({ ...p, nome: e.target.value }))} />
            <Select value={novoCartao.bandeira} onValueChange={v => setNovoCartao(p => ({ ...p, bandeira: v }))}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["VISA", "MASTERCARD", "ELO", "AMEX", "HIPERCARD", "OUTRO"].map(b => (
                  <SelectItem key={b} value={b}>{b}</SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Input placeholder="Banco" value={novoCartao.banco} onChange={e => setNovoCartao(p => ({ ...p, banco: e.target.value }))} />
            <Input placeholder="Últimos 4 dígitos" maxLength={4} value={novoCartao.ultimos_digitos} onChange={e => setNovoCartao(p => ({ ...p, ultimos_digitos: e.target.value.replace(/\D/g, "") }))} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Dia fechamento</label>
                <Input type="number" min={1} max={31} value={novoCartao.dia_fechamento} onChange={e => setNovoCartao(p => ({ ...p, dia_fechamento: +e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Dia vencimento</label>
                <Input type="number" min={1} max={31} value={novoCartao.dia_vencimento} onChange={e => setNovoCartao(p => ({ ...p, dia_vencimento: +e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCartaoDialog(false)}>Cancelar</Button>
            <Button onClick={handleCriarCartao} disabled={!novoCartao.nome || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
            </Button>
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
                {cartoes.map(c => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.nome}{c.ultimos_digitos ? ` •••${c.ultimos_digitos}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mês de referência *</label>
              <Input type="month" value={novaFatura.mes_referencia} onChange={e => setNovaFatura(p => ({ ...p, mes_referencia: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Data de vencimento</label>
              <Input type="date" value={novaFatura.data_vencimento} onChange={e => setNovaFatura(p => ({ ...p, data_vencimento: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Valor total da fatura (R$)</label>
              <Input type="number" step="0.01" placeholder="0,00" value={novaFatura.valor_total} onChange={e => setNovaFatura(p => ({ ...p, valor_total: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFaturaDialog(false)}>Cancelar</Button>
            <Button onClick={handleCriarFatura} disabled={!novaFatura.cartao_id || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar Fatura"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Nova Transação Manual */}
      <Dialog open={showTransacaoDialog} onOpenChange={setShowTransacaoDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Adicionar Transação</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Data da compra *</label>
              <Input type="date" value={novaTransacao.data_transacao} onChange={e => setNovaTransacao(p => ({ ...p, data_transacao: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Descrição (como aparece na fatura) *</label>
              <Input placeholder="Ex: POSTO SHELL" value={novaTransacao.descricao} onChange={e => setNovaTransacao(p => ({ ...p, descricao: e.target.value }))} />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Valor *</label>
              <Input type="number" step="0.01" placeholder="0,00" value={novaTransacao.valor} onChange={e => setNovaTransacao(p => ({ ...p, valor: e.target.value }))} />
            </div>
            <Input placeholder="Categoria (opcional)" value={novaTransacao.categoria} onChange={e => setNovaTransacao(p => ({ ...p, categoria: e.target.value }))} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Parcela atual</label>
                <Input type="number" min={1} value={novaTransacao.parcela_atual} onChange={e => setNovaTransacao(p => ({ ...p, parcela_atual: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Total parcelas</label>
                <Input type="number" min={1} value={novaTransacao.total_parcelas} onChange={e => setNovaTransacao(p => ({ ...p, total_parcelas: e.target.value }))} />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowTransacaoDialog(false)}>Cancelar</Button>
            <Button onClick={handleCriarTransacao} disabled={!novaTransacao.descricao || !novaTransacao.valor || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Import CSV */}
      <Dialog open={showCsvDialog} onOpenChange={setShowCsvDialog}>
        <DialogContent>
          <DialogHeader><DialogTitle>Importar Transações via CSV</DialogTitle></DialogHeader>
          <div className="space-y-2">
            <div className="flex items-start gap-2 p-2 rounded bg-muted/50">
              <Info className="h-4 w-4 text-muted-foreground mt-0.5 shrink-0" />
              <div className="text-xs text-muted-foreground space-y-1">
                <p className="font-medium text-foreground">Formato: data;descricao;valor;categoria;parcela;total_parcelas</p>
                <p>Separador: ponto e vírgula. Data: DD/MM/AAAA ou AAAA-MM-DD.</p>
                <p>Valor: use vírgula ou ponto decimal. Header é ignorado automaticamente.</p>
              </div>
            </div>
          </div>
          <Textarea
            rows={10}
            placeholder={"data_transacao;descricao;valor;categoria\n10/03/2026;POSTO SHELL;150,00;Combustível\n11/03/2026;SUPERMERCADO XYZ;320,50;Alimentação"}
            value={csvText}
            onChange={e => setCsvText(e.target.value)}
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCsvDialog(false)}>Cancelar</Button>
            <Button onClick={handleImportCSV} disabled={!csvText.trim() || importing}>
              {importing ? <Loader2 className="h-4 w-4 mr-1 animate-spin" /> : <Upload className="h-4 w-4 mr-1" />}
              Importar
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
