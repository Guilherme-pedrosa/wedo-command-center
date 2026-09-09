REVOKE ALL ON FUNCTION public.has_financeiro_write(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.has_financeiro_write(uuid) FROM anon;
GRANT EXECUTE ON FUNCTION public.has_financeiro_write(uuid) TO authenticated, service_role;