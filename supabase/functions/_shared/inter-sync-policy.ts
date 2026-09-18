/**
 * Política de sincronização com o Banco Inter: janela, ritmo e reação a 429.
 *
 * Lógica pura, sem I/O, para ser testada com vitest — as edge functions só
 * chamam daqui. Nasceu do incidente de 17–18/09/2026, em que o Inter passou
 * horas devolvendo 429 no /oauth/v2/token. A causa não era o Inter:
 *
 * - o pipeline de conciliação relia 89 dias de extrato a cada ~15 minutos
 *   (duas crons, :00/:30 e :15/:45), porque a janela padrão era fixa e não
 *   havia cursor de última sincronização bem-sucedida — 378 chamadas de
 *   extrato em 24 h;
 * - a trava anti-duplicata só olhava corridas `running`/`success`; como o
 *   reconciliation-engine falhava sempre (546, sem memória), toda corrida era
 *   `error` e a trava nunca disparava;
 * - a proxy respondia 500 quando o OAuth dava 429, sem gravar cooldown; o
 *   inter-extrato tratava 500 como transitório e tentava 4× por endpoint,
 *   4 endpoints por chunk, 4 chunks — até 64 pedidos de token numa corrida.
 */

const DIA_MS = 86_400_000;

const iso = (d: Date) => d.toISOString().slice(0, 10);
const deIso = (s: string) => new Date(`${s}T00:00:00Z`);

export interface JanelaOpcoes {
  /** Hoje, em YYYY-MM-DD. */
  hoje: string;
  /** dataFim da última corrida do pipeline com status success, ou null. */
  ultimoSucessoFim: string | null;
  /** Dias a recuar antes do último sucesso: o Inter lança com atraso. */
  sobreposicaoDias?: number;
  /** Janela quando nunca houve sucesso. */
  padraoDias?: number;
  /** Teto absoluto, mesmo que o último sucesso seja muito antigo. */
  maximoDias?: number;
}

export interface Janela {
  dataInicio: string;
  dataFim: string;
  motivo: string;
}

/**
 * Janela incremental: recomeça um pouco antes do último sucesso, em vez de
 * sempre 89 dias atrás.
 *
 * Três dias de sobreposição cobrem lançamento que o Inter registra depois do
 * dia da operação; o upsert por id torna a releitura inofensiva. Sem sucesso
 * anterior, sete dias. Nunca mais que `maximoDias`, para que um pipeline
 * parado há meses não volte a arrastar um trimestre por corrida.
 */
export function janelaIncremental(o: JanelaOpcoes): Janela {
  const sobreposicao = o.sobreposicaoDias ?? 3;
  const padrao = o.padraoDias ?? 7;
  const maximo = o.maximoDias ?? 89;
  const hoje = deIso(o.hoje);

  if (!o.ultimoSucessoFim) {
    return {
      dataInicio: iso(new Date(hoje.getTime() - padrao * DIA_MS)),
      dataFim: o.hoje,
      motivo: `sem sucesso anterior: ${padrao} dias`,
    };
  }

  const candidato = new Date(deIso(o.ultimoSucessoFim).getTime() - sobreposicao * DIA_MS);
  const piso = new Date(hoje.getTime() - maximo * DIA_MS);
  const inicio = candidato < piso ? piso : candidato;
  // Último sucesso no futuro (relógio, fuso) não pode virar janela negativa.
  const inicioSeguro = inicio > hoje ? hoje : inicio;

  return {
    dataInicio: iso(inicioSeguro),
    dataFim: o.hoje,
    motivo:
      candidato < piso
        ? `último sucesso em ${o.ultimoSucessoFim}, limitado ao teto de ${maximo} dias`
        : `último sucesso em ${o.ultimoSucessoFim} menos ${sobreposicao} dias de sobreposição`,
  };
}

export interface CorridaRecente {
  status: string;
  created_at: string;
}

/**
 * Decide se esta corrida deve ceder a vez a uma recente.
 *
 * `running` e `success` sempre contaram. `error` passa a contar também: um
 * pipeline que falha não pode ser reagendado quatro vezes por hora, porque a
 * primeira etapa dele — o extrato — já bateu no Inter antes de falhar.
 */
export function deveAguardar(
  recente: CorridaRecente | null,
  agoraMs: number,
  janelaMinutos = 25,
): { aguardar: boolean; motivo: string } {
  if (!recente) return { aguardar: false, motivo: "nenhuma corrida recente" };
  const idadeMin = (agoraMs - new Date(recente.created_at).getTime()) / 60_000;
  if (idadeMin >= janelaMinutos) {
    return { aguardar: false, motivo: `última corrida há ${Math.round(idadeMin)} min` };
  }
  if (recente.status === "running") {
    return { aguardar: true, motivo: `corrida em andamento há ${Math.round(idadeMin)} min` };
  }
  if (recente.status === "success") {
    return { aguardar: true, motivo: `concluída há ${Math.round(idadeMin)} min` };
  }
  if (recente.status === "error") {
    return {
      aguardar: true,
      motivo: `falhou há ${Math.round(idadeMin)} min — aguardando ${janelaMinutos} min antes de insistir`,
    };
  }
  return { aguardar: false, motivo: `status ${recente.status} não bloqueia` };
}

/**
 * Até quando parar de pedir token depois de um 429 no OAuth.
 *
 * Respeita `Retry-After` em segundos quando vier; sem ele, um minuto. Nunca
 * menos de 5 s, para um Retry-After de "0" não virar loop.
 */
export function cooldownAte(retryAfter: string | null | undefined, agoraMs: number, padraoSeg = 60): number {
  const n = Number(retryAfter);
  const seg = Number.isFinite(n) && n > 0 ? Math.max(5, n) : padraoSeg;
  return agoraMs + seg * 1000;
}

export interface DecisaoRetry {
  tentar: boolean;
  esperaMs: number;
  motivo: string;
}

/**
 * Se vale tentar de novo depois de um status HTTP, e quanto esperar.
 *
 * 429 com `retry_after` não se insiste: quem mandou esperar sabe mais que o
 * cliente, e insistir só alonga o bloqueio. 429 sem instrução tenta uma vez
 * com espera curta. 500 é ambíguo — pode ser a proxy sem token — e ganha uma
 * única repetição. 503 tem direito às tentativas normais.
 */
export function decidirRetry(
  status: number,
  tentativa: number,
  maxTentativas: number,
  retryAfterSeg?: number | null,
): DecisaoRetry {
  if (status === 429) {
    if (retryAfterSeg && retryAfterSeg > 0) {
      return { tentar: false, esperaMs: 0, motivo: `429 com retry_after=${retryAfterSeg}s: não insistir` };
    }
    return tentativa < 1
      ? { tentar: true, esperaMs: 5_000, motivo: "429 sem retry_after: uma tentativa em 5 s" }
      : { tentar: false, esperaMs: 0, motivo: "429 repetido: desistir" };
  }
  if (status === 500) {
    return tentativa < 1
      ? { tentar: true, esperaMs: 2_000, motivo: "500: uma repetição" }
      : { tentar: false, esperaMs: 0, motivo: "500 repetido: desistir" };
  }
  if (status === 503) {
    return tentativa < maxTentativas
      ? { tentar: true, esperaMs: (tentativa + 1) * 2_000, motivo: `503: tentativa ${tentativa + 1}` }
      : { tentar: false, esperaMs: 0, motivo: "503: esgotou" };
  }
  return { tentar: false, esperaMs: 0, motivo: `status ${status} não é transitório` };
}
