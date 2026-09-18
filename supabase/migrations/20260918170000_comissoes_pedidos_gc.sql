-- Pedidos de compra gerados no Gestão Click para pagar comissões.
--
-- Um pedido por vendedor e período. A linha nasce "pendente" junto com um
-- job em fin_gc_write_jobs (recurso = 'compras'); o processador faz o POST
-- e grava aqui o id e o código que o GC devolveu. A unicidade por
-- (vendedor, período) impede dois pedidos para a mesma quinzena; a lista de
-- vendas fica em jsonb para o próximo pedido saber o que já foi pedido.
CREATE TABLE IF NOT EXISTS public.fin_comissoes_pedidos_gc (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vendedor_chave text NOT NULL,
  vendedor_nome text NOT NULL,
  fornecedor_gc_id text NOT NULL,
  periodo_inicio date NOT NULL,
  periodo_fim date NOT NULL,
  valor_total numeric(14,2) NOT NULL CHECK (valor_total > 0),
  vendas jsonb NOT NULL DEFAULT '[]',
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','erro','cancelado')),
  job_id uuid REFERENCES public.fin_gc_write_jobs(id),
  gc_compra_id text,
  gc_codigo text,
  erro text,
  created_by uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (periodo_inicio <= periodo_fim),
  UNIQUE (vendedor_chave, periodo_inicio, periodo_fim)
);

CREATE INDEX IF NOT EXISTS idx_fin_comissoes_pedidos_gc_status ON public.fin_comissoes_pedidos_gc(status, created_at);

DROP TRIGGER IF EXISTS trg_fin_comissoes_pedidos_gc_updated_at ON public.fin_comissoes_pedidos_gc;
CREATE TRIGGER trg_fin_comissoes_pedidos_gc_updated_at
  BEFORE UPDATE ON public.fin_comissoes_pedidos_gc
  FOR EACH ROW EXECUTE FUNCTION public.update_updated_at_column();

ALTER TABLE public.fin_comissoes_pedidos_gc ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "comissoes_pedidos_gc_leitura" ON public.fin_comissoes_pedidos_gc;
CREATE POLICY "comissoes_pedidos_gc_leitura" ON public.fin_comissoes_pedidos_gc
  FOR SELECT TO authenticated USING (true);

-- Só admin cria; o mesmo critério das demais ações de comissão.
DROP POLICY IF EXISTS "comissoes_pedidos_gc_admin" ON public.fin_comissoes_pedidos_gc;
CREATE POLICY "comissoes_pedidos_gc_admin" ON public.fin_comissoes_pedidos_gc
  FOR ALL TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

-- O processador de jobs (service role) precisa gravar o retorno do GC; a
-- policy acima é para usuários. Service role ignora RLS.
