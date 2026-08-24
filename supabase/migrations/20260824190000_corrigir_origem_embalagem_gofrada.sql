-- Corrige ambientes que receberam a interpretação equivocada
-- "terceira opção" = código 3. A terceira opção exibida é o código 2:
-- estrangeira, adquirida no mercado interno.
INSERT INTO public.fin_produto_tributos (
  gc_produto_id,
  nome_produto,
  origem_manual,
  ultima_atualizacao
) VALUES (
  '93413152',
  'EMBALAGEM GOFRADA TRANSP. 28X40CM X 0,16MM CAIXA C/100',
  '2',
  now()
)
ON CONFLICT (gc_produto_id) DO UPDATE
SET origem_manual = EXCLUDED.origem_manual,
    ultima_atualizacao = EXCLUDED.ultima_atualizacao;

UPDATE public.gc_produtos_cache
SET origem = '2',
    updated_at = now()
WHERE produto_gc_id = '93413152';
