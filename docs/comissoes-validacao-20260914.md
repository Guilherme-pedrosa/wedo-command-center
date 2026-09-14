# Comissões de vendedores — validação local em 14/09/2026

Base: `348a3a078e3ad5905989eea3e1d84c908d251436`, branch `codex/comissoes-vendedores-20260914`.

## Implementação

- Rota `/financeiro/comissoes` e entrada no menu Financeiro.
- Faixas: acima de 20% = 5%; de 12% até 20% = 3%; abaixo de 12% = zero com aviso. Base de comissão: produtos após descontos, excluindo serviços/frete. Margem considera custos da venda. O padrão usa margem antes da própria comissão, com opção explícita para considerar depois.
- Filtros de período, vendedores, situação da venda no GC e pagamento/conferência. Os três filtros categóricos aceitam múltiplas seleções, combinadas por OU dentro do filtro e E entre filtros.
- Custos dos itens vêm do payload histórico da venda no GC. Preserva brinde com receita zero. Alimentação, administração, prêmio técnico, financiamento e restorno não são ativados automaticamente; dependem de conferência. Impostos de 14% são parâmetro gerencial copiado da configuração existente do Pick & Pack, não cálculo fiscal individual da venda.
- Recebimentos: consulta paginada ao GC por cliente, sem limitar vencimento/liquidação ao período da venda; valida quantidade e identidade. Vínculo por venda_id ou código inequívoco e mesmo cliente. Falhas preservam a última leitura e deixam a atualização pendente.
- Excel nativo `.xlsx`, tabela com filtros, cabeçalho fixo, valores numéricos, datas, moeda, percentuais e total visível. Registra filtros da tela e separa custo do produto de outras despesas.
- Conferências, ajustes, registro de comissões já pagas e auditoria em quatro tabelas novas. Escrita restrita a administradores. Alterar custo invalida a conferência; pagamentos anteriores permanecem registrados. Não transfere dinheiro nem baixa títulos no GC.

## Evidência real

- Consultados 47 registros de vendas de agosto e 38 de setembro no banco do Command Center. A primeira prévia continha apenas setembro; os dois meses foram incluídos. Dados reais da prévia ficam fora do Git.
- Venda 1773530806: conferida em Contas a receber do GC. Seis títulos 601354220, 601354221, 601354224, 601354226, 601354228, 601354229; total 1.788,46, em aberto, vencimentos de 11/10/2026 a 28/02/2027. A tela do GC indica boletos Inter gerados em 11/09/2026. As duas bases locais de recebimentos não continham esses títulos. Na prévia, essa evidência foi incorporada ao conjunto local; não houve escrita no financeiro de produção.
- Venda 1773530801: custo unitário e total do item 6,736, venda 9,21. O cálculo inicial incluía alimentação/administração indevidas e foi corrigido. Novo custo de produto exibido 6,74; impostos gerenciais 1,29; custo total antes de comissão 8,03. Caso coberto por teste de regressão.
- CSV enviado pelo usuário tinha casas decimais excessivas e negativos tratados como texto. Substituído por `.xlsx`; teste reabre o arquivo e verifica tipos, negativos, datas, filtros e congelamento. Download real da tela e renderização do Excel foram verificados.

## Verificações e limites

- Suite: 266 testes passaram e 5 testes existentes estão ignorados.
- Typecheck real: `npx tsc --noEmit -p tsconfig.app.json`.
- Build: `npm run build`, incluindo recomposição do MCP. Alteração incidental do banner gerado não faz parte da entrega.
- A tabela de vendas existente é sincronizada pelo fluxo atual do sistema e contém apenas as situações importadas por esse fluxo; esta mudança não amplia silenciosamente o escopo do sincronizador global.
- A consulta nova pelo proxy GC tem testes de paginação/identidade/falha. Sua integração autenticada em produção e as políticas da nova migration ainda dependem da instalação autorizada e da verificação após publicação. A prévia usa dados consultados, não executa esse proxy ao vivo.
- Não se executaram transferências, baixas, emissão de boleto ou pagamentos fictícios como teste.

## Instalação pendente

A migration `20260914160000_comissoes_vendedores.sql` não foi aplicada. A revisão automática de aprovação rejeitou a criação de tabelas, RLS, permissões, triggers e funções em produção por exigir autorização explícita. A consulta posterior confirmou ausência da tabela de configuração.

Antes de publicar: obter autorização para essa migration e publicação; conferir novamente SHA/base; instalar e validar tabelas/políticas/RPC; integrar o código e publicar pelas ferramentas diretas. Nenhuma mensagem deve ser enviada ao agente do Lovable.
