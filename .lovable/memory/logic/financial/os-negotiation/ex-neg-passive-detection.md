---
name: Detecção de passivo "ex-Neg"
description: scan-passivos reconhece parcelas remanescentes de negociações antigas ("... ex-Neg.36") como passivos, só se ainda abertas
type: logic
---
Parcelas do GC cuja descrição contém `ex-Neg.<numero>` (ex.: "NEG103 - Parcela - OS 8728 ex-Neg.36") são passivos de negociações anteriores e devem ser importadas em `fin_residuos_negociacao` mesmo sem a palavra "PASSIVO".

Regra adicional: para esse padrão, importar apenas se o recebimento estiver **aberto** (não liquidado/recebido e não cancelado), diferente dos passivos tageados com "PASSIVO", que permanecem mesmo liquidados.
