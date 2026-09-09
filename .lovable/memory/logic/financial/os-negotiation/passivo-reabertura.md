---
name: Passivo Reaberto Volta à Lista
description: scan-passivos devolve passivo a utilizado=false quando a parcela volta a estar aberta no GC
type: feature
---
Em `scan-passivos`, cada passivo encontrado carrega `aberto` (não liquidado e não cancelado no GC). Se já existe linha em `fin_residuos_negociacao` com `utilizado=true` mas a parcela está aberta no GC (ex.: parcela "NEG114 - Parcela - OS X ex-Neg.60" reaberta em nova negociação), o scan faz `utilizado=false` e atualiza `valor_residual` com o valor atual do GC. Também sincroniza `valor_residual` quando o valor mudou. Contador `reabertos` no retorno.

Caso de referência: ENTTRES COCINA DE MEZCLA — 14 parcelas ex-Neg.60 pendentes venc. 30/09/2026 estavam presas como `utilizado=true` da NEG60; após a correção, 17 passivos disponíveis somando R$ 10.939,42.
