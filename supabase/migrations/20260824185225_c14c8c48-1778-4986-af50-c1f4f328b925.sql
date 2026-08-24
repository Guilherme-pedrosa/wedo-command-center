-- A origem lida do XML e a correção fiscal decidida pelo usuário são fatos
-- diferentes. Mantê-las na mesma coluna fazia uma nova sincronização/lote
-- sobrescrever a correção manual.
ALTER TABLE public.fin_produto_tributos
  ADD COLUMN IF NOT EXISTS origem_manual text;

ALTER TABLE public.fin_produto_tributos
  DROP CONSTRAINT IF EXISTS fin_produto_tributos_origem_manual_check;

ALTER TABLE public.fin_produto_tributos
  ADD CONSTRAINT fin_produto_tributos_origem_manual_check
  CHECK (origem_manual IS NULL OR btrim(origem_manual) ~ '^[0-8]$');

COMMENT ON COLUMN public.fin_produto_tributos.origem_manual IS
  'Correção explícita da origem fiscal feita no Argus. Quando preenchida, prevalece sobre o código <orig> da NF.';

-- Um job que confirmou o NCM, mas não gravou a origem, não pode aparecer como
-- sucesso integral para outros consumidores da fila.
ALTER TABLE public.fin_gc_write_jobs
  DROP CONSTRAINT IF EXISTS fin_gc_write_jobs_status_check;

ALTER TABLE public.fin_gc_write_jobs
  ADD CONSTRAINT fin_gc_write_jobs_status_check
  CHECK (status IN (
    'pendente',
    'processando',
    'sucesso',
    'sucesso_parcial',
    'erro_retentavel',
    'erro_fatal'
  ));

-- Correção informada pelo usuário para este produto: código 3 no cadastro
-- fiscal do GC. O valor 2 veio do fluxo regressivo NF/cache e não pode vencer.
INSERT INTO public.fin_produto_tributos (
  gc_produto_id,
  nome_produto,
  origem_manual,
  ultima_atualizacao
) VALUES (
  '93413152',
  'EMBALAGEM GOFRADA TRANSP. 28X40CM X 0,16MM CAIXA C/100',
  '3',
  now()
)
ON CONFLICT (gc_produto_id) DO UPDATE
SET origem_manual = EXCLUDED.origem_manual,
    ultima_atualizacao = EXCLUDED.ultima_atualizacao;

UPDATE public.gc_produtos_cache
SET origem = '3',
    updated_at = now()
WHERE produto_gc_id = '93413152';