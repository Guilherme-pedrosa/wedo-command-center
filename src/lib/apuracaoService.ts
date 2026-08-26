/**
 * Orquestração da apuração fiscal: carrega a competência do Supabase, roda o
 * motor puro (apuracaoFiscal.ts) e devolve o resultado pronto para a tela.
 *
 * A decisão fiscal NÃO mora aqui — aqui só se busca dado e se soma. Qualquer
 * regra nova vai para apuracaoFiscal.ts, onde há teste.
 */
import { supabase } from "@/integrations/supabase/client";
import {
  decidirCreditoPisCofins,
  decidirCreditoIcms,
  decidirReceitaSaida,
  apurarPisCofins,
  apurarIcms,
  ratearRetencoes,
  round2,
  ALIQUOTA_PIS_COFINS,
  type RegraCfop,
  type RegimeEmitente,
  type ResultadoTributo,
  type RetencaoRateada,
  type DecisaoCredito,
} from "@/lib/apuracaoFiscal";

/**
 * As tabelas fis_* ainda não constam em integrations/supabase/types.ts porque
 * a migration não foi aplicada. Até lá, descrevemos aqui a forma das linhas que
 * lemos — explícito e conferível. Depois do deploy, regenerar os tipos e trocar
 * estas interfaces pelas geradas.
 */
interface RespostaSupabase<T> {
  data: T[] | null;
  error: { message: string } | null;
}

interface Consulta<T> extends PromiseLike<RespostaSupabase<T>> {
  select(colunas: string): Consulta<T>;
  eq(coluna: string, valor: unknown): Consulta<T>;
  gte(coluna: string, valor: unknown): Consulta<T>;
  lte(coluna: string, valor: unknown): Consulta<T>;
  or(expressao: string): Consulta<T>;
  upsert(linhas: unknown, opcoes?: { onConflict?: string }): Consulta<T>;
}

const db = supabase as unknown as { from<T>(tabela: string): Consulta<T> };

interface CfopRegraRow {
  cfop: string;
  sentido: "entrada" | "saida";
  compoe_receita: boolean;
  gera_credito_piscofins: boolean;
  gera_credito_icms: boolean;
}

interface NfSaidaRow {
  id: string;
  gc_id: string;
  modelo: "55" | "65" | "NFSE";
  numero: string | null;
  autorizada: boolean;
  cancelada: boolean;
  denegada: boolean;
  codigo_cfop: string | null;
  natureza_operacao: string | null;
  destinatario_nome: string | null;
  valor_produtos: number | null;
  valor_servico: number | null;
  valor_desconto: number | null;
  valor_total_nf: number | null;
  valor_ipi: number | null;
  valor_icms: number | null;
}

interface CompraRow {
  numero_nfe: string | null;
  codigo: string | null;
  data: string | null;
  nome_fornecedor: string | null;
  valor_total: number | null;
  nome_situacao: string | null;
}

interface ProdutoTributoRow {
  gc_produto_id: string;
  nf_chave: string | null;
  nome_produto: string | null;
  sem_credito: boolean | null;
  excecao_manual: boolean | null;
  excecao_motivo: string | null;
  ineligivel_precificacao: boolean | null;
  ineligivel_motivo: string | null;
}

interface FornecedorPapelRow {
  cnpj: string;
  papel: string;
  credita: boolean;
  justificativa: string;
}

interface ServicoRegraRow {
  padrao: string;
  credita: boolean;
  categoria: string;
  fundamento: string;
  prioridade: number;
  ativo: boolean;
}

/**
 * Combustível e lubrificante: NCM do capítulo 2710 ou descrição explícita.
 * Só vale como insumo se houver pedido de compra amarrado — sem isso não há
 * evidência de que foi consumido na operação.
 */
function ehCombustivel(ncm: string | null, descricao: string | null): boolean {
  const porNcm = /^2710/.test((ncm ?? "").replace(/\D/g, ""));
  const porDescricao = /gasolina|diesel|[óo]leo diesel|etanol|arla|lubrificante|combust/i
    .test(descricao ?? "");
  return porNcm || porDescricao;
}

/** CFOP de serviço tributado pelo ISSQN (x933 na saída do prestador). */
function ehCfopServico(cfop: string | null): boolean {
  return !!cfop && /^[1256]933$/.test(cfop);
}

/**
 * Classifica um serviço tomado contra fis_servico_regra. Menor prioridade é
 * avaliada primeiro, para que uma vedação (almoço) vença uma palavra que
 * pareça insumo na mesma descrição.
 */
function classificarServico(descricao: string | null, regras: ServicoRegraRow[]) {
  const texto = descricao ?? "";
  for (const r of regras) {
    try {
      if (new RegExp(r.padrao, "i").test(texto)) {
        return { insumo: r.credita, categoria: r.categoria, fundamento: r.fundamento };
      }
    } catch {
      // Padrão inválido cadastrado por engano não pode derrubar a apuração.
    }
  }
  return { insumo: null as boolean | null, categoria: null, fundamento: null };
}

