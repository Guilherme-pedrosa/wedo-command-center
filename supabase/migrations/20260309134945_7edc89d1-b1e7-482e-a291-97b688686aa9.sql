-- Fix PIX records: extract name and CNPJ from description pattern "PIX ... - Cp :CNPJ-NOME"
UPDATE fin_extrato_inter
SET 
  nome_contraparte = regexp_replace(
    payload_raw->>'descricao',
    '^.*[-–]\s*(?:Cp\s*:|CP\s*:)?\s*\d{8,14}\s*[-–]\s*',
    '',
    'i'
  ),
  contrapartida = regexp_replace(
    payload_raw->>'descricao',
    '^.*[-–]\s*(?:Cp\s*:|CP\s*:)?\s*\d{8,14}\s*[-–]\s*',
    '',
    'i'
  ),
  cpf_cnpj = CASE 
    WHEN cpf_cnpj IS NULL OR cpf_cnpj = '' THEN
      (regexp_match(payload_raw->>'descricao', '[-–]\s*(?:Cp\s*:|CP\s*:)?\s*(\d{8,14})\s*[-–]'))[1]
    ELSE cpf_cnpj
  END,
  descricao = payload_raw->>'descricao'
WHERE 
  (nome_contraparte IS NULL OR nome_contraparte IN ('Pix recebido', 'Pix enviado', 'Pix enviado ', 'Pagamento efetuado', 'Boleto de cobrança recebido'))
  AND payload_raw->>'descricao' ~ '[-–]\s*(?:Cp\s*:|CP\s*:)?\s*\d{8,14}\s*[-–]'