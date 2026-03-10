
-- Cartões de crédito
CREATE TABLE public.fin_cartoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome text NOT NULL,
  bandeira text NOT NULL DEFAULT 'VISA',
  ultimos_digitos text,
  banco text,
  dia_fechamento integer DEFAULT 5,
  dia_vencimento integer DEFAULT 15,
  ativo boolean DEFAULT true,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.fin_cartoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_cartoes FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.fin_cartoes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Faturas de cartão
CREATE TABLE public.fin_fatura_cartao (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cartao_id uuid NOT NULL REFERENCES public.fin_cartoes(id) ON DELETE CASCADE,
  mes_referencia text NOT NULL,
  data_fechamento date,
  data_vencimento date,
  valor_total numeric NOT NULL DEFAULT 0,
  valor_conciliado numeric NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'aberta',
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.fin_fatura_cartao ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_fatura_cartao FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.fin_fatura_cartao FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Transações da fatura
CREATE TABLE public.fin_fatura_transacoes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fatura_id uuid NOT NULL REFERENCES public.fin_fatura_cartao(id) ON DELETE CASCADE,
  data_transacao date NOT NULL,
  descricao text NOT NULL,
  valor numeric NOT NULL,
  categoria text,
  conciliado boolean DEFAULT false,
  lancamento_id uuid,
  reconciliation_rule text,
  conciliado_em timestamptz,
  created_at timestamptz DEFAULT now()
);

ALTER TABLE public.fin_fatura_transacoes ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_fatura_transacoes FOR ALL TO public USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.fin_fatura_transacoes FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- Add cartao_id to fin_pagamentos if not exists
ALTER TABLE public.fin_pagamentos ADD COLUMN IF NOT EXISTS cartao_id uuid REFERENCES public.fin_cartoes(id);
