ALTER TABLE public.gc_produtos_cache DISABLE TRIGGER trg_repricing_on_cost_change;

UPDATE public.gc_produtos_cache 
SET 
  valor_custo = 0.10,
  valor_venda_padrao = 0.21,
  valores = $$[
    {"tipo_id":"509604","nome_tipo":"Tabela V (Acima de 500km)","valor_custo":"0.00","valor_venda":"0.24","lucro_utilizado":"0.00"},
    {"tipo_id":"509605","nome_tipo":"Tabela B (Consumidor Final, PAG a Vista)","valor_custo":"0.00","valor_venda":"0.20","lucro_utilizado":"0.00"},
    {"tipo_id":"509606","nome_tipo":"TABELA P","valor_custo":"0.00","valor_venda":"0.17","lucro_utilizado":"0.00"},
    {"tipo_id":"509609","nome_tipo":"Tabela A - (Sodexo, GR, CLIENTES A PRAZO)","valor_custo":"0.00","valor_venda":"0.21","lucro_utilizado":"0.00"},
    {"tipo_id":"576894","nome_tipo":"TABELA COMERCIAL ACESSÓRIOS","valor_custo":"0.00","valor_venda":"0.17","lucro_utilizado":"0.00"},
    {"tipo_id":"585751","nome_tipo":"TABELA SAPORE / JBS","valor_custo":"0.00","valor_venda":"0.31","lucro_utilizado":"0.00"},
    {"tipo_id":"590124","nome_tipo":"TABELA RATIONAL A","valor_custo":"0.00","valor_venda":"0.13","lucro_utilizado":"0.00"},
    {"tipo_id":"596109","nome_tipo":"TABELA RATIONAL - GUERRA","valor_custo":"0.00","valor_venda":"0.11","lucro_utilizado":"0.00"},
    {"tipo_id":"596111","nome_tipo":"TABELA RATIONAL B","valor_custo":"0.00","valor_venda":"0.12","lucro_utilizado":"0.00"},
    {"tipo_id":"596115","nome_tipo":"TABELA EQUIPAMENTOS A (EXCETO RATIONAL)","valor_custo":"0.00","valor_venda":"0.14","lucro_utilizado":"0.00"},
    {"tipo_id":"596116","nome_tipo":"TABELA EQUIPAMENTOS B (EXCETO RATIONAL)","valor_custo":"0.00","valor_venda":"0.13","lucro_utilizado":"0.00"},
    {"tipo_id":"596118","nome_tipo":"TABELA EQUIPAMENTOS P (EXCETO RATIONAL)","valor_custo":"0.00","valor_venda":"0.12","lucro_utilizado":"0.00"}
  ]$$::jsonb,
  updated_at = now()
WHERE produto_gc_id = '73325958';

UPDATE public.fin_gc_price_aprovacoes 
SET status = 'rejeitada', 
    decidido_em = now(),
    decisao_observacao = 'Rollback final teste piloto v4'
WHERE gc_produto_id = '73325958' 
  AND status IN ('pendente','aprovada');

UPDATE public.fin_gc_write_jobs 
SET status = 'erro_fatal',
    ultimo_erro = 'Cancelado rollback teste piloto v4',
    finalizado_em = now()
WHERE recurso_id = '73325958' 
  AND status NOT IN ('sucesso','erro_fatal');

ALTER TABLE public.gc_produtos_cache ENABLE TRIGGER trg_repricing_on_cost_change;