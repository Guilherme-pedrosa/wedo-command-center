
CREATE SEQUENCE IF NOT EXISTS public.fin_negociacao_seq START WITH 1 INCREMENT BY 1;

CREATE OR REPLACE FUNCTION public.next_negociacao_number()
RETURNS integer
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT nextval('public.fin_negociacao_seq')::integer;
$$;