/** Base do item quando a inclusão é decidida à mão: valor líquido de desconto. */
function baseDoItemManual(item: { valorProduto: number; valorDesconto?: number }): number {
  return round2((item.valorProduto ?? 0) - (item.valorDesconto ?? 0));
}

/** Chave de ligação com a precificação: a NF de origem mais o nome do item. */
function chaveCuradoria(nfChave: string | null, nomeProduto: string | null): string {
  return `${nfChave ?? ""}|${(nomeProduto ?? "").trim().toLowerCase()}`;
}

interface NfSaidaRetencaoRow {
  id: string;
  numero: string | null;
  valor_total_nf: number | null;
  valor_pis: number | null;
  valor_cofins: number | null;
  pis_retido: boolean | null;
  cofins_retido: boolean | null;
}

interface NfEntradaItemRow {
  id: string;
  ordem: number;
  cfop: string | null;
  cst_pis: string | null;
  cst_cofins: string | null;
  cst_icms: string | null;
  nome_produto: string | null;
  ncm: string | null;
  valor_produto: number | null;
  valor_desconto: number | null;
  valor_frete: number | null;
  valor_icms: number | null;
  perc_reducao_bc: number | null;
}

interface NfEntradaRow {
  chave: string;
  numero: string | null;
  nome_emitente: string | null;
  cnpj_emitente: string | null;
  crt_emitente: number | null;
  regime_emitente: RegimeEmitente | null;
  fis_nf_entrada_item: NfEntradaItemRow[] | null;
}

interface RecebimentoRow {
  id: string;
  nf_numero: string | null;
  valor: number | null;
  data_liquidacao: string;
  nome_cliente: string | null;
}

interface ApuracaoSaldoRow {
  tributo: string;
  saldo_credor_proximo: number | null;
}

interface AnomaliaRow {
  tipo: string;
  severidade: "info" | "aviso" | "critico";
  referencia: string | null;
  descricao: string;
}

export interface AnomaliaApuracao {
  tipo: string;
  severidade: "info" | "aviso" | "critico";
  referencia: string;
  descricao: string;
}

interface DecisaoManualRow {
  nf_entrada_item_id: string;
  incluir: boolean;
  motivo: string | null;
  decidido_por: string | null;
}

export interface LinhaCredito {
  /** Id do item — chave para gravar a decisão manual. */
  itemId: string;
  /** true quando uma pessoa decidiu manualmente, contra ou a favor da regra. */
  decidoManualmente: boolean;
  chave: string;
  fornecedor: string;
  regime: RegimeEmitente;
  numero: string | null;
  item: number;
  produto: string | null;
  cfop: string | null;
  /** CST de PIS/COFINS — não confundir com o de ICMS. */
  cstPisCofins: string | null;
  /** CST de ICMS, ou CSOSN quando o emitente é do Simples. */
  cstIcms: string | null;
  valorProduto: number;
  temPedidoCompra: boolean;
  decisao: DecisaoCredito;
  decisaoIcms: DecisaoCredito;
}

export interface LinhaReceita {
  gcId: string;
  modelo: string;
  numero: string | null;
  cliente: string | null;
  cfop: string | null;
  natureza: string | null;
  valor: number;
  compoe: boolean;
  motivo: string;
}

export interface ResultadoApuracao {
  competencia: string;
  receitaBruta: number;
  baseDebito: number;
  baseCredito: number;
  baseCreditoSimples: number;
  pis: ResultadoTributo;
  cofins: ResultadoTributo;
  icms: ResultadoTributo;
  saldoTotalPisCofins: number;
  retencoes: RetencaoRateada[];
  totalRetencaoPis: number;
  totalRetencaoCofins: number;
  linhasReceita: LinhaReceita[];
  linhasCredito: LinhaCredito[];
  anomalias: AnomaliaApuracao[];
  contadores: {
    notasSaida: number;
    notasSaidaNaBase: number;
    notasEntrada: number;
    itensEntrada: number;
    itensComCredito: number;
    itensParaRevisao: number;
  };
}

function ultimoDiaDoMes(competencia: string): string {
  const [ano, mes] = competencia.split("-").map(Number);
  return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
}

function competenciaAnterior(competencia: string): string {
  const [ano, mes] = competencia.split("-").map(Number);
  const d = new Date(Date.UTC(ano, mes - 2, 1));
  return d.toISOString().slice(0, 7) + "-01";
}

async function carregarRegrasCfop(): Promise<Map<string, RegraCfop>> {
  const { data, error } = await db.from<CfopRegraRow>("fis_cfop_regra").select("*");
  if (error) throw new Error(`Falha ao ler regras de CFOP: ${error.message}`);
  const mapa = new Map<string, RegraCfop>();
  for (const r of data ?? []) {
    mapa.set(String(r.cfop), {
      cfop: String(r.cfop),
      sentido: r.sentido,
      compoeReceita: !!r.compoe_receita,
      geraCreditoPisCofins: !!r.gera_credito_piscofins,
      geraCreditoIcms: !!r.gera_credito_icms,
    });
  }
  return mapa;
}

