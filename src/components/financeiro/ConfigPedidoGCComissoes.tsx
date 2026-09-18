import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Input } from '@/components/ui/input';
import { supabase } from '@/integrations/supabase/client';
import { CONFIG_PEDIDO_GC_PADRAO, type ConfigPedidoGC } from '@/lib/comissoes/pedidoCompraGC';
import { sugerirFornecedor, type FornecedorGC } from '@/lib/comissoes/sugerirFornecedor';

interface Props {
  value: ConfigPedidoGC;
  onChange: (next: ConfigPedidoGC) => void;
  /** Vendedores presentes na tela: chave → nome. */
  vendedores: Record<string, string>;
  disabled?: boolean;
}

export function ConfigPedidoGCComissoes({ value, onChange, vendedores, disabled }: Props) {
  const fornecedores = useQuery({
    queryKey: ['fin_fornecedores-para-comissao'],
    staleTime: 5 * 60_000,
    queryFn: async () => {
      const { data, error } = await supabase.from('fin_fornecedores').select('gc_id, nome, cpf_cnpj').order('nome').limit(5000);
      if (error) throw error;
      return (data ?? []) as FornecedorGC[];
    },
  });

  const sugestoes = useMemo(() => {
    const m: Record<string, FornecedorGC | null> = {};
    for (const [chave, nome] of Object.entries(vendedores)) m[chave] = sugerirFornecedor(nome, fornecedores.data ?? []);
    return m;
  }, [vendedores, fornecedores.data]);

  const set = (campo: keyof ConfigPedidoGC, v: string) =>
    onChange({ ...value, [campo]: campo === 'diasVencimento' ? Number(v) : v });

  const setFornecedor = (chave: string, v: string) =>
    onChange({ ...value, fornecedorPorVendedor: { ...value.fornecedorPorVendedor, [chave]: v.trim() } });

  const nomeDoFornecedor = (gcId: string) => fornecedores.data?.find((f) => f.gc_id === gcId)?.nome;

  return (
    <div className="space-y-3 rounded-md border p-3">
      <h4 className="text-sm font-semibold">Pedido de compra no GC</h4>
      <p className="text-xs text-muted-foreground">
        Ao gerar o pedido de um vendedor, o Argus cria uma compra no Gestão Click com estes parâmetros. Padrões descobertos no seu GC:
        situação <strong>SERVIÇOS</strong>, plano <strong>Comissão de vendedores</strong>, centro <strong>COMERCIAL</strong>, forma <strong>PIX</strong>.
      </p>
      <fieldset disabled={disabled} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 text-sm">
        <label>Situação da compra (id GC)<Input value={value.situacaoId} onChange={(e) => set('situacaoId', e.target.value)} placeholder={CONFIG_PEDIDO_GC_PADRAO.situacaoId} /></label>
        <label>Plano de contas (id GC)<Input value={value.planoContasId} onChange={(e) => set('planoContasId', e.target.value)} placeholder={CONFIG_PEDIDO_GC_PADRAO.planoContasId} /></label>
        <label>Centro de custo (id GC)<Input value={value.centroCustoId} onChange={(e) => set('centroCustoId', e.target.value)} placeholder={CONFIG_PEDIDO_GC_PADRAO.centroCustoId} /></label>
        <label>Forma de pagamento (id GC)<Input value={value.formaPagamentoId} onChange={(e) => set('formaPagamentoId', e.target.value)} placeholder={CONFIG_PEDIDO_GC_PADRAO.formaPagamentoId} /></label>
        <label>Vencimento (dias após a emissão)<Input type="number" min={0} max={90} value={value.diasVencimento} onChange={(e) => set('diasVencimento', e.target.value)} /></label>
        <label>Produto "Comissão" no GC (opcional)<Input value={value.produtoId ?? ''} onChange={(e) => onChange({ ...value, produtoId: e.target.value.trim() || undefined })} placeholder="id do produto, se existir" /></label>
      </fieldset>

      <div className="space-y-2">
        <p className="text-sm font-medium">Fornecedor do GC de cada vendedor</p>
        <p className="text-xs text-muted-foreground">O GC exige um fornecedor no pedido. Vendedor sem fornecedor não gera pedido. A sugestão vem do cadastro de fornecedores pelo nome; confira e ajuste.</p>
        <fieldset disabled={disabled} className="space-y-2">
          {Object.entries(vendedores).sort(([, a], [, b]) => a.localeCompare(b, 'pt-BR')).map(([chave, nome]) => {
            const atual = value.fornecedorPorVendedor[chave] ?? '';
            const sug = sugestoes[chave];
            return (
              <div key={chave} className="grid items-center gap-2 text-sm sm:grid-cols-[1fr_9rem_1fr]">
                <span className="truncate font-medium">{nome}</span>
                <Input value={atual} onChange={(e) => setFornecedor(chave, e.target.value)} placeholder="id GC" aria-label={`Fornecedor GC de ${nome}`} />
                <span className="truncate text-xs text-muted-foreground">
                  {atual ? (nomeDoFornecedor(atual) ?? 'id não encontrado no cadastro sincronizado')
                    : sug ? <button type="button" className="underline" onClick={() => setFornecedor(chave, sug.gc_id)}>usar sugestão: {sug.nome} ({sug.gc_id})</button>
                    : fornecedores.isLoading ? 'buscando…' : 'sem sugestão — informe o id'}
                </span>
              </div>
            );
          })}
        </fieldset>
      </div>
    </div>
  );
}
