import { formatBRL, formatPct } from '@/lib/comissoes/analisePickPack';
import type { calcularVenda } from '@/lib/comissoes/calculo';
import { resumirCustosComissao } from '@/lib/comissoes/resumoCustos';

export function ResumoCustosComissao({ linha }: { linha: ReturnType<typeof calcularVenda> }) {
  const resumo = resumirCustosComissao(linha);
  const custos = [
    ['Produtos GC', resumo.custoProdutos],
    ...(linha.a.linhas.some(item => item.tipo === 'servico') ? [['Serviços GC', resumo.custoServicos]] : []),
    ['Impostos', resumo.impostos],
    ['Descontos / taxas do financeiro', resumo.taxasRecebimento],
    ['Demais despesas', resumo.demaisDespesas],
    ['Frete adicional atribuído', resumo.custoFrete],
    ...(resumo.ajusteArredondamento ? [['Arredondamento', resumo.ajusteArredondamento]] : []),
  ] as [string, number][];

  return <div className="grid gap-3 rounded-md border bg-background/30 p-3 text-xs lg:grid-cols-3" aria-label={`Custos e frete da venda ${linha.venda.codigo}`}>
    <section className="min-w-0">
      <h4 className="mb-2 font-semibold">Custos da venda</h4>
      <dl className="space-y-1">
        {custos.map(([rotulo, valor]) => <div key={rotulo} className="flex justify-between gap-3">
          <dt className="text-muted-foreground" title={rotulo === 'Demais despesas' ? 'Deslocamento adicional, despesas operacionais, custo fixo, garantia e ajustes manuais.' : undefined}>{rotulo}</dt>
          <dd className="shrink-0 tabular-nums">{formatBRL(valor)}</dd>
        </div>)}
        <div className="flex justify-between gap-3 border-t pt-1 font-semibold"><dt>Total antes da comissão</dt><dd className="shrink-0 tabular-nums">{formatBRL(resumo.totalCustosAntesComissao)}</dd></div>
      </dl>
      {!linha.custosValidos && <p className="mt-1 text-amber-600 dark:text-amber-400">Custo incompleto ou inválido — conferir os itens.</p>}
    </section>
    <section className="min-w-0 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
      <h4 className="mb-2 font-semibold">Frete</h4>
      <dl className="space-y-1">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Cobrado do cliente (receita)</dt><dd className="shrink-0 tabular-nums">{formatBRL(resumo.receitaFrete)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Custo adicional atribuído</dt><dd className="shrink-0 font-medium tabular-nums">{formatBRL(resumo.custoFrete)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Já incluído no custo dos itens</dt><dd className="shrink-0 tabular-nums">{formatBRL(resumo.freteIncluidoNoCusto)}</dd></div>
      </dl>
      <p className={`mt-2 font-medium ${resumo.fretePendente ? 'text-amber-600 dark:text-amber-400' : ''}`}>{resumo.situacaoFrete}</p>
      {resumo.avisosFrete.length > 0 && <p className="mt-1 text-amber-600 dark:text-amber-400">{resumo.avisosFrete.slice(0, 2).join(' · ')}{resumo.avisosFrete.length > 2 && ` · Mais ${resumo.avisosFrete.length - 2} aviso(s) em Conferir.`}</p>}
      {resumo.fontesAtribuidas.length > 0 && <ul className="mt-2 space-y-2">
        {resumo.fontesAtribuidas.slice(0, 2).map(fonte => <li key={fonte.fonteId} className="break-words">
          <p><b>{fonte.rotulo}</b>{fonte.fonte?.compraCodigo && ` · ${fonte.fonte.fornecedor}`} · {formatBRL(fonte.valor)} {fonte.incluidoNoCusto ? 'já incluídos no custo dos itens' : 'atribuídos à venda'}</p>
          <p className="text-muted-foreground">{fonte.situacaoPagamento}{fonte.pagoNaFonte !== null && `: ${formatBRL(fonte.pagoNaFonte)} de ${formatBRL(fonte.valorTotalFonte!)}`}.</p>
        </li>)}
      </ul>}
      {resumo.fontesAtribuidas.length > 2 && <p className="mt-1 text-muted-foreground">Mais {resumo.fontesAtribuidas.length - 2} fonte(s) atribuída(s) em Conferir.</p>}
      {resumo.fontesAtribuidas.some(fonte => fonte.pagoNaFonte !== null) && <p className="mt-1 text-muted-foreground">A baixa é do total da fonte de frete; ela pode atender outras vendas.</p>}
      {resumo.fontesCandidatas.length > 0 && <div className="mt-2 border-t pt-2">
        <p className="font-medium">Possíveis fretes — confirmar em Conferir</p>
        <p className="mt-1 break-words text-muted-foreground">{resumo.fontesCandidatas.slice(0, 2).map(fonte => `${fonte.compraCodigo ? `Pedido ${fonte.compraCodigo} · ${fonte.fornecedor}` : fonte.fornecedor || fonte.id}: ${formatBRL(fonte.valor)} (${fonte.pagamentos.length ? 'baixado na fonte: '+formatBRL(fonte.pago) : 'baixa não localizada'})`).join(' · ')}{resumo.fontesCandidatas.length > 2 && ` · mais ${resumo.fontesCandidatas.length - 2} fonte(s)`}</p>
        <p className="text-muted-foreground">Ainda não adicionados aos custos desta venda.</p>
      </div>}
    </section>
    <section className="min-w-0 border-t pt-3 lg:border-l lg:border-t-0 lg:pl-3 lg:pt-0">
      <h4 className="mb-2 font-semibold">Resultado da venda</h4>
      <dl className="space-y-2">
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Lucro antes da comissão</dt><dd className="shrink-0 font-semibold tabular-nums">{linha.custosValidos ? formatBRL(resumo.lucroAntes) : 'Custos pendentes'}</dd></div>
        <div className={`flex justify-between gap-3 ${resumo.margemAntes === null || resumo.margemAntes < 12 ? 'text-amber-600 dark:text-amber-400' : ''}`}><dt>Margem antes da comissão</dt><dd className="shrink-0 font-semibold tabular-nums">{resumo.margemAntes === null ? 'A conferir' : formatPct(resumo.margemAntes, 2)}</dd></div>
        <div className="flex justify-between gap-3 border-t pt-2"><dt className="text-muted-foreground">Comissão devida</dt><dd className="shrink-0 tabular-nums">{formatBRL(linha.comissao)}</dd></div>
        <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Lucro após a comissão</dt><dd className="shrink-0 font-semibold tabular-nums">{linha.custosValidos ? formatBRL(resumo.lucroFinal) : 'Custos pendentes'}</dd></div>
        <div className={`flex justify-between gap-3 ${resumo.margemFinal === null || resumo.margemFinal < 12 ? 'text-amber-600 dark:text-amber-400' : ''}`}><dt>Margem após a comissão</dt><dd className="shrink-0 font-semibold tabular-nums">{resumo.margemFinal === null ? 'A conferir' : formatPct(resumo.margemFinal, 2)}</dd></div>
      </dl>
      {resumo.fretePendente && <p className="mt-3 text-amber-600 dark:text-amber-400">Resultado sujeito à conferência do frete.</p>}
    </section>
  </div>;
}
