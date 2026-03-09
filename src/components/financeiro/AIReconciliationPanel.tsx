import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { Brain, Loader2, Send, CheckCircle, AlertTriangle, HelpCircle, ChevronDown, ChevronUp, Sparkles } from "lucide-react";
import toast from "react-hot-toast";

interface Sugestao {
  extrato_id: string;
  extrato_resumo: string;
  lancamento_id: string;
  lancamento_tipo: "recebimento" | "pagamento";
  lancamento_resumo: string;
  confianca: "ALTA" | "MEDIA" | "BAIXA";
  confianca_pct: number;
  evidencias: string[];
  valor_extrato: number;
  valor_lancamento: number;
  diferenca: number;
}

interface AIResult {
  analise: string;
  sugestoes: Sugestao[];
  sem_match: string[];
  stats: {
    extratos_analisados: number;
    sugestoes_total: number;
    alta_confianca: number;
    media_confianca: number;
    baixa_confianca: number;
  };
}

interface Props {
  onVincular: (extratoId: string, lancamentoId: string, tipo: "recebimento" | "pagamento") => Promise<void>;
  extratoIds?: string[];
}

const confiancaConfig = {
  ALTA: { color: "text-green-600 bg-green-500/10 border-green-500/20", icon: CheckCircle, label: "Alta Confiança" },
  MEDIA: { color: "text-yellow-600 bg-yellow-500/10 border-yellow-500/20", icon: AlertTriangle, label: "Média Confiança" },
  BAIXA: { color: "text-red-500 bg-red-500/10 border-red-500/20", icon: HelpCircle, label: "Baixa Confiança" },
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
      toast.success(`IA encontrou ${data.stats.sugestoes_total} sugestões (${data.stats.alta_confianca} alta confiança)`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro na análise IA");
    } finally {
      setLoading(false);
    }
  };

  const handleVincularSugestao = async (s: Sugestao) => {
    setVinculando(s.extrato_id);
    try {
      await onVincular(s.extrato_id, s.lancamento_id, s.lancamento_tipo);
      setVinculados(prev => new Set([...prev, s.extrato_id]));
      toast.success("Vinculado com sucesso!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Erro ao vincular");
    } finally {
      setVinculando(null);
    }
  };

  const handleVincularTodosAlta = async () => {
    if (!result) return;
    const altas = result.sugestoes.filter(s => s.confianca === "ALTA" && !vinculados.has(s.extrato_id));
    if (!altas.length) { toast("Nenhuma sugestão de alta confiança pendente"); return; }
    
    for (const s of altas) {
      await handleVincularSugestao(s);
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
          <h3 className="text-sm font-semibold">Assistente IA — Conciliação</h3>
          <Badge variant="outline" className="text-[10px] border-primary/30 text-primary">GPT-5</Badge>
        </div>
        {expanded ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          {/* Command input */}
          <div className="flex gap-2">
            <Input
              placeholder='Digite um comando (ex: "analisa recebimentos do Mercado Pago") ou deixe vazio para análise completa...'
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
            {["Analisa créditos sem match", "Busca recebimentos do Mercado Pago", "Verifica PIX recebidos hoje", "Analisa débitos pendentes"].map(cmd => (
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
                <span className="text-muted-foreground">{result.stats.extratos_analisados} extratos analisados</span>
                <span className="text-green-600 font-semibold">{result.stats.alta_confianca} alta</span>
                <span className="text-yellow-600 font-semibold">{result.stats.media_confianca} média</span>
                <span className="text-red-500 font-semibold">{result.stats.baixa_confianca} baixa</span>
              </div>

              {/* Analysis text */}
              {result.analise && (
                <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground whitespace-pre-wrap">
                  {result.analise}
                </div>
              )}

              {/* Bulk action */}
              {result.stats.alta_confianca > 0 && (
                <Button
                  variant="default"
                  size="sm"
                  className="gap-2"
                  onClick={handleVincularTodosAlta}
                  disabled={loading}
                >
                  <CheckCircle className="h-3.5 w-3.5" />
                  Vincular todos de Alta Confiança ({result.stats.alta_confianca})
                </Button>
              )}

              {/* Suggestions */}
              <div className="space-y-2 max-h-[50vh] overflow-y-auto">
                {result.sugestoes.map((s, idx) => {
                  const cfg = confiancaConfig[s.confianca];
                  const Icon = cfg.icon;
                  const isVinculado = vinculados.has(s.extrato_id);
                  const isVinculando = vinculando === s.extrato_id;

                  return (
                    <div key={idx} className={`rounded-md border p-3 space-y-2 ${isVinculado ? "opacity-50 border-green-500/30" : cfg.color}`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 shrink-0" />
                          <div>
                            <div className="flex items-center gap-2">
                              <Badge variant="outline" className={`text-[10px] ${cfg.color}`}>
                                {cfg.label} ({s.confianca_pct}%)
                              </Badge>
                              {isVinculado && <Badge className="text-[10px] bg-green-600">Vinculado ✓</Badge>}
                            </div>
                          </div>
                        </div>
                        {!isVinculado && (
                          <Button
                            size="sm"
                            variant={s.confianca === "ALTA" ? "default" : "outline"}
                            className="text-xs h-7 shrink-0"
                            onClick={() => handleVincularSugestao(s)}
                            disabled={isVinculando}
                          >
                            {isVinculando ? <Loader2 className="h-3 w-3 animate-spin mr-1" /> : null}
                            Confirmar
                          </Button>
                        )}
                      </div>

                      {/* Match details */}
                      <div className="grid grid-cols-2 gap-2 text-xs">
                        <div className="rounded bg-background/50 p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-1">Extrato</p>
                          <p className="font-medium">{s.extrato_resumo}</p>
                          <p className="font-bold text-primary">{formatCurrency(s.valor_extrato)}</p>
                        </div>
                        <div className="rounded bg-background/50 p-2">
                          <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-1">
                            {s.lancamento_tipo === "recebimento" ? "Recebimento" : "Pagamento"}
                          </p>
                          <p className="font-medium">{s.lancamento_resumo}</p>
                          <p className="font-bold text-primary">{formatCurrency(s.valor_lancamento)}</p>
                        </div>
                      </div>

                      {s.diferenca > 0.01 && (
                        <p className="text-[10px] text-yellow-600">⚠️ Diferença: {formatCurrency(s.diferenca)}</p>
                      )}

                      {/* Evidence */}
                      <div className="flex flex-wrap gap-1">
                        {s.evidencias.map((ev, i) => (
                          <span key={i} className="text-[10px] bg-background/70 rounded px-1.5 py-0.5 text-muted-foreground">
                            {ev}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* No match items */}
              {result.sem_match?.length > 0 && (
                <div className="rounded-md bg-muted/30 p-3 space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase">Sem match encontrado:</p>
                  {result.sem_match.map((msg, i) => (
                    <p key={i} className="text-[10px] text-muted-foreground">• {msg}</p>
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
