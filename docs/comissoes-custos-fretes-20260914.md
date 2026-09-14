# Custos e fretes na conferência de comissões

Base: `b598b527`, branch sincronizado `feature/wedo-chatgpt-mcp`.

O painel por vendedor exibia a comissão sem detalhar os custos já usados no cálculo. Agora cada venda mostra produtos, serviços, impostos, descontos/taxas do recebimento, outras despesas, frete adicional, lucro e margens. O mesmo resumo aparece na visão por venda, com totais no vendedor. Valores sem origem de frete continuam pendentes: ausência de rateio não comprova custo zero. Frete cobrado do cliente é receita; frete já incluído no custo dos produtos não é descontado novamente.

O Excel mantém as abas anteriores e acrescenta `Custos e fretes`, com valores numéricos, origem atribuída, baixa na fonte, candidatos e pendências. O ajuste de arredondamento reconcilia custos unitários do GC com quatro casas decimais.

Foi reproduzido no banco sincronizado o caso da venda 1773530751: produtos de R$ 6.290,00, impostos de R$ 1.304,80 e frete cobrado de R$ 330,00. O título 41621 (GC 593814263), de transportadora, registra entrega de lixeiras com referência OS 6449; o atributo do orçamento da venda também é 6449. O título registra R$ 230,00 liquidado em 19/08/2026, e cita a compra 4673, ausente no cache. O usuário informou R$ 250,00; a diferença permanece pendente de esclarecimento. Nenhum rateio foi criado por esta migração.

O filtro antigo procurava frete/transporte/carreto apenas na descrição. A migração `20260914230000` e o helper do cliente passam a reconhecer fornecedor transportador combinado com finalidade entrega/coleta/reembolso (inclusive a grafia REEMSOLSO presente no registro). Referência de orçamento é indício, exige o atributo correto e número completo, e não gera alocação automática. Caso o pedido exista, título e pedido formam uma única fonte. O guard mantém justificativa, limite real e trava contra rateio excedente entre vendas.

Validação: typecheck com `tsconfig.app.json`, `npm run build`, testes de cálculo, painel, resumo e Excel; 14 casos de identificação de frete e 17 casos PostgreSQL/PGlite para consulta, permissões, limites e não duplicação. A consulta de produção passou a retornar o título 41621. A simulação local com o registro real e R$ 230,00 de custo resulta em lucro antes da comissão de R$ 1.495,20 (16,04%), preservando a retirada de comissão já registrada pelo usuário. Não foi feita escrita financeira no GC nem alteração de retiradas/pagamentos.

As evidências completas ficam em arquivos privados fora do commit. Não houve uso do navegador do usuário ou mensagem ao agente Lovable. Esta mudança não implementa fechamento mensal congelado nem altera a paginação da consulta ao financeiro.
