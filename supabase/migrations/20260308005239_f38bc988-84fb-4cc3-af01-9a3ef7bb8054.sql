UPDATE fin_extrato_inter
SET contrapartida = NULL
WHERE contrapartida IN (
  'Pix enviado','Pix recebido','Pix Enviado','Pix Recebido',
  'Transferência','Transferencia','TED enviado','TED recebido',
  'Pagamento','Recebimento'
);