# Comissões de vendedores — validação em 14/09/2026

Base: `348a3a078e3ad5905989eea3e1d84c908d251436`, branch `codex/comissoes-vendedores-20260914`.

## Implementação

- Rota `/financeiro/comissoes` e entrada no menu Financeiro.
- Faixas: acima de 20% = 5%; de 12% até 20% = 3%; abaixo de 12% = zero com aviso. Base de comissão: produtos após descontos, excluindo serviços/frete. Margem considera custos da venda. O padrão usa margem antes da própria comissão, com opção explícita para considerar depois.
- Filtros de período, vendedores, situação da venda no GC e pagamento/conferência. Os três filtros categóricos aceitam múltiplas seleções, combinadas por OU dentro do filtro e E entre filtros.
- Custos dos itens vêm do payload histórico da venda no GC. Preserva brinde com receita zero. Alimentação, administração, prêmio técnico, financiamento e restorno não são ativados automaticamente; dependem de conferência. Impostos de 14% são parâmetro gerencial copiado da configuração existente do Pick & Pack, não cálculo fiscal individual da venda.
- Recebimentos: consulta paginada ao GC por cliente, sem limitar vencimento/liquidação ao período da venda; valida quantidade e identidade. Vínculo por venda_id ou código globalmente único, inclusive cobrança em outra unidade. Ausência por cliente dispara consulta global para localizar títulos novos fora do cache. Falhas preservam a última leitura e deixam a atualização pendente.
- Excel nativo `.xlsx`, tabela com filtros, cabeçalho fixo, valores numéricos, datas, moeda, percentuais e total visível. Registra filtros da tela e separa custo do produto de outras despesas.
- Conferências, ajustes, registro de comissões já pagas e auditoria em quatro tabelas novas. Escrita restrita a administradores. Alterar custo invalida a conferência; pagamentos anteriores permanecem registrados. Não transfere dinheiro nem baixa títulos no GC.

## Evidência real

- Consultados 47 registros de vendas de agosto e 38 de setembro no banco do Command Center. A primeira prévia continha apenas setembro; os dois meses foram incluídos. Dados reais da prévia ficam fora do Git.
- Venda 1773530806: conferida em Contas a receber do GC. Seis títulos 601354220, 601354221, 601354224, 601354226, 601354228, 601354229; total 1.788,46, em aberto, vencimentos de 11/10/2026 a 28/02/2027. A tela do GC indica boletos Inter gerados em 11/09/2026. As duas bases locais de recebimentos não continham esses títulos. Na prévia, essa evidência foi incorporada ao conjunto local; não houve escrita no financeiro de produção.
- Venda 1773530801: custo unitário e total do item 6,736, venda 9,21. O cálculo inicial incluía alimentação/administração indevidas e foi corrigido. Novo custo de produto exibido 6,74; impostos gerenciais 1,29; custo total antes de comissão 8,03. Caso coberto por teste de regressão.
- CSV enviado pelo usuário tinha casas decimais excessivas e negativos tratados como texto. Substituído por `.xlsx`; teste reabre o arquivo e verifica tipos, negativos, datas, filtros e congelamento. Download real da tela e renderização do Excel foram verificados.

## Correções financeiras e fretes verificadas

- Venda 1773530751: títulos 594076497/595611090, 4.660 cada, em outros clientes (CAOA 51/50), rejeitados pelo filtro anterior. O primeiro título foi confirmado pela tela do GC, inclusive boleto e vencimento em 13/11. A prévia agora exibe dois títulos em aberto e identifica os destinatários divergentes.
- Vendas 1773530754/1773530740: descontos explícitos de 182,73/23,55. A quitação compara o valor bruto dos títulos, e o caixa apresenta 3.207,58/724,35. Descontos entram no custo, sem serem classificados automaticamente como taxa da operadora. Casos verificados na prévia.
- Pedido 4684: campo frete zerado, parcela de frete 756,86. Título antigo 594191926 não abre mais no GC; o atual 599081401, confirmado na tela do GC, foi baixado em 01/09. A consulta ao vivo de pagamentos substitui o conjunto antigo somente depois de validar todas as páginas.
- Pagamento 593553631 descreve frete de 300 para venda 1773530725. Pedidos 4672/4692 possuem referência a vários pedidos; não há rateio automático por nome ou produto. Divergências entre financeiro e pedido ficam visíveis.
- Catálogo de fretes identifica cabeçalho, itens, parcelas e títulos, inclui pedidos relacionados e não limita datas ao mês da venda. Rateio por venda com justificativa, saldo disponível e opção de custo já incluído. Trigger valida o valor contra a fonte no banco e impede soma dos rateios acima do total. Alterações invalidam a conferência anterior.
- Validação do PostgreSQL local executa a migração, RPCs, auditoria e rejeições de rateio excessivo/limite adulterado. Não usa produção. Teste reproduzível com PGlite como dependência exclusiva de desenvolvimento.
- Simulação visual: adicionar frete 756,86 à venda da minicâmara reduz o lucro de 6.111,31 para 5.354,45; marcar custo já incluído restaura 6.111,31. A simulação foi descartada, sem salvar atribuição real.

