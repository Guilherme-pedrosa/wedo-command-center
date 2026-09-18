export interface FornecedorGC { gc_id: string; nome: string; cpf_cnpj: string | null }

// Faixa U+0300–U+036F: as marcas combinantes que o NFD separa das letras.
const semAcento = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();

/**
 * Sugere o fornecedor do GC pelo nome do vendedor.
 *
 * Os vendedores são MEIs e quase todos já existem como fornecedor — o GC
 * prefixa o CNPJ na razão social ("60.104.608 FILIPE FARIAS DE CARVALHO"),
 * então a comparação ignora dígitos e pontuação e exige os dois primeiros
 * nomes. Sugestão, não decisão: o campo continua editável.
 */
export function sugerirFornecedor(nomeVendedor: string, fornecedores: FornecedorGC[]): FornecedorGC | null {
  const partes = semAcento(nomeVendedor).replace(/[^A-Z ]/g, ' ').split(/\s+/).filter((p) => p.length > 2);
  if (partes.length < 2) return null;
  const [a, b] = partes;
  const candidatos = fornecedores.filter((f) => {
    const n = semAcento(f.nome).replace(/[^A-Z ]/g, ' ');
    return n.includes(a) && n.includes(b);
  });
  // Empate: fica com o mais curto, que tende a ser o cadastro "limpo".
  return candidatos.sort((x, y) => x.nome.length - y.nome.length)[0] ?? null;
}

