## Objetivo

Eliminar a dependência da API GC `/api/notas_fiscais_produtos` e do paginador `/api/compras` no `sync-nfe-entrada`. Tudo que precisamos já está local:

- `gc_compras` → `numero_nfe`, `cnpj_fornecedor`, `fornecedor_id`, `data` (após enrichment P1+P2)
- `gc_compras_itens` → produtos da compra com `produto_gc_id` (ou legacy `nome_produto`+`valor_custo`)
- `fin_nfe_xml_index` → `chave`, `cnpj_emitente`, `numero_nf` (a extrair), `data_emissao`, `valor_total`
- Bucket `nf-xmls` → XML completo para parsing por item

## Estratégia do matcher (3 níveis, em ordem)

```text
Nível 1 — DETERMINÍSTICO (preferencial)
  match em fin_nfe_xml_index por:
    normalizar_cnpj(cnpj_emitente) = normalizar_cnpj(gc_compras.cnpj_fornecedor)
    AND normalizar_numero_nf(numero_nf_extraido) = normalizar_numero_nf(gc_compras.numero_nfe)
  → 1 candidato → usa direto
  → N candidatos → desempate por menor |valor_total_xml − gc_compras.valor_total| e |data − data_emissao| ≤ 30d

Nível 2 — CNPJ + VALOR (fallback brando, mesma janela)
  só CNPJ bate, sem nº NF confiável → escolhe XML com menor diff de valor (tol 1% ou R$5)
  marca match_rule = "cnpj_valor_frouxo"

Nível 3 — SEM MATCH
  registra em fin_nfe_match_pendentes (nova tabela) com motivo:
    "sem_cnpj_compra" | "cnpj_sem_xml" | "valor_fora_tolerancia" | "multiplo_ambiguo"
  NÃO marca passivos retroativos ainda (combinado).
```

## Pré-requisito: pré-processar `fin_nfe_xml_index` para extrair `numero_nf`

Hoje a tabela tem `chave` (44 dígitos). O número da NF é dígitos 26-34 da chave (posição `nNF`). Adicionar coluna gerada:

```sql
ALTER TABLE fin_nfe_xml_index
  ADD COLUMN numero_nf TEXT
    GENERATED ALWAYS AS (substring(chave from 26 for 9)) STORED;
CREATE INDEX idx_xml_index_cnpj_numero
  ON fin_nfe_xml_index (cnpj_emitente, numero_nf);
```

## Fluxo da edge refatorada

```text
1. Carregar gc_compras com numero_nfe IS NOT NULL (slice por offset/batch_size)
   — sem chamar /api/compras
2. Carregar gc_compras_itens dessas compras em bulk
   — substitui o array compra.produtos da API
3. Carregar fin_nfe_xml_index inteiro (já cabe em RAM, ~3-5k linhas)
   — montar Map<(cnpj+numero), xml> + Map<cnpj, xml[]>
4. Para cada compra:
   a. Tenta Nível 1 (cnpj+numero) → match exato
   b. Senão tenta Nível 2 (cnpj+valor)
   c. Senão registra em fin_nfe_match_pendentes
5. Para cada match → baixar XML do bucket e rodar parseXmlItems + matching
   item-a-item (lógica de impostos atual permanece intacta)
6. Upsert em fin_produto_tributos (preserva manual overrides — lógica existente OK)
7. Item com produto_gc_id IS NULL (legacy) → match item por nome_produto + valor_custo
   com xmlItems do XML; sem gc_produto_id, registra apenas estatística (não grava em
   fin_produto_tributos, que tem PK = gc_produto_id)
```

## Nova tabela `fin_nfe_match_pendentes`

```sql
CREATE TABLE fin_nfe_match_pendentes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  compra_gc_id text NOT NULL,
  numero_nfe text,
  cnpj_fornecedor text,
  nome_fornecedor text,
  valor_compra numeric,
  data_compra date,
  motivo text NOT NULL,
  candidatos jsonb,
  created_at timestamptz DEFAULT now(),
  resolvido boolean DEFAULT false,
  resolvido_em timestamptz,
  UNIQUE (compra_gc_id)
);
ALTER TABLE fin_nfe_match_pendentes ENABLE ROW LEVEL SECURITY;
CREATE POLICY ... (ceo/admin/gerente_financeiro SELECT)
```

## O que NÃO muda nesta etapa

- Toda a lógica de parsing XML por item (`parseXmlItems`, `isXmlSimplesNacional`, rateio).
- Upsert em `fin_produto_tributos` (preservar manuais).
- Contador diário de chamadas GC (vai cair drasticamente, mas mantém o guard).
- NÃO mexer em `gc_compras_itens` para marcar `pendente_revinculacao_pedido` retroativo (combinado: só após matcher validado).

## Sequência de execução proposta

1. **Migration**: gera coluna `numero_nf` em `fin_nfe_xml_index` + índice + tabela `fin_nfe_match_pendentes` + RLS.
2. **Edge refatorada**: novo `sync-nfe-entrada` com matcher determinístico + leitura local.
3. **Smoke run**: chamar a edge com `batch_size=20` em compras com `numero_nfe IS NOT NULL` e devolver:
   - total de compras candidatas
   - nivel_1 (cnpj+numero) / nivel_2 (cnpj+valor) / sem_match
   - amostra de 5 sem_match (compra + motivo + candidatos)
   - tempo total, chamadas GC = 0 (esperado)
4. **PARAR** para validação antes de processar o resto do batch e antes de qualquer cleanup retroativo.

Aguardo aprovação para gerar a migration (passo 1).
