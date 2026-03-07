import { useState, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { formatCurrency } from "@/lib/format";
import { Target, Plus, Trash2, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

const MESES = ["Jan","Fev","Mar","Abr","Mai","Jun","Jul","Ago","Set","Out","Nov","Dez"];

export default function MetasFinanceirasPage() {
  const qc = useQueryClient();
  const [showNew, setShowNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [filtroAno, setFiltroAno] = useState(String(new Date().getFullYear()));
  const [filtroCC, setFiltroCC] = useState("todos");
  const [filtroTipo, setFiltroTipo] = useState("todos");

  // Form state
  const [form, setForm] = useState({
    nome: "", tipo: "despesa", periodo_tipo: "mensal", periodo_ano: new Date().getFullYear(),
    periodo_mes: new Date().getMonth() + 1, periodo_trimestre: 1,
    plano_contas_id: "", centro_custo_id: "", valor_meta: "", alerta_pct: "80", observacao: "",
  });

  const { data: metas, isLoading } = useQuery({
    queryKey: ["fin-metas", filtroAno],
    queryFn: async () => {
      const { data } = await supabase.from("fin_metas" as any).select("*, plano:fin_plano_contas(nome, codigo), centro:fin_centros_custo(nome, codigo)").eq("periodo_ano", Number(filtroAno)).order("created_at", { ascending: false });
      return (data ?? []) as any[];
    },
  });

  const { data: planoContas } = useQuery({
    queryKey: ["fin-plano-contas-list"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_plano_contas").select("id, nome, codigo, tipo").eq("ativo", true).order("codigo");
      return data ?? [];
    },
  });

  const { data: centrosCusto } = useQuery({
    queryKey: ["fin-centros-custo-list"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_centros_custo").select("id, nome, codigo").eq("ativo", true).order("codigo");
      return data ?? [];
    },
  });

  // Fetch realized amounts
  const { data: realizados } = useQuery({
    queryKey: ["fin-metas-realizado", filtroAno],
    queryFn: async () => {
      const [{ data: rec }, { data: pag }] = await Promise.all([
        supabase.from("fin_recebimentos").select("valor, data_liquidacao, plano_contas_id, centro_custo_id").eq("liquidado", true).gte("data_liquidacao", `${filtroAno}-01-01`).lte("data_liquidacao", `${filtroAno}-12-31`),
        supabase.from("fin_pagamentos").select("valor, data_liquidacao, plano_contas_id, centro_custo_id").eq("liquidado", true).gte("data_liquidacao", `${filtroAno}-01-01`).lte("data_liquidacao", `${filtroAno}-12-31`),
      ]);
      return { recebimentos: rec ?? [], pagamentos: pag ?? [] };
    },
  });

  const metasComProgresso = useMemo(() => {
    if (!metas || !realizados) return [];
    return metas.map((m: any) => {
      const pool = m.tipo === "receita" ? realizados.recebimentos : realizados.pagamentos;
      const realizado = pool
        .filter((l: any) => {
          if (m.plano_contas_id && l.plano_contas_id !== m.plano_contas_id) return false;
          if (m.centro_custo_id && l.centro_custo_id !== m.centro_custo_id) return false;
          if (!l.data_liquidacao) return false;
          const d = new Date(l.data_liquidacao);
          if (m.periodo_tipo === "mensal" && m.periodo_mes && (d.getMonth() + 1) !== m.periodo_mes) return false;
          if (m.periodo_tipo === "trimestral" && m.periodo_trimestre && Math.ceil((d.getMonth() + 1) / 3) !== m.periodo_trimestre) return false;
          return true;
        })
        .reduce((s: number, l: any) => s + Number(l.valor || 0), 0);
      const pct = m.valor_meta > 0 ? (realizado / Number(m.valor_meta)) * 100 : 0;
      const status = pct >= 100 ? "estourada" : pct >= Number(m.alerta_pct) ? "alerta" : "no_prazo";
      return { ...m, realizado, pct, status };
    });
  }, [metas, realizados]);

  const filtered = useMemo(() => {
    return metasComProgresso.filter((m: any) => {
      if (filtroCC !== "todos" && m.centro_custo_id !== filtroCC) return false;
      if (filtroTipo !== "todos" && m.tipo !== filtroTipo) return false;
      return true;
    });
  }, [metasComProgresso, filtroCC, filtroTipo]);

  const resumo = useMemo(() => {
    const total = metasComProgresso.length;
    const noPrazo = metasComProgresso.filter((m: any) => m.status === "no_prazo").length;
    const alerta = metasComProgresso.filter((m: any) => m.status === "alerta").length;
    const estourada = metasComProgresso.filter((m: any) => m.status === "estourada").length;
    return { total, noPrazo, alerta, estourada };
  }, [metasComProgresso]);

  const handleSave = async () => {
    if (!form.nome || !form.valor_meta) { toast.error("Nome e valor são obrigatórios"); return; }
    setSaving(true);
    try {
      const { error } = await supabase.from("fin_metas" as any).insert({
        nome: form.nome, tipo: form.tipo, periodo_tipo: form.periodo_tipo,
        periodo_ano: form.periodo_ano,
        periodo_mes: form.periodo_tipo === "mensal" ? form.periodo_mes : null,
        periodo_trimestre: form.periodo_tipo === "trimestral" ? form.periodo_trimestre : null,
        plano_contas_id: form.plano_contas_id || null,
        centro_custo_id: form.centro_custo_id || null,
        valor_meta: parseFloat(form.valor_meta), alerta_pct: parseFloat(form.alerta_pct),
        observacao: form.observacao || null,
      });
      if (error) throw error;
      toast.success("Meta criada");
      setShowNew(false);
      setForm({ nome: "", tipo: "despesa", periodo_tipo: "mensal", periodo_ano: new Date().getFullYear(), periodo_mes: new Date().getMonth() + 1, periodo_trimestre: 1, plano_contas_id: "", centro_custo_id: "", valor_meta: "", alerta_pct: "80", observacao: "" });
      qc.invalidateQueries({ queryKey: ["fin-metas"] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Erro"); }
    finally { setSaving(false); }
  };

  const handleDelete = async (id: string) => {
    if (!confirm("Excluir esta meta?")) return;
    await supabase.from("fin_metas" as any).delete().eq("id", id);
    toast.success("Meta excluída");
    qc.invalidateQueries({ queryKey: ["fin-metas"] });
  };

  const statusBadge = (s: string) => {
    if (s === "estourada") return <Badge variant="destructive" className="text-[10px]">Estourada</Badge>;
    if (s === "alerta") return <Badge className="bg-wedo-orange/20 text-wedo-orange border-wedo-orange/30 text-[10px]">Em alerta</Badge>;
    return <Badge className="bg-wedo-green/20 text-wedo-green border-wedo-green/30 text-[10px]">No prazo</Badge>;
  };

  const progressColor = (s: string) => s === "estourada" ? "bg-destructive" : s === "alerta" ? "bg-wedo-orange" : "bg-wedo-green";

  const periodoLabel = (m: any) => {
    if (m.periodo_tipo === "mensal") return `${MESES[(m.periodo_mes || 1) - 1]}/${m.periodo_ano}`;
    if (m.periodo_tipo === "trimestral") return `Q${m.periodo_trimestre}/${m.periodo_ano}`;
    return String(m.periodo_ano);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Metas Financeiras</h1><p className="text-sm text-muted-foreground">Acompanhe metas de receita e despesa por plano de contas e centro de custo</p></div>
        <Button onClick={() => setShowNew(true)} className="gap-2"><Plus className="h-4 w-4" />Nova Meta</Button>
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-muted-foreground">Total Ativas</p><p className="text-2xl font-bold">{resumo.total}</p></div>
        <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-wedo-green">No Prazo</p><p className="text-2xl font-bold text-wedo-green">{resumo.noPrazo}</p></div>
        <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-wedo-orange">Em Alerta</p><p className="text-2xl font-bold text-wedo-orange">{resumo.alerta}</p></div>
        <div className="rounded-lg border border-border bg-card p-4"><p className="text-xs text-destructive">Estouradas</p><p className="text-2xl font-bold text-destructive">{resumo.estourada}</p></div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <Select value={filtroAno} onValueChange={setFiltroAno}><SelectTrigger className="w-[100px]"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="2024">2024</SelectItem><SelectItem value="2025">2025</SelectItem><SelectItem value="2026">2026</SelectItem></SelectContent></Select>
        <Select value={filtroCC} onValueChange={setFiltroCC}><SelectTrigger className="w-[180px]"><SelectValue placeholder="Centro Custo" /></SelectTrigger><SelectContent><SelectItem value="todos">Todos CCs</SelectItem>{centrosCusto?.map(cc => <SelectItem key={cc.id} value={cc.id}>{cc.nome}</SelectItem>)}</SelectContent></Select>
        <Select value={filtroTipo} onValueChange={setFiltroTipo}><SelectTrigger className="w-[140px]"><SelectValue placeholder="Tipo" /></SelectTrigger><SelectContent><SelectItem value="todos">Todos</SelectItem><SelectItem value="receita">Receita</SelectItem><SelectItem value="despesa">Despesa</SelectItem><SelectItem value="lucro">Lucro</SelectItem><SelectItem value="margem">Margem</SelectItem></SelectContent></Select>
      </div>

      {/* Table */}
      <div className="rounded-lg border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs">
              <tr>
                <th className="text-left p-3">Nome</th>
                <th className="text-left p-3">Plano Contas</th>
                <th className="text-left p-3">Centro Custo</th>
                <th className="text-left p-3">Tipo</th>
                <th className="text-left p-3">Período</th>
                <th className="text-right p-3">Meta</th>
                <th className="text-right p-3">Realizado</th>
                <th className="text-center p-3 w-40">% Execução</th>
                <th className="text-center p-3">Status</th>
                <th className="p-3"></th>
              </tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={10} className="text-center py-8 text-muted-foreground"><Loader2 className="h-5 w-5 animate-spin mx-auto" /></td></tr>}
              {!isLoading && filtered.length === 0 && <tr><td colSpan={10} className="text-center py-8 text-muted-foreground">Nenhuma meta encontrada</td></tr>}
              {filtered.map((m: any) => (
                <tr key={m.id} className="border-t border-border hover:bg-muted/20">
                  <td className="p-3 font-medium">{m.nome}</td>
                  <td className="p-3 text-xs text-muted-foreground">{m.plano?.nome ?? "—"}</td>
                  <td className="p-3 text-xs text-muted-foreground">{m.centro?.nome ?? "—"}</td>
                  <td className="p-3"><Badge variant="outline" className="text-[10px] capitalize">{m.tipo}</Badge></td>
                  <td className="p-3 text-xs">{periodoLabel(m)}</td>
                  <td className="p-3 text-right font-mono">{formatCurrency(Number(m.valor_meta))}</td>
                  <td className="p-3 text-right font-mono">{formatCurrency(m.realizado)}</td>
                  <td className="p-3">
                    <div className="flex items-center gap-2">
                      <div className="flex-1 h-2 rounded-full bg-muted overflow-hidden">
                        <div className={`h-full rounded-full transition-all ${progressColor(m.status)}`} style={{ width: `${Math.min(m.pct, 100)}%` }} />
                      </div>
                      <span className="text-xs font-mono w-12 text-right">{m.pct.toFixed(0)}%</span>
                    </div>
                  </td>
                  <td className="p-3 text-center">{statusBadge(m.status)}</td>
                  <td className="p-3"><Button variant="ghost" size="sm" onClick={() => handleDelete(m.id)} className="h-7 w-7 p-0 text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /></Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* New Meta Dialog */}
      <Dialog open={showNew} onOpenChange={setShowNew}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle className="flex items-center gap-2"><Target className="h-5 w-5" />Nova Meta</DialogTitle></DialogHeader>
          <div className="space-y-4">
            <div><Label>Nome *</Label><Input value={form.nome} onChange={e => setForm(f => ({ ...f, nome: e.target.value }))} placeholder="Ex: Limite despesas operacionais" /></div>
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Tipo *</Label><Select value={form.tipo} onValueChange={v => setForm(f => ({ ...f, tipo: v }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="receita">Receita</SelectItem><SelectItem value="despesa">Despesa</SelectItem><SelectItem value="lucro">Lucro</SelectItem><SelectItem value="margem">Margem</SelectItem></SelectContent></Select></div>
              <div><Label>Período *</Label><Select value={form.periodo_tipo} onValueChange={v => setForm(f => ({ ...f, periodo_tipo: v }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent><SelectItem value="mensal">Mensal</SelectItem><SelectItem value="trimestral">Trimestral</SelectItem><SelectItem value="anual">Anual</SelectItem></SelectContent></Select></div>
            </div>
            <div className="grid grid-cols-3 gap-4">
              <div><Label>Ano *</Label><Input type="number" value={form.periodo_ano} onChange={e => setForm(f => ({ ...f, periodo_ano: Number(e.target.value) }))} /></div>
              {form.periodo_tipo === "mensal" && <div><Label>Mês</Label><Select value={String(form.periodo_mes)} onValueChange={v => setForm(f => ({ ...f, periodo_mes: Number(v) }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{MESES.map((m, i) => <SelectItem key={i} value={String(i + 1)}>{m}</SelectItem>)}</SelectContent></Select></div>}
              {form.periodo_tipo === "trimestral" && <div><Label>Trimestre</Label><Select value={String(form.periodo_trimestre)} onValueChange={v => setForm(f => ({ ...f, periodo_trimestre: Number(v) }))}><SelectTrigger><SelectValue /></SelectTrigger><SelectContent>{[1,2,3,4].map(q => <SelectItem key={q} value={String(q)}>Q{q}</SelectItem>)}</SelectContent></Select></div>}
            </div>
            <div><Label>Plano de Contas</Label><Select value={form.plano_contas_id || "none"} onValueChange={v => setForm(f => ({ ...f, plano_contas_id: v === "none" ? "" : v }))}><SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger><SelectContent><SelectItem value="none">Todos</SelectItem>{planoContas?.map(pc => <SelectItem key={pc.id} value={pc.id}>{pc.codigo ? `${pc.codigo} - ` : ""}{pc.nome}</SelectItem>)}</SelectContent></Select></div>
            <div><Label>Centro de Custo</Label><Select value={form.centro_custo_id || "none"} onValueChange={v => setForm(f => ({ ...f, centro_custo_id: v === "none" ? "" : v }))}><SelectTrigger><SelectValue placeholder="Todos" /></SelectTrigger><SelectContent><SelectItem value="none">Todos</SelectItem>{centrosCusto?.map(cc => <SelectItem key={cc.id} value={cc.id}>{cc.codigo ? `${cc.codigo} - ` : ""}{cc.nome}</SelectItem>)}</SelectContent></Select></div>
            <div className="grid grid-cols-2 gap-4">
              <div><Label>Valor Meta (R$) *</Label><Input type="number" step="0.01" value={form.valor_meta} onChange={e => setForm(f => ({ ...f, valor_meta: e.target.value }))} placeholder="0.00" /></div>
              <div><Label>Alerta (%)</Label><Input type="number" step="1" value={form.alerta_pct} onChange={e => setForm(f => ({ ...f, alerta_pct: e.target.value }))} /></div>
            </div>
            <div><Label>Observação</Label><Input value={form.observacao} onChange={e => setForm(f => ({ ...f, observacao: e.target.value }))} placeholder="Opcional" /></div>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setShowNew(false)}>Cancelar</Button>
            <Button onClick={handleSave} disabled={saving}>{saving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}Salvar</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
