# Gestão das comissões por vendedor — 14/09/2026

Referência examinada no código real do Sync GC: `auvo-gc-sync`, `origin/main` 221d2976, Premiação. O Sync GC usa cards por técnico e deméritos percentuais por mês. O usuário definiu expressamente outra regra para o Command Center: retirar a comissão de vendas selecionadas, com motivo.

## Comportamento

- Visualização padrão por vendedor, agrupada por ID do GC quando disponível, com expansão para vendas e clientes, total vendido, comissão calculada, retirada, devida, pagamentos e saldo. A visão por venda continua disponível.
- Retirada/reinclusão individual ou de até 200 vendas por operação; exige motivo nos dois sentidos. Venda e pagamentos permanecem visíveis. Reinclusão recalcula pelas regras atuais, sem reaproveitar uma conferência antiga.
- Situação persistida separadamente dos ajustes. RPC administrativa e histórico de autor, data, motivo e snapshot. Upsert comum não consegue adulterar situação; histórico não admite edição/exclusão pela aplicação.
- Pagamentos anteriores preservados. Valores pagos acima da comissão devida aparecem separados, sem compensação automática entre vendas. Novo registro de pagamento é bloqueado no banco quando a venda está retirada; a mudança de situação e inserção de pagamento compartilham bloqueio transacional.
- Alteração da situação atualiza as consultas locais sem repetir a leitura de todo o GC. Se gravação concluir e a leitura falhar, a tela informa que já registrou e repete só a leitura.
- Excel contém os valores calculado/retirado/devido e motivo, além de aba Por vendedor. Valores negativos, números, datas e identificadores continuam preservados.

## Verificação

- Typecheck real: `npx tsc --noEmit -p tsconfig.app.json` aprovado.
- `npm run build` aprovado; somente alteração incidental do banner MCP restaurada.
- Suíte completa: 311 testes aprovados, 5 existentes ignorados. Inclui cálculos, seleção, homônimos, lote, Excel reaberto, falha parcial de leitura e PostgreSQL/PGlite com RLS, atomicidade, idempotência, preservação de ajustes/pagamentos e bloqueio compartilhado. PGlite não simula duas conexões simultâneas.
- Prévia local com cópia de registros: retirada de duas vendas altera comissão de Eduarda de 187,20 para 166,86, registra 20,34 retirados e preserva recebimento do cliente. Reinclusão de uma venda restaura 8,79, total devido175,65; motivos e autoria local aparecem no histórico. Nenhuma retirada de comissão real executada.
- Base de integração: 573d45be, branch conectado `feature/wedo-chatgpt-mcp`.
- Migration20260914210000 aplicada em transação pela ferramenta direta do banco. Nenhuma mensagem para o agente Lovable.
