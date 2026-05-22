import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import toast from "react-hot-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertTriangle, History, Loader2, Save, X } from "lucide-react";
import { formatDateTime } from "@/lib/format";

type Politica = {
  id: string;
  tipo_id: string;
  nome_tabela: string;
  margem_minima: number; // 0..1
  modo_sugestao: "sugerir" | "manual";
  exige_aprovacao_ceo: boolean;
  updated_at: string;
};

type Edits = Record<
  string,
  Partial<Pick<Politica, "margem_minima" | "modo_sugestao" | "exige_aprovacao_ceo">>
>;

function pct(decimal: number): string {
  return (decimal * 100).toFixed(1).replace(".", ",");
}

export default function PoliticasPage() {
  const { user, loading: authLoading } = useAuth();
  const qc = useQueryClient();

  const [hasAccess, setHasAccess] = useState<boolean | null>(null);
  const [edits, setEdits] = useState<Edits>({});
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkMargem, setBulkMargem] = useState<string>("");
  const [bulkModo, setBulkModo] = useState<string>("");
  const [bulkAprov, setBulkAprov] = useState<string>("");
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [impactLoading, setImpactLoading] = useState(false);
  const [impactRows, setImpactRows] = useState<
    Array<{ tipo_id: string; nome_tabela: string; antiga: number; nova: number; produtos: number }>
  >([]);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Verifica role (admin ou ceo)
  useEffect(() => {
    if (authLoading) return;
    if (!user) {
      setHasAccess(false);
      return;
    }
    (async () => {
      const { data } = await supabase
        .from("user_roles")
        .select("role")
        .eq("user_id", user.id);
      const roles = (data ?? []).map((r: any) => r.role);
      setHasAccess(roles.includes("admin") || roles.includes("ceo"));
    })();
  }, [user, authLoading]);

  const { data: politicas, isLoading } = useQuery({
    queryKey: ["politica-markup"],
    enabled: hasAccess === true,
    queryFn: async (): Promise<Politica[]> => {
      const { data, error } = await supabase
        .from("fin_politica_markup_tabela")
        .select("id, tipo_id, nome_tabela, margem_minima, modo_sugestao, exige_aprovacao_ceo, updated_at")
        .order("nome_tabela");
      if (error) throw error;
      return (data ?? []) as Politica[];
    },
  });

  const ultimaAlteracao = useMemo(() => {
    if (!politicas?.length) return null;
    return politicas.reduce((a, b) => (a.updated_at > b.updated_at ? a : b)).updated_at;
  }, [politicas]);

  function getEffective(p: Politica) {
    const e = edits[p.tipo_id] ?? {};
    return {
      margem_minima: e.margem_minima ?? p.margem_minima,
      modo_sugestao: e.modo_sugestao ?? p.modo_sugestao,
      exige_aprovacao_ceo: e.exige_aprovacao_ceo ?? p.exige_aprovacao_ceo,
    };
  }
  function isDirty(p: Politica) {
    const e = edits[p.tipo_id];
    if (!e) return false;
    return (
      (e.margem_minima !== undefined && e.margem_minima !== p.margem_minima) ||
      (e.modo_sugestao !== undefined && e.modo_sugestao !== p.modo_sugestao) ||
      (e.exige_aprovacao_ceo !== undefined && e.exige_aprovacao_ceo !== p.exige_aprovacao_ceo)
    );
  }

  const dirtyList = useMemo(
    () => (politicas ?? []).filter(isDirty),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [politicas, edits],
  );

  function patchEdit(tipo_id: string, patch: Edits[string]) {
    setEdits((prev) => ({ ...prev, [tipo_id]: { ...prev[tipo_id], ...patch } }));
  }

  function onMargemChange(p: Politica, raw: string) {
    // aceita "25,0" ou "25.0"
    const norm = raw.replace(",", ".").trim();
    if (norm === "") {
      patchEdit(p.tipo_id, { margem_minima: 0 });
      return;
    }
    const n = parseFloat(norm);
    if (!isFinite(n)) return;
    if (n < 0 || n > 99.9) {
      toast.error("Margem deve estar entre 0,0% e 99,9%");
      return;
    }
    patchEdit(p.tipo_id, { margem_minima: Number((n / 100).toFixed(4)) });
  }

  function applyBulk() {
    if (selected.size === 0) return;
    if (!bulkMargem && !bulkModo && !bulkAprov) {
      toast.error("Preencha pelo menos margem, modo ou aprovação");
      return;
    }
    const patch: Edits[string] = {};
    if (bulkMargem) {
      const n = parseFloat(bulkMargem.replace(",", "."));
      if (!isFinite(n) || n < 0 || n > 99.9) {
        toast.error("Margem inválida (0,0 a 99,9)");
        return;
      }
      patch.margem_minima = Number((n / 100).toFixed(4));
    }
    if (bulkModo) patch.modo_sugestao = bulkModo as Politica["modo_sugestao"];
    if (bulkAprov) patch.exige_aprovacao_ceo = bulkAprov === "true";
    setEdits((prev) => {
      const next = { ...prev };
      for (const tid of selected) next[tid] = { ...next[tid], ...patch };
      return next;
    });
    setBulkMargem("");
    setBulkModo("");
    setBulkAprov("");
    toast.success(`Aplicado em ${selected.size} tabela(s) — revise e salve`);
  }

  function cancelar() {
    setEdits({});
    setSelected(new Set());
  }

  async function abrirConfirmacao() {
    if (dirtyList.length === 0) return;
    setImpactLoading(true);
    setConfirmOpen(true);
    try {
      const rows: typeof impactRows = [];
      for (const p of dirtyList) {
        const eff = getEffective(p);
        if (eff.margem_minima !== p.margem_minima) {
          const res = await supabase
            .from("v_produto_tabela_mc" as any)
            .select("*", { count: "exact", head: true })
            .eq("tipo_id", p.tipo_id)
            .lt("margem_contribuicao", eff.margem_minima)
            .not("margem_contribuicao", "is", null);
          rows.push({
            tipo_id: p.tipo_id,
            nome_tabela: p.nome_tabela,
            antiga: p.margem_minima,
            nova: eff.margem_minima,
            produtos: res.count ?? 0,
          });
        } else {
          rows.push({
            tipo_id: p.tipo_id,
            nome_tabela: p.nome_tabela,
            antiga: p.margem_minima,
            nova: p.margem_minima,
            produtos: 0,
          });
        }
      }
      setImpactRows(rows);
    } finally {
      setImpactLoading(false);
    }
  }

  async function salvar() {
    setSaving(true);
    try {
      let totalProdutos = 0;
      for (const p of dirtyList) {
        const eff = getEffective(p);
        const { error } = await supabase
          .from("fin_politica_markup_tabela")
          .update({
            margem_minima: eff.margem_minima,
            modo_sugestao: eff.modo_sugestao,
            exige_aprovacao_ceo: eff.exige_aprovacao_ceo,
          })
          .eq("tipo_id", p.tipo_id);
        if (error) throw error;
        const found = impactRows.find((r) => r.tipo_id === p.tipo_id);
        totalProdutos += found?.produtos ?? 0;
      }
      toast.success(
        `${dirtyList.length} tabela(s) atualizada(s). ${totalProdutos} produto(s) passaram a ter sugestão de novo preço.`,
        { duration: 6000 },
      );
      setEdits({});
      setSelected(new Set());
      setConfirmOpen(false);
      qc.invalidateQueries({ queryKey: ["politica-markup"] });
    } catch (e: any) {
      toast.error(`Falha ao salvar: ${e?.message ?? e}`);
    } finally {
      setSaving(false);
    }
  }

  if (authLoading || hasAccess === null) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!hasAccess) {
    return (
      <div className="p-6">
        <Card className="p-8 text-center">
          <h2 className="text-lg font-semibold text-destructive">403 — Acesso negado</h2>
          <p className="text-sm text-muted-foreground mt-2">
            Esta tela é restrita a perfis Admin e CEO.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-4">
      <Card className="p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-semibold flex items-center gap-2">
              ⚙️ Política de Margem Mínima por Tabela
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              Configurar a margem de contribuição mínima aceita por tabela. O sistema sugere
              correção quando a margem real cai abaixo desse mínimo.
            </p>
            {ultimaAlteracao && (
              <p className="text-xs text-muted-foreground mt-2">
                Última alteração: {formatDateTime(ultimaAlteracao)}
              </p>
            )}
          </div>
          <Button variant="outline" size="sm" onClick={() => setHistoryOpen(true)}>
            <History className="h-4 w-4 mr-1" /> Histórico
          </Button>
        </div>
      </Card>

      <Card>
        {isLoading ? (
          <div className="flex justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-10">
                  <Checkbox
                    checked={
                      politicas && politicas.length > 0 && selected.size === politicas.length
                    }
                    onCheckedChange={(c) =>
                      setSelected(c ? new Set((politicas ?? []).map((p) => p.tipo_id)) : new Set())
                    }
                  />
                </TableHead>
                <TableHead>Tabela</TableHead>
                <TableHead className="w-32">Marg. Mínima</TableHead>
                <TableHead className="w-32">Modo</TableHead>
                <TableHead className="w-24 text-center">Aprov. CEO</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(politicas ?? []).map((p) => {
                const eff = getEffective(p);
                const dirty = isDirty(p);
                const pctVal = eff.margem_minima * 100;
                const warnLow = pctVal < 5;
                const warnHigh = pctVal > 80;
                return (
                  <TableRow
                    key={p.tipo_id}
                    className={dirty ? "bg-yellow-50 dark:bg-yellow-950/30" : ""}
                  >
                    <TableCell>
                      <Checkbox
                        checked={selected.has(p.tipo_id)}
                        onCheckedChange={(c) =>
                          setSelected((prev) => {
                            const next = new Set(prev);
                            if (c) next.add(p.tipo_id);
                            else next.delete(p.tipo_id);
                            return next;
                          })
                        }
                      />
                    </TableCell>
                    <TableCell className="font-medium">
                      {p.nome_tabela}
                      {(warnLow || warnHigh) && (
                        <div className="flex items-center gap-1 mt-1 text-xs text-yellow-600 dark:text-yellow-400">
                          <AlertTriangle className="h-3 w-3" />
                          {warnLow
                            ? "Margem muito baixa — confirme se é intencional"
                            : "Margem muito alta — confirme se é intencional"}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Input
                          type="text"
                          inputMode="decimal"
                          className="h-8 w-20"
                          defaultValue={pct(p.margem_minima)}
                          key={`${p.tipo_id}-${p.margem_minima}-${edits[p.tipo_id]?.margem_minima ?? "x"}`}
                          onBlur={(e) => onMargemChange(p, e.target.value)}
                        />
                        <span className="text-sm text-muted-foreground">%</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={eff.modo_sugestao}
                        onValueChange={(v) =>
                          patchEdit(p.tipo_id, { modo_sugestao: v as "sugerir" | "manual" })
                        }
                      >
                        <SelectTrigger className="h-8">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="sugerir">sugerir</SelectItem>
                          <SelectItem value="manual">manual</SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell className="text-center">
                      <Checkbox
                        checked={eff.exige_aprovacao_ceo}
                        onCheckedChange={(c) =>
                          patchEdit(p.tipo_id, { exige_aprovacao_ceo: !!c })
                        }
                      />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </Card>

      {selected.size > 0 && (
        <Card className="p-4 bg-muted/30">
          <div className="text-sm font-medium mb-2">
            Ação em massa ({selected.size} selecionada{selected.size > 1 ? "s" : ""})
          </div>
          <div className="flex flex-wrap items-end gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Margem mínima %</label>
              <Input
                value={bulkMargem}
                onChange={(e) => setBulkMargem(e.target.value)}
                className="h-9 w-24"
                placeholder="ex: 25,0"
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Modo</label>
              <Select value={bulkModo} onValueChange={setBulkModo}>
                <SelectTrigger className="h-9 w-32">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sugerir">sugerir</SelectItem>
                  <SelectItem value="manual">manual</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Aprov. CEO</label>
              <Select value={bulkAprov} onValueChange={setBulkAprov}>
                <SelectTrigger className="h-9 w-32">
                  <SelectValue placeholder="—" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="true">exige</SelectItem>
                  <SelectItem value="false">não exige</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <Button onClick={applyBulk}>Aplicar às selecionadas</Button>
          </div>
        </Card>
      )}

      <div className="flex justify-end gap-2 pt-2">
        <Button variant="outline" onClick={cancelar} disabled={dirtyList.length === 0}>
          <X className="h-4 w-4 mr-1" /> Cancelar
        </Button>
        <Button onClick={abrirConfirmacao} disabled={dirtyList.length === 0}>
          <Save className="h-4 w-4 mr-1" /> Salvar Alterações ({dirtyList.length})
        </Button>
      </div>

      {/* Modal de confirmação */}
      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Confirmar alterações</DialogTitle>
            <DialogDescription>
              Revise o impacto antes de persistir as mudanças.
            </DialogDescription>
          </DialogHeader>
          {impactLoading ? (
            <div className="flex justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : (
            <div className="space-y-3 max-h-96 overflow-y-auto">
              {impactRows.map((r) => (
                <div key={r.tipo_id} className="border rounded p-3">
                  <div className="font-medium">{r.nome_tabela}</div>
                  {r.antiga !== r.nova ? (
                    <>
                      <div className="text-sm mt-1">
                        Margem: <span className="line-through text-muted-foreground">{pct(r.antiga)}%</span>{" "}
                        → <span className="font-semibold">{pct(r.nova)}%</span>
                      </div>
                      <div className="text-sm text-muted-foreground mt-1">
                        Impacto estimado:{" "}
                        <span className="font-semibold text-foreground">{r.produtos}</span> produto(s)
                        passarão a ter sugestão de novo preço
                      </div>
                    </>
                  ) : (
                    <div className="text-sm text-muted-foreground mt-1">
                      Apenas modo/aprovação alterado(s)
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)} disabled={saving}>
              Cancelar
            </Button>
            <Button onClick={salvar} disabled={saving || impactLoading}>
              {saving && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              Confirmar alterações
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Histórico */}
      <HistoricoDialog open={historyOpen} onOpenChange={setHistoryOpen} />
    </div>
  );
}

function HistoricoDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { data, isLoading } = useQuery({
    queryKey: ["politica-markup-history"],
    enabled: open,
    queryFn: async () => {
      const { data: hist, error } = await supabase
        .from("fin_politica_markup_tabela_history")
        .select("id, tipo_id, acao, antes, depois, ator, created_at")
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;

      // Resolve nomes de tabelas
      const tipoIds = [...new Set((hist ?? []).map((h: any) => h.tipo_id))];
      const { data: pols } = await supabase
        .from("fin_politica_markup_tabela")
        .select("tipo_id, nome_tabela")
        .in("tipo_id", tipoIds);
      const nomeMap = new Map((pols ?? []).map((p: any) => [p.tipo_id, p.nome_tabela]));

      // Resolve emails de atores via profiles
      const atorIds = [...new Set((hist ?? []).map((h: any) => h.ator).filter(Boolean))];
      const { data: profs } = atorIds.length
        ? await supabase.from("profiles").select("id, email, nome").in("id", atorIds)
        : { data: [] };
      const emailMap = new Map(
        (profs ?? []).map((p: any) => [p.id, p.nome || p.email || "—"]),
      );

      return (hist ?? []).map((h: any) => {
        const antes = h.antes ?? {};
        const depois = h.depois ?? {};
        const diffs: string[] = [];
        for (const k of ["margem_minima", "modo_sugestao", "exige_aprovacao_ceo"]) {
          if (JSON.stringify(antes[k]) !== JSON.stringify(depois[k])) {
            const fmt = (v: any) =>
              k === "margem_minima" && typeof v === "number"
                ? `${pct(v)}%`
                : v === null || v === undefined
                  ? "—"
                  : String(v);
            diffs.push(`${k}: ${fmt(antes[k])} → ${fmt(depois[k])}`);
          }
        }
        return {
          id: h.id,
          created_at: h.created_at,
          acao: h.acao,
          nome_tabela: nomeMap.get(h.tipo_id) ?? h.tipo_id,
          ator_nome: h.ator ? emailMap.get(h.ator) ?? "—" : "sistema",
          diffs,
        };
      });
    },
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Histórico de Alterações</DialogTitle>
          <DialogDescription>Últimas 50 entradas</DialogDescription>
        </DialogHeader>
        {isLoading ? (
          <div className="flex justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-3 max-h-96 overflow-y-auto">
            {(data ?? []).length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-4">
                Nenhuma alteração registrada
              </p>
            ) : (
              (data ?? []).map((h) => (
                <div key={h.id} className="border-l-2 border-primary pl-3 py-1">
                  <div className="text-xs text-muted-foreground">
                    {formatDateTime(h.created_at)} — {h.ator_nome}{" "}
                    <span className="opacity-50">[{h.acao}]</span>
                  </div>
                  <div className="text-sm font-medium">{h.nome_tabela}</div>
                  {h.diffs.length > 0 ? (
                    <ul className="text-sm text-muted-foreground mt-0.5">
                      {h.diffs.map((d, i) => (
                        <li key={i}>· {d}</li>
                      ))}
                    </ul>
                  ) : (
                    <div className="text-xs text-muted-foreground">
                      (sem mudança nos campos rastreados)
                    </div>
                  )}
                </div>
              ))
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
