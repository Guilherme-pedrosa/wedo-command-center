---
name: Margem usa custo conservador (max GC vs NF)
description: Margem exibida e filtros de fora/acima usam max(custo NF+frete+IPI, valor_custo GC) para evitar inflar margem quando NF está abaixo do custo atual cadastrado no GC
type: feature
---
Em PrecificacaoPage.tsx, após calcular `calc.custoTotal` (via calcPricingWithNF ou calcPricing), sobrescreve para `Math.max(calc.custoTotal, parseFloat(p.valor_custo) || 0)` quando não é exceção manual.

Aplicado em 4 blocos: outOfMarginByProduct, aboveMarginByProduct, export rows e linha da tabela. Exceções manuais (`excecao_manual=true`) seguem intocadas.

Custo fixo continua embutido via `custoFixoPctEfetivo` no divisor do markup.
