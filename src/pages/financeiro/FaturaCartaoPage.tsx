/**
 * FaturaCartaoPage.tsx — v3.0
 * Fatura = Cartão + Forma de Pagamento
 * Busca automática de pagamentos pelo período de fechamento
 * Vinculação com extrato bancário como liquidante
 */
import { useState, useMemo, useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
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
  CreditCard, Plus, CheckCircle2, AlertCircle,
  ChevronDown, ChevronUp, Loader2, Lock, Link2, Search, Unlink,
  Pencil, Trash2,
} from "lucide-react";
import { format, parseISO } from "date-fns";

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

interface FormaPagamento {
  id: string;
  nome: string;
  gc_id: string | null;
  ativo: boolean;
}

interface Fatura {
  id: string;
  cartao_id: string;
  forma_pagamento_id: string | null;
  mes_referencia: string;
  data_fechamento: string | null;
  data_fechamento_inicio: string | null;
  data_fechamento_fim: string | null;
  data_vencimento: string | null;
  valor_total: number;
  valor_conciliado: number;
  status: "aberta" | "fechada" | "paga";
  extrato_liquidante_id: string | null;
  fin_cartoes: Cartao | null;
  fin_formas_pagamento: FormaPagamento | null;
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

interface ExtratoItem {
  id: string;
  data_hora: string | null;
  descricao: string | null;
  valor: number | null;
  tipo: string | null;
  nome_contraparte: string | null;
  reconciliado: boolean | null;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const fmt = (v: number) => v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
const fmtDate = (s: string | null) => s ? format(parseISO(s), "dd/MM/yy") : "—";

// ─── Componente ───────────────────────────────────────────────────────────────
export default function FaturaCartaoPage() {
  const qc = useQueryClient();

  const [cartaoSel, setCartaoSel] = useState("all");
  const [mesSel, setMesSel] = useState("");
  const [expandedFatura, setExpandedFatura] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [loadingTransacoes, setLoadingTransacoes] = useState(false);

  // Dialogs
  const [showCartaoDialog, setShowCartaoDialog] = useState(false);
  const [showFaturaDialog, setShowFaturaDialog] = useState(false);
  const [showExtratoDialog, setShowExtratoDialog] = useState(false);
  const [extratoFaturaId, setExtratoFaturaId] = useState<string | null>(null);
  const [extratoSearch, setExtratoSearch] = useState("");
  const [editFatura, setEditFatura] = useState<Fatura | null>(null);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [editForm, setEditForm] = useState({ data_fechamento_inicio: "", data_fechamento_fim: "", data_vencimento: "", mes_referencia: "" });

  // Novo cartão
  const [novoCartao, setNovoCartao] = useState({
    nome: "", bandeira: "VISA", ultimos_digitos: "", banco: "",
    dia_fechamento: 5, dia_vencimento: 15,
  });

  // Nova fatura
  const [novaFatura, setNovaFatura] = useState({
    cartao_id: "",
    forma_pagamento_id: "",
    mes_referencia: format(new Date(), "yyyy-MM"),
    data_fechamento_inicio: "",
    data_fechamento_fim: "",
    data_vencimento: "",
  });

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

  const { data: formasPagamento = [] } = useQuery<FormaPagamento[]>({
    queryKey: ["fin_formas_pagamento"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_formas_pagamento").select("*").eq("ativo", true).order("nome");
      if (error) throw error;
      return (data ?? []) as unknown as FormaPagamento[];
    },
  });

  const { data: faturas = [], isLoading: loadingFaturas } = useQuery<Fatura[]>({
    queryKey: ["fin_fatura_cartao", cartaoSel, mesSel],
    queryFn: async () => {
      let q = supabase
        .from("fin_fatura_cartao")
        .select("*, fin_cartoes(*), fin_formas_pagamento(*)")
        .order("mes_referencia", { ascending: false })
        .order("created_at", { ascending: false });
      if (cartaoSel !== "all") q = q.eq("cartao_id", cartaoSel);
      if (mesSel) q = q.eq("mes_referencia", mesSel);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as Fatura[];
    },
  });

  const { data: transacoes = [], isLoading: loadingTransacoesQ } = useQuery<FaturaTransacao[]>({
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

  // Extrato para vincular como liquidante
  const { data: extratoItems = [], isLoading: loadingExtrato } = useQuery<ExtratoItem[]>({
    queryKey: ["extrato_liquidante_search", extratoSearch],
    queryFn: async () => {
      let q = supabase
        .from("fin_extrato_inter")
        .select("id,data_hora,descricao,valor,tipo,nome_contraparte,reconciliado")
        .lt("valor", 0) // Débitos (pagamentos saindo)
        .order("data_hora", { ascending: false })
        .limit(50);
      if (extratoSearch.trim()) {
        q = q.or(`descricao.ilike.%${extratoSearch}%,nome_contraparte.ilike.%${extratoSearch}%`);
      }
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as unknown as ExtratoItem[];
    },
    enabled: showExtratoDialog,
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
    if (!novaFatura.cartao_id || !novaFatura.forma_pagamento_id) {
      toast.error("Selecione o cartão e a forma de pagamento.");
      return;
    }
    if (!novaFatura.data_fechamento_inicio || !novaFatura.data_fechamento_fim) {
      toast.error("Informe as datas de fechamento (início e fim do período).");
      return;
    }
    setSaving(true);
    try {
      // 1. Buscar pagamentos pela forma de pagamento
      // No ERP, todos os lançamentos de cartão compartilham a mesma data_vencimento
      // (dia de pagamento da fatura). Então filtramos por data_vencimento = vencimento da fatura
      // OU por data_competencia dentro do período de fechamento como fallback.
      let pgQuery = supabase
        .from("fin_pagamentos")
        .select("id,descricao,valor,data_vencimento,data_competencia,nome_fornecedor,status")
        .eq("forma_pagamento_id", novaFatura.forma_pagamento_id)
        .neq("status", "cancelado")
        .order("data_vencimento");

      if (novaFatura.data_vencimento) {
        // Estratégia principal: buscar pelo vencimento da fatura (como o ERP grava)
        pgQuery = pgQuery.eq("data_vencimento", novaFatura.data_vencimento);
      } else {
        // Fallback: buscar por data_competencia no período de fechamento
        pgQuery = pgQuery
          .gte("data_competencia", novaFatura.data_fechamento_inicio)
          .lte("data_competencia", novaFatura.data_fechamento_fim);
      }

      const { data: pagamentos, error: pgErr } = await pgQuery;

      if (pgErr) throw pgErr;

      const valorTotal = (pagamentos ?? []).reduce((s, p) => s + Math.abs(p.valor), 0);

      // 2. Criar a fatura
      const { data: faturaData, error: fatErr } = await supabase
        .from("fin_fatura_cartao")
        .insert([{
          cartao_id: novaFatura.cartao_id,
          forma_pagamento_id: novaFatura.forma_pagamento_id,
          mes_referencia: novaFatura.mes_referencia,
          data_fechamento_inicio: novaFatura.data_fechamento_inicio,
          data_fechamento_fim: novaFatura.data_fechamento_fim,
          data_vencimento: novaFatura.data_vencimento || null,
          valor_total: valorTotal,
        } as any])
        .select("id")
        .single();

      if (fatErr) throw fatErr;

      // 3. Criar transações a partir dos pagamentos encontrados
      if (pagamentos && pagamentos.length > 0) {
        const transRows = pagamentos.map(p => ({
          fatura_id: faturaData.id,
          data_transacao: p.data_vencimento || novaFatura.data_fechamento_fim,
          descricao: [p.descricao, p.nome_fornecedor].filter(Boolean).join(" — ").toUpperCase(),
          valor: Math.abs(p.valor),
          conciliado: true,
          lancamento_id: p.id,
          reconciliation_rule: "AUTO_FORMA_PAGAMENTO",
          conciliado_em: new Date().toISOString(),
        }));

        const { error: trErr } = await supabase
          .from("fin_fatura_transacoes")
          .insert(transRows as any);
        if (trErr) throw trErr;

        // Atualizar valor_conciliado
        await supabase.from("fin_fatura_cartao")
          .update({ valor_conciliado: valorTotal } as any)
          .eq("id", faturaData.id);
      }

      invalidateAll();
      toast.success(`Fatura criada com ${pagamentos?.length ?? 0} transações (${fmt(valorTotal)})`);
      setShowFaturaDialog(false);
      setNovaFatura(prev => ({
        ...prev, data_fechamento_inicio: "", data_fechamento_fim: "", data_vencimento: "",
      }));
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao criar fatura.");
    } finally { setSaving(false); }
  };

  // Auto-preencher datas baseado no cartão selecionado
  useEffect(() => {
    if (!novaFatura.cartao_id || !novaFatura.mes_referencia) return;
    const cartao = cartoes.find(c => c.id === novaFatura.cartao_id);
    if (!cartao) return;

    const [ano, mes] = novaFatura.mes_referencia.split("-").map(Number);
    const diaFech = cartao.dia_fechamento ?? 5;
    const diaVenc = cartao.dia_vencimento ?? 15;

    // Período: do dia de fechamento do mês anterior até dia de fechamento do mês atual
    const mesAnterior = mes === 1 ? 12 : mes - 1;
    const anoAnterior = mes === 1 ? ano - 1 : ano;
    const maxDiaInicio = new Date(anoAnterior, mesAnterior, 0).getDate();
    const maxDiaFim = new Date(ano, mes, 0).getDate();

    const inicio = `${anoAnterior}-${String(mesAnterior).padStart(2, "0")}-${String(Math.min(diaFech, maxDiaInicio)).padStart(2, "0")}`;
    const fim = `${ano}-${String(mes).padStart(2, "0")}-${String(Math.min(diaFech, maxDiaFim)).padStart(2, "0")}`;
    const venc = `${ano}-${String(mes).padStart(2, "0")}-${String(Math.min(diaVenc, maxDiaFim)).padStart(2, "0")}`;

    setNovaFatura(prev => ({
      ...prev,
      data_fechamento_inicio: inicio,
      data_fechamento_fim: fim,
      data_vencimento: venc,
    }));
  }, [novaFatura.cartao_id, novaFatura.mes_referencia, cartoes]);

  // Vincular extrato como liquidante
  const handleVincularExtrato = async (extratoId: string) => {
    if (!extratoFaturaId) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("fin_fatura_cartao")
        .update({ extrato_liquidante_id: extratoId, status: "paga" } as any)
        .eq("id", extratoFaturaId);
      if (error) throw error;

      invalidateAll();
      toast.success("Extrato vinculado — fatura marcada como paga.");
      setShowExtratoDialog(false);
      setExtratoFaturaId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao vincular.");
    } finally { setSaving(false); }
  };

  const handleDesvincularExtrato = async (faturaId: string) => {
    setSaving(true);
    try {
      const { error } = await supabase
        .from("fin_fatura_cartao")
        .update({ extrato_liquidante_id: null, status: "aberta" } as any)
        .eq("id", faturaId);
      if (error) throw error;
      invalidateAll();
      toast.success("Extrato desvinculado.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao desvincular.");
    } finally { setSaving(false); }
  };

  // Excluir fatura (e transações relacionadas)
  const handleExcluirFatura = async (faturaId: string) => {
    if (!confirm("Tem certeza que deseja excluir esta fatura e todas as suas transações?")) return;
    setSaving(true);
    try {
      await supabase.from("fin_fatura_transacoes").delete().eq("fatura_id", faturaId);
      const { error } = await supabase.from("fin_fatura_cartao").delete().eq("id", faturaId);
      if (error) throw error;
      invalidateAll();
      if (expandedFatura === faturaId) setExpandedFatura(null);
      toast.success("Fatura excluída.");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao excluir fatura.");
    } finally { setSaving(false); }
  };

  // Abrir edição
  const handleAbrirEdicao = (f: Fatura) => {
    setEditFatura(f);
    setEditForm({
      data_fechamento_inicio: f.data_fechamento_inicio || "",
      data_fechamento_fim: f.data_fechamento_fim || "",
      data_vencimento: f.data_vencimento || "",
      mes_referencia: f.mes_referencia,
    });
    setShowEditDialog(true);
  };

  // Salvar edição
  const handleSalvarEdicao = async () => {
    if (!editFatura) return;
    setSaving(true);
    try {
      const { error } = await supabase
        .from("fin_fatura_cartao")
        .update({
          mes_referencia: editForm.mes_referencia,
          data_fechamento_inicio: editForm.data_fechamento_inicio || null,
          data_fechamento_fim: editForm.data_fechamento_fim || null,
          data_vencimento: editForm.data_vencimento || null,
        } as any)
        .eq("id", editFatura.id);
      if (error) throw error;
      invalidateAll();
      toast.success("Fatura atualizada.");
      setShowEditDialog(false);
      setEditFatura(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao atualizar fatura.");
    } finally { setSaving(false); }
  };

  // ─── Render Helpers ───────────────────────────────────────────────────────
  const statusColor: Record<string, string> = {
    aberta: "bg-blue-500/10 text-blue-700 border-blue-500/20",
    fechada: "bg-yellow-500/10 text-yellow-700 border-yellow-500/20",
    paga: "bg-emerald-500/10 text-emerald-700 border-emerald-500/20",
  };

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <CreditCard className="h-6 w-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold text-foreground">Fatura de Cartão</h1>
            <p className="text-sm text-muted-foreground">Conciliação por forma de pagamento + período de fechamento</p>
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
        <SearchableSelect
          value={cartaoSel}
          onValueChange={setCartaoSel}
          placeholder="Filtrar cartão"
          searchPlaceholder="Buscar cartão..."
          className="w-[220px]"
          options={[
            { value: "all", label: "Todos os cartões" },
            ...cartoes.map(c => ({
              value: c.id,
              label: `${c.nome}${c.ultimos_digitos ? ` •••${c.ultimos_digitos}` : ""}`,
            })),
          ]}
        />
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

            return (
              <Card key={f.id} className="overflow-hidden">
                <div
                  className="flex items-center justify-between p-4 cursor-pointer hover:bg-muted/30 transition-colors"
                  onClick={() => setExpandedFatura(isExpanded ? null : f.id)}
                >
                  <div className="flex items-center gap-3">
                    <CreditCard className="h-5 w-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm text-foreground">
                        {f.fin_cartoes?.nome ?? "Cartão"}
                        {f.fin_cartoes?.ultimos_digitos ? ` •••${f.fin_cartoes.ultimos_digitos}` : ""}
                        {f.fin_formas_pagamento ? (
                          <span className="text-muted-foreground font-normal"> · {f.fin_formas_pagamento.nome}</span>
                        ) : null}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {f.mes_referencia}
                        {f.data_fechamento_inicio && f.data_fechamento_fim
                          ? ` · ${fmtDate(f.data_fechamento_inicio)} a ${fmtDate(f.data_fechamento_fim)}`
                          : ""}
                        {f.data_vencimento ? ` · vence ${fmtDate(f.data_vencimento)}` : ""}
                      </p>
                    </div>
                    <Badge variant="outline" className={statusColor[f.status] || ""}>{f.status.toUpperCase()}</Badge>
                    {f.extrato_liquidante_id && (
                      <Badge className="bg-emerald-600/10 text-emerald-700 text-[9px]">
                        <Link2 className="h-2.5 w-2.5 mr-0.5" /> Liquidada
                      </Badge>
                    )}
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
                      {!f.extrato_liquidante_id ? (
                        <Button size="sm" variant="outline" onClick={() => {
                          setExtratoFaturaId(f.id);
                          setExtratoSearch("");
                          setShowExtratoDialog(true);
                        }}>
                          <Link2 className="h-3.5 w-3.5 mr-1" /> Vincular Extrato (Liquidante)
                        </Button>
                      ) : (
                        <Button size="sm" variant="ghost" onClick={() => handleDesvincularExtrato(f.id)}>
                          <Unlink className="h-3.5 w-3.5 mr-1" /> Desvincular Extrato
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => handleAbrirEdicao(f)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" /> Editar
                      </Button>
                      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => handleExcluirFatura(f.id)} disabled={saving}>
                        <Trash2 className="h-3.5 w-3.5 mr-1" /> Excluir
                      </Button>
                    </div>

                    {/* Tabela de transações */}
                    {loadingTransacoesQ ? (
                      <div className="flex justify-center py-8">
                        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
                      </div>
                    ) : transacoes.length === 0 ? (
                      <p className="text-sm text-muted-foreground text-center py-6">
                        Nenhuma transação encontrada no período.
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
                              <TableHead className="w-[130px]">Regra</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {transacoes.map(t => (
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
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}

                    {/* Resumo */}
                    {transacoes.length > 0 && (
                      <div className="flex justify-between text-xs text-muted-foreground px-1">
                        <span>{transacoes.filter(t => t.conciliado).length}/{transacoes.length} conciliadas</span>
                        <span>Total: {fmt(transacoes.reduce((s, t) => s + t.valor, 0))}</span>
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
            <SearchableSelect
              value={novoCartao.bandeira}
              onValueChange={v => setNovoCartao(p => ({ ...p, bandeira: v }))}
              placeholder="Bandeira"
              searchPlaceholder="Buscar bandeira..."
              options={["VISA", "MASTERCARD", "ELO", "AMEX", "HIPERCARD", "OUTRO"].map(b => ({ value: b, label: b }))}
            />
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
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Nova Fatura</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Cartão *</label>
              <SearchableSelect
                value={novaFatura.cartao_id}
                onValueChange={v => setNovaFatura(p => ({ ...p, cartao_id: v }))}
                placeholder="Selecione o cartão"
                searchPlaceholder="Buscar cartão..."
                options={cartoes.map(c => ({
                  value: c.id,
                  label: `${c.nome}${c.ultimos_digitos ? ` •••${c.ultimos_digitos}` : ""}${c.dia_fechamento ? ` (fech. dia ${c.dia_fechamento})` : ""}`,
                }))}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Forma de Pagamento *</label>
              <SearchableSelect
                value={novaFatura.forma_pagamento_id}
                onValueChange={v => setNovaFatura(p => ({ ...p, forma_pagamento_id: v }))}
                placeholder="Selecione a forma de pagamento"
                searchPlaceholder="Buscar forma de pagamento..."
                options={formasPagamento.map(fp => ({
                  value: fp.id,
                  label: fp.nome,
                }))}
              />
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mês de referência *</label>
              <Input type="month" value={novaFatura.mes_referencia} onChange={e => setNovaFatura(p => ({ ...p, mes_referencia: e.target.value }))} />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Fechamento início</label>
                <Input type="date" value={novaFatura.data_fechamento_inicio} onChange={e => setNovaFatura(p => ({ ...p, data_fechamento_inicio: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Fechamento fim</label>
                <Input type="date" value={novaFatura.data_fechamento_fim} onChange={e => setNovaFatura(p => ({ ...p, data_fechamento_fim: e.target.value }))} />
              </div>
            </div>

            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Data de vencimento</label>
              <Input type="date" value={novaFatura.data_vencimento} onChange={e => setNovaFatura(p => ({ ...p, data_vencimento: e.target.value }))} />
            </div>

            {novaFatura.forma_pagamento_id && (
              <div className="p-2 rounded bg-muted/50 text-xs text-muted-foreground">
                {novaFatura.data_vencimento ? (
                  <p>O sistema buscará todos os pagamentos com a forma de pagamento selecionada e <strong>data de vencimento = {fmtDate(novaFatura.data_vencimento)}</strong>.</p>
                ) : novaFatura.data_fechamento_inicio && novaFatura.data_fechamento_fim ? (
                  <p>Sem data de vencimento, o sistema usará a <strong>data de competência</strong> entre <strong>{fmtDate(novaFatura.data_fechamento_inicio)}</strong> e <strong>{fmtDate(novaFatura.data_fechamento_fim)}</strong>.</p>
                ) : (
                  <p>Informe a data de vencimento da fatura para buscar os pagamentos correspondentes.</p>
                )}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowFaturaDialog(false)}>Cancelar</Button>
            <Button onClick={handleCriarFatura} disabled={!novaFatura.cartao_id || !novaFatura.forma_pagamento_id || saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Criar Fatura"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Vincular Extrato Liquidante */}
      <Dialog open={showExtratoDialog} onOpenChange={setShowExtratoDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Vincular Extrato Liquidante</DialogTitle></DialogHeader>
          <p className="text-xs text-muted-foreground">
            Selecione a transação bancária (débito) que quitou esta fatura do cartão.
          </p>
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input
              className="pl-8"
              placeholder="Buscar por descrição ou contraparte..."
              value={extratoSearch}
              onChange={e => setExtratoSearch(e.target.value)}
            />
          </div>

          <div className="max-h-[300px] overflow-auto rounded-md border border-border">
            {loadingExtrato ? (
              <div className="flex justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            ) : extratoItems.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">Nenhum débito encontrado.</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[80px]">Data</TableHead>
                    <TableHead>Descrição</TableHead>
                    <TableHead className="text-right w-[100px]">Valor</TableHead>
                    <TableHead className="w-[50px]"></TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {extratoItems.map(e => (
                    <TableRow key={e.id} className="cursor-pointer hover:bg-muted/30">
                      <TableCell className="text-xs">{fmtDate(e.data_hora)}</TableCell>
                      <TableCell>
                        <p className="text-xs">{e.descricao || "—"}</p>
                        {e.nome_contraparte && (
                          <p className="text-[10px] text-muted-foreground">{e.nome_contraparte}</p>
                        )}
                      </TableCell>
                      <TableCell className="text-right text-xs font-medium text-destructive">
                        {fmt(Math.abs(e.valor ?? 0))}
                      </TableCell>
                      <TableCell>
                        <Button
                          size="icon" variant="ghost" className="h-6 w-6"
                          onClick={() => handleVincularExtrato(e.id)}
                          disabled={saving}
                        >
                          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>
        </DialogContent>
      </Dialog>

      {/* Editar Fatura */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Editar Fatura</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Mês de referência</label>
              <Input type="month" value={editForm.mes_referencia} onChange={e => setEditForm(p => ({ ...p, mes_referencia: e.target.value }))} />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Fechamento início</label>
                <Input type="date" value={editForm.data_fechamento_inicio} onChange={e => setEditForm(p => ({ ...p, data_fechamento_inicio: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <label className="text-xs text-muted-foreground">Fechamento fim</label>
                <Input type="date" value={editForm.data_fechamento_fim} onChange={e => setEditForm(p => ({ ...p, data_fechamento_fim: e.target.value }))} />
              </div>
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Data de vencimento</label>
              <Input type="date" value={editForm.data_vencimento} onChange={e => setEditForm(p => ({ ...p, data_vencimento: e.target.value }))} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>Cancelar</Button>
            <Button onClick={handleSalvarEdicao} disabled={saving}>
              {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : "Salvar"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