## Verificações e limites

- Suite: 281 testes passaram e 5 testes existentes estão ignorados.
- Typecheck real: `npx tsc --noEmit -p tsconfig.app.json`.
- Build: `npm run build`, incluindo recomposição do MCP. Alteração incidental do banner gerado não faz parte da entrega.
- A tabela de vendas existente é sincronizada pelo fluxo atual do sistema e contém apenas as situações importadas por esse fluxo; esta mudança não amplia silenciosamente o escopo do sincronizador global.
- A consulta nova pelo proxy GC tem testes de paginação/identidade/falha. Integração autenticada validada após publicação do commit 1c994097: períodos explícitos, títulos conhecidos preservados e casos reais descritos abaixo. A prévia local continua separada e não executa o proxy ao vivo.
- Não se executaram transferências, baixas, emissão de boleto ou pagamentos fictícios como teste.

## Instalação em produção — 14/09/2026

- Autorização explícita do usuário para migration, integração GitHub e publicação, sem mensagem ao agente Lovable.
- Migration aplicada em transação pela ferramenta direta do banco. Quatro tabelas com RLS ativo e duas RPCs verificadas.
- RPC de agosto retorna 2 títulos para 1773530751 e 1 título para cada venda 1773530754/1773530740. Fontes de frete: 456 compras e 1.107 pagamentos candidatos do cache.
- Branch conectado confirmado na configuração Git: `feature/wedo-chatgpt-mcp`. Avanço direto de `348a3a07` para `accd9954`, sem force-push ou merge.
- Build remoto de `accd9954` confirmado pelo projeto. Publicação solicitada pela ferramenta direta e a rota pública passou a exigir login, em vez do 404 da versão antiga.
- Validação do proxy GC na tela publicada concluída após o usuário abrir a sessão, conforme evidências abaixo. Nenhuma credencial foi extraída e nenhum pagamento fictício foi registrado.

## Correção do recorte financeiro implícito do GC

- Em 14/09, captura da chamada autenticada `gc-proxy` mostrou que GET `/api/recebimentos` sem datas devolvia somente setembro: 439 títulos. A consulta por cliente 49132537 retornou lista vazia e metadados nulos apesar de o título 587580801 existir, pago em agosto.
- GC consultado pela tela: recebimento 40920, venda 1773530705, 105,63, boleto 90798868124, confirmado pelo Inter em 20/08/2026. A RPC local já continha esse título.
- Causa: a listagem sem parâmetros de período foi tratada como histórico completo e substituiu os vínculos existentes.
- Commit `1c994097`: datas explícitas 2000-01-01 a 2100-12-31 para recebimentos e pagamentos, independentes do filtro de vendas; consulta por ID de qualquer título conhecido omitido pela listagem; falha nessa confirmação preserva a leitura anterior e deixa pendência. Consulta global também expõe progresso das páginas.
- Testes de integração simulada reproduzem o contrato observado do GC e a preservação por ID. 11 testes financeiros, typecheck e build passaram. Validação autenticada da publicação concluída, conforme evidências abaixo.

## Verificação final autenticada — commit 1c994097

- Capturadas as requisições da tela pública: data_inicio=2000-01-01 e data_fim=2100-12-31. Leitura completa de 14.348 pagamentos em 144 páginas, substituindo o antigo recorte de 424 pagamentos em 5 páginas. Recebimentos consultados por cliente e fallback de 44 páginas.
- Julho, venda 1773530705: linha pública mostra Recebido, 105,63, 1 título, Boleto Banco Inter - WD. Drawer identifica #40920, vencimento e baixa em 20/08/2026. Confirmado contra a página real do título 587580801 no GC.
- Setembro, venda 1773530806: 6 títulos em aberto na tela pública.
- Agosto, venda 1773530751: 2 títulos em aberto e aviso de cobrança em cliente diferente; 1773530754: recebido 3.207,58 e despesas 657,38; 1773530740: recebido 724,35 e despesas 128,25.
- Catálogo público de fretes: 529 fontes. Pedido 4684 apresenta 756,86 baixados, um único título atual #42395 / GC 599081401, MANDA LA, data 01/09. O título antigo não foi somado em duplicidade.
- Nenhum título, baixa, transferência, conferência ou pagamento de comissão foi criado como teste. Nenhuma mensagem foi enviada ao agente do Lovable.
