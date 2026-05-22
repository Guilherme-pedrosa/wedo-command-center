CREATE OR REPLACE FUNCTION public.fn_compras_preencher_cnpj()
RETURNS trigger LANGUAGE plpgsql 
SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NEW.cnpj_fornecedor IS NULL AND NEW.fornecedor_id IS NOT NULL THEN
    SELECT cpf_cnpj INTO NEW.cnpj_fornecedor
    FROM public.fin_fornecedores
    WHERE gc_id = NEW.fornecedor_id
    LIMIT 1;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_compras_preencher_cnpj ON public.gc_compras;
CREATE TRIGGER trg_compras_preencher_cnpj
  BEFORE INSERT OR UPDATE OF fornecedor_id, cnpj_fornecedor ON public.gc_compras
  FOR EACH ROW EXECUTE FUNCTION public.fn_compras_preencher_cnpj();