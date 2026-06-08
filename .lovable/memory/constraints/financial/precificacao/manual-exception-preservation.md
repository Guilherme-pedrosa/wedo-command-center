---
name: Manual Exception Preservation
description: Excecao_manual em fin_produto_tributos é intocável — syncs de NF não deletam nem sobrescrevem
type: constraint
---

Quando o usuário marca "🔕 Ignorar (exceção manual)" na tela de Precificação (`fin_produto_tributos.excecao_manual = true`), nenhum fluxo automático pode mexer naquela linha.

**Aplicado em:**
- `sync-nfe-entrada/index.ts`: DELETE preserva `excecao_manual=true`; UPSERT pula via `excecoes` Set.
- `sync-nfe-entrada-offline/index.ts`: idem.

**Why:** o usuário define manualmente o `excecao_custo_unitario` (ex: cadastro 1L mas compra é caixa 10L). Sobrescrever via NF quebra o cálculo de preço e silencia o trabalho dele.

**How to apply:** qualquer novo fluxo que faça DELETE/UPSERT em `fin_produto_tributos` precisa filtrar `excecao_manual != true`.
