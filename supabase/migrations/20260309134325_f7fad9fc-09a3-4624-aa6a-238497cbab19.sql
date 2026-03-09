UPDATE fin_extrato_inter
SET 
  nome_contraparte = regexp_replace(
    payload_raw->>'descricao',
    '^(?:TED|DOC)\s+(?:RECEBIDA|ENVIADA?|RECEBIDO|ENVIADO)\s*[-–]\s*\d+\s+\d+\s+\d+\s+',
    '',
    'i'
  ),
  contrapartida = regexp_replace(
    payload_raw->>'descricao',
    '^(?:TED|DOC)\s+(?:RECEBIDA|ENVIADA?|RECEBIDO|ENVIADO)\s*[-–]\s*\d+\s+\d+\s+\d+\s+',
    '',
    'i'
  ),
  descricao = payload_raw->>'descricao'
WHERE 
  nome_contraparte IN ('Transferência recebida', 'Transferência enviada')
  AND payload_raw->>'descricao' ~ '(?:TED|DOC)\s+(?:RECEBIDA|ENVIADA).*\d+\s+\d+\s+\d+\s+\S'