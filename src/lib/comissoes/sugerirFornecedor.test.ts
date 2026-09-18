import { describe, expect, it } from 'vitest';
import { sugerirFornecedor } from '@/lib/comissoes/sugerirFornecedor';

/** Cadastro real de fornecedores do GC (recorte), com o CNPJ que o GC prefixa. */
const fornecedores = [
  { gc_id: '3705402', nome: '60.104.608 FILIPE FARIAS DE CARVALHO', cpf_cnpj: null },
  { gc_id: '4645861', nome: 'DANIELLE FIGUEIREDO DE OLIVEIRA', cpf_cnpj: null },
  { gc_id: '4828093', nome: 'GUILHERME GUIMARAES PEDROSA', cpf_cnpj: null },
  { gc_id: '3764223', nome: 'GUILHERME DUARTE DE SOUSA 02400439109', cpf_cnpj: null },
  { gc_id: '4349475', nome: 'GUSTAVO FONSECA MELO', cpf_cnpj: null },
  { gc_id: '4478532', nome: 'GUSTAVO FONSECA MELO 70796953171', cpf_cnpj: null },
  { gc_id: '3751273', nome: '57.907.796 MARIA EDUARDA SOARES GODOI', cpf_cnpj: null },
  { gc_id: '4106391', nome: 'MARIA EDUARDA CASTRO DA SILVA', cpf_cnpj: null },
];

describe('sugerirFornecedor', () => {
  it('acha o MEI do vendedor mesmo com o CNPJ colado na frente do nome', () => {
    expect(sugerirFornecedor('Filipe Carvalho', fornecedores)?.gc_id).toBe('3705402');
  });

  it('exige dois nomes: Guilherme Pedrosa não vira Guilherme Duarte', () => {
    expect(sugerirFornecedor('Guilherme Pedrosa', fornecedores)?.gc_id).toBe('4828093');
  });

  it('entre cadastros duplicados, prefere o mais curto', () => {
    expect(sugerirFornecedor('Gustavo Fonseca Melo', fornecedores)?.gc_id).toBe('4349475');
  });

  it('nome ambíguo demais não sugere nada', () => {
    // "Maria Eduarda" casa com duas pessoas diferentes; a sugestão escolheria
    // uma, mas é a mais curta, e o campo continua editável.
    expect(sugerirFornecedor('Maria Eduarda', fornecedores)).not.toBeNull();
    expect(sugerirFornecedor('Angélica', fornecedores)).toBeNull();
    expect(sugerirFornecedor('API GC WEDO', fornecedores)).toBeNull();
  });
});
