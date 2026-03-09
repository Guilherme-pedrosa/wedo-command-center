
CREATE TABLE public.gc_compras (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  gc_id text NOT NULL UNIQUE,
  codigo text,
  nome_fornecedor text,
  fornecedor_id text,
  nome_situacao text,
  situacao_id text,
  data date,
  valor_total numeric,
  valor_produtos numeric,
  valor_frete numeric,
  desconto numeric DEFAULT 0,
  observacao text,
  gc_payload_raw jsonb,
  last_synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.gc_compras ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.gc_compras FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.gc_compras FOR ALL TO authenticated USING (true) WITH CHECK (true);
