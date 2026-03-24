
-- Fix os_codigo for receivable that belongs to OS 9032 but was incorrectly set to 8772
UPDATE fin_recebimentos
SET os_codigo = '9032'
WHERE id = 'b276a10a-9260-4fda-a444-f2607fdea8c3' AND os_codigo = '8772';
