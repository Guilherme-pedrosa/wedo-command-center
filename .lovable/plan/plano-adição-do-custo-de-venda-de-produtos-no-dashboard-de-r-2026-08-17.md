# Plano: Adição do Custo de Venda de Produtos no Dashboard de Resultados

O usuário deseja adicionar uma nova linha informativa no dashboard de metas para controlar o custo dos produtos vendidos como "Venda de Produtos" (concretizadas), similar ao que já existe para o "Custo com Peças para Operações". Esse custo deve ser extraído das vendas concretizadas que entraram no faturamento do período.

## Alterações Sugeridas

### Frontend e Lógica de Dados

1.  **Atualizar o Hook `useMetasResultados.ts`**:
    *   Extrair o custo das vendas concretizadas a partir do campo `gc_payload_raw.valor_custo` na query `gc_vendas_metas`.
    *   Adicionar um novo `useMemo` chamado `custoVendasProdutos` para somar esses custos.
    *   Retornar esse novo valor no objeto de retorno do hook.

2.  **Atualizar a Página `MetasOrcamentoPage.tsx`**:
    *   Criar um novo componente `CustoVendasProdutosRow` similar ao `SaidasOsRow` para exibir o custo das vendas de produtos.
    *   Adicionar esse componente na seção de "Custos Variáveis" quando a meta for relacionada a vendas/produtos.

3.  **Atualizar a Página `RelatorioResultados.tsx`**:
    *   Garantir que o relatório público também exiba essa informação caso necessário (embora o foco do usuário pareça ser a tela de gestão interna).

## Detalhes Técnicos

*   **Fonte de Dados**: Tabela `gc_vendas`, campo `gc_payload_raw` (JSON do GestãoClick).
*   **Lógica de Cálculo**: `sum(venda.gc_payload_raw->>'valor_custo')` para todas as vendas com `situacao_id = 7063585` no período selecionado.
*   **Localização na UI**: Logo abaixo ou acima da meta de "Custo com Peças para Operações", para facilitar a comparação.

---

### Arquivos a serem modificados:
- `src/hooks/useMetasResultados.ts`
- `src/pages/financeiro/MetasOrcamentoPage.tsx`
