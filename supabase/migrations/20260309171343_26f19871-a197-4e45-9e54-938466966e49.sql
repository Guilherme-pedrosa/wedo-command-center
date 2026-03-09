
ALTER TABLE public.os_index
  ADD COLUMN IF NOT EXISTS data_saida DATE,
  ADD COLUMN IF NOT EXISTS valor_total NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS valor_servicos NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS valor_pecas NUMERIC(14,2),
  ADD COLUMN IF NOT EXISTS numero_os TEXT;

CREATE INDEX IF NOT EXISTS idx_os_index_data_saida ON public.os_index (data_saida);
CREATE INDEX IF NOT EXISTS idx_os_index_nome_situacao ON public.os_index (nome_situacao);
CREATE INDEX IF NOT EXISTS idx_os_index_nome_cliente ON public.os_index (nome_cliente);
