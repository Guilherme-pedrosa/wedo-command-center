import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/format";
import {
  Brain, Loader2, Play, AlertTriangle, AlertCircle, Info,
  CheckCircle2, FileSearch, TrendingDown, ExternalLink,
} from "lucide-react";
import toast from "react-hot-toast";

interface Achado {
  tipo: string;
  severidade: "alta" | "media" | "baixa";
  titulo: string;
  descricao: string;
  ids_afetados: string[];
  valor_impacto: number;
  evidencias: string[];
  acao_sugerida: string;
}

interface AuditResult {
  analise: string;
  achados: Achado[];
  stats: {
    total_pagamentos: number;
    valor_total: number;
    achados_total: number;
    alta: number;
    media: number;
    baixa: number;
    valor_em_risco: number;
  };
}

const sevConfig = {
  alta:  { color: "text-destructive bg-destructive/10 border-destructive/30", icon: AlertCircle, label: "Alta" },
  media: { color: "text-yellow-600 bg-yellow-500/10 border-yellow-500/30", icon: AlertTriangle, label: "Média" },
  baixa: { color: "text-muted-foreground bg-muted/50 border-border", icon: Info, label: "Baixa" },
};

function firstDayMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
}
function lastDayMonth() {
  const d = new Date();
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return last.toISOString().split("T")[0];
}