async function saldoCredorAnterior(competencia: string) {
  const anterior = competenciaAnterior(competencia);
  const { data } = await db
    .from<ApuracaoSaldoRow>("fis_apuracao")
    .select("tributo, saldo_credor_proximo")
    .eq("competencia", anterior);

  const porTributo = new Map<string, number>();
  for (const r of data ?? []) {
    porTributo.set(r.tributo, Number(r.saldo_credor_proximo) || 0);
  }
  return {
    pis: porTributo.get("PIS") ?? 0,
    cofins: porTributo.get("COFINS") ?? 0,
    icms: porTributo.get("ICMS") ?? 0,
  };
}

export interface OpcoesApuracao {
  incluirFrete?: boolean;
}

export async function apurarCompetencia(
  competencia: string,
  opcoes: OpcoesApuracao = {},
): Promise<ResultadoApuracao> {
  const inicio = competencia;
  const fim = ultimoDiaDoMes(competencia);
  const anomalias: AnomaliaApuracao[] = [];
  const regras = await carregarRegrasCfop();

  // ── Regra 1: débitos ──────────────────────────────────────────────────
  const { data: saidas, error: erroSaidas } = await db
    .from<NfSaidaRow>("fis_nf_saida")
    .select("*")
    .eq("competencia", competencia);
  if (erroSaidas) throw new Error(`Falha ao ler notas de saída: ${erroSaidas.message}`);

  const linhasReceita: LinhaReceita[] = [];
  let baseDebito = 0;
  let debitoIcms = 0;

  for (const nf of saidas ?? []) {
    const decisao = decidirReceitaSaida(
      {
        gcId: nf.gc_id,
        modelo: nf.modelo,
        numero: nf.numero,
        autorizada: !!nf.autorizada,
        cancelada: !!nf.cancelada,
        denegada: !!nf.denegada,
        codigoCfop: nf.codigo_cfop,
        naturezaOperacao: nf.natureza_operacao,
        valorProdutos: Number(nf.valor_produtos) || 0,
        valorServico: Number(nf.valor_servico) || 0,
        valorDesconto: Number(nf.valor_desconto) || 0,
        valorTotalNf: Number(nf.valor_total_nf) || 0,
        valorIpi: Number(nf.valor_ipi) || 0,
      },
      nf.codigo_cfop ? regras.get(String(nf.codigo_cfop)) ?? null : null,
    );

    linhasReceita.push({
      gcId: nf.gc_id,
      modelo: nf.modelo,
      numero: nf.numero,
      cliente: nf.destinatario_nome,
      cfop: nf.codigo_cfop,
      natureza: nf.natureza_operacao,
      valor: decisao.valor,
      compoe: decisao.compoe,
      motivo: decisao.motivo,
    });

    if (decisao.compoe) baseDebito += decisao.valor;

    // ICMS de saída: o que foi efetivamente destacado na nota autorizada.
    if (nf.autorizada && !nf.cancelada && !nf.denegada) {
      debitoIcms += Number(nf.valor_icms) || 0;
    }

    if (decisao.requerRevisao) {
      anomalias.push({
        tipo: "SAIDA_REQUER_REVISAO",
        severidade: "critico",
        referencia: `${nf.modelo} ${nf.numero ?? nf.gc_id}`,
        descricao: decisao.motivo,
      });
    }
  }

  // ── Regra 2: créditos ─────────────────────────────────────────────────
  const { data: entradas, error: erroEntradas } = await db
    .from<NfEntradaRow>("fis_nf_entrada")
    .select("*, fis_nf_entrada_item(*)")
    .eq("competencia", competencia);
  if (erroEntradas) throw new Error(`Falha ao ler notas de entrada: ${erroEntradas.message}`);

  // Pedidos de compra da janela. Nota amarrada a pedido é prova de que o item
  // foi adquirido para uso na operação — critério de insumo objetivo, em vez
  // de depender do CST que o fornecedor digitou.
  const { data: compras } = await db
    .from<CompraRow>("gc_compras")
    .select("numero_nfe, codigo, data, nome_fornecedor, valor_total, nome_situacao")
    .gte("data", competenciaAnterior(competencia))
    .lte("data", ultimoDiaDoMes(competencia));
  const semZeros = (s: string) => s.replace(/^0+/, "");
  const numerosComPedido = new Set(
    (compras ?? [])
      .map((c) => (c.numero_nfe ?? "").trim())
      .filter(Boolean)
      .map(semZeros),
  );

  // Decisões já curadas na precificação. Elas mandam: se um humano marcou
  // sem_credito ou corrigiu a alíquota, a apuração não pode contradizer.
  const { data: tributos } = await db
    .from<ProdutoTributoRow>("fin_produto_tributos")
    .select(
      "gc_produto_id, nf_chave, nome_produto, sem_credito, " +
      "excecao_manual, excecao_motivo, ineligivel_precificacao, ineligivel_motivo",
    );
  const curadoria = new Map<string, ProdutoTributoRow>();
  for (const t of tributos ?? []) {
    curadoria.set(chaveCuradoria(t.nf_chave, t.nome_produto), t);
  }

  const { data: regrasServicoRaw } = await db
    .from<ServicoRegraRow>("fis_servico_regra")
    .select("padrao, credita, categoria, fundamento, prioridade, ativo")
    .eq("ativo", true);
  const regrasServico = (regrasServicoRaw ?? []).sort(
    (a, b) => (a.prioridade ?? 100) - (b.prioridade ?? 100),
  );

  // Decisões manuais: a regra continua decidindo sozinha, mas quando alguém
  // marca ou desmarca um item na tela, a palavra dele é a final.
  const { data: manuaisRaw } = await db
    .from<DecisaoManualRow>("fis_item_decisao_manual")
    .select("nf_entrada_item_id, incluir, motivo, decidido_por");
  const decisoesManuais = new Map<string, DecisaoManualRow>();
  for (const m of manuaisRaw ?? []) decisoesManuais.set(m.nf_entrada_item_id, m);

  const { data: papeisRaw } = await db
    .from<FornecedorPapelRow>("fis_fornecedor_papel")
    .select("cnpj, papel, credita, justificativa");
  const papeisFornecedor = new Map<string, FornecedorPapelRow>();
  for (const p of papeisRaw ?? []) {
    papeisFornecedor.set(String(p.cnpj ?? "").replace(/\D/g, ""), p);
  }

  const linhasCredito: LinhaCredito[] = [];
  let baseCredito = 0;
  let baseCreditoSimples = 0;
  let creditoIcms = 0;
  let itensEntrada = 0;
  let itensComCredito = 0;
  let itensParaRevisao = 0;

  for (const nf of entradas ?? []) {
    const regime = (nf.regime_emitente ?? "desconhecido") as RegimeEmitente;
    const temPedidoCompra = numerosComPedido.has(semZeros((nf.numero ?? "").trim()));
    // 11 dígitos = CPF. MEI tem CNPJ (14) e não é pessoa física.
    const doc = String(nf.cnpj_emitente ?? "").replace(/\D/g, "");
    const cabecalho = {
      regimeEmitente: regime,
      crtEmitente: nf.crt_emitente ?? null,
      temPedidoCompra,
      emitentePessoaFisica: doc.length === 11,
    };

    for (const item of nf.fis_nf_entrada_item ?? []) {
      itensEntrada++;
      const regra = item.cfop ? regras.get(String(item.cfop)) ?? null : null;
      const itemEntrada = {
        ordem: item.ordem,
        cfop: item.cfop,
        cstPis: item.cst_pis,
        cstCofins: item.cst_cofins,
        cstIcms: item.cst_icms,
        valorProduto: Number(item.valor_produto) || 0,
        valorDesconto: Number(item.valor_desconto) || 0,
        valorFrete: Number(item.valor_frete) || 0,
        valorIcms: Number(item.valor_icms) || 0,
        percReducaoBc: Number(item.perc_reducao_bc) || 0,
        ncm: item.ncm,
        nomeProduto: item.nome_produto,
        ehServico: ehCfopServico(item.cfop),
        ehCombustivelInsumo:
          temPedidoCompra && ehCombustivel(item.ncm, item.nome_produto),
        // Monofásico/ST comprado com pedido e por CFOP de aquisição foi para
        // uso na atividade, não para revenda — é a destinação que decide.
        ehMonofasicoInsumo: temPedidoCompra && !!regra?.geraCreditoPisCofins,
        ...(() => {
          if (!ehCfopServico(item.cfop)) return {};
          // O papel declarado do prestador manda sobre a descrição da linha:
          // quando o fornecedor executa em cliente, "alimentação" e "premiação"
          // são como o MEI discrimina o próprio preço, não despesa de pessoal
          // do tomador.
          const papel = papeisFornecedor.get(String(nf.cnpj_emitente ?? "").replace(/\D/g, ""));
          if (papel) {
            // Linha com a palavra "comissão" vinda de prestador de campo:
            // credita, porque a substância é remuneração variável do técnico
            // pela entrega — mas fica marcada. A descrição na NFS-e diz
            // "comissão de venda" com número de venda, e é isso que o auditor
            // lê. O caminho de defesa é o prestador descrever o que entregou.
            if (papel.credita && /comiss[ãa]o/i.test(item.nome_produto ?? "")) {
              return {
                servicoEhInsumo: true,
                servicoCategoria: "bonus_entrega",
                servicoFundamento:
                  "Prestador de campo. Declarado como bônus por foco em entrega, não " +
                  "comissão de venda. ATENÇÃO: a descrição na nota diz 'comissão de venda' — " +
                  "orientar o prestador a descrever o serviço entregue.",
              };
            }
            return {
              servicoEhInsumo: papel.credita,
              servicoCategoria: papel.papel,
              servicoFundamento: papel.justificativa,
            };
          }
          const c = classificarServico(item.nome_produto, regrasServico);
          return {
            servicoEhInsumo: c.insumo,
            servicoCategoria: c.categoria,
            servicoFundamento: c.fundamento,
          };
        })(),
      };

      let decisao = decidirCreditoPisCofins(itemEntrada, cabecalho, regra, opcoes);
      const decisaoIcms = decidirCreditoIcms(itemEntrada, cabecalho, regra);

      // A precificação tem precedência: se um humano já vetou o item ou o
      // marcou como inelegível (brinde, bonificação, doação), a apuração
      // não pode conceder crédito por cima dessa decisão.
      const curado = curadoria.get(chaveCuradoria(nf.chave, item.nome_produto));
      if (decisao.permitido && curado?.sem_credito) {
        decisao = {
          ...decisao,
          permitido: false,
          base: 0,
          regra: "VETO_PRECIFICACAO",
          motivo:
            "Vedado na precificação (sem_credito). " +
            (curado.excecao_motivo ?? "Sem motivo registrado."),
        };
      } else if (decisao.permitido && curado?.ineligivel_precificacao) {
        decisao = {
          ...decisao,
          permitido: false,
          base: 0,
          regra: "INELEGIVEL_PRECIFICACAO",
          motivo:
            `Marcado como inelegível na precificação: ${curado.ineligivel_motivo ?? "sem motivo"}`,
        };
      }

      // Decisão manual vence a regra — nos dois sentidos. Fica registrado no
      // motivo de quem decidiu, para o relatório não parecer automático.
      const manual = decisoesManuais.get(item.id);
      if (manual) {
        decisao = {
          ...decisao,
          permitido: manual.incluir,
          base: manual.incluir ? baseDoItemManual(itemEntrada) : 0,
          regra: manual.incluir ? "MANUAL_INCLUIDO" : "MANUAL_EXCLUIDO",
          requerRevisao: false,
          motivo:
            `Decisão manual de ${manual.decidido_por ?? "usuário"}: ` +
            `${manual.incluir ? "incluído" : "excluído"} da base. ` +
            (manual.motivo ? `${manual.motivo} ` : "") +
            `(Regra automática dizia: ${decisao.permitido ? "creditar" : "não creditar"} — ${decisao.motivo})`,
        };
      }

      if (decisao.permitido) {
        baseCredito += decisao.base;
        itensComCredito++;
        if (decisao.viaResgateSimples) baseCreditoSimples += decisao.base;
      }
      if (decisaoIcms.permitido) creditoIcms += decisaoIcms.base;

      if (decisao.requerRevisao) {
        itensParaRevisao++;
        anomalias.push({
          tipo: decisao.regra,
          severidade: "critico",
          referencia: `${nf.chave} item ${item.ordem}`,
          descricao: `${item.nome_produto ?? "item"}: ${decisao.motivo}`,
        });
      }

      linhasCredito.push({
        itemId: item.id,
        decidoManualmente: !!manual,
        chave: nf.chave,
        fornecedor: nf.nome_emitente ?? "",
        regime,
        numero: nf.numero,
        item: item.ordem,
        produto: item.nome_produto,
        cfop: item.cfop,
        cstPisCofins: item.cst_pis ?? item.cst_cofins,
        cstIcms: item.cst_icms,
        valorProduto: itemEntrada.valorProduto,
        temPedidoCompra,
        decisao,
        decisaoIcms,
      });
    }
  }

  // ── Compra registrada sem XML: crédito que existe e ninguém vê ─────────
  // Se há pedido de compra com número de NF e o XML nunca chegou, o crédito
  // simplesmente não entra na apuração — em silêncio. Em julho/2026 isso
  // escondia R$ 72.509,55 de uma única nota. Aqui vira lista de trabalho.
  const numerosComXml = new Set(
    (entradas ?? []).map((e) => semZeros((e.numero ?? "").trim())).filter(Boolean),
  );
  const semXml = (compras ?? []).filter((c) => {
    const nf = semZeros((c.numero_nfe ?? "").trim());
    if (!nf) return false;
    // Só interessa compra da própria competência.
    if (!c.data || c.data < inicio || c.data > fim) return false;
    return !numerosComXml.has(nf);
  });

  let valorSemXml = 0;
  for (const c of semXml) {
    const valor = Number(c.valor_total) || 0;
    valorSemXml += valor;
    anomalias.push({
      tipo: "COMPRA_SEM_XML",
      // Acima de mil reais o crédito perdido passa de R$ 92 e vira dinheiro.
      severidade: valor >= 1000 ? "critico" : "aviso",
      referencia: `NF ${c.numero_nfe} · pedido ${c.codigo ?? "?"}`,
      descricao:
        `${c.nome_fornecedor ?? "Fornecedor"} — R$ ${valor.toFixed(2)} (${c.nome_situacao ?? "?"}). ` +
        `Pedido de compra registrado, XML nunca importado. Crédito potencial de ` +
        `R$ ${round2((valor * ALIQUOTA_PIS_COFINS) / 100).toFixed(2)} em PIS/COFINS não está ` +
        `sendo aproveitado. Baixar o XML na SEFAZ e importar.`,
    });
  }
  if (valorSemXml > 0) {
    anomalias.push({
      tipo: "COMPRA_SEM_XML_TOTAL",
      severidade: "critico",
      referencia: competencia.slice(0, 7),
      descricao:
        `${semXml.length} compra(s) somando R$ ${valorSemXml.toFixed(2)} sem XML importado. ` +
        `Crédito de PIS/COFINS deixado na mesa: aproximadamente ` +
        `R$ ${round2((valorSemXml * ALIQUOTA_PIS_COFINS) / 100).toFixed(2)}.`,
    });
  }

  // ── Regra 3: retenções na fonte, regime de caixa ──────────────────────
  const { data: nfseComRetencao } = await db
    .from<NfSaidaRetencaoRow>("fis_nf_saida")
    .select("id, numero, valor_total_nf, valor_pis, valor_cofins, pis_retido, cofins_retido")
    .eq("modelo", "NFSE")
    .or("pis_retido.eq.true,cofins_retido.eq.true");

  const { data: liquidacoes } = await db
    .from<RecebimentoRow>("fin_recebimentos")
    .select("id, nf_numero, valor, data_liquidacao, nome_cliente")
    .gte("data_liquidacao", inicio)
    .lte("data_liquidacao", fim)
    .eq("liquidado", true);

  const rateio = ratearRetencoes(
    (nfseComRetencao ?? []).map((n) => ({
      nfSaidaId: n.id,
      numero: String(n.numero ?? ""),
      valorTotalNf: Number(n.valor_total_nf) || 0,
      valorPisRetido: n.pis_retido ? Number(n.valor_pis) || 0 : 0,
      valorCofinsRetido: n.cofins_retido ? Number(n.valor_cofins) || 0 : 0,
    })),
    (liquidacoes ?? []).map((r) => ({
      recebimentoId: r.id,
      nfNumero: r.nf_numero,
      valor: Number(r.valor) || 0,
      dataLiquidacao: r.data_liquidacao,
      nomeCliente: r.nome_cliente,
    })),
  );

  for (const aviso of rateio.avisos) {
    anomalias.push({
      tipo: aviso.tipo,
      severidade: "aviso",
      referencia: aviso.referencia,
      descricao: aviso.descricao,
    });
  }

  // ── Consolidação ──────────────────────────────────────────────────────
  const anterior = await saldoCredorAnterior(competencia);
  const receitaBruta = round2(baseDebito);

  const { pis, cofins, saldoTotalARecolher } = apurarPisCofins({
    receitaBruta,
    baseDebito: round2(baseDebito),
    baseCredito: round2(baseCredito),
    baseCreditoSimples: round2(baseCreditoSimples),
    retencaoPis: rateio.totalPis,
    retencaoCofins: rateio.totalCofins,
    saldoCredorAnteriorPis: anterior.pis,
    saldoCredorAnteriorCofins: anterior.cofins,
  });

  const icms = apurarIcms({
    debitoDestacado: round2(debitoIcms),
    creditoDestacado: round2(creditoIcms),
    saldoCredorAnterior: anterior.icms,
  });

  // Anomalias já registradas pela ingestão entram no mesmo relatório.
  const { data: anomaliasBanco } = await db
    .from<AnomaliaRow>("fis_anomalia")
    .select("tipo, severidade, referencia, descricao")
    .eq("competencia", competencia)
    .eq("resolvida", false);

  for (const a of anomaliasBanco ?? []) {
    anomalias.push({
      tipo: a.tipo,
      severidade: a.severidade,
      referencia: a.referencia ?? "",
      descricao: a.descricao,
    });
  }

  return {
    competencia,
    receitaBruta,
    baseDebito: round2(baseDebito),
    baseCredito: round2(baseCredito),
    baseCreditoSimples: round2(baseCreditoSimples),
    pis,
    cofins,
    icms,
    saldoTotalPisCofins: saldoTotalARecolher,
    retencoes: rateio.retencoes,
    totalRetencaoPis: rateio.totalPis,
    totalRetencaoCofins: rateio.totalCofins,
    linhasReceita,
    linhasCredito,
    anomalias,
    contadores: {
      notasSaida: (saidas ?? []).length,
      notasSaidaNaBase: linhasReceita.filter((l) => l.compoe).length,
      notasEntrada: (entradas ?? []).length,
      itensEntrada,
      itensComCredito,
      itensParaRevisao,
    },
  };
}

