
CREATE TABLE public.fin_nfe_xml_index (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  chave text NOT NULL UNIQUE,
  cnpj_emitente text,
  nome_emitente text,
  data_emissao date,
  valor_total numeric,
  valor_produtos numeric,
  qtd_itens integer DEFAULT 0,
  storage_path text NOT NULL,
  parsed_at timestamp with time zone DEFAULT now()
);

CREATE INDEX idx_nfe_xml_cnpj ON public.fin_nfe_xml_index(cnpj_emitente);
CREATE INDEX idx_nfe_xml_data ON public.fin_nfe_xml_index(data_emissao);

ALTER TABLE public.fin_nfe_xml_index ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Anon access" ON public.fin_nfe_xml_index FOR ALL TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Authenticated access" ON public.fin_nfe_xml_index FOR ALL TO authenticated USING (true) WITH CHECK (true);
