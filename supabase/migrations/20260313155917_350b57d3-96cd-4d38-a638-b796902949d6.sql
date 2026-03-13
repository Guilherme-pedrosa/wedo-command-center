
CREATE TABLE public.fin_os_retornos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  os_codigo text NOT NULL,
  tecnico_original text NOT NULL,
  tecnico_retorno text NOT NULL,
  valor numeric NOT NULL DEFAULT 0,
  ano integer NOT NULL,
  mes integer NOT NULL,
  created_at timestamptz DEFAULT now(),
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  UNIQUE(os_codigo, ano, mes)
);

ALTER TABLE public.fin_os_retornos ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon read" ON public.fin_os_retornos FOR SELECT TO anon USING (true);
CREATE POLICY "Auth full" ON public.fin_os_retornos FOR ALL TO authenticated USING (true) WITH CHECK (true);
