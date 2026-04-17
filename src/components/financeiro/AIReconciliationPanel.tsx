import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { Brain, Loader2, Send, CheckCircle, AlertTriangle, HelpCircle, ChevronDown, ChevronUp, Sparkles, Lightbulb, Bell } from "lucide-react";
import toast from "react-hot-toast";

type LancTipo = "recebimento" | "pagamento" | "grupo_receber" | "grupo_pagar" | "agenda" | "residuo";
type AcaoSugerida = "quitar_recebimento" | "quitar_pagamento" | "vincular_grupo" | "executar_agenda" | "usar_residuo" | "criar_pagamento_de_nf";

interface Candidato {
  lancamento_id: string;
  lancamento_tipo: LancTipo;
  lancamento_resumo: string;
  confianca: "ALTA" | "MEDIA" | "MÉDIA" | "BAIXA";
  confianca_pct: number;
  evidencias: string[];
  valor_extrato: number;
  valor_lancamento: number;
  diferenca: number;
  acao_sugerida?: AcaoSugerida;
}

interface Sugestao {
  extrato_id: string;
  extrato_resumo: string;
  candidatos: Candidato[];
}

interface SemMatch {
  extrato_id?: string;
  extrato_resumo?: string;
  classificacao?: string;
  motivo?: string;
}

interface AIResult {
  analise_geral?: string;
  sugestoes: Sugestao[];
  sem_match: SemMatch[] | string[];
  alertas?: string[];
  insights?: string[];
  stats: {
    extratos_analisados: number;
    sugestoes_total: number;
    alta_confianca: number;
    media_confianca: number;
    baixa_confianca: number;
    grupos_receber_pool?: number;
    grupos_pagar_pool?: number;
    residuos_pool?: number;
    agenda_pool?: number;
    nfe_pool?: number;
  };
}

interface Props {
  onVincular: (extratoId: string, lancamentoId: string, tipo: LancTipo) => Promise<void>;
  extratoIds?: string[];
}

const confiancaConfig = {
  ALTA: { color: "text-green-600 bg-green-500/10 border-green-500/20", icon: CheckCircle, label: "Alta" },
  MEDIA: { color: "text-yellow-600 bg-yellow-500/10 border-yellow-500/20", icon: AlertTriangle, label: "Média" },
  "MÉDIA": { color: "text-yellow-600 bg-yellow-500/10 border-yellow-500/20", icon: AlertTriangle, label: "Média" },
  BAIXA: { color: "text-red-500 bg-red-500/10 border-red-500/20", icon: HelpCircle, label: "Baixa" },
};

const tipoLabel: Record<LancTipo, string> = {
  recebimento: "Recebimento",
  pagamento: "Pagamento",
  grupo_receber: "Grupo a Receber",
  grupo_pagar: "Grupo a Pagar",
  agenda: "Agenda Inter",
  residuo: "Resíduo",
};

const tipoBadgeColor: Record<LancTipo, string> = {
  recebimento: "bg-emerald-500/15 text-emerald-700 border-emerald-500/30",
  pagamento: "bg-rose-500/15 text-rose-700 border-rose-500/30",
  grupo_receber: "bg-cyan-500/15 text-cyan-700 border-cyan-500/30",
  grupo_pagar: "bg-orange-500/15 text-orange-700 border-orange-500/30",
  agenda: "bg-indigo-500/15 text-indigo-700 border-indigo-500/30",
  residuo: "bg-purple-500/15 text-purple-700 border-purple-500/30",
};

