UPDATE fin_residuos_negociacao 
SET utilizado = false, utilizado_em = null
WHERE id IN (
  '3dac1055-70ac-4c46-b7f8-5dbc96055ebf',
  '928908c3-b10e-4633-a089-99bc9c0ba894',
  '412f9276-6158-4ee5-bdda-141c97c1dcea',
  'c24a38bc-47e6-4127-9b2e-dd7bcc070e72'
)
AND utilizado = true;