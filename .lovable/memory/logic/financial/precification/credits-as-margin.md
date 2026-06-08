---
name: Créditos como Margem Extra
description: Precificação usa NF cheia, créditos viram ganho fiscal (não reduzem preço)
type: feature
---

**Regra:** O preço mínimo é calculado sobre **NF cheia** (valorUnit + IPI + frete), **sem subtrair** créditos de ICMS/PIS/COFINS de entrada.

**Por quê:** Blinda a precificação contra troca de fornecedor — se o próximo fornecedor for Simples Nacional (sem créditos), o preço de venda não fica subdimensionado e a margem não desaba.

**Como aparecem os créditos:**
- `margemExtraCreditos = creditoIcms + creditoPis + creditoCofins`
- Somados ao `lucroLiquido` (ganho de caixa adicional)
- Exibidos na UI em verde com sinal "+" e legenda "margem extra" (NÃO "-")

**Onde está implementado:** `calcPricingWithNF` em `src/pages/financeiro/PrecificacaoPage.tsx` (linhas ~299 e ~322).

**Política de uso:** Créditos servem para (a) reforçar margem efetiva, (b) abrir espaço para descontos pontuais — nunca para reduzir o preço de tabela automaticamente.