export default function AIReconciliationPanel({ onVincular, extratoIds }: Props) {
  const [command, setCommand] = useState("");
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<AIResult | null>(null);
  const [expanded, setExpanded] = useState(true);
  const [vinculando, setVinculando] = useState<string | null>(null);
  const [vinculados, setVinculados] = useState<Set<string>>(new Set());

  const handleAnalyze = async (cmd?: string) => {
    setLoading(true);
    setResult(null);
    try {
      const { data, error } = await supabase.functions.invoke("ai-reconciliation", {
        body: { command: cmd || command || null, extratoIds: extratoIds?.length ? extratoIds : undefined },
      });
      if (error) throw new Error(error.message);
      if (!data?.success) throw new Error(data?.error ?? "Erro desconhecido");
      setResult(data);
      toast.success(`IA: ${data.stats.sugestoes_total} candidatos (${data.stats.alta_confianca} alta confiança)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro na análise IA");
    } finally {
      setLoading(false);
    }
  };

  const handleVincularCandidato = async (extratoId: string, c: Candidato) => {
    const key = `${extratoId}|${c.lancamento_id}`;
    setVinculando(key);
    try {
      await onVincular(extratoId, c.lancamento_id, c.lancamento_tipo);
      setVinculados(prev => new Set([...prev, extratoId]));
      toast.success("Vinculado com sucesso!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao vincular");
    } finally {
      setVinculando(null);
    }
  };

  const handleVincularTodosAlta = async () => {
    if (!result) return;
    const altas: { extratoId: string; cand: Candidato }[] = [];
    for (const s of result.sugestoes) {
      if (vinculados.has(s.extrato_id)) continue;
      const top = s.candidatos.find(c => c.confianca === "ALTA");
      if (top) altas.push({ extratoId: s.extrato_id, cand: top });
    }
    if (!altas.length) { toast("Nenhuma sugestão de alta confiança pendente"); return; }
    for (const { extratoId, cand } of altas) {
      await handleVincularCandidato(extratoId, cand);
    }
  };

  return (
    <div className="rounded-lg border border-primary/20 bg-card overflow-hidden">
      {/* Header */}
      <div
        className="flex items-center justify-between p-3 bg-primary/5 cursor-pointer"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-primary" />
          <h3 className="text-sm font-semibold">ARGUS-FIN Pro — Conciliação Total</h3>
          <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">Gemini 2.5 Pro</Badge>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          {/* Command input */}
          <div className="flex gap-2">
            <Input
              placeholder='Comando (ex: "concilia Mercado Pago", "grupos", "resíduos", "nf órfãs") ou vazio = análise completa'
              value={command}
              onChange={(e) => setCommand(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && !loading && handleAnalyze()}
              className="text-sm"
              disabled={loading}
            />
            <Button onClick={() => handleAnalyze()} disabled={loading} className="gap-2 shrink-0">
              {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              {loading ? "Analisando..." : "Analisar"}
            </Button>
          </div>

          {/* Quick commands */}
          <div className="flex flex-wrap gap-1.5">
            {["Análise completa", "Concilia Mercado Pago", "Grupos a receber", "Resíduos disponíveis", "NF órfãs", "PIX hoje"].map(cmd => (
              <Button
                key={cmd}
                variant="outline"
                size="sm"
                className="text-[10px] h-6 gap-1"
                onClick={() => { setCommand(cmd); handleAnalyze(cmd); }}
                disabled={loading}
              >
                <Sparkles className="h-2.5 w-2.5" />
                {cmd}
              </Button>
            ))}
          </div>

          {/* Results */}
          {result && (
            <div className="space-y-4">
              {/* Stats */}
              <div className="flex flex-wrap gap-3 text-xs">
                <span className="text-muted-foreground">{result.stats.extratos_analisados} extratos</span>
                <span className="text-green-600 font-semibold">{result.stats.alta_confianca} alta</span>
                <span className="text-yellow-600 font-semibold">{result.stats.media_confianca} média</span>
                <span className="text-red-500 font-semibold">{result.stats.baixa_confianca} baixa</span>
                {result.stats.grupos_receber_pool != null && (
                  <span className="text-cyan-600">📦 {result.stats.grupos_receber_pool} grupos rec.</span>
                )}
                {result.stats.residuos_pool != null && result.stats.residuos_pool > 0 && (
                  <span className="text-purple-600">💎 {result.stats.residuos_pool} resíduos</span>
                )}
                {result.stats.agenda_pool != null && (
                  <span className="text-indigo-600">⏰ {result.stats.agenda_pool} agenda</span>
                )}
                {result.stats.nfe_pool != null && (
                  <span className="text-muted-foreground">📄 {result.stats.nfe_pool} NF-e</span>
                )}
              </div>

              {/* Análise geral */}
              {result.analise_geral && (
                <div className="rounded-md bg-muted/50 p-3 text-xs whitespace-pre-wrap">
                  <div className="flex items-center gap-1.5 mb-1 text-muted-foreground font-semibold uppercase text-[10px]">
                    <Brain className="h-3 w-3" /> Análise
                  </div>
                  {result.analise_geral}
                </div>
              )}

              {/* Alertas */}
              {result.alertas && result.alertas.length > 0 && (
                <div className="rounded-md border border-orange-500/30 bg-orange-500/5 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-orange-600 font-semibold uppercase text-[10px]">
                    <Bell className="h-3 w-3" /> Alertas ({result.alertas.length})
                  </div>
                  {result.alertas.map((a, i) => (
                    <p key={i} className="text-xs text-foreground">⚠️ {a}</p>
                  ))}
                </div>
              )}

              {/* Insights */}
              {result.insights && result.insights.length > 0 && (
                <div className="rounded-md border border-blue-500/30 bg-blue-500/5 p-3 space-y-1">
                  <div className="flex items-center gap-1.5 text-blue-600 font-semibold uppercase text-[10px]">
                    <Lightbulb className="h-3 w-3" /> Insights
                  </div>
                  {result.insights.map((a, i) => (
                    <p key={i} className="text-xs text-foreground">💡 {a}</p>
                  ))}
                </div>
              )}

              {/* Bulk action */}
              {result.stats.alta_confianca > 0 && (
                <Button
                  variant="default"
                  size="sm"
                  className="gap-2"
                  onClick={handleVincularTodosAlta}
                  disabled={loading || vinculando !== null}
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  Vincular todos de Alta Confiança ({result.stats.alta_confianca})
                </Button>
              )}

              {/* Suggestions */}
              <div className="space-y-3 max-h-[60vh] overflow-y-auto">
                {result.sugestoes.map((s, idx) => {
                  const isVinculado = vinculados.has(s.extrato_id);
                  return (
                    <div key={idx} className={`rounded-md border p-3 space-y-2 ${isVinculado ? "opacity-50 border-green-500/30 bg-green-500/5" : "border-border bg-background/50"}`}>
                      {/* Extrato header */}
                      <div className="flex items-start justify-between gap-2">
                        <div className="text-xs">
                          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Extrato</p>
                          <p className="font-medium">{s.extrato_resumo}</p>
                        </div>
                        {isVinculado && <Badge className="text-[10px] bg-green-600 shrink-0">Vinculado ✓</Badge>}
                      </div>

                      {/* Candidatos */}
                      <div className="space-y-1.5">
                        {s.candidatos.map((c, ci) => {
                          const cfg = confiancaConfig[c.confianca] ?? confiancaConfig.BAIXA;
                          const Icon = cfg.icon;
                          const key = `${s.extrato_id}|${c.lancamento_id}`;
                          const isThisVinculando = vinculando === key;
                          return (
                            <div key={ci} className={`rounded border p-2 ${cfg.color}`}>
                              <div className="flex items-start justify-between gap-2">
                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                  <Icon className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                                  <div className="min-w-0 flex-1">
                                    <div className="flex items-center gap-1.5 flex-wrap mb-1">
                                      <Badge variant="outline" className={`text-[9px] h-4 px-1 ${cfg.color}`}>
                                        {cfg.label} {c.confianca_pct}%
                                      </Badge>
                                      <Badge variant="outline" className={`text-[9px] h-4 px-1 ${tipoBadgeColor[c.lancamento_tipo] ?? ""}`}>
                                        {tipoLabel[c.lancamento_tipo] ?? c.lancamento_tipo}
                                      </Badge>
                                      <span className="text-[10px] font-bold text-primary">{formatCurrency(c.valor_lancamento)}</span>
                                      {c.diferenca > 0.01 && (
                                        <span className="text-[10px] text-yellow-600">Δ {formatCurrency(c.diferenca)}</span>
                                      )}
                                    </div>
                                    <p className="text-xs font-medium truncate">{c.lancamento_resumo}</p>
                                    {c.evidencias && c.evidencias.length > 0 && (
                                      <div className="flex flex-wrap gap-1 mt-1">
                                        {c.evidencias.map((ev, i) => (
                                          <span key={i} className="text-[9px] bg-background/70 rounded px-1 py-0.5 text-muted-foreground">
                                            {ev}
                                          </span>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                </div>
                                {!isVinculado && (
                                  <Button
                                    size="sm"
                                    variant={c.confianca === "ALTA" ? "default" : "outline"}
                                    className="text-[10px] h-6 px-2 shrink-0"
                                    onClick={() => handleVincularCandidato(s.extrato_id, c)}
                                    disabled={isThisVinculando || vinculando !== null}
                                  >
                                    {isThisVinculando ? <Loader2 className="h-3 w-3 animate-spin" /> : "Vincular"}
                                  </Button>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* No match items */}
              {Array.isArray(result.sem_match) && result.sem_match.length > 0 && (
                <div className="rounded-md bg-muted/30 p-3 space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Sem match ({result.sem_match.length}):</p>
                  {result.sem_match.map((m: any, i) => (
                    <p key={i} className="text-[10px] text-muted-foreground">
                      • {typeof m === "string" ? m : `${m.extrato_resumo ?? m.extrato_id} — ${m.classificacao ?? ""}${m.motivo ? `: ${m.motivo}` : ""}`}
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
