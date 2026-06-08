---
name: Subset-Sum Complement Search
description: SOMA_PARCELAS uses complement search (find items to REMOVE) for consolidated invoices with 8+ parcelas
type: feature
---

`findSubsetSum` em `reconciliation-engine/index.ts` usa duas estratégias:

1. **Busca direta** — pool dos 24 maiores, até 8 itens somando o alvo. Cobre N:1 pequeno.
2. **Busca por complemento iterativa** — para fatura consolidada (cliente paga 10-30 parcelas num crédito só):
   - Encontra K* = menor pool top-K (por valor desc) cuja soma ≥ alvo
   - Procura subset PEQUENO (≤6 itens) que some o **excesso** (a remover)
   - Resultado = top-K menos esse subset
   - Expande K até K*+12 se a remoção não couber em 6 itens

Pool em `tentarSomaParcelas` capado em **60 candidatos** (não 24) para garantir cobertura.

Janela SOMA_PARCELAS: 30 dias normal, **90 dias** para CNPJs em `CNPJ_PRAZO_ESTENDIDO` (Sapore 67945071, Sodexo 49930514, Ecolab 00536772).

Caso de referência: Ecolab credita R$18.594,95 (08/06/26) somando 16 NFs de NF2966 vencidas 08/06/26 — match automático via complement search.
