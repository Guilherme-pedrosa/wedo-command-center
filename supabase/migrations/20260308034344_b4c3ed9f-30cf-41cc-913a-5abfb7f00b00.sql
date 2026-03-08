UPDATE fin_extrato_inter
SET nome_contraparte = TRIM(SUBSTRING(descricao FROM '.* [-–] (.+)$')),
    contrapartida = TRIM(SUBSTRING(descricao FROM '.* [-–] (.+)$'))
WHERE (nome_contraparte IS NULL 
   OR nome_contraparte IN ('Pagamento efetuado', 'Boleto de cobrança recebido', 'Transferência recebida', 'Pix recebido', 'Pix enviado'))
  AND descricao ~ '[-–]\s+[A-Za-z]{3}'
  AND TRIM(SUBSTRING(descricao FROM '.* [-–] (.+)$')) IS NOT NULL
  AND LENGTH(TRIM(SUBSTRING(descricao FROM '.* [-–] (.+)$'))) >= 3;