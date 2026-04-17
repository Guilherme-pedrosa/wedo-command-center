// Painel de Análise IA para a página Metas & Orçamento
import { useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Sparkles, TrendingUp, AlertTriangle, Lightbulb, Loader2, ChevronDown, ChevronUp, RefreshCw } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import toast from 'react-hot-toast';
import type { MetaComResultado } from '@/hooks/useMetasResultados';

interface AnaliseIA {
  diagnostico: string;
  destaques_positivos: { titulo: string; descricao: string }[];
  alertas_criticos: { titulo: string; descricao: string }[];
  recomendacoes: { acao: string; justificativa: string; impacto_estimado: string }[];
}

interface Props {
  ano: number;
  mes: number;
  execTotal: number;
  margemLiquida: number;
  totalCustos: number;
  metas: MetaComResultado[];
}

export default function AnaliseIAMetas({ ano, mes, execTotal, margemLiquida, totalCustos, metas }: Props) {
  const [analise, setAnalise] = useState<AnaliseIA | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const [geradoEm, setGeradoEm] = useState<string | null>(null);

  const gerarAnalise = async () => {
    if (metas.length === 0) {
      toast.error('Sem metas para analisar');
      return;
    }
    setLoading(true);
    try {
      const payload = {
        ano,
        mes,
        execTotal,
        margemLiquida,
        totalCustos,
        metas: metas.map(m => ({
          nome: m.nome,
          categoria: m.categoria,
          meta_calculada: m.meta_calculada,
          realizado: m.realizado,
          delta: m.delta,
          pct_faturamento: m.pct_faturamento,
          status: m.status,
        })),
      };

      const { data, error } = await supabase.functions.invoke('analise-metas-ia', { body: payload });

      if (error) throw error;
      if (data?.error) throw new Error(data.error);

      setAnalise(data.analise);
      setGeradoEm(data.gerado_em);
      setExpanded(true);
      toast.success('Análise IA gerada');
    } catch (e: any) {
      console.error(e);
      toast.error(e.message || 'Erro ao gerar análise IA');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Card className="border-2 border-primary/30 bg-gradient-to-br from-primary/5 via-background to-background">
      <CardContent className="pt-4">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="flex items-center gap-2">
            <div className="h-8 w-8 rounded-lg bg-primary/15 flex items-center justify-center">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-foreground">Análise IA do Período</h3>
              <p className="text-xs text-muted-foreground">
                {analise
                  ? `Diagnóstico gerado por IA • ${geradoEm ? new Date(geradoEm).toLocaleString('pt-BR') : ''}`
                  : 'Diagnóstico de variação + recomendações acionáveis'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {analise && (
              <Button variant="ghost" size="sm" onClick={() => setExpanded(!expanded)}>
                {expanded ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
              </Button>
            )}
            <Button
              variant={analise ? 'outline' : 'default'}
              size="sm"
              onClick={gerarAnalise}
              disabled={loading}
            >
              {loading ? (
                <><Loader2 className="h-4 w-4 mr-1 animate-spin" /> Analisando...</>
              ) : analise ? (
                <><RefreshCw className="h-4 w-4 mr-1" /> Regenerar</>
              ) : (
                <><Sparkles className="h-4 w-4 mr-1" /> Gerar Análise IA</>
              )}
            </Button>
          </div>
        </div>

        {analise && expanded && (
          <div className="mt-4 flex flex-col gap-4">
            {/* DIAGNÓSTICO */}
            <div className="p-3 rounded-lg bg-card border border-border">
              <p className="text-sm text-foreground leading-relaxed">{analise.diagnostico}</p>
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
              {/* DESTAQUES */}
              {analise.destaques_positivos.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5">
                    <TrendingUp className="h-3.5 w-3.5 text-emerald-500" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-emerald-600 dark:text-emerald-400">
                      Destaques
                    </span>
                  </div>
                  {analise.destaques_positivos.map((d, i) => (
                    <div key={i} className="p-2.5 rounded border border-emerald-500/30 bg-emerald-500/5">
                      <p className="text-xs font-bold text-foreground">{d.titulo}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{d.descricao}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* ALERTAS */}
              {analise.alertas_criticos.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5">
                    <AlertTriangle className="h-3.5 w-3.5 text-destructive" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-destructive">
                      Alertas Críticos
                    </span>
                  </div>
                  {analise.alertas_criticos.map((a, i) => (
                    <div key={i} className="p-2.5 rounded border border-destructive/30 bg-destructive/5">
                      <p className="text-xs font-bold text-foreground">{a.titulo}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{a.descricao}</p>
                    </div>
                  ))}
                </div>
              )}

              {/* RECOMENDAÇÕES */}
              {analise.recomendacoes.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-1.5">
                    <Lightbulb className="h-3.5 w-3.5 text-yellow-500" />
                    <span className="text-xs font-semibold uppercase tracking-wide text-yellow-600 dark:text-yellow-400">
                      Ações Recomendadas
                    </span>
                  </div>
                  {analise.recomendacoes.map((r, i) => (
                    <div key={i} className="p-2.5 rounded border border-yellow-500/30 bg-yellow-500/5">
                      <p className="text-xs font-bold text-foreground">{r.acao}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{r.justificativa}</p>
                      <Badge variant="outline" className="text-[10px] mt-1.5 border-yellow-500/40 text-yellow-700 dark:text-yellow-400">
                        Impacto: {r.impacto_estimado}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
