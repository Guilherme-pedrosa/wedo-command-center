---
name: Reconciliation Max Gap 5d
description: Hard cap of 5 days between bank extract and GC entry; blocks matches/suggestions in all rules
type: feature
---
Regra global do Sync GC (reconciliation-engine): `MAX_GAP_DIAS = 5`. A função `dentroJanelaMaxima` pré-filtra `candidatosRaw` para descartar qualquer lançamento GC cuja `data_vencimento`/`data_liquidacao` esteja a mais de 5 dias da data do extrato. Isso cascatea em TODAS as regras (R0..R6 e n:n aproximado), inclusive Sapore/Sodexo — janelas maiores declaradas nas regras (30/90 dias) ficam efetivamente limitadas a 5 dias. Objetivo: só conciliar quando extrato e GC estão no mesmo dia ou até ±5 dias.
