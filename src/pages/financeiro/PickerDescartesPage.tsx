import { useEffect, useState, useMemo } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Loader2, Search, RefreshCw } from "lucide-react";

interface Candidato {
  idx: number;
  nome_nf: string;
  cprod_nf: string;
  vunit_nf: number;
  vtotal_nf: number;
  qcom_nf: number;
  token_score: number;
  unit_diff_pct: number;
  total_diff_pct: number;
  usado_por_outro: boolean;
}

interface Descarte {
  id: string;
  compra_gc_id: string;
  compra_codigo: string | null;
  produto_gc_id: string | null;
  nome_produto_pedido: string | null;
  codigo_interno_pedido: string | null;
  quantidade_pedido: number | null;
  valor_unit_pedido: number | null;
  valor_total_pedido: number | null;
  nf_chave: string | null;
  nf_numero: string | null;
  motivo: string;
  candidatos: Candidato[];
  created_at: string;
}

const MOTIVO_COR: Record<string, string> = {
  nome_muito_diferente: "bg-red-500/15 text-red-500 border-red-500/40",
  score_abaixo_do_threshold: "bg-amber-500/15 text-amber-500 border-amber-500/40",
  preco_incompativel: "bg-orange-500/15 text-orange-500 border-orange-500/40",
  xml_sem_itens: "bg-slate-500/15 text-slate-500 border-slate-500/40",
  xml_1_item_mas_pedido_multi: "bg-purple-500/15 text-purple-500 border-purple-500/40",
};