/** Grava o resultado como rascunho (uma linha por tributo). */
export async function salvarApuracao(r: ResultadoApuracao): Promise<void> {
  const linhas = [
    { tributo: "PIS", res: r.pis },
    { tributo: "COFINS", res: r.cofins },
    { tributo: "ICMS", res: r.icms },
  ].map(({ tributo, res }) => ({
    competencia: r.competencia,
    tributo,
    receita_bruta: r.receitaBruta,
    base_debito: res.baseDebito,
    aliquota: res.aliquota,
    valor_debito: res.valorDebito,
    base_credito: res.baseCredito,
    base_credito_simples: r.baseCreditoSimples,
    valor_credito: res.valorCredito,
    valor_retencoes: res.valorRetencoes,
    saldo_credor_anterior: res.saldoCredorAnterior,
    saldo_a_recolher: res.saldoARecolher,
    saldo_credor_proximo: res.saldoCredorProximo,
    status: "rascunho",
    calculado_em: new Date().toISOString(),
    detalhamento: {
      contadores: r.contadores,
      anomalias: r.anomalias.length,
      aliquota_combinada_pis_cofins: ALIQUOTA_PIS_COFINS,
    },
  }));

  const { error } = await db
    .from<ApuracaoSaldoRow>("fis_apuracao")
    .upsert(linhas, { onConflict: "competencia,tributo" });
  if (error) throw new Error(`Falha ao gravar apuração: ${error.message}`);
}

