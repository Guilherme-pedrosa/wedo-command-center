import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Loader2, ShoppingCart } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatBRL } from '@/lib/comissoes/analisePickPack';
import type { calcularVenda } from '@/lib/comissoes/calculo';
import { configPedidoValida, montarPedidoCompra } from '@/lib/comissoes/pedidoCompraGC';
import { gerarPedidoCompraGC, listarPedidosGC, vendasJaPedidas } from '@/lib/comissoes/api';

type LinhaComissao = ReturnType<typeof calcularVenda>;

interface Props {
  vendedorChave: string;
  vendedorNome: string;
  linhas: LinhaComissao[];
  periodo: { inicio: string; fim: string };
  /** `parametros.pedidoGC` cru; a validação acontece aqui. */
  configBruta: unknown;
  onClose: () => void;
}

const dataBR = (iso: string) => iso.slice(0, 10).split('-').reverse().join('/');
const hojeIso = () => new Date().toISOString().slice(0, 10);

/**
 * Confirmação antes de gerar o pedido de compra no GC.
 *
 * Mostra o que entra e o que fica de fora, com motivo, ANTES de gravar.
 * Pedido de compra é documento no ERP: quem confirma precisa ver o número
 * exato e a lista, não descobrir depois que metade das vendas não entrou.
 */
export function PedidoCompraComissaoDialog({ vendedorChave, vendedorNome, linhas, periodo, configBruta, onClose }: Props) {
  const qc = useQueryClient();
  const [gerando, setGerando] = useState(false);
  const pedidos = useQuery({ queryKey: ['comissoes-pedidos-gc'], queryFn: listarPedidosGC, staleTime: 30_000 });

  const config = useMemo(() => configPedidoValida(configBruta), [configBruta]);
  const montagem = useMemo(
    () =>
      montarPedidoCompra({
        vendedorChave,
        vendedorNome,
        linhas,
        config,
        periodoInicio: periodo.inicio,
        periodoFim: periodo.fim,
        hoje: hojeIso(),
        jaPedidas: vendasJaPedidas(pedidos.data ?? []),
      }),
    [vendedorChave, vendedorNome, linhas, config, periodo, pedidos.data],
  );

  const anteriores = (pedidos.data ?? []).filter((p) => p.vendedor_chave === vendedorChave);

  const gerar = async () => {
    if (!montagem.pedido) return;
    setGerando(true);
    try {
      const r = await gerarPedidoCompraGC(montagem.pedido);
      await qc.invalidateQueries({ queryKey: ['comissoes-pedidos-gc'] });
      toast.success(`Pedido de ${formatBRL(r.valor_total)} enfileirado para o GC. O número aparece aqui assim que o GC responder (até 2 min).`);
      onClose();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setGerando(false);
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShoppingCart className="h-5 w-5" /> Pedido de compra no GC — {vendedorNome}
          </DialogTitle>
          <DialogDescription>
            Período {dataBR(periodo.inicio)} a {dataBR(periodo.fim)}. Gera um pedido de compra no Gestão Click em nome do vendedor
            (como fornecedor), com um item por venda e uma parcela com o total, que vira a conta a pagar.
          </DialogDescription>
        </DialogHeader>

        {pedidos.isLoading ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Conferindo pedidos já gerados…</p>
        ) : montagem.erro && !montagem.pedido ? (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
            <p className="font-medium">Não dá para gerar: {montagem.erro}</p>
            {montagem.erro.includes('fornecedor') && (
              <p className="mt-1 text-muted-foreground">Cadastre o fornecedor do GC deste vendedor em <strong>Custos e regras de comissão → Pedido de compra no GC</strong>.</p>
            )}
          </div>
        ) : (
          <>
            <section className="rounded-md border p-3 text-sm">
              <div className="flex items-baseline justify-between gap-3">
                <span className="font-medium">{montagem.pedido!.vendas.length} venda(s) no pedido</span>
                <span className="text-lg font-semibold tabular-nums">{formatBRL(montagem.pedido!.valorTotal)}</span>
              </div>
              <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto text-xs">
                {montagem.pedido!.vendas.map((v) => (
                  <li key={v.vendaId} className="flex justify-between gap-3">
                    <span className="truncate">Venda {v.codigo} · {v.cliente} · {dataBR(v.data)}</span>
                    <span className="shrink-0 tabular-nums">{formatBRL(v.comissao)}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-2 text-xs text-muted-foreground">
                Fornecedor GC {montagem.pedido!.fornecedorId} · situação {config.situacaoId} · plano de contas {config.planoContasId} · vencimento em {config.diasVencimento} dia(s).
              </p>
            </section>

            {montagem.impedimentos.length > 0 && (
              <section className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                <p className="font-medium">{montagem.impedimentos.length} venda(s) ficam de fora</p>
                <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">
                  {montagem.impedimentos.map((i) => (
                    <li key={i.vendaId}>Venda {i.codigo}: {i.motivo}</li>
                  ))}
                </ul>
              </section>
            )}
          </>
        )}

        {anteriores.length > 0 && (
          <section className="text-xs text-muted-foreground">
            <p className="font-medium text-foreground">Pedidos anteriores deste vendedor</p>
            <ul className="mt-1 space-y-0.5">
              {anteriores.slice(0, 6).map((p) => (
                <li key={p.id}>
                  {dataBR(p.periodo_inicio)}–{dataBR(p.periodo_fim)} · {formatBRL(p.valor_total)} ·{' '}
                  {p.status === 'enviado' ? `GC #${p.gc_codigo ?? p.gc_compra_id}` : p.status === 'erro' ? `erro: ${p.erro ?? ''}` : p.status}
                </li>
              ))}
            </ul>
          </section>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose} disabled={gerando}>Cancelar</Button>
          <Button onClick={() => void gerar()} disabled={gerando || !montagem.pedido || pedidos.isLoading} className="gap-2">
            {gerando ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShoppingCart className="h-4 w-4" />}
            Gerar pedido de {montagem.pedido ? formatBRL(montagem.pedido.valorTotal) : '—'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
