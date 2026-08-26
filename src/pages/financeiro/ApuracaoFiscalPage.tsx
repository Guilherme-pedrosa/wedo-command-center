import { Fragment, useEffect, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { formatCurrency } from "@/lib/format";
import { toast } from "sonner";
import {
  Calculator,
  RefreshCw,
  FileDown,
  AlertTriangle,
  Stethoscope,
  Save,
  Upload,
  History,
  Lock,
} from "lucide-react";
import {
  apurarCompetencia,
  salvarApuracao,
  diagnosticarEndpointsGC,
  type ResultadoApuracao,
  type DiagnosticoEndpoint,
  type LinhaCredito,
  decidirItemManualmente,
  voltarParaRegraAutomatica,
  listarApuracoes,
  fecharCompetencia,
  reapurarCadeia,
  type ApuracaoHistorico,
} from "@/lib/apuracaoService";
import { importarXmlFiscal, type ResultadoImportacao } from "@/lib/importarXmlFiscal";
import { exportarApuracaoXlsx } from "@/lib/exportarApuracao";

function ultimoDiaDoMes(competencia: string): string {
  const [ano, mes] = competencia.split("-").map(Number);
  return new Date(Date.UTC(ano, mes, 0)).toISOString().slice(0, 10);
}

function mesAtual(): string {
  return new Date().toISOString().slice(0, 7);
}

/** Linha do bloco de resultado, no formato exigido pelo fechamento. */
function Linha({
  rotulo,
  valor,
  destaque,
  nota,
}: {
  rotulo: string;
  valor: number;
  destaque?: boolean;
  nota?: string;
}) {
  return (
    <div
      className={`flex items-baseline justify-between gap-4 px-4 py-3 ${
        destaque ? "border-t-2 border-border bg-muted/40 font-bold" : "border-t border-border/50"
      }`}
    >
      <div className="min-w-0">
        <span className={destaque ? "text-foreground" : "text-muted-foreground"}>{rotulo}</span>
        {nota && <p className="mt-0.5 text-xs text-muted-foreground">{nota}</p>}
      </div>
      <span className={`shrink-0 tabular-nums ${destaque ? "text-lg" : ""}`}>
        {formatCurrency(valor)}
      </span>
    </div>
  );
}

export default function ApuracaoFiscalPage() {
  const [competencia, setCompetencia] = useState(mesAtual());
  const [resultado, setResultado] = useState<ResultadoApuracao | null>(null);
  const [carregando, setCarregando] = useState<string | null>(null);
  const [diagnostico, setDiagnostico] = useState<DiagnosticoEndpoint[] | null>(null);
  const [importacao, setImportacao] = useState<ResultadoImportacao | null>(null);
  const [progressoImport, setProgressoImport] = useState("");
  const [alternando, setAlternando] = useState<string | null>(null);
  const [historico, setHistorico] = useState<ApuracaoHistorico[]>([]);

  const competenciaIso = `${competencia}-01`;

  async function invocar(fn: string, body: Record<string, unknown>, rotulo: string) {
    setCarregando(rotulo);
    try {
      const { data, error } = await supabase.functions.invoke(fn, { body });
      if (error) throw error;
      if (data?.incompleto) {
        toast.warning(`${rotulo}: ${data.mensagem}`, { duration: 8000 });
      } else {
        toast.success(`${rotulo} concluído.`);
      }
      return data;
    } catch (e) {
      toast.error(`${rotulo} falhou: ${(e as Error)?.message ?? e}`);
      return null;
    } finally {
      setCarregando(null);
    }
  }

  const sincronizarSaidas = () =>
    invocar(
      "fis-sync-saida",
      { data_inicio: competenciaIso, data_fim: ultimoDiaDoMes(competencia) },
      "Sincronizar saídas",
    );

  const processarEntradas = () =>
    invocar(
      "fis-parse-entrada",
      { data_inicio: competenciaIso, data_fim: ultimoDiaDoMes(competencia) },
      "Processar XMLs de entrada",
    );

  async function carregarHistorico() {
    try {
      setHistorico(await listarApuracoes());
    } catch {
      // Histórico é informativo; falhar aqui não pode derrubar a apuração.
    }
  }

  useEffect(() => {
    void carregarHistorico();
  }, []);

  async function apurar() {
    setCarregando("Apurando");
    try {
      const r = await apurarCompetencia(competenciaIso);
      setResultado(r);
      // Grava sozinho: apuração que não fica registrada não serve de nada
      // quando alguém perguntar, meses depois, de onde saiu o número.
      await salvarApuracao(r);

      // O saldo credor encadeia: mexer num mês muda todos os seguintes.
      // Sem reapurar a frente, a cadeia fica desalinhada em silêncio.
      setCarregando("Reapurando meses seguintes");
      const mudancas = await reapurarCadeia(competenciaIso);
      await carregarHistorico();

      if (mudancas.length) {
        // Diz QUAL mes e QUAL tributo mudou: "3 competencias mudaram" nao
        // ajuda ninguem a conferir nem a refazer uma guia ja paga.
        const detalhe = mudancas
          .map(
            (m) =>
              m.competencia.slice(0, 7) +
              " " +
              m.tributo +
              ": " +
              formatCurrency(m.saldoAntes) +
              " → " +
              formatCurrency(m.saldoDepois),
          )
          .join(" · ");
        toast.success("Apuração registrada. Meses seguintes recalculados — " + detalhe, {
          duration: 15000,
        });
      } else {
        toast.success("Apuração calculada e registrada.");
      }
    } catch (e) {
      toast.error(`Apuração falhou: ${(e as Error)?.message ?? e}`);
    } finally {
      setCarregando(null);
    }
  }

  async function fechar() {
    if (!resultado) return;
    setCarregando("Fechando");
    try {
      const { data: sessao } = await supabase.auth.getUser();
      await fecharCompetencia(competenciaIso, sessao?.user?.email ?? "usuário");
      await carregarHistorico();
      toast.success(`Competência ${competencia} fechada.`);
    } catch (e) {
      toast.error(`Falha ao fechar: ${(e as Error)?.message ?? e}`);
    } finally {
      setCarregando(null);
    }
  }

  async function salvar() {
    if (!resultado) return;
    setCarregando("Salvando");
    try {
      await salvarApuracao(resultado);
      toast.success("Apuração gravada como rascunho.");
    } catch (e) {
      toast.error(`Falha ao gravar: ${(e as Error)?.message ?? e}`);
    } finally {
      setCarregando(null);
    }
  }

  async function handleImportarXml(e: React.ChangeEvent<HTMLInputElement>) {
    const arquivos = Array.from(e.target.files ?? []);
    e.target.value = "";
    if (!arquivos.length) return;

    setCarregando("Importando XMLs");
    setImportacao(null);
    try {
      const r = await importarXmlFiscal(arquivos, { onProgresso: setProgressoImport });
      setImportacao(r);
      if (r.erros.length) {
        toast.warning(
          `${r.xmlsEncontrados} XMLs lidos, ${r.erros.length} com erro. Veja o detalhe abaixo.`,
          { duration: 8000 },
        );
      } else {
        toast.success(
          `${r.xmlsEncontrados} XMLs importados: ${r.nfeEntrada} entradas, ` +
          `${r.nfeSaida + r.nfseSaida} saídas.`,
        );
      }
      if (r.competencias.length === 1) setCompetencia(r.competencias[0].slice(0, 7));
    } catch (err) {
      toast.error(`Importação falhou: ${(err as Error)?.message ?? err}`);
    } finally {
      setCarregando(null);
      setProgressoImport("");
    }
  }

  async function diagnosticar() {
    setCarregando("Diagnóstico");
    try {
      const r = await diagnosticarEndpointsGC(competenciaIso, ultimoDiaDoMes(competencia));
      setDiagnostico(r);
    } catch (e) {
      toast.error(`Diagnóstico falhou: ${(e as Error)?.message ?? e}`);
    } finally {
      setCarregando(null);
    }
  }

  async function exportar() {
    if (!resultado) return;
    setCarregando("Exportando");
    try {
      await exportarApuracaoXlsx(resultado);
      toast.success("Planilha gerada.");
    } catch (e) {
      toast.error(`Falha ao exportar: ${(e as Error)?.message ?? e}`);
    } finally {
      setCarregando(null);
    }
  }

  const criticas = resultado?.anomalias.filter((a) => a.severidade === "critico") ?? [];

  // NF-e e NFS-e sao livros fiscais diferentes: mercadoria tem CFOP e ICMS,
  // servico tem ISS municipal. Misturar numa lista so atrapalha a conferencia.
  const vendasProduto = (resultado?.linhasReceita ?? []).filter((l) => l.modelo !== "NFSE");
  const vendasServico = (resultado?.linhasReceita ?? []).filter((l) => l.modelo === "NFSE");

  /** Fora da base primeiro: é o que precisa de decisão, não o que já passou. */
  const creditosOrdenados = [...(resultado?.linhasCredito ?? [])].sort((a, b) => {
    if (a.decisao.permitido !== b.decisao.permitido) return a.decisao.permitido ? 1 : -1;
    return b.valorProduto - a.valorProduto;
  });

  async function alternarItem(linha: LinhaCredito, incluir: boolean) {
    setAlternando(linha.chave + "#" + linha.item);
    try {
      const { data: sessao } = await supabase.auth.getUser();
      const quem = sessao?.user?.email ?? "usuário";

      if (linha.decidoManualmente && incluir === linha.decisao.permitido) {
        await voltarParaRegraAutomatica(linha.chave, linha.item);
      } else {
        await decidirItemManualmente(linha.chave, linha.item, incluir, quem);
      }

      // Recalcula tudo: mexer num item muda base, crédito e saldo.
      const r = await apurarCompetencia(competenciaIso);
      setResultado(r);
      toast.success(
        `${linha.produto ?? "Item"} ${incluir ? "incluído na" : "removido da"} base.`,
      );
    } catch (e) {
      toast.error(`Não foi possível alterar: ${(e as Error)?.message ?? e}`);
    } finally {
      setAlternando(null);
    }
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Calculator className="h-6 w-6" />
            Apuração Fiscal
          </h1>
          <p className="text-sm text-muted-foreground">
            PIS/COFINS não-cumulativo (Lucro Real) e ICMS. Os números são para conferência
            da contabilidade — o sistema não emite nem transmite guia.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Input
            type="month"
            value={competencia}
            onChange={(e) => setCompetencia(e.target.value)}
            className="w-40"
          />
          <Button variant="outline" onClick={sincronizarSaidas} disabled={!!carregando}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Saídas
          </Button>
          <Button variant="outline" onClick={processarEntradas} disabled={!!carregando}>
            <RefreshCw className="mr-2 h-4 w-4" />
            Entradas
          </Button>
          <Button onClick={apurar} disabled={!!carregando}>
            <Calculator className="mr-2 h-4 w-4" />
            {carregando ?? "Apurar"}
          </Button>
        </div>
      </header>

      {/* Histórico: toda apuração calculada fica registrada, com data. */}
      {historico.length > 0 && (
        <section className="rounded-lg border border-border">
          <h2 className="flex items-center gap-2 border-b border-border px-4 py-3 font-semibold">
            <History className="h-4 w-4" />
            Apurações registradas
            <span className="text-sm font-normal text-muted-foreground">
              ({historico.length} competência{historico.length > 1 ? "s" : ""})
            </span>
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-left">
                <tr className="text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="p-2" colSpan={3}></th>
                  <th className="border-l border-border p-2 text-center" colSpan={3}>
                    PIS 1,65%
                  </th>
                  <th className="border-l border-border p-2 text-center" colSpan={3}>
                    COFINS 7,6%
                  </th>
                  <th className="border-l border-border p-2 text-center" colSpan={3}>
                    ICMS
                  </th>
                  <th className="p-2" colSpan={2}></th>
                </tr>
                <tr>
                  <th className="p-2">Competência</th>
                  <th className="p-2">Situação</th>
                  <th className="p-2 text-right">Receita</th>
                  <th className="border-l border-border p-2 text-right">Débito</th>
                  <th className="p-2 text-right">Crédito</th>
                  <th className="p-2 text-right">Saldo</th>
                  <th className="border-l border-border p-2 text-right">Débito</th>
                  <th className="p-2 text-right">Crédito</th>
                  <th className="p-2 text-right">Saldo</th>
                  <th className="border-l border-border p-2 text-right">Débito</th>
                  <th className="p-2 text-right">Crédito</th>
                  <th className="p-2 text-right">Saldo</th>
                  <th className="p-2">Calculado em</th>
                  <th className="p-2"></th>
                </tr>
              </thead>
              <tbody>
                {historico.map((h) => (
                  <tr
                    key={h.competencia}
                    className={`border-t border-border/50 ${
                      h.competencia === competenciaIso ? "bg-muted/30" : ""
                    }`}
                  >
                    <td className="p-2 font-medium">{h.competencia.slice(0, 7)}</td>
                    <td className="p-2">
                      {h.status === "fechada" ? (
                        <Badge>fechada</Badge>
                      ) : (
                        <Badge variant="secondary">rascunho</Badge>
                      )}
                    </td>
                    <td className="p-2 text-right tabular-nums">{formatCurrency(h.receitaBruta)}</td>
                    {([h.pis, h.cofins, h.icms] as const).map((t, i) => (
                      <Fragment key={i}>
                        <td className="border-l border-border p-2 text-right tabular-nums">
                          {formatCurrency(t.debito)}
                        </td>
                        <td className="p-2 text-right tabular-nums">{formatCurrency(t.credito)}</td>
                        <td className="p-2 text-right font-semibold tabular-nums">
                          {t.saldo > 0 ? (
                            formatCurrency(t.saldo)
                          ) : t.credor > 0 ? (
                            <span
                              className="font-normal text-emerald-500"
                              title="Crédito não aproveitado. Abate os meses seguintes (Lei 10.833/2003, art. 3º, § 4º)."
                            >
                              credor {formatCurrency(t.credor)}
                            </span>
                          ) : (
                            formatCurrency(0)
                          )}
                        </td>
                      </Fragment>
                    ))}
                    <td className="p-2 text-xs text-muted-foreground">
                      {h.calculadoEm ? new Date(h.calculadoEm).toLocaleString("pt-BR") : "—"}
                      {h.fechadaEm && (
                        <p className="mt-0.5">
                          Fechada por {h.fechadaPor} em{" "}
                          {new Date(h.fechadaEm).toLocaleDateString("pt-BR")}
                        </p>
                      )}
                    </td>
                    <td className="p-2 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setCompetencia(h.competencia.slice(0, 7))}
                        disabled={h.competencia === competenciaIso}
                      >
                        abrir
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
            "Credor" não é zero: é crédito que sobrou porque as entradas superaram
            as saídas no mês. Ele não se perde — abate o saldo da competência
            seguinte automaticamente.
          </p>
        </section>
      )}

      {/* Importação direta de XML — o caminho que não depende do GestãoClick. */}
      <section className="rounded-lg border-2 border-dashed border-border p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-2xl">
            <h2 className="flex items-center gap-2 font-semibold">
              <Upload className="h-4 w-4" />
              Importar XMLs
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Suba o .zip da SEFAZ (aceita zip dentro de zip) ou XMLs soltos. O sistema
              identifica sozinho o que é entrada, saída e nota de serviço, comparando o
              CNPJ do emitente com o da empresa — sem consultar o GestãoClick.
            </p>
          </div>
          <label className="shrink-0">
            <input
              type="file"
              accept=".xml,.zip"
              multiple
              className="hidden"
              onChange={handleImportarXml}
              disabled={!!carregando}
            />
            <span
              className={`inline-flex cursor-pointer items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground ${
                carregando ? "pointer-events-none opacity-50" : ""
              }`}
            >
              <Upload className="mr-2 h-4 w-4" />
              Escolher arquivos
            </span>
          </label>
        </div>

        {progressoImport && (
          <p className="mt-3 text-sm text-muted-foreground">{progressoImport}</p>
        )}

        {importacao && (
          <div className="mt-4 space-y-3">
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                { rotulo: "XMLs lidos", valor: importacao.xmlsEncontrados },
                { rotulo: "NF-e de entrada", valor: importacao.nfeEntrada },
                { rotulo: "Saídas (NF-e + NFS-e)", valor: importacao.nfeSaida + importacao.nfseSaida },
                { rotulo: "Itens gravados", valor: importacao.itensGravados },
              ].map((c) => (
                <div key={c.rotulo} className="rounded border border-border/60 p-3">
                  <p className="text-2xl font-semibold tabular-nums">{c.valor}</p>
                  <p className="text-xs text-muted-foreground">{c.rotulo}</p>
                </div>
              ))}
            </div>

            <p className="text-sm text-muted-foreground">
              {importacao.zipsAninhados > 0 && `${importacao.zipsAninhados} zip(s) aninhado(s). `}
              {importacao.jaExistiam > 0 &&
                `${importacao.jaExistiam} nota(s) já estavam na base e foram atualizadas em vez de duplicadas. `}
              {importacao.nfseEntrada > 0 &&
                `${importacao.nfseEntrada} NFS-e recebida(s) de terceiro ignorada(s). `}
              {importacao.ignorados > 0 && `${importacao.ignorados} arquivo(s) não reconhecido(s). `}
              {importacao.competencias.length > 0 &&
                `Competência(s): ${importacao.competencias.map((c) => c.slice(0, 7)).join(", ")}.`}
            </p>

            {importacao.erros.length > 0 && (
              <details className="rounded border border-destructive/50 bg-destructive/10 p-3">
                <summary className="cursor-pointer text-sm font-medium text-destructive">
                  {importacao.erros.length} arquivo(s) com erro
                </summary>
                <ul className="mt-2 space-y-1 text-xs">
                  {importacao.erros.slice(0, 30).map((e, i) => (
                    <li key={i} className="font-mono">
                      {e.arquivo}: {e.motivo}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
      </section>

      {/* Diagnóstico: confirma que a API do GC entrega os campos assumidos. */}
      <details className="rounded-lg border border-border">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium">
          <Stethoscope className="mr-2 inline h-4 w-4" />
          Diagnóstico da API do GestãoClick
          <span className="ml-2 font-normal text-muted-foreground">
            — rode antes do primeiro fechamento
          </span>
        </summary>
        <div className="space-y-3 border-t border-border p-4">
          <Button size="sm" variant="outline" onClick={diagnosticar} disabled={!!carregando}>
            Testar endpoints fiscais
          </Button>
          {diagnostico?.map((d) => (
            <div key={d.endpoint} className="rounded border border-border/60 p-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="font-medium">{d.nome}</span>
                {d.erro ? (
                  <Badge variant="destructive">erro</Badge>
                ) : d.camposFaltando.length === 0 ? (
                  <Badge>ok — {d.totalRegistros} registros</Badge>
                ) : (
                  <Badge variant="destructive">
                    faltam {d.camposFaltando.length} campo(s)
                  </Badge>
                )}
              </div>
              <p className="mt-1 font-mono text-xs text-muted-foreground">{d.endpoint}</p>
              {d.erro && <p className="mt-1 text-xs text-destructive">{d.erro}</p>}
              {d.camposFaltando.length > 0 && !d.erro && (
                <p className="mt-1 text-xs text-destructive">
                  Ausentes na resposta: {d.camposFaltando.join(", ")} — a apuração depende
                  destes campos.
                </p>
              )}
            </div>
          ))}
        </div>
      </details>

      {!resultado && (
        <div className="rounded-lg border border-dashed border-border p-10 text-center text-sm text-muted-foreground">
          Escolha a competência, sincronize saídas e entradas, depois clique em Apurar.
        </div>
      )}

      {resultado && (
        <>
          {criticas.length > 0 && (
            <div className="flex items-start gap-3 rounded-lg border border-destructive/50 bg-destructive/10 p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
              <div className="text-sm">
                <p className="font-semibold text-destructive">
                  {criticas.length} pendência(s) crítica(s) — não feche a competência assim.
                </p>
                <p className="text-muted-foreground">
                  Itens sem CST, sem CFOP ou com regime do fornecedor indefinido ficaram
                  FORA do crédito. O saldo abaixo está subestimado até que sejam resolvidos.
                </p>
              </div>
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-2">
            <section className="rounded-lg border border-border">
              <h2 className="border-b border-border px-4 py-3 font-semibold">
                PIS/COFINS — competência {resultado.competencia.slice(0, 7)}
              </h2>
              <Linha rotulo="Receita Bruta Tributável" valor={resultado.receitaBruta} />
              <Linha
                rotulo="Débito Apurado (PIS/COFINS)"
                valor={resultado.pis.valorDebito + resultado.cofins.valorDebito}
                nota={`PIS ${formatCurrency(resultado.pis.valorDebito)} + COFINS ${formatCurrency(resultado.cofins.valorDebito)}`}
              />
              <Linha
                rotulo="Base de Crédito de Insumos Válida"
                valor={resultado.baseCredito}
                nota={
                  resultado.baseCreditoSimples > 0
                    ? `Inclui ${formatCurrency(resultado.baseCreditoSimples)} resgatados do Simples Nacional (Regra 2.4)`
                    : "Nenhuma fração resgatada do Simples Nacional"
                }
              />
              <Linha
                rotulo="Crédito Apurado (PIS/COFINS)"
                valor={resultado.pis.valorCredito + resultado.cofins.valorCredito}
                nota={`PIS ${formatCurrency(resultado.pis.valorCredito)} + COFINS ${formatCurrency(resultado.cofins.valorCredito)}`}
              />
              <Linha
                rotulo="Retenções na Fonte (Caixa)"
                valor={resultado.totalRetencaoPis + resultado.totalRetencaoCofins}
                nota={`${resultado.retencoes.length} liquidação(ões) no mês`}
              />
              {(resultado.pis.saldoCredorAnterior > 0 ||
                resultado.cofins.saldoCredorAnterior > 0) && (
                <Linha
                  rotulo="Saldo credor do mês anterior"
                  valor={
                    resultado.pis.saldoCredorAnterior + resultado.cofins.saldoCredorAnterior
                  }
                />
              )}
              <Linha
                rotulo="SALDO FINAL A RECOLHER (DARF)"
                valor={resultado.saldoTotalPisCofins}
                destaque
              />
              {(resultado.pis.saldoCredorProximo > 0 ||
                resultado.cofins.saldoCredorProximo > 0) && (
                <Linha
                  rotulo="Saldo credor a transportar"
                  valor={
                    resultado.pis.saldoCredorProximo + resultado.cofins.saldoCredorProximo
                  }
                  nota="Crédito excedeu o débito — nada a recolher neste mês"
                />
              )}
            </section>

            <section className="rounded-lg border border-border">
              <h2 className="border-b border-border px-4 py-3 font-semibold">ICMS</h2>
              <Linha
                rotulo="Débito destacado nas saídas"
                valor={resultado.icms.valorDebito}
                nota="Soma do ICMS das notas autorizadas"
              />
              <Linha
                rotulo="Crédito destacado nas entradas"
                valor={resultado.icms.valorCredito}
                nota="Fornecedor do Simples não transfere crédito de ICMS"
              />
              {resultado.icms.saldoCredorAnterior > 0 && (
                <Linha
                  rotulo="Saldo credor anterior"
                  valor={resultado.icms.saldoCredorAnterior}
                />
              )}
              <Linha rotulo="SALDO DE ICMS A RECOLHER" valor={resultado.icms.saldoARecolher} destaque />
              {resultado.icms.saldoCredorProximo > 0 && (
                <Linha
                  rotulo="Saldo credor a transportar"
                  valor={resultado.icms.saldoCredorProximo}
                />
              )}
              <div className="border-t border-border px-4 py-3 text-xs text-muted-foreground">
                ICMS é apurado por confronto do que foi efetivamente destacado, não por
                alíquota única — cada item varia conforme UF de destino e NCM. DIFAL e
                ICMS-ST são capturados por item mas não entram neste confronto: têm guia
                própria.
              </div>
            </section>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button onClick={salvar} disabled={!!carregando} variant="outline">
              <Save className="mr-2 h-4 w-4" />
              Regravar
            </Button>
            <Button onClick={fechar} disabled={!!carregando} variant="outline">
              <Lock className="mr-2 h-4 w-4" />
              Fechar competência
            </Button>
            <Button onClick={exportar} variant="outline">
              <FileDown className="mr-2 h-4 w-4" />
              Exportar planilha
            </Button>
            <span className="text-sm text-muted-foreground">
              {resultado.contadores.notasSaidaNaBase}/{resultado.contadores.notasSaida} notas de
              saída na base · {resultado.contadores.itensComCredito}/
              {resultado.contadores.itensEntrada} itens de entrada com crédito
              {resultado.contadores.itensParaRevisao > 0 &&
                ` · ${resultado.contadores.itensParaRevisao} para revisão`}
            </span>
          </div>

          <Tabs defaultValue="anomalias">
            <TabsList>
              <TabsTrigger value="anomalias">
                Anomalias ({resultado.anomalias.length})
              </TabsTrigger>
              <TabsTrigger value="creditos">
                Créditos ({resultado.linhasCredito.length})
              </TabsTrigger>
              <TabsTrigger value="receita">
                Vendas NF-e ({vendasProduto.length})
              </TabsTrigger>
              <TabsTrigger value="servicos">
                Serviços NFS-e ({vendasServico.length})
              </TabsTrigger>
              <TabsTrigger value="retencoes">
                Retenções ({resultado.retencoes.length})
              </TabsTrigger>
            </TabsList>

            <TabsContent value="anomalias">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2">Severidade</th>
                      <th className="p-2">Tipo</th>
                      <th className="p-2">Referência</th>
                      <th className="p-2">Descrição</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.anomalias.length === 0 && (
                      <tr>
                        <td colSpan={4} className="p-4 text-center text-muted-foreground">
                          Nenhuma anomalia nesta competência.
                        </td>
                      </tr>
                    )}
                    {resultado.anomalias.map((a, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="p-2">
                          <Badge
                            variant={a.severidade === "critico" ? "destructive" : "secondary"}
                          >
                            {a.severidade}
                          </Badge>
                        </td>
                        <td className="p-2 font-mono text-xs">{a.tipo}</td>
                        <td className="p-2 font-mono text-xs">{a.referencia}</td>
                        <td className="p-2">{a.descricao}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <TabsContent value="creditos">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2 text-center">Na base</th>
                      <th className="p-2">Fornecedor</th>
                      <th className="p-2">NF</th>
                      <th className="p-2">Emissão</th>
                      <th className="p-2">Regime</th>
                      <th className="p-2">Item</th>
                      <th className="p-2">CFOP</th>
                      <th className="p-2">Pedido</th>
                      <th className="p-2 text-right">Valor</th>
                      <th className="p-2 text-right">Desconto</th>
                      <th className="p-2">CST PIS/COF</th>
                      <th className="p-2 text-right">Base PIS/COF</th>
                      <th className="p-2">CST ICMS</th>
                      <th className="p-2 text-right">Créd. ICMS</th>
                      <th className="p-2">Motivo</th>
                      <th className="p-2">Chave de Acesso</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditosOrdenados.map((l, i) => (
                      <tr
                        key={l.chave + "#" + l.item}
                        className={`border-t border-border/50 align-top ${
                          l.decisao.permitido ? "" : "bg-muted/30"
                        }`}
                      >
                        <td className="p-2 text-center">
                          <input
                            type="checkbox"
                            className="h-4 w-4 cursor-pointer accent-primary"
                            checked={l.decisao.permitido}
                            disabled={alternando === l.chave + "#" + l.item}
                            onChange={(ev) => alternarItem(l, ev.target.checked)}
                            title={
                              l.decidoManualmente
                                ? "Decidido manualmente — desmarcar volta para a regra"
                                : "Marque para incluir na base de crédito"
                            }
                          />
                          {l.decidoManualmente && (
                            <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                              manual
                            </p>
                          )}
                        </td>
                        <td className="p-2">{l.fornecedor}</td>
                        <td className="p-2 whitespace-nowrap font-mono text-xs">
                          {l.numero ?? "—"}
                          {l.serie ? <span className="text-muted-foreground">/{l.serie}</span> : null}
                        </td>
                        <td className="p-2 whitespace-nowrap text-xs">
                          {l.dataEmissao
                            ? l.dataEmissao.slice(0, 10).split("-").reverse().join("/")
                            : "—"}
                        </td>
                        <td className="p-2">
                          <Badge variant="secondary">{l.regime}</Badge>
                        </td>
                        <td className="p-2">{l.produto}</td>
                        <td className="p-2 font-mono text-xs">{l.cfop}</td>
                        <td className="p-2 text-xs">
                          {l.temPedidoCompra ? (
                            <Badge>sim</Badge>
                          ) : (
                            <span className="text-muted-foreground">não</span>
                          )}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCurrency(l.valorProduto)}
                        </td>
                        <td className="p-2 text-right tabular-nums text-muted-foreground">
                          {l.valorDesconto > 0 ? "-" + formatCurrency(l.valorDesconto) : "—"}
                        </td>
                        <td className="p-2 font-mono text-xs">{l.cstPisCofins ?? "—"}</td>
                        <td className="p-2 text-right tabular-nums">
                          {l.decisao.permitido ? formatCurrency(l.decisao.base) : "—"}
                        </td>
                        <td className="p-2 font-mono text-xs">{l.cstIcms ?? "—"}</td>
                        <td className="p-2 text-right tabular-nums">
                          {l.decisaoIcms.permitido ? formatCurrency(l.decisaoIcms.base) : "—"}
                        </td>
                        <td className="p-2 text-xs text-muted-foreground">
                          <p>
                            <span className="font-medium text-foreground">PIS/COF:</span>{" "}
                            {l.decisao.motivo}
                          </p>
                          <p className="mt-1">
                            <span className="font-medium text-foreground">ICMS:</span>{" "}
                            {l.decisaoIcms.motivo}
                          </p>
                        </td>
                        <td className="p-2 font-mono text-[10px] leading-tight text-muted-foreground">
                          {l.chave}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <TabsContent value="receita">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2">Modelo</th>
                      <th className="p-2">Número</th>
                      <th className="p-2">Cliente</th>
                      <th className="p-2">CFOP</th>
                      <th className="p-2 text-right">Valor</th>
                      <th className="p-2">Na base?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendasProduto.map((l, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="p-2">{l.modelo}</td>
                        <td className="p-2">{l.numero}</td>
                        <td className="p-2">{l.cliente}</td>
                        <td className="p-2 font-mono text-xs">{l.cfop ?? l.natureza}</td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCurrency(l.valor)}
                        </td>
                        <td className="p-2 text-xs">
                          {l.compoe ? (
                            <Badge>sim</Badge>
                          ) : (
                            <span className="text-muted-foreground">{l.motivo}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <TabsContent value="servicos">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2">NFS-e</th>
                      <th className="p-2">Tomador</th>
                      <th className="p-2">Discriminação</th>
                      <th className="p-2 text-right">Valor do serviço</th>
                      <th className="p-2">Na base?</th>
                    </tr>
                  </thead>
                  <tbody>
                    {vendasServico.map((l, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="p-2">{l.numero}</td>
                        <td className="p-2">{l.cliente}</td>
                        <td className="p-2 text-xs text-muted-foreground">{l.natureza}</td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCurrency(l.valor)}
                        </td>
                        <td className="p-2 text-xs">
                          {l.compoe ? (
                            <Badge>sim</Badge>
                          ) : (
                            <span className="text-muted-foreground">{l.motivo}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>

            <TabsContent value="retencoes">
              <div className="overflow-x-auto rounded-lg border border-border">
                <table className="w-full text-sm">
                  <thead className="bg-muted/50 text-left">
                    <tr>
                      <th className="p-2">NFS-e</th>
                      <th className="p-2">Cliente</th>
                      <th className="p-2">Liquidação</th>
                      <th className="p-2 text-right">Valor recebido</th>
                      <th className="p-2 text-right">% da nota</th>
                      <th className="p-2 text-right">PIS retido</th>
                      <th className="p-2 text-right">COFINS retido</th>
                    </tr>
                  </thead>
                  <tbody>
                    {resultado.retencoes.length === 0 && (
                      <tr>
                        <td colSpan={7} className="p-4 text-center text-muted-foreground">
                          Nenhuma retenção liquidada nesta competência.
                        </td>
                      </tr>
                    )}
                    {resultado.retencoes.map((r, i) => (
                      <tr key={i} className="border-t border-border/50">
                        <td className="p-2">{r.nfNumero}</td>
                        <td className="p-2">{r.nomeCliente}</td>
                        <td className="p-2">{r.dataLiquidacao}</td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCurrency(r.valorBase)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {(r.proporcao * 100).toFixed(1)}%
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCurrency(r.valorPisRetido)}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {formatCurrency(r.valorCofinsRetido)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </TabsContent>
          </Tabs>
        </>
      )}
    </div>
  );
}