/**
 * Sonda os endpoints fiscais do GC e mostra o primeiro registro cru.
 *
 * Existe porque a modelagem partiu da spec da API (gc.apib), não de resposta
 * real. Antes de confiar em qualquer número, confirmar aqui que os campos
 * codigo_cfop, situacao_nf e pis_retido chegam como o esperado.
 */
interface GcRespostaLista {
  data?: Record<string, unknown>[];
  meta?: { total_registros?: number };
}

export interface DiagnosticoEndpoint {
  nome: string;
  endpoint: string;
  httpStatus: number;
  totalRegistros: number;
  camposEsperados: string[];
  camposPresentes: string[];
  camposFaltando: string[];
  amostra: Record<string, unknown> | null;
  erro: string | null;
}

export async function diagnosticarEndpointsGC(
  dataInicio: string,
  dataFim: string,
): Promise<DiagnosticoEndpoint[]> {
  const { callGC } = await import("@/lib/gc-client");
  const alvos = [
    { nome: "NF-e (produtos)", endpoint: "/api/notas_fiscais_produtos", camposEsperados: ["codigo_cfop", "situacao_nf", "chave", "base_icms", "valor_icms"] },
    { nome: "NFC-e (consumidor)", endpoint: "/api/notas_fiscais_consumidores", camposEsperados: ["codigo_cfop", "situacao_nf"] },
    { nome: "NFS-e (serviços)", endpoint: "/api/notas_fiscais_servicos", camposEsperados: ["pis_retido", "cofins_retido", "valor_pis", "valor_cofins", "valor_servico"] },
  ];

  const resultados: DiagnosticoEndpoint[] = [];
  for (const alvo of alvos) {
    try {
      const res = await callGC<GcRespostaLista>({
        endpoint: alvo.endpoint,
        params: { limite: "1", pagina: "1", data_inicio: dataInicio, data_fim: dataFim },
      });
      const registro = res.data?.data?.[0];
      // O GC ora embrulha em { Entidade: {...} }, ora devolve direto.
      const primeiro = registro ? Object.values(registro)[0] : null;
      const objeto: Record<string, unknown> | null =
        primeiro && typeof primeiro === "object" && !Array.isArray(primeiro)
          ? (primeiro as Record<string, unknown>)
          : (registro ?? null);
      const presentes = alvo.camposEsperados.filter(
        (c) => objeto && Object.prototype.hasOwnProperty.call(objeto, c),
      );
      resultados.push({
        nome: alvo.nome,
        endpoint: alvo.endpoint,
        httpStatus: res.status,
        totalRegistros: res.data?.meta?.total_registros ?? 0,
        camposEsperados: alvo.camposEsperados,
        camposPresentes: presentes,
        camposFaltando: alvo.camposEsperados.filter((c) => !presentes.includes(c)),
        amostra: objeto,
        erro: null as string | null,
      });
    } catch (e) {
      resultados.push({
        nome: alvo.nome,
        endpoint: alvo.endpoint,
        httpStatus: 0,
        totalRegistros: 0,
        camposEsperados: alvo.camposEsperados,
        camposPresentes: [],
        camposFaltando: alvo.camposEsperados,
        amostra: null,
        erro: String((e as Error)?.message ?? e),
      });
    }
  }
  return resultados;
}

