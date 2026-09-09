// Regra única de conclusão de job de negociação.
// Um job só pode ser "concluido" quando não houve erro, o retorno foi bem
// sucedido, a composição está completa e não há pendências de vínculo.
export interface RespostaExecucao {
  success?: boolean;
  summary?: { ok?: number; errors?: number };
  pendencias?: unknown[];
  composicao_incompleta?: boolean;
}

export interface DecisaoConclusao {
  concluiu: boolean;
  motivo: string;
  okCount: number;
  errCount: number;
  pendencias: number;
}

export function decidirConclusao(resp: RespostaExecucao | null | undefined): DecisaoConclusao {
  const okCount = Number(resp?.summary?.ok ?? 0);
  const errCount = Number(resp?.summary?.errors ?? 0);
  const pendencias = Array.isArray(resp?.pendencias) ? resp!.pendencias!.length : 0;
  const sucesso = resp?.success !== false;
  const composicaoCompleta = resp?.composicao_incompleta !== true;

  const motivo = !sucesso
    ? "A função de negociação retornou success=false"
    : errCount > 0
      ? `${errCount} erro(s) na execução`
      : !composicaoCompleta
        ? "Composição da negociação incompleta"
        : pendencias > 0
          ? `${pendencias} pendência(s) de vínculo`
          : "";

  return {
    concluiu: motivo === "",
    motivo,
    okCount,
    errCount,
    pendencias,
  };
}
