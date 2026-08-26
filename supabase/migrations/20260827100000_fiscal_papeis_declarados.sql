-- ============================================================================
-- Declarações de papel de fornecedor.
--
-- Estas oito linhas não foram inferidas de dado nenhum: foram AFIRMADAS pelo
-- responsável, e várias contrariam o que a nota fiscal diz. Ficam aqui, no
-- versionamento, porque são a parte da apuração que depende de conhecimento
-- da operação e não pode ser reconstruída a partir dos XMLs.
--
-- Quem auditar precisa conseguir separar as duas coisas: o que o sistema
-- deduziu (origem='inferido') e o que uma pessoa declarou (origem='declarado',
-- com nome e data). Por isso o campo existe e por isso este arquivo existe.
--
-- O caso do Filipe Farias é o mais exposto: as três notas dele descrevem
-- "treinamento da equipe sobre vendas e produtos", e a declaração diz que é
-- prestação de serviço de campo emitida com descrição errada. Enquanto a
-- carta de correção não chegar, o crédito se apoia na declaração, não no
-- documento — e a justificativa registra isso em letras maiúsculas.
-- ============================================================================

ALTER TABLE public.fis_fornecedor_papel DROP CONSTRAINT IF EXISTS fis_fornecedor_papel_papel_check;
ALTER TABLE public.fis_fornecedor_papel ADD CONSTRAINT fis_fornecedor_papel_papel_check
  CHECK (papel IN ('prestador_campo','software_operacional','capacitacao_tecnica',
                   'comercial','nao_operacional','indefinido'));

INSERT INTO public.fis_fornecedor_papel
  (cnpj, nome, papel, credita, justificativa, origem, declarado_por)
VALUES
  ('59944433000148', 'ANGELICA JESSICA MOREIRA SOBRINHO', 'prestador_campo', true,
   'Declarado pelo responsavel: apoio nao e atividade-meio, e voltado a operacao fim (atendimento a cliente).',
   'declarado', 'Guilherme'),
  ('09296295001050', 'AZUL LINHAS AEREAS BRASILEIRAS SA', 'prestador_campo', true,
   'Declarado pelo responsavel: deslocamento de tecnico para atendimento em cliente.',
   'declarado', 'Guilherme'),
  ('60104608000198', 'FILIPE FARIAS DE CARVALHO', 'prestador_campo', true,
   'Declarado pelo responsavel: e prestador de servico de campo. A descricao "Instrucao e treinamento da equipe sobre vendas e produtos" foi erro de emissao do proprio prestador -- as tres notas dele saem com esse texto. Carta de correcao a ser solicitada para descrever o servico efetivamente executado. ATENCAO: enquanto a CC-e nao chegar, o documento contradiz a classificacao e o credito se apoia na declaracao, nao na nota.',
   'declarado', 'Guilherme'),
  ('15803343000152', 'HOTEL CITY CALIFORNIA RIOS LTDA', 'prestador_campo', true,
   'Declarado pelo responsavel: hospedagem de tecnico em deslocamento para atendimento em cliente. Insumo por essencialidade.',
   'declarado', 'Guilherme'),
  ('57907969000188', 'MARIA EDUARDA SOARES GODOI', 'prestador_campo', true,
   'Presta servico em cliente (ex.: "servico minerva - mao de obra extra"). A NFS-e inteira e insumo; linhas de "almoco" e "mensal" sao a forma como o MEI discrimina o proprio preco.',
   'declarado', 'Guilherme'),
  ('57907996000188', 'MARIA EDUARDA SOARES GODOI', 'prestador_campo', true,
   'Presta servico em cliente. A NFS-e inteira e insumo; linhas de "almoco" e "mensal" sao a forma como o MEI discrimina o proprio preco.',
   'declarado', 'Guilherme'),
  ('57907796000188', 'MARIA EDUARDA SOARES GODOI', 'prestador_campo', true,
   'Presta servico em cliente. A NFS-e inteira e insumo; linhas de "almoco" e "mensal" sao a forma como o MEI discrimina o proprio preco.',
   'declarado', 'Guilherme'),
  ('64307323000114', 'PEDRO HENRIQUE PEREIRA RODRIGUES', 'prestador_campo', true,
   'Tecnico de campo; a linha de alimentacao e a forma como o MEI discrimina o proprio preco.',
   'declarado', 'Guilherme'),

  -- Fora da base de credito, por natureza da operacao
  ('47543331000131', 'TATIANE SOUZA DE BASTOS', 'nao_operacional', false,
   'Propaganda e publicidade, e linha descrita como "referente a salario". Nenhum dos dois e insumo. A linha de salario e assunto trabalhista, nao fiscal -- carta de correcao nao resolveria.',
   'inferido', NULL),
  ('05906360000164', 'Solucoes Loyal Medicina do Trabalho Ltda', 'nao_operacional', false,
   'Medicina do trabalho: obrigacao trabalhista, nao insumo.',
   'inferido', NULL),
  ('03506307000157', 'TICKET SOLUCOES HDFGT S.A.', 'nao_operacional', false,
   'Reembolso/ressarcimento por conta e ordem nao e aquisicao de bem ou servico. O credito do combustivel vem da NF-e do posto, nao desta fatura -- creditar as duas seria duplicidade.',
   'inferido', NULL),
  ('10426136000111', 'Auvo Tecnologia S.A.', 'software_operacional', true,
   'Sistema que operacionaliza a execucao dos servicos em campo. Insumo por relevancia (REsp 1.221.170/PR).',
   'inferido', NULL)
ON CONFLICT (cnpj) DO UPDATE SET
  papel         = EXCLUDED.papel,
  credita       = EXCLUDED.credita,
  justificativa = EXCLUDED.justificativa,
  origem        = EXCLUDED.origem,
  declarado_por = EXCLUDED.declarado_por,
  declarado_em  = now();
