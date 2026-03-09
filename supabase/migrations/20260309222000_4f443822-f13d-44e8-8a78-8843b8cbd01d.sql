
CREATE TABLE public.fin_metas_tecnicos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  nome_tecnico text NOT NULL UNIQUE,
  meta_faturamento numeric NOT NULL DEFAULT 0,
  ativo boolean NOT NULL DEFAULT true,
  created_at timestamptz DEFAULT now(),
  updated_at timestamptz DEFAULT now()
);

ALTER TABLE public.fin_metas_tecnicos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Allow public read fin_metas_tecnicos" ON public.fin_metas_tecnicos
  FOR SELECT USING (true);

INSERT INTO public.fin_metas_tecnicos (nome_tecnico, meta_faturamento) VALUES
  ('ELTON', 30550),
  ('DANIEL', 21600),
  ('FRED', 45000),
  ('ROMÁRIO', 45000),
  ('IGOR', 21600),
  ('DONIZETE', 21600),
  ('AYRTON', 21600),
  ('DENILSON', 30550),
  ('SINVAL', 21600),
  ('WILTON', 21600);