/**
 * Grava a decisão manual de incluir ou excluir um item da base de crédito.
 *
 * A regra automática continua rodando e continua registrada no motivo — a
 * decisão manual não a apaga, se sobrepõe a ela. Em fiscalização, crédito
 * tomado por escolha humana precisa mostrar quem escolheu.
 */
export async function decidirItemManualmente(
  nfEntradaItemId: string,
  incluir: boolean,
  quem: string,
  motivo?: string,
): Promise<void> {
  const { error } = await db.from<DecisaoManualRow>("fis_item_decisao_manual").upsert(
    {
      nf_entrada_item_id: nfEntradaItemId,
      incluir,
      motivo: motivo ?? null,
      decidido_por: quem,
      decidido_em: new Date().toISOString(),
    },
    { onConflict: "nf_entrada_item_id" },
  );
  if (error) throw new Error(`Falha ao gravar decisão manual: ${error.message}`);
}

/** Desfaz a decisão manual e devolve o item ao que a regra automática disser. */
export async function voltarParaRegraAutomatica(nfEntradaItemId: string): Promise<void> {
  const alvo = db.from<DecisaoManualRow>("fis_item_decisao_manual") as unknown as {
    delete(): { eq(c: string, v: string): Promise<{ error: { message: string } | null }> };
  };
  const { error } = await alvo.delete().eq("nf_entrada_item_id", nfEntradaItemId);
  if (error) throw new Error(`Falha ao remover decisão manual: ${error.message}`);
}

export interface ApuracaoHistorico {
  competencia: string;
  status: "rascunho" | "fechada";
  calculadoEm: string | null;
  fechadaEm: string | null;
  fechadaPor: string | null;
  receitaBruta: number;
  debitoPisCofins: number;
  creditoPisCofins: number;
  retencoes: number;
  saldoPisCofins: number;
  debitoIcms: number;
  creditoIcms: number;
  saldoIcms: number;
}

interface ApuracaoLinhaRow {
  competencia: string;
  tributo: string;
  status: string;
  calculado_em: string | null;
  fechada_em: string | null;
  fechada_por: string | null;
  receita_bruta: number | null;
  valor_debito: number | null;
  valor_credito: number | null;
  valor_retencoes: number | null;
  saldo_a_recolher: number | null;
}

/**
 * Histórico das apurações já calculadas, uma linha por competência.
 *
 * A tabela guarda uma linha por tributo; aqui elas viram um mês só, que é
 * como se olha o fechamento. Existe para que ninguém precise reapurar para
 * lembrar quanto deu — e para que dê para ver se um mês foi recalculado
 * depois de fechado.
 */
export async function listarApuracoes(): Promise<ApuracaoHistorico[]> {
  const { data, error } = await db
    .from<ApuracaoLinhaRow>("fis_apuracao")
    .select(
      "competencia, tributo, status, calculado_em, fechada_em, fechada_por, " +
      "receita_bruta, valor_debito, valor_credito, valor_retencoes, saldo_a_recolher",
    );
  if (error) throw new Error(`Falha ao ler histórico: ${error.message}`);

  const porCompetencia = new Map<string, ApuracaoHistorico>();
  for (const l of data ?? []) {
    const atual = porCompetencia.get(l.competencia) ?? {
      competencia: l.competencia,
      status: "rascunho" as const,
      calculadoEm: l.calculado_em,
      fechadaEm: l.fechada_em,
      fechadaPor: l.fechada_por,
      receitaBruta: 0,
      debitoPisCofins: 0, creditoPisCofins: 0, retencoes: 0, saldoPisCofins: 0,
      debitoIcms: 0, creditoIcms: 0, saldoIcms: 0,
    };

    if (l.tributo === "ICMS") {
      atual.debitoIcms = Number(l.valor_debito) || 0;
      atual.creditoIcms = Number(l.valor_credito) || 0;
      atual.saldoIcms = Number(l.saldo_a_recolher) || 0;
    } else {
      atual.receitaBruta = Number(l.receita_bruta) || atual.receitaBruta;
      atual.debitoPisCofins += Number(l.valor_debito) || 0;
      atual.creditoPisCofins += Number(l.valor_credito) || 0;
      atual.retencoes += Number(l.valor_retencoes) || 0;
      atual.saldoPisCofins += Number(l.saldo_a_recolher) || 0;
    }
    // Fechada só quando todos os tributos do mês estão fechados.
    if (l.status === "fechada" && atual.status === "rascunho" && porCompetencia.has(l.competencia)) {
      atual.status = "fechada";
    } else if (l.status !== "fechada") {
      atual.status = "rascunho";
    }
    atual.calculadoEm = l.calculado_em ?? atual.calculadoEm;
    porCompetencia.set(l.competencia, atual);
  }

  return [...porCompetencia.values()].sort((a, b) => b.competencia.localeCompare(a.competencia));
}

/** Marca a competência como fechada, congelando o que foi apurado. */
export async function fecharCompetencia(competencia: string, quem: string): Promise<void> {
  const alvo = db.from<ApuracaoLinhaRow>("fis_apuracao") as unknown as {
    update(v: unknown): { eq(c: string, x: string): Promise<{ error: { message: string } | null }> };
  };
  const { error } = await alvo
    .update({ status: "fechada", fechada_em: new Date().toISOString(), fechada_por: quem })
    .eq("competencia", competencia);
  if (error) throw new Error(`Falha ao fechar competência: ${error.message}`);
}