export default function PickerDescartesPage() {
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState<Descarte[]>([]);
  const [filtro, setFiltro] = useState("");
  const [motivoFilter, setMotivoFilter] = useState<string>("");

  const load = async () => {
    setLoading(true);
    const { data } = await supabase
      .from("fin_nfe_picker_descartes")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    setRows((data as any as Descarte[]) || []);
    setLoading(false);
  };

  useEffect(() => { load(); }, []);

  const contagemMotivos = useMemo(() => {
    const acc = new Map<string, number>();
    for (const r of rows) acc.set(r.motivo, (acc.get(r.motivo) || 0) + 1);
    return [...acc.entries()].sort((a, b) => b[1] - a[1]);
  }, [rows]);

  const filtered = useMemo(() => {
    const q = filtro.trim().toLowerCase();
    return rows.filter((r) => {
      if (motivoFilter && r.motivo !== motivoFilter) return false;
      if (!q) return true;
      return (
        r.nome_produto_pedido?.toLowerCase().includes(q) ||
        r.codigo_interno_pedido?.toLowerCase().includes(q) ||
        r.compra_codigo?.toLowerCase().includes(q) ||
        r.nf_numero?.toLowerCase().includes(q)
      );
    });
  }, [rows, filtro, motivoFilter]);

  return (
    <div className="p-6 space-y-4 max-w-[1600px] mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Descartes do matcher de NF</h1>
          <p className="text-sm text-muted-foreground">
            Itens do pedido de compra que o matcher <strong>não conseguiu casar</strong> com um item do XML da NF.
            Aqui você vê os 3 melhores candidatos que foram testados e por que foram rejeitados.
          </p>
        </div>
        <Button variant="outline" onClick={load} disabled={loading}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <RefreshCw className="h-4 w-4 mr-2" />}
          Recarregar
        </Button>
      </div>

      <div className="flex flex-wrap gap-2">
        <Badge
          variant={motivoFilter === "" ? "default" : "outline"}
          className="cursor-pointer"
          onClick={() => setMotivoFilter("")}
        >
          Todos ({rows.length})
        </Badge>
        {contagemMotivos.map(([m, c]) => (
          <Badge
            key={m}
            variant={motivoFilter === m ? "default" : "outline"}
            className="cursor-pointer"
            onClick={() => setMotivoFilter(motivoFilter === m ? "" : m)}
          >
            {m} ({c})
          </Badge>
        ))}
      </div>

      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Filtrar por nome do produto, código interno, código da compra, número da NF..."
          value={filtro}
          onChange={(e) => setFiltro(e.target.value)}
          className="max-w-xl"
        />
        <span className="text-xs text-muted-foreground">{filtered.length} resultado(s)</span>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-muted-foreground">
          <Loader2 className="h-5 w-5 animate-spin mr-2" /> Carregando...
        </div>
      ) : filtered.length === 0 ? (
        <div className="rounded-md border border-border bg-muted/20 p-8 text-center text-muted-foreground">
          Nenhum descarte encontrado. Rode "Sincronizar por período" pra popular esse diagnóstico.
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((d) => (
            <Card key={d.id} className="overflow-hidden">
              <CardHeader className="py-3 bg-muted/30">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <CardTitle className="text-sm font-medium">
                      <span className="font-mono text-primary">#{d.compra_codigo}</span>
                      {" — "}
                      <span>{d.nome_produto_pedido}</span>
                      {d.codigo_interno_pedido && (
                        <span className="text-xs text-muted-foreground ml-2">
                          cadastro: <span className="font-mono">{d.codigo_interno_pedido}</span>
                        </span>
                      )}
                    </CardTitle>
                    <div className="text-xs text-muted-foreground mt-1">
                      Qtd: <strong>{d.quantidade_pedido}</strong>
                      {" • "}Unit: <strong>R$ {(d.valor_unit_pedido ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</strong>
                      {" • "}Total: <strong>R$ {(d.valor_total_pedido ?? 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</strong>
                      {d.nf_numero && <> • NF <span className="font-mono">{d.nf_numero}</span></>}
                    </div>
                  </div>
                  <Badge
                    variant="outline"
                    className={MOTIVO_COR[d.motivo] || "border-border"}
                  >
                    {d.motivo}
                  </Badge>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                {d.candidatos.length === 0 ? (
                  <div className="p-4 text-sm text-muted-foreground italic">XML sem itens.</div>
                ) : (
                  <table className="w-full text-xs">
                    <thead className="bg-muted/20">
                      <tr>
                        <th className="px-3 py-2 text-left">#</th>
                        <th className="px-3 py-2 text-left">Nome no XML</th>
                        <th className="px-3 py-2 text-left">cProd</th>
                        <th className="px-3 py-2 text-right">Qtd</th>
                        <th className="px-3 py-2 text-right">Unit</th>
                        <th className="px-3 py-2 text-right">Total</th>
                        <th className="px-3 py-2 text-center">Score nome</th>
                        <th className="px-3 py-2 text-right">Δ unit</th>
                        <th className="px-3 py-2 text-right">Δ total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {d.candidatos.map((c, i) => (
                        <tr key={i} className="border-t border-border">
                          <td className="px-3 py-2 text-muted-foreground">{c.idx}</td>
                          <td className="px-3 py-2">{c.nome_nf}{c.usado_por_outro && <span className="ml-1 text-[10px] text-amber-500">(já usado)</span>}</td>
                          <td className="px-3 py-2 font-mono text-muted-foreground">{c.cprod_nf}</td>
                          <td className="px-3 py-2 text-right">{c.qcom_nf}</td>
                          <td className="px-3 py-2 text-right">R$ {c.vunit_nf.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</td>
                          <td className="px-3 py-2 text-right">R$ {c.vtotal_nf.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</td>
                          <td className={`px-3 py-2 text-center font-medium ${c.token_score >= 0.45 ? "text-emerald-500" : c.token_score >= 0.3 ? "text-amber-500" : "text-red-500"}`}>
                            {(c.token_score * 100).toFixed(0)}%
                          </td>
                          <td className={`px-3 py-2 text-right ${c.unit_diff_pct <= 15 ? "text-emerald-500" : "text-red-500"}`}>{c.unit_diff_pct.toFixed(1)}%</td>
                          <td className={`px-3 py-2 text-right ${c.total_diff_pct <= 5 ? "text-emerald-500" : "text-red-500"}`}>{c.total_diff_pct.toFixed(1)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
