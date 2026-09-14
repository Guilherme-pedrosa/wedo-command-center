import { useQuery } from '@tanstack/react-query';
import { carregarHistoricoComissao } from '@/lib/comissoes/api';
import { Button } from '@/components/ui/button';

export function HistoricoSituacaoComissao({ vendaId }: { vendaId: string }) {
  const query = useQuery({ queryKey: ['comissao-historico', vendaId], queryFn: () => carregarHistoricoComissao(vendaId), staleTime: 30000 });
  return <section className="space-y-2" aria-label="Histórico de retiradas e reinclusões">
    <h3 className="font-semibold">Histórico de retiradas e reinclusões</h3>
    {query.isPending ? <p role="status" className="text-sm">Carregando histórico…</p> : query.isError ? <p role="alert" className="text-sm text-destructive">Não foi possível carregar o histórico. <Button size="sm" variant="outline" onClick={() => void query.refetch()}>Tentar novamente</Button></p> : query.data.length ? <ol className="space-y-2">{query.data.map(e => <li key={e.id} className="border rounded p-3 text-sm">
      <p><b>{e.retirada_depois ? 'Comissão retirada' : 'Comissão reincluída'}</b> · {new Date(e.created_at).toLocaleString('pt-BR')}</p>
      <p>{e.usuario_nome || `Usuário ${e.usuario_id.slice(0, 8)}`} · {e.vendedor_nome || 'Vendedor não identificado'}</p>
      <p className="whitespace-pre-wrap break-words mt-1">{e.motivo}</p>
    </li>)}</ol> : <p className="text-sm text-muted-foreground">Nenhuma retirada ou reinclusão registrada.</p>}
  </section>;
}