export default function AuditorIAPage() {
  const [dataInicio, setDataInicio] = useState(firstDayMonth());
  const [dataFim, setDataFim] = useState(lastDayMonth());
  const [planoFilter, setPlanoFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AuditResult | null>(null);
  const [filterSev, setFilterSev] = useState<"all" | "alta" | "media" | "baixa">("all");

  const runAudit = async () => {
    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("fin-audit-duplicates", {
        body: { dataInicio, dataFim, plano_filter: planoFilter || null },
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error || "Erro desconhecido");
      setResult(data);
      toast.success(`Auditoria concluída: ${data.stats.achados_total} achados`);
    } catch (e: any) {
      toast.error(e.message || "Falha na auditoria");
    } finally {
      setLoading(false);
    }
  };

  const achadosFiltrados = result?.achados.filter(a =>
    filterSev === "all" || a.severidade === filterSev
  ) || [];

  return (
    <div className="space-y-4 p-4 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="h-10 w-10 rounded-lg bg-primary/10 flex items-center justify-center">
          <Brain className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-xl font-bold">Auditor IA</h1>
          <p className="text-xs text-muted-foreground">
            Detecta duplicações, misclassificações e anomalias em lançamentos via Gemini + heurísticas
          </p>
        </div>
        <Badge variant="outline" className="ml-auto text-[10px] border-primary/30 text-primary">
          Gemini 2.5 Flash
        </Badge>
      </div>

      {/* Controls */}
      <Card>
        <CardContent className="pt-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
            <div>
              <label className="text-xs text-muted-foreground">Data início</label>
              <Input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Data fim</label>
              <Input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)} className="h-9 text-sm" />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Filtro por plano (opcional)</label>
              <Input placeholder="ex: combustivel, treinamento..." value={planoFilter} onChange={e => setPlanoFilter(e.target.value)} className="h-9 text-sm" />
            </div>
            <Button onClick={runAudit} disabled={loading} className="gap-2 h-9">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {loading ? "Auditando..." : "Rodar auditoria"}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* Stats */}
      {result && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Card><CardHeader className="pb-2"><CardTitle className="text-[10px] uppercase text-muted-foreground">Lançamentos</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{result.stats.total_pagamentos}</div>
            <div className="text-xs text-muted-foreground">{formatCurrency(result.stats.valor_total)}</div></CardContent>
          </Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-[10px] uppercase text-muted-foreground">Achados</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{result.stats.achados_total}</div>
            <div className="text-xs text-muted-foreground">total</div></CardContent>
          </Card>
          <Card className="border-destructive/30"><CardHeader className="pb-2"><CardTitle className="text-[10px] uppercase text-destructive">Alta severidade</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold text-destructive">{result.stats.alta}</div>
            <div className="text-xs text-muted-foreground">{result.stats.media} média · {result.stats.baixa} baixa</div></CardContent>
          </Card>
          <Card><CardHeader className="pb-2"><CardTitle className="text-[10px] uppercase text-muted-foreground flex items-center gap-1"><TrendingDown className="h-3 w-3" />Em risco</CardTitle></CardHeader>
            <CardContent><div className="text-2xl font-bold">{formatCurrency(result.stats.valor_em_risco)}</div>
            <div className="text-xs text-muted-foreground">valor impactado</div></CardContent>
          </Card>
        </div>
      )}

      {/* AI analysis */}
      {result?.analise && (
        <Card className="border-primary/20">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2"><Brain className="h-4 w-4 text-primary" /> Análise da IA</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground whitespace-pre-wrap">{result.analise}</p>
          </CardContent>
        </Card>
      )}

      {/* Filter chips */}
      {result && result.achados.length > 0 && (
        <div className="flex gap-2 flex-wrap">
          {(["all", "alta", "media", "baixa"] as const).map(s => (
            <Button
              key={s}
              variant={filterSev === s ? "default" : "outline"}
              size="sm"
              onClick={() => setFilterSev(s)}
              className="text-xs h-7"
            >
              {s === "all" ? "Todos" : sevConfig[s].label} ({s === "all" ? result.achados.length : result.stats[s]})
            </Button>
          ))}
        </div>
      )}

      {/* Achados list */}
      {result && (
        <div className="space-y-3">
          {achadosFiltrados.length === 0 ? (
            <Card>
              <CardContent className="py-10 text-center text-muted-foreground">
                <CheckCircle2 className="h-10 w-10 mx-auto mb-2 text-green-500" />
                <p className="text-sm">Nenhum achado nesse filtro. Ótimo sinal!</p>
              </CardContent>
            </Card>
          ) : (
            achadosFiltrados.map((a, i) => {
              const cfg = sevConfig[a.severidade];
              const Icon = cfg.icon;
              return (
                <Card key={i} className={`border-2 ${cfg.color}`}>
                  <CardContent className="pt-4 space-y-2">
                    <div className="flex items-start justify-between gap-3">
                      <div className="flex items-start gap-2 min-w-0">
                        <Icon className="h-4 w-4 mt-0.5 shrink-0" />
                        <div className="min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <Badge variant="outline" className={`text-[10px] ${cfg.color}`}>{cfg.label}</Badge>
                            <Badge variant="outline" className="text-[10px]">{a.tipo}</Badge>
                            {a.valor_impacto > 0 && (
                              <span className="text-xs font-semibold">{formatCurrency(a.valor_impacto)}</span>
                            )}
                          </div>
                          <h3 className="text-sm font-semibold mt-1">{a.titulo}</h3>
                          <p className="text-xs text-muted-foreground mt-1">{a.descricao}</p>
                        </div>
                      </div>
                    </div>

                    {a.evidencias.length > 0 && (
                      <div className="flex flex-wrap gap-1 pl-6">
                        {a.evidencias.map((ev, j) => (
                          <span key={j} className="text-[10px] bg-background/70 rounded px-1.5 py-0.5 text-muted-foreground border border-border">
                            {ev}
                          </span>
                        ))}
                      </div>
                    )}

                    <div className="pl-6 pt-1 flex items-start gap-2">
                      <FileSearch className="h-3 w-3 mt-0.5 text-muted-foreground shrink-0" />
                      <p className="text-xs text-muted-foreground"><strong>Ação:</strong> {a.acao_sugerida}</p>
                    </div>

                    {a.ids_afetados.length > 0 && (
                      <div className="pl-6 pt-1">
                        <details className="text-[10px]">
                          <summary className="cursor-pointer text-muted-foreground hover:text-foreground">
                            IDs afetados ({a.ids_afetados.length})
                          </summary>
                          <div className="mt-1 font-mono text-[9px] text-muted-foreground break-all">
                            {a.ids_afetados.join(", ")}
                          </div>
                        </details>
                      </div>
                    )}
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>
      )}

      {!result && !loading && (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            <Brain className="h-12 w-12 mx-auto mb-3 text-primary/50" />
            <p className="text-sm">Configure o período e clique em <strong>Rodar auditoria</strong></p>
            <p className="text-xs mt-1">A IA analisará lançamentos buscando duplicações, misclassificações e anomalias.</p>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
