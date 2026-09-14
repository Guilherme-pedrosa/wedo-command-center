/** Estado atual da comissão; a retirada nunca exclui a venda ou os pagamentos. */
export interface SituacaoComissao {
  retirada: boolean;
  motivo_retirada: string;
  situacao_alterada_em: string | null;
  situacao_alterada_por: string | null;
}

export interface EventoSituacaoComissao {
  id: string;
  venda_id: string;
  vendedor_nome: string;
  usuario_id: string;
  usuario_nome: string;
  created_at: string;
  motivo: string;
  retirada_antes: boolean;
  retirada_depois: boolean;
  snapshot: {
    codigo_venda: string | null;
    cliente_nome: string | null;
    valor_venda: number | null;
    total_comissao_pago: number;
    conferencia_anterior: Record<string, unknown> | null;
  };
}

export interface ResultadoSituacaoComissoes {
  solicitadas: number;
  alteradas: number;
}
