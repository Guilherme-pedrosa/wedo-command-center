CREATE TABLE public.gc_vendas (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  gc_id text NOT NULL,
  codigo text,
  tipo text DEFAULT 'produto',
  nome_cliente text,
  cliente_id text,
  nome_situacao text,
  situacao_id text,
  data date,
  valor_total numeric,
  valor_produtos numeric,
  valor_servicos numeric,
  desconto numeric DEFAULT 0,
  observacao text,
  gc_payload_raw jsonb,
  last_synced_at timestamptz DEFAULT now(),
  created_at timestamptz DEFAULT now(),
  UNIQUE(gc_id)
);

ALTER TABLE public.gc_vendas ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.gc_vendas FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.gc_vendas FOR ALL TO authenticated USING (true) WITH CHECK (true);