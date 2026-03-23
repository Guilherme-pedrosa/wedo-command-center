
CREATE TABLE public.fin_residuos_negociacao (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cliente_gc_id TEXT NOT NULL,
  nome_cliente TEXT NOT NULL,
  valor_residual NUMERIC NOT NULL,
  negociacao_origem_numero INTEGER,
  observacao TEXT,
  utilizado BOOLEAN DEFAULT false,
  utilizado_em TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by UUID
);

ALTER TABLE public.fin_residuos_negociacao ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated users can manage residuos"
ON public.fin_residuos_negociacao
FOR ALL
TO authenticated
USING (true)
WITH CHECK (true);
