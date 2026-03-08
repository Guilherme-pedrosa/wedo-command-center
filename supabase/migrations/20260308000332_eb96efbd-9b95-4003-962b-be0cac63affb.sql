
UPDATE fin_extrato_inter
SET
  contrapartida = CASE 
    WHEN tipo = 'DEBITO' THEN COALESCE(payload_raw->'detalhes'->>'nomeRecebedor', contrapartida)
    ELSE COALESCE(payload_raw->'detalhes'->>'nomePagador', contrapartida)
  END,
  cpf_cnpj = CASE 
    WHEN tipo = 'DEBITO' THEN COALESCE(
      regexp_replace(payload_raw->'detalhes'->>'cpfCnpjRecebedor', '\D', '', 'g'),
      cpf_cnpj
    )
    ELSE COALESCE(
      regexp_replace(payload_raw->'detalhes'->>'cpfCnpjPagador', '\D', '', 'g'),
      cpf_cnpj
    )
  END,
  chave_pix = COALESCE(
    payload_raw->'detalhes'->>'chavePixRecebedor',
    payload_raw->'detalhes'->>'chavePixPagador',
    chave_pix
  )
WHERE payload_raw IS NOT NULL
  AND (contrapartida IS NULL OR cpf_cnpj IS NULL OR chave_pix IS NULL)
