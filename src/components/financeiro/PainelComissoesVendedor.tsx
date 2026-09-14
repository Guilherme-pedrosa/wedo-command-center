import { useEffect, useId, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ResumoCustosComissao } from './ResumoCustosComissao';
import { resumirCustosComissao } from '@/lib/comissoes/resumoCustos';
import { formatBRL } from '@/lib/comissoes/analisePickPack';
import { centavos, type calcularVenda } from '@/lib/comissoes/calculo';

type LinhaComissao = ReturnType<typeof calcularVenda>;

export interface PainelComissoesVendedorProps {
  linhas: LinhaComissao[];
  onConferir: (vendaId: string) => void;
  onAlterarSituacao: (ids: string[], retirada: boolean) => void;
  isAdmin: boolean;
}

const dataBR = (valor?: string) => valor ? valor.slice(0, 10).split('-').reverse().join('/') : '—';

function situacaoComissao(linha: LinhaComissao) {
  if (linha.retirada) return linha.pago > 0 ? 'Retirada · pagamento registrado' : 'Retirada';
  if (linha.saldo < 0) return 'Pagamento acima da comissão';
  if (linha.comissao <= 0) return 'Sem comissão';
  if (linha.pago > 0) return linha.saldo > 0 ? 'Pagamento parcial registrado' : 'Pagamento registrado';
  return 'A pagar';
}

export function PainelComissoesVendedor(props: PainelComissoesVendedorProps) {
  const grupos = useMemo(() => {
    const porVendedor = new Map<string, { nome: string; linhas: LinhaComissao[] }>();
    for (const linha of props.linhas) {
      const nome = linha.vendedor || 'Vendedor não informado';
      const grupo = porVendedor.get(linha.vendedorChave) ?? { nome, linhas: [] };
      grupo.linhas.push(linha);
      porVendedor.set(linha.vendedorChave, grupo);
    }
    return [...porVendedor.entries()].sort(([, a], [, b]) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }, [props.linhas]);

  if (!grupos.length) {
    return <p className="rounded-lg border p-8 text-center text-muted-foreground">Nenhuma venda encontrada para estes filtros.</p>;
  }

  return <div className="space-y-3">
    <p className="text-sm text-muted-foreground">Abra um vendedor para conferir as vendas e suas comissões. Os valores abaixo respeitam os filtros do período.</p>
    {grupos.map(([chave, { nome, linhas }]) => <CardVendedor key={chave} {...props} nome={nome} linhas={linhas} />)}
  </div>;
}

function CardVendedor({ nome, linhas, onConferir, onAlterarSituacao, isAdmin }: PainelComissoesVendedorProps & { nome: string }) {
  const [aberto, setAberto] = useState(false);
  const [selecao, setSelecao] = useState<{ escopo: string; ids: string[] }>({ escopo: '', ids: [] });
  const id = useId();
  // A seleção pertence exatamente às linhas e situações exibidas neste card.
  const escopo = linhas.map(linha => `${linha.venda.id}:${linha.retirada}`).sort().join('|');
  useEffect(() => setSelecao({ escopo, ids: [] }), [escopo]);
  const selecionadas = selecao.escopo === escopo ? selecao.ids : [];
  const escolhidas = linhas.filter(linha => selecionadas.includes(String(linha.venda.id)));
  const paraRetirar = escolhidas.filter(linha => !linha.retirada);
  const paraReincluir = escolhidas.filter(linha => linha.retirada);
  const excedeLimite = paraRetirar.length > 200 || paraReincluir.length > 200;
  const todasSelecionadas = linhas.length > 0 && escolhidas.length === linhas.length;
  const total = (ler: (linha: LinhaComissao) => number) => centavos(linhas.reduce((soma, linha) => soma + ler(linha), 0));
  const saldoAConferir = total(linha => Math.max(0, -linha.saldo));
  const retiradas = linhas.filter(linha => linha.retirada).length;
  const custos = linhas.map(resumirCustosComissao);
  const fretesPendentes = custos.filter(c => c.fretePendente).length;
  const custosIncompletos = linhas.some(l => !l.custosValidos);
  const totalCustos = centavos(custos.reduce((s, c) => s + c.totalCustosAntesComissao, 0));
  const totalFrete = centavos(custos.reduce((s, c) => s + c.custoFrete, 0));
  const lucroFinal = centavos(custos.reduce((s, c) => s + c.lucroFinal, 0));
  const indicadores = [
    ['Total vendido', total(linha => linha.a.receitaLiquida)],
    ['Comissão calculada', total(linha => linha.comissaoCalculada)],
    ['Comissão retirada', total(linha => linha.retirada ? linha.comissaoCalculada : 0)],
    ['Comissão devida', total(linha => linha.comissao)],
    ['Paga registrada', total(linha => linha.pago)],
    ['Saldo a pagar', total(linha => Math.max(0, linha.saldo))],
  ] as const;

  const selecionar = (ids: string[]) => setSelecao({ escopo, ids });
  const alterar = (vendas: LinhaComissao[], retirada: boolean) => {
    const ids = vendas.map(linha => String(linha.venda.id));
    if (!ids.length || ids.length > 200) return;
    selecionar([]);
    onAlterarSituacao(ids, retirada);
  };

  return <section className="overflow-hidden rounded-lg border bg-card" aria-labelledby={`${id}-nome`}>
    <button type="button" className="flex w-full items-center gap-3 p-4 text-left hover:bg-muted/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
      aria-expanded={aberto} aria-controls={`${id}-vendas`}
      onClick={() => { setAberto(!aberto); selecionar([]); }}>
      <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary"><UserRound className="h-5 w-5" aria-hidden="true" /></span>
      <span className="min-w-0 flex-1"><span id={`${id}-nome`} className="block break-words font-semibold">{nome}</span>
        <span className="text-xs text-muted-foreground">{linhas.length} venda(s) · {retiradas} comissão(ões) retirada(s)</span>
      </span>
      <span className="hidden text-sm text-muted-foreground sm:inline">{aberto ? 'Ocultar vendas' : 'Ver vendas'}</span>
      {aberto ? <ChevronUp className="h-4 w-4 shrink-0" aria-hidden="true" /> : <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />}
    </button>

    <dl className="grid grid-cols-2 gap-x-4 gap-y-3 px-4 pb-4 md:grid-cols-3 xl:grid-cols-6">
      {indicadores.map(([rotulo, valor]) => <div key={rotulo}>
        <dt className="text-xs text-muted-foreground">{rotulo}</dt>
        <dd className={`mt-1 font-semibold tabular-nums ${rotulo === 'Saldo a pagar' ? 'text-primary' : ''}`}>{formatBRL(valor)}</dd>
      </div>)}
    </dl>
    <dl className="grid grid-cols-2 gap-3 border-t bg-muted/10 px-4 py-3 lg:grid-cols-4" aria-label={`Custos e frete de ${nome}`}>
      <div><dt className="text-xs text-muted-foreground">Custos antes da comissão{custosIncompletos ? ' (parciais)' : ''}</dt><dd className="font-semibold tabular-nums">{formatBRL(totalCustos)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Frete adicional rateado (dentro dos custos)</dt><dd className="font-semibold tabular-nums">{formatBRL(totalFrete)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Lucro após comissão{custosIncompletos || fretesPendentes ? ' (provisório)' : ''}</dt><dd className="font-semibold tabular-nums">{custosIncompletos ? 'Custos pendentes' : formatBRL(lucroFinal)}</dd></div>
      <div><dt className="text-xs text-muted-foreground">Conferência do frete</dt><dd className={fretesPendentes ? 'text-sm text-amber-500' : 'text-sm'}>{fretesPendentes ? `${fretesPendentes} venda(s) com frete a conferir` : 'Rateios registrados'}</dd></div>
    </dl>
    {saldoAConferir > 0 && <p className="mx-4 mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-sm text-amber-600 dark:text-amber-400">
      <b>{formatBRL(saldoAConferir)} em pagamentos acima das comissões devidas.</b> Conferir os registros das vendas; esse valor não foi descontado do saldo a pagar de outras vendas.
    </p>}

    <div id={`${id}-vendas`} hidden={!aberto}>
      {aberto && <>
        {isAdmin && <div className="flex flex-wrap items-center gap-2 border-t bg-muted/20 px-4 py-3">
          <label className="mr-2 flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4 accent-primary" checked={todasSelecionadas}
              aria-label={`Selecionar todas as ${linhas.length} vendas exibidas de ${nome}`}
              ref={elemento => { if (elemento) elemento.indeterminate = escolhidas.length > 0 && !todasSelecionadas; }}
              onChange={evento => selecionar(evento.target.checked ? linhas.map(linha => String(linha.venda.id)) : [])} />
            Selecionar vendas exibidas ({linhas.length})
          </label>
          <span className="text-xs text-muted-foreground" role="status">{escolhidas.length} selecionada(s)</span>
          <Button type="button" variant="outline" size="sm" disabled={!paraRetirar.length || paraRetirar.length > 200}
            onClick={() => alterar(paraRetirar, true)}>Retirar comissões ({paraRetirar.length})</Button>
          <Button type="button" variant="outline" size="sm" disabled={!paraReincluir.length || paraReincluir.length > 200}
            onClick={() => alterar(paraReincluir, false)}>Reincluir comissões ({paraReincluir.length})</Button>
          {escolhidas.length > 0 && <Button type="button" variant="ghost" size="sm" onClick={() => selecionar([])}>Limpar seleção</Button>}
          {excedeLimite && <p role="alert" className="w-full text-sm text-amber-600 dark:text-amber-400">Selecione até 200 comissões para cada ação. A seleção foi mantida; desmarque vendas para liberar a ação que excedeu o limite.</p>}
          <p className="w-full text-xs text-muted-foreground">Até 200 comissões por retirada ou reinclusão. A retirada pede um motivo e mantém a venda e os pagamentos no histórico.</p>
        </div>}

        <div className="hidden grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_auto] gap-4 border-t bg-muted/30 px-4 py-2 text-xs font-medium text-muted-foreground lg:grid" aria-hidden="true">
          <span>Venda / cliente / produtos</span><span>Valor da venda</span><span>Comissão</span><span>Pagamento do cliente</span><span className="w-36">Ações</span>
        </div>

        <ul>
          {linhas.map(linha => {
            const vendaId = String(linha.venda.id);
            return <li key={vendaId} className={`grid gap-3 border-t p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(0,1.6fr)_auto] lg:gap-4 ${linha.retirada ? 'bg-muted/20' : ''}`}>
              <div className="flex items-start gap-2 text-sm">
                {isAdmin && <input type="checkbox" className="mt-1 h-4 w-4 shrink-0 accent-primary" checked={selecionadas.includes(vendaId)}
                  aria-label={`Selecionar venda ${linha.venda.codigo} de ${linha.venda.nome_cliente}`}
                  onChange={evento => selecionar(evento.target.checked ? [...selecionadas, vendaId] : selecionadas.filter(idVenda => idVenda !== vendaId))} />}
                <div className="min-w-0">
                  <a className="font-medium text-primary underline" href={`https://gestaoclick.com/pedidos/vendas/vendas_produtos/visualizar/${encodeURIComponent(linha.venda.gc_id)}`} target="_blank" rel="noreferrer">Venda {linha.venda.codigo}</a>
                  <p className="break-words">{linha.venda.nome_cliente || 'Cliente não informado'}</p>
                  <p className="text-xs text-muted-foreground">{dataBR(linha.venda.data)} · {linha.venda.nome_situacao || 'Situação no GC não informada'}</p>
                  <ul className="mt-1 space-y-1 text-xs text-muted-foreground">{linha.a.linhas.filter(l => l.tipo === 'produto').slice(0, 2).map((l, i) => <li key={i}>{l.quantidade} × {l.nome}</li>)}</ul>
                  {linha.a.linhas.filter(l => l.tipo === 'produto').length > 2 && <p className="text-xs text-muted-foreground">Mais {linha.a.linhas.filter(l => l.tipo === 'produto').length - 2} produto(s) em Conferir</p>}
                </div>
              </div>
              <div className="text-sm">
                <p className="text-xs text-muted-foreground lg:hidden">Valor da venda</p>
                <p className="font-medium tabular-nums">{formatBRL(linha.a.receitaLiquida)}</p>
                <p className="text-xs text-muted-foreground">Base produtos: {formatBRL(linha.base)}</p>
              </div>
              <div className="text-sm">
                <p className="text-xs text-muted-foreground lg:hidden">Comissão</p>
                {linha.retirada && <p className="text-muted-foreground"><span className="sr-only">Comissão calculada antes da retirada: </span><s>{formatBRL(linha.comissaoCalculada)}</s> ({linha.percentual}%)</p>}
                <p className="font-semibold tabular-nums">{formatBRL(linha.comissao)}{!linha.retirada && ` (${linha.percentual}%)`}</p>
                <p className={`text-xs ${linha.retirada || linha.saldo < 0 ? 'text-amber-600 dark:text-amber-400' : 'text-muted-foreground'}`}>{situacaoComissao(linha)}</p>
                <p className="text-xs">Pago: {formatBRL(linha.pago)}</p>
                <p className="text-xs">{linha.saldo < 0 ? 'Pagamento a conferir' : 'Saldo a pagar'}: {formatBRL(linha.saldo < 0 ? -linha.saldo : linha.saldo)}</p>
                {linha.retirada && <p className="mt-1 break-words text-xs"><b>Motivo:</b> {linha.conferencia?.motivo_retirada || 'Motivo não informado'}</p>}
              </div>
              <div className="text-sm">
                <p className="text-xs text-muted-foreground lg:hidden">Pagamento do cliente</p>
                <p className="font-medium">{linha.recebimento}</p>
                <p className="break-words text-xs text-muted-foreground">{linha.formas.join(' / ') || 'Forma de pagamento não informada'}</p>
                {linha.avisos.length > 0 && <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">{linha.avisos.length} aviso(s) para conferir</p>}
              </div>
              <div className="flex flex-wrap gap-2 lg:w-36 lg:flex-col lg:items-stretch">
                <Button type="button" variant="outline" size="sm" aria-label={`Conferir venda ${linha.venda.codigo}`} onClick={() => onConferir(vendaId)}>Conferir</Button>
                {isAdmin && <Button type="button" variant="ghost" size="sm" aria-label={`${linha.retirada ? 'Reincluir' : 'Retirar'} comissão da venda ${linha.venda.codigo}`}
                  onClick={() => alterar([linha], !linha.retirada)}>{linha.retirada ? 'Reincluir comissão' : 'Retirar comissão'}</Button>}
              </div>
              <div className="min-w-0 lg:col-span-5"><ResumoCustosComissao linha={linha} /></div>
            </li>;
          })}
        </ul>
      </>}
    </div>
  </section>;
}
