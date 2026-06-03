import { useState, useMemo, useRef, useEffect, Fragment } from "react";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Slider } from "@/components/ui/slider";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter } from "@/components/ui/dialog";
import { Loader2, Search, Calculator, Package, TrendingUp, AlertTriangle, DollarSign, BarChart3, RefreshCw, FileText, Info, ShoppingCart, Wrench, Upload, Pencil, Plus } from "lucide-react";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency } from "@/lib/format";
import toast from "react-hot-toast";

// ── Types ──
interface GCProduto {
  id: string;
  nome: string;
  codigo?: string;
  codigo_interno?: string;
  estoque: number | string;
  valor_custo: string;
  valor_venda: string;
  nome_grupo?: string;
  ncm?: string;
  unidade?: string;
}

interface ProdutoTributo {
  gc_produto_id: string;
  nome_produto: string;
  ncm: string | null;
  cfop: string | null;
  nf_numero: string | null;
  nf_chave: string | null;
  nf_data_emissao: string | null;
  fornecedor_nome: string | null;
  compra_codigo: string | null;
  regime_fornecedor: string | null;
  sem_credito: boolean | null;
  match_rule: string | null;
  icms_aliquota: number;
  icms_aliquota_manual: number | null;
  pis_aliquota: number;
  pis_aliquota_manual: number | null;
  cofins_aliquota: number;
  cofins_aliquota_manual: number | null;
  ipi_aliquota: number;
  ipi_aliquota_manual: number | null;
  frete_percentual: number;
  valor_unitario_nf: number;
  valor_icms_unit: number;
  valor_pis_unit: number;
  valor_cofins_unit: number;
  valor_ipi_unit: number;
  valor_frete_unit: number;
  custo_efetivo_unit: number;
}

type TipoSaida = "venda" | "servico";

interface TaxConfigEntrada {
  icmsCredito: number;   // Crédito ICMS entrada (%)
  pisCredito: number;    // Crédito PIS entrada (%)
  cofinsCredito: number; // Crédito COFINS entrada (%)
  frete: number;         // Frete (% custo)
  custoFixoUnit: number; // Custo fixo por unidade (R$)
}

interface TaxConfigSaida {
  // Venda de produto
  icmsSaida: number;     // ICMS saída (%)
  pisSaida: number;      // PIS saída (%)
  cofinsSaida: number;   // COFINS saída (%)
  // Serviço
  iss: number;           // ISS (%)
  pisSaidaServico: number;
  cofinsSaidaServico: number;
  // Comum
  irpjCsll: number;     // IRPJ+CSLL sobre lucro (%)
}

const DEFAULT_ENTRADA: TaxConfigEntrada = {
  icmsCredito: 18,
  pisCredito: 1.65,
  cofinsCredito: 7.6,
  frete: 5,
  custoFixoUnit: 0,
};

const DEFAULT_SAIDA: TaxConfigSaida = {
  icmsSaida: 8.8,
  pisSaida: 1.65,
  cofinsSaida: 7.6,
  iss: 3.65,
  pisSaidaServico: 1.65,
  cofinsSaidaServico: 7.6,
  irpjCsll: 0, // Desconsiderado no custo da peça — incide sobre lucro da empresa, não do produto
};

// ── Helpers ──
function calcPricing(
  custoBruto: number,
  entrada: TaxConfigEntrada,
  saida: TaxConfigSaida,
  tipo: TipoSaida,
  margemDesejada: number,
  custoFixoPct: number = 0 // fração (0.08 = 8%) — entra no DIVISOR do mark-up
) {
  // Sem NF para consultar → NUNCA inferir crédito de entrada. Zerado.
  const creditoIcms = 0;
  const creditoPis = 0;
  const creditoCofins = 0;
  const totalCreditosEntrada = 0;

  const custoLiquido = custoBruto - totalCreditosEntrada;
  const custoFrete = custoBruto * (entrada.frete / 100);
  // custoFixoUnit (override flat manual) ainda soma direto no custo, se setado.
  // O rateio proporcional (custoFixoPct) é embutido NO DIVISOR — não no custo.
  const custoTotal = custoLiquido + custoFrete + entrada.custoFixoUnit;

  // Alíquotas de saída (incidem sobre faturamento)
  let aliquotaSaidaFaturamento: number;
  if (tipo === "venda") {
    aliquotaSaidaFaturamento = (saida.icmsSaida + saida.pisSaida + saida.cofinsSaida) / 100;
  } else {
    aliquotaSaidaFaturamento = (saida.iss + saida.pisSaidaServico + saida.cofinsSaidaServico) / 100;
  }

  const irpjPct = saida.irpjCsll / 100;

  const margemDecimal = margemDesejada / 100;
  // Mark-up Divisor (padrão de mercado para custo fixo):
  // Preço = CustoTotal / (1 - tributos_saida - custoFixo% - margem)
  // CustoFixo% = CustoFixoMensal / FaturamentoMensalMédio
  // Assim, cada R$ vendido contribui na mesma proporção pra cobrir o custo fixo.
  const divisor = 1 - aliquotaSaidaFaturamento - custoFixoPct - margemDecimal;
  // Safety: divisor pequeno gera preços absurdos. Trava em no máx 5x o custo.
  const PRECO_MAX_MULTIPLICADOR = 5;
  const precoMinimoCalculado = divisor > 0.05 ? custoTotal / divisor : custoTotal * PRECO_MAX_MULTIPLICADOR;
  const precoMinimo = Math.min(precoMinimoCalculado, custoTotal * PRECO_MAX_MULTIPLICADOR);

  const tributosSaida = precoMinimo * aliquotaSaidaFaturamento;
  const custoFixoEmbutido = precoMinimo * custoFixoPct;
  const lucroAnteIR = precoMinimo - custoTotal - tributosSaida - custoFixoEmbutido;
  const impostoRenda = Math.max(0, lucroAnteIR * irpjPct);
  const lucroLiquido = lucroAnteIR - impostoRenda;

  return {
    creditoIcms,
    creditoPis,
    creditoCofins,
    totalCreditosEntrada,
    custoLiquido,
    custoFrete,
    custoTotal,
    precoMinimo,
    tributosSaida,
    custoFixoEmbutido,
    impostoRenda,
    lucroAnteIR,
    lucroLiquido,
    margemReal: precoMinimo > 0 ? (lucroLiquido / precoMinimo) * 100 : 0,
    aliquotaSaidaFaturamento,
    custoFixoPct,
  };
}

// Get effective aliquota (manual override > NF sync value; sem_credito zeroes all)
function getEffectiveRates(t: ProdutoTributo) {
  const semCredito = t.sem_credito || t.regime_fornecedor === "simples_nacional";
  return {
    icms: semCredito ? 0 : (t.icms_aliquota_manual ?? t.icms_aliquota),
    pis: semCredito ? 0 : (t.pis_aliquota_manual ?? t.pis_aliquota),
    cofins: semCredito ? 0 : (t.cofins_aliquota_manual ?? t.cofins_aliquota),
    ipi: t.ipi_aliquota_manual ?? t.ipi_aliquota,
    semCredito,
  };
}

function normalizeForMatch(value?: string | null) {
  return (value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isTributoCompativelComProduto(produto: GCProduto, tributo?: ProdutoTributo) {
  if (!tributo) return false;
  return tributo.gc_produto_id === produto.id;
}

/**
 * Detecta quando o valor_unitario_nf representa um KIT/embalagem maior do que a
 * unidade que o GC vende. Heurística: ratio nf/gc >= 2 e desvio do múltiplo
 * inteiro mais próximo <= 25% — significa que a NF veio em kit (ex.: caixa,
 * milheiro) e o preço unitário precisa ser dividido para casar com a unidade GC.
 * Retorna 1 quando não é kit (ou quando faltam dados pra inferir).
 */
function detectKitRatio(tributo: ProdutoTributo | undefined, gcCusto: number): number {
  if (!tributo || !gcCusto || gcCusto <= 0) return 1;
  const nfUnit = Number(tributo.valor_unitario_nf) || 0;
  if (nfUnit <= 0) return 1;
  const ratio = nfUnit / gcCusto;
  if (ratio < 1.8) return 1;
  const r = Math.round(ratio);
  if (r < 2) return 1;
  const dev = Math.abs(nfUnit - r * gcCusto) / nfUnit;
  if (dev > 0.25) return 1;
  return r;
}

function ajustarTributoPorKit(tributo: ProdutoTributo, ratio: number): ProdutoTributo {
  if (ratio <= 1) return tributo;
  return {
    ...tributo,
    valor_unitario_nf: (Number(tributo.valor_unitario_nf) || 0) / ratio,
    valor_icms_unit: (Number(tributo.valor_icms_unit) || 0) / ratio,
    valor_pis_unit: (Number(tributo.valor_pis_unit) || 0) / ratio,
    valor_cofins_unit: (Number(tributo.valor_cofins_unit) || 0) / ratio,
    valor_ipi_unit: (Number(tributo.valor_ipi_unit) || 0) / ratio,
    valor_frete_unit: (Number(tributo.valor_frete_unit) || 0) / ratio,
    custo_efetivo_unit: (Number(tributo.custo_efetivo_unit) || 0) / ratio,
  };
}


function calcPricingWithNF(
  tributo: ProdutoTributo,
  saida: TaxConfigSaida,
  tipo: TipoSaida,
  custoFixo: number,
  margemDesejada: number,
  custoFixoPct: number = 0,
  custoBaseUnit?: number
) {
  const eff = getEffectiveRates(tributo);
  const valorUnit = custoBaseUnit && custoBaseUnit > 0 ? custoBaseUnit : tributo.valor_unitario_nf;
  
  const creditoIcms = tipo === "servico" ? 0 : valorUnit * (eff.icms / 100);
  const creditoPis = tipo === "servico" ? 0 : valorUnit * (eff.pis / 100);
  const creditoCofins = tipo === "servico" ? 0 : valorUnit * (eff.cofins / 100);
  const ipiUnit = valorUnit * (eff.ipi / 100);
  const freteUnit = valorUnit * ((tributo.frete_percentual || 0) / 100);
  
  const custoEfetivo = valorUnit + ipiUnit + freteUnit - creditoIcms - creditoPis - creditoCofins;
  const custoTotal = custoEfetivo + custoFixo; // custoFixo aqui = override flat manual

  let aliquotaSaidaFaturamento: number;
  if (tipo === "venda") {
    aliquotaSaidaFaturamento = (saida.icmsSaida + saida.pisSaida + saida.cofinsSaida) / 100;
  } else {
    aliquotaSaidaFaturamento = (saida.iss + saida.pisSaidaServico + saida.cofinsSaidaServico) / 100;
  }

  const irpjPct = saida.irpjCsll / 100;
  const margemDecimal = margemDesejada / 100;
  // Mark-up Divisor com custo fixo embutido
  const divisor = 1 - aliquotaSaidaFaturamento - custoFixoPct - margemDecimal;
  // Safety: divisor pequeno gera preços absurdos. Trava em no máx 5x o custo.
  const PRECO_MAX_MULTIPLICADOR = 5;
  const precoMinimoCalculado = divisor > 0.05 ? custoTotal / divisor : custoTotal * PRECO_MAX_MULTIPLICADOR;
  const precoMinimo = Math.min(precoMinimoCalculado, custoTotal * PRECO_MAX_MULTIPLICADOR);

  const tributosSaida = precoMinimo * aliquotaSaidaFaturamento;
  const custoFixoEmbutido = precoMinimo * custoFixoPct;
  const lucroAnteIR = precoMinimo - custoTotal - tributosSaida - custoFixoEmbutido;
  const impostoRenda = Math.max(0, lucroAnteIR * irpjPct);
  const lucroLiquido = lucroAnteIR - impostoRenda;

  return {
    creditoIcms,
    creditoPis,
    creditoCofins,
    totalCreditosEntrada: creditoIcms + creditoPis + creditoCofins,
    custoEfetivo,
    custoTotal,
    precoMinimo,
    tributosSaida,
    custoFixoEmbutido,
    impostoRenda,
    lucroAnteIR,
    lucroLiquido,
    aliquotaSaidaFaturamento,
    custoFixoPct,
  };
}

export default function PrecificacaoPage() {
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");
  const [marginFilter, setMarginFilter] = useState<"todos" | "fora" | "negativa">("todos");
  const [grupoFilter, setGrupoFilter] = useState<string>("todos");
  const [page, setPage] = useState(1);
  const PAGE_SIZE = 50;
  const [taxEntrada, setTaxEntrada] = useState<TaxConfigEntrada>(DEFAULT_ENTRADA);
  const [taxSaida, setTaxSaida] = useState<TaxConfigSaida>(DEFAULT_SAIDA);
  const [tipoSaidaGlobal, setTipoSaidaGlobal] = useState<TipoSaida>("venda");
  const [margemAlvo, setMargemAlvo] = useState(30);
  // Override manual do % de custo fixo (vazio = usa rateio auto cap'd em CUSTO_FIXO_PCT_MAX)
  const [custoFixoPctOverride, setCustoFixoPctOverride] = useState<string>("");
  const [tabelaVenda, setTabelaVenda] = useState<"A" | "B" | "P">("B");
  // MARKUP_TABELAS removido — tabelas vêm de fin_politica_markup_tabela (dinâmico)
  const [activeSync, setActiveSync] = useState<"gc" | "offline" | null>(null);
  const [calcCusto, setCalcCusto] = useState<string>("");
  const [calcTipoSaida, setCalcTipoSaida] = useState<TipoSaida>("venda");
  const [calcMargens] = useState([10, 15, 20, 25, 30]);
  // Override de ICMS de saída na Calculadora (vazio = usa o global do header)
  const [calcIcmsSaida, setCalcIcmsSaida] = useState<string>("");
  // Override de ICMS de saída por produto na tabela (Map<gc_produto_id, %>)
  const [icmsSaidaOverrides, setIcmsSaidaOverrides] = useState<Map<string, number>>(new Map());
  const activeSyncRef = useRef<"gc" | "offline" | null>(null);

  // ── Manual tributo (crédito manual quando não há NF) ──
  const [manualTributoOpen, setManualTributoOpen] = useState(false);
  const [manualTributoProduto, setManualTributoProduto] = useState<GCProduto | null>(null);
  const [manualTributoForm, setManualTributoForm] = useState({
    valor_unitario_nf: "",
    icms_aliquota: "",
    pis_aliquota: "1.65",
    cofins_aliquota: "7.60",
    ipi_aliquota: "0",
    frete_percentual: "0",
    fornecedor_nome: "",
    nf_numero: "",
    regime: "normal" as "normal" | "simples_nacional",
  });
  const [savingManualTributo, setSavingManualTributo] = useState(false);

  function abrirManualTributo(produto: GCProduto, existente?: ProdutoTributo) {
    setManualTributoProduto(produto);
    setManualTributoForm({
      valor_unitario_nf: existente ? String(existente.valor_unitario_nf || "") : String(Number(produto.valor_custo) || ""),
      icms_aliquota: existente ? String(existente.icms_aliquota_manual ?? existente.icms_aliquota ?? "") : "",
      pis_aliquota: existente ? String(existente.pis_aliquota_manual ?? existente.pis_aliquota ?? "1.65") : "1.65",
      cofins_aliquota: existente ? String(existente.cofins_aliquota_manual ?? existente.cofins_aliquota ?? "7.60") : "7.60",
      ipi_aliquota: existente ? String(existente.ipi_aliquota_manual ?? existente.ipi_aliquota ?? "0") : "0",
      frete_percentual: existente ? String(existente.frete_percentual ?? "0") : "0",
      fornecedor_nome: existente?.fornecedor_nome || "",
      nf_numero: existente?.nf_numero || "",
      regime: (existente?.regime_fornecedor === "simples_nacional" ? "simples_nacional" : "normal"),
    });
    setManualTributoOpen(true);
  }

  async function salvarManualTributo() {
    if (!manualTributoProduto) return;
    const valorUnit = parseFloat(manualTributoForm.valor_unitario_nf);
    if (!valorUnit || valorUnit <= 0) {
      toast.error("Informe um custo unitário válido");
      return;
    }
    setSavingManualTributo(true);
    try {
      const semCredito = manualTributoForm.regime === "simples_nacional";
      const icms = parseFloat(manualTributoForm.icms_aliquota) || 0;
      const pis = parseFloat(manualTributoForm.pis_aliquota) || 0;
      const cofins = parseFloat(manualTributoForm.cofins_aliquota) || 0;
      const ipi = parseFloat(manualTributoForm.ipi_aliquota) || 0;
      const frete = parseFloat(manualTributoForm.frete_percentual) || 0;

      const payload = {
        gc_produto_id: String(manualTributoProduto.id),
        nome_produto: manualTributoProduto.nome,
        valor_unitario_nf: valorUnit,
        icms_aliquota: icms,
        pis_aliquota: pis,
        cofins_aliquota: cofins,
        ipi_aliquota: ipi,
        icms_aliquota_manual: icms,
        pis_aliquota_manual: pis,
        cofins_aliquota_manual: cofins,
        ipi_aliquota_manual: ipi,
        frete_percentual: frete,
        valor_icms_unit: semCredito ? 0 : valorUnit * (icms / 100),
        valor_pis_unit: semCredito ? 0 : valorUnit * (pis / 100),
        valor_cofins_unit: semCredito ? 0 : valorUnit * (cofins / 100),
        valor_ipi_unit: valorUnit * (ipi / 100),
        valor_frete_unit: valorUnit * (frete / 100),
        fornecedor_nome: manualTributoForm.fornecedor_nome || "Manual",
        nf_numero: manualTributoForm.nf_numero || null,
        regime_fornecedor: manualTributoForm.regime,
        sem_credito: semCredito,
        match_rule: "manual",
        ultima_atualizacao: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("fin_produto_tributos")
        .upsert(payload, { onConflict: "gc_produto_id" });

      if (error) throw error;
      toast.success("Crédito manual salvo");
      setManualTributoOpen(false);
      await refetchTributos();
    } catch (e: any) {
      toast.error(`Falha ao salvar: ${e.message || e}`);
    } finally {
      setSavingManualTributo(false);
    }
  }

  const isSyncing = activeSync !== null;
  const syncingGC = activeSync === "gc";
  const syncingOffline = activeSync === "offline";

  // ── Produtos: sempre do cadastro cacheado do GC (não dos itens da NF) ──
  const { data: produtos, isLoading: loadingProdutos, refetch: refetchProdutos, isFetching: fetchingProdutos } = useQuery({
    queryKey: ["gc-produtos"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: GCProduto[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("gc_produtos_cache")
          .select("produto_gc_id, nome, codigo_interno, codigo_barra, estoque, valor_custo, valor_venda_padrao, nome_grupo, ncm, unidade")
          .eq("ativo", true)
          .order("nome")
          .range(from, from + pageSize - 1);

        if (error) throw error;
        const batch = (data || []).map((p) => ({
          id: String(p.produto_gc_id),
          nome: p.nome,
          codigo: p.codigo_interno || p.codigo_barra || undefined,
          codigo_interno: p.codigo_interno || undefined,
          estoque: p.estoque ?? 0,
          valor_custo: String(p.valor_custo ?? 0),
          valor_venda: String(p.valor_venda_padrao ?? 0),
          nome_grupo: p.nome_grupo || undefined,
          ncm: p.ncm || undefined,
          unidade: p.unidade || undefined,
        })) as GCProduto[];
        allRows.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return allRows;
    },
    staleTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

  const handleSyncEstoque = async () => {
    try {
      toast("Sincronizando cadastro de produtos do GC...");
      let paginaInicial: number | undefined;
      let total = 0;
      for (let tentativa = 0; tentativa < 20; tentativa++) {
        const { data, error } = await supabase.functions.invoke("sync-gc-produtos", {
          body: paginaInicial ? { pagina_inicial: paginaInicial } : {},
        });
        if (error) throw error;
        total += Number(data?.produtos_sincronizados || 0);
        if (data?.status !== "em_progresso") break;
        paginaInicial = Number(data?.proxima_pagina || 0) || undefined;
      }
      const data = await refetchProdutos();
      await refetchProdutosCacheValores();
      toast.success(`Cadastro GC sincronizado: ${data.data?.length ?? total} produtos`);
    } catch (err) {
      toast.error(`Falha ao sincronizar cadastro GC: ${err instanceof Error ? err.message : String(err)}`);
    }
  };


  const { data: tributos, refetch: refetchTributos } = useQuery({
    queryKey: ["produto-tributos"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: ProdutoTributo[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("fin_produto_tributos")
          .select("*")
          .order("nome_produto")
          .range(from, from + pageSize - 1);

        if (error) throw error;

        const batch = (data || []) as ProdutoTributo[];
        allRows.push(...batch);

        if (batch.length < pageSize) break;
        from += pageSize;
      }

      return allRows;
    },
    staleTime: 5 * 60_000,
  });

  // Fonte canônica de custo (Refator matcher v3 — Pedido de Compra GC = verdade)
  const { data: custoCanonico } = useQuery({
    queryKey: ["v-produto-custo-atual"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: { produto_gc_id: string; custo_variavel_real: number | null; status_custo: string }[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("v_produto_custo_atual" as any)
          .select("produto_gc_id, custo_variavel_real, status_custo")
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const batch = (data || []) as any[];
        allRows.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return allRows;
    },
    staleTime: 5 * 60_000,
  });

  const custoCanonicoMap = useMemo(() => {
    const m = new Map<string, { custo: number; status: string }>();
    for (const r of custoCanonico || []) {
      m.set(String(r.produto_gc_id), {
        custo: Number(r.custo_variavel_real) || 0,
        status: r.status_custo || "ok_sem_tributo",
      });
    }
    return m;
  }, [custoCanonico]);

  // Políticas de margem ativas (12 tabelas configuradas em /precificacao/politicas)
  const { data: politicas } = useQuery({
    queryKey: ["fin-politica-markup-tabela"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("fin_politica_markup_tabela")
        .select("tipo_id, nome_tabela, margem_minima, modo_sugestao, exige_aprovacao_ceo")
        .eq("ativo", true)
        .order("nome_tabela");
      if (error) throw error;
      return data as Array<{
        tipo_id: string;
        nome_tabela: string;
        margem_minima: number;
        modo_sugestao: string;
        exige_aprovacao_ceo: boolean;
      }>;
    },
    staleTime: 5 * 60_000,
  });

  // Snapshot dos valores de venda por tabela vindos do cache GC
  const { data: produtosCacheValores, refetch: refetchProdutosCacheValores } = useQuery({
    queryKey: ["gc-produtos-cache-valores"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: { produto_gc_id: string; valores: unknown }[] = [];
      while (true) {
        const { data, error } = await supabase
          .from("gc_produtos_cache")
          .select("produto_gc_id, valores")
          .eq("ativo", true)
          .range(from, from + pageSize - 1);
        if (error) throw error;
        const batch = (data || []) as { produto_gc_id: string; valores: unknown }[];
        allRows.push(...batch);
        if (batch.length < pageSize) break;
        from += pageSize;
      }
      return allRows;
    },
    staleTime: 5 * 60_000,
  });

  const valoresMap = useMemo(() => {
    const m = new Map<string, Map<string, number>>();
    for (const row of produtosCacheValores || []) {
      const inner = new Map<string, number>();
      const arr = Array.isArray(row.valores) ? (row.valores as Array<{ tipo_id: string | number; valor_venda?: string | number }>) : [];
      for (const v of arr) {
        inner.set(String(v.tipo_id), Number(v.valor_venda ?? 0) || 0);
      }
      m.set(String(row.produto_gc_id), inner);
    }
    return m;
  }, [produtosCacheValores]);


  // Índice de XMLs realmente enviados/processados
  const { data: xmlIndexRows } = useQuery({
    queryKey: ["nfe-xml-index-keys"],
    queryFn: async () => {
      const pageSize = 1000;
      let from = 0;
      const allRows: { chave: string | null }[] = [];

      while (true) {
        const { data, error } = await supabase
          .from("fin_nfe_xml_index")
          .select("chave")
          .range(from, from + pageSize - 1);

        if (error) throw error;

        const batch = (data || []) as { chave: string | null }[];
        allRows.push(...batch);

        if (batch.length < pageSize) break;
        from += pageSize;
      }

      return allRows;
    },
    staleTime: 5 * 60_000,
  });

  const indexedNfChaves = useMemo(() => {
    return new Set(
      (xmlIndexRows || [])
        .map((r) => r.chave)
        .filter((c): c is string => Boolean(c))
    );
  }, [xmlIndexRows]);

  // Mantém apenas tributos com NF que existe no índice de XML de entrada
  const tributosXml = useMemo(() => {
    return (tributos || []).filter(
      (t) =>
        t.match_rule === "manual" ||
        (Boolean(t.nf_chave) && indexedNfChaves.has(t.nf_chave as string))
    );
  }, [tributos, indexedNfChaves]);

  const tributosMap = useMemo(() => {
    const map = new Map<string, ProdutoTributo>();
    tributosXml.forEach((t) => map.set(t.gc_produto_id, t));
    return map;
  }, [tributosXml]);

  // ── Fetch monthly fixed costs using same logic as Resultados Operação ──
  const now = new Date();
  const { data: custoFixoMensal } = useQuery({
    queryKey: ["custo-fixo-mensal-resultados", now.getFullYear(), now.getMonth() + 1],
    queryFn: async () => {
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const start = `${year}-${String(month).padStart(2, "0")}-01`;
      const lastDay = new Date(year, month, 0).getDate();
      const end = `${year}-${String(month).padStart(2, "0")}-${lastDay}`;

      // 1) Fetch active metas of category 'custo_fixo'
      const { data: metas } = await supabase.from("fin_metas").select("id, nome, categoria").eq("ativo", true).eq("categoria", "custo_fixo");
      if (!metas || metas.length === 0) return 0;

      // 2) Fetch plano_contas mappings for these metas
      const metaIds = metas.map(m => m.id);
      const { data: links } = await supabase.from("fin_meta_plano_contas").select("meta_id, plano_contas_id, centro_custo_id, peso").in("meta_id", metaIds);
      if (!links || links.length === 0) return 0;

      // 3) Build plano UUID → GC ID map
      const { data: planos } = await supabase.from("fin_plano_contas").select("id, gc_id");
      const uuidToGcId: Record<string, string> = {};
      for (const p of (planos || [])) { if (p.gc_id) uuidToGcId[p.id] = p.gc_id; }

      // 4) Build centro_custo UUID → codigo map
      const { data: centros } = await supabase.from("fin_centros_custo").select("id, codigo");
      const centroMap: Record<string, string> = {};
      for (const c of (centros || [])) { if (c.codigo) centroMap[c.id] = c.codigo; }

      // 5) Fetch GC pagamentos for the period
      const { data: gcPag } = await supabase.from("gc_pagamentos")
        .select("valor, plano_contas_id, centro_custo_id")
        .gte("data_vencimento", start).lte("data_vencimento", end);

      // 6) Fetch Auvo expenses for the period
      const { data: auvoExp } = await supabase.from("auvo_expenses_sync")
        .select("type_id, amount")
        .gte("expense_date", start).lte("expense_date", end);

      // Auvo typeId → plano gc_id mapping (same as hook)
      const AUVO_SOURCE_MAP: Record<string, number[]> = {
        '27867667': [48782], '27912040': [48784], '28160784': [49032], '28223100': [49032],
      };

      // 7) Calculate realized for each custo_fixo meta
      let totalFixo = 0;
      for (const meta of metas) {
        const metaLinks = links.filter(l => l.meta_id === meta.id);
        for (const link of metaLinks) {
          const gcId = uuidToGcId[link.plano_contas_id];
          const auvoTypeIds = gcId ? AUVO_SOURCE_MAP[gcId] : undefined;
          const centroCodigo = link.centro_custo_id ? centroMap[link.centro_custo_id] : null;

          if (auvoTypeIds && auvoExp && auvoExp.length > 0) {
            const auvoSum = auvoExp
              .filter((e: any) => auvoTypeIds.includes(e.type_id))
              .reduce((acc: number, e: any) => acc + (Number(e.amount) || 0), 0);
            totalFixo += auvoSum * (link.peso || 1);
          } else if (gcId && gcPag) {
            const soma = gcPag
              .filter((r: any) => r.plano_contas_id === gcId &&
                (!centroCodigo || !r.centro_custo_id || r.centro_custo_id === centroCodigo))
              .reduce((acc: number, r: any) => acc + Math.abs(r.valor || 0), 0);
            totalFixo += soma * (link.peso || 1);
          }
        }
      }
      return totalFixo;
    },
    staleTime: 10 * 60_000,
  });

  // ── Filtered products (works with or without GC products loaded) ──
  const EXCLUDED_GROUP_KEYWORDS = ["ferramentas", "consignado"];
  const EXCLUDED_NAME_KEYWORDS = ["consignado", "garantia metalfrio", "lona plastica"];
  const filtered = useMemo(() => {
    const q = search.toLowerCase();
    const pols = politicas ?? [];

    // Avalia margem de um produto contra todas as políticas ativas (aproximação: ignora tributo de saída).
    // Retorna { negativa, fora } onde:
    //  - negativa = alguma tabela com venda > 0 mas (venda - custo) < 0
    //  - fora     = alguma tabela sem preço cadastrado OU margem aprox < margem_minima da política
    const avaliarMargem = (produtoId: string, custoBase: number): { negativa: boolean; fora: boolean } => {
      if (pols.length === 0 || custoBase <= 0) return { negativa: false, fora: false };
      const vendaPorTipo = valoresMap.get(produtoId);
      let negativa = false;
      let fora = false;
      for (const pol of pols) {
        const venda = Number(vendaPorTipo?.get(String(pol.tipo_id)) ?? 0);
        if (venda <= 0) { fora = true; continue; }
        const margem = (venda - custoBase) / venda;
        if (margem < 0) negativa = true;
        if (margem < Number(pol.margem_minima)) fora = true;
      }
      return { negativa, fora };
    };

    const aplicarFiltroMargem = (id: string, custoBase: number) => {
      if (marginFilter === "todos") return true;
      const { negativa, fora } = avaliarMargem(id, custoBase);
      if (marginFilter === "negativa") return negativa;
      return fora; // 'fora' inclui negativas (margem < mínima)
    };

    if (produtos) {
      return produtos
        .filter((p) => {
          // Removido filtro de estoque > 0: GC tem ~3 mil produtos, maioria com estoque 0 mas válidos para precificar
          if (EXCLUDED_GROUP_KEYWORDS.some(k => (p.nome_grupo || "").toLowerCase().includes(k))) return false;
          const nome = (p.nome || "").toLowerCase();
          if (EXCLUDED_NAME_KEYWORDS.some(k => nome.includes(k))) return false;
          const codigo = (p.codigo || p.codigo_interno || "").toLowerCase();
          if (!(nome.includes(q) || codigo.includes(q))) return false;

          if (grupoFilter !== "todos" && (p.nome_grupo || "(sem grupo)") !== grupoFilter) return false;

          const custoBase = custoCanonicoMap.get(p.id)?.custo || Number(p.valor_custo) || 0;
          return aplicarFiltroMargem(p.id, custoBase);
        })
        .sort((a, b) => {
          const estoqueA = Number(a.estoque) || 0;
          const estoqueB = Number(b.estoque) || 0;

          const custoA = custoCanonicoMap.get(a.id)?.custo || Number(a.valor_custo) || 0;
          const custoB = custoCanonicoMap.get(b.id)?.custo || Number(b.valor_custo) || 0;

          const valorEstoqueA = estoqueA * custoA;
          const valorEstoqueB = estoqueB * custoB;

          const statusA = custoCanonicoMap.get(a.id)?.status;
          const statusB = custoCanonicoMap.get(b.id)?.status;
          const pendA = statusA === "pendente_custo_zero" ? 1 : 0;
          const pendB = statusB === "pendente_custo_zero" ? 1 : 0;
          if (pendA !== pendB) return pendB - pendA;

          if (valorEstoqueB !== valorEstoqueA) return valorEstoqueB - valorEstoqueA;
          if (custoB !== custoA) return custoB - custoA;
          return estoqueB - estoqueA;
        })
        .slice(0, 1000);
    }
    return [];
  }, [produtos, search, tributosMap, tributosXml, custoCanonicoMap, marginFilter, grupoFilter, politicas, valoresMap]);

  // Reseta página ao mudar filtros para evitar ficar fora do range
  useEffect(() => { setPage(1); }, [search, marginFilter, grupoFilter, tipoSaidaGlobal]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const paged = useMemo(
    () => filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE),
    [filtered, currentPage]
  );


  const gruposDisponiveis = useMemo(() => {
    if (!produtos) return [] as string[];
    const set = new Set<string>();
    for (const p of produtos) {
      if (EXCLUDED_GROUP_KEYWORDS.some(k => (p.nome_grupo || "").toLowerCase().includes(k))) continue;
      set.add(p.nome_grupo || "(sem grupo)");
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "pt-BR"));
  }, [produtos]);

  const grupoOptions = useMemo(() => [
    { value: "todos", label: "Todos os grupos" },
    ...gruposDisponiveis.map((g) => ({ value: g, label: g })),
  ], [gruposDisponiveis]);

  const totalProdutosEstoque = useMemo(() => {
    if (!produtos) return null; // sem dados de estoque carregados
    return produtos
      .filter(p => !EXCLUDED_GROUP_KEYWORDS.some(k => (p.nome_grupo || "").toLowerCase().includes(k)))
      .reduce((sum, p) => sum + (Number(p.estoque) || 0), 0) || 1;
  }, [produtos]);

  // ── Faturamento mensal médio (últimos 90 dias / 3) — base para rateio do custo fixo ──
  // Padrão de mercado: custo fixo é recuperado como % do faturamento, não do estoque.
  // Cada R$ vendido contribui na mesma proporção pra pagar o custo fixo, independente
  // do produto ser caro ou barato. A fórmula é embutida no DIVISOR do mark-up.
  const { data: faturamentoMensalMedio } = useQuery({
    queryKey: ["faturamento-mensal-medio-90d"],
    queryFn: async () => {
      const d = new Date(); d.setDate(d.getDate() - 90);
      const start = d.toISOString().slice(0, 10);
      const { data } = await supabase
        .from("gc_recebimentos")
        .select("valor_total, valor")
        .gte("data_vencimento", start);
      const total = (data || []).reduce((s: number, r: any) => s + (Number(r.valor_total) || Number(r.valor) || 0), 0);
      return total / 3; // média mensal
    },
    staleTime: 10 * 60 * 1000,
  });

  // % do custo fixo sobre faturamento (fração: 0.08 = 8%). Entra direto no divisor do mark-up.
  // Cap: muito faturamento vem de serviço (OS), então ratear 100% no produto distorce — limita em 10%.
  const CUSTO_FIXO_PCT_MAX = 0.10;
  const custoFixoPctRaw = (custoFixoMensal && faturamentoMensalMedio && faturamentoMensalMedio > 0)
    ? custoFixoMensal / faturamentoMensalMedio
    : 0;
  const custoFixoPctAutoCapeado = Math.min(custoFixoPctRaw, CUSTO_FIXO_PCT_MAX);
  const custoFixoPct = custoFixoPctAutoCapeado;
  const foiCapeado = custoFixoPctRaw > CUSTO_FIXO_PCT_MAX;

  // Custo fixo /un médio (só display)
  const custoFixoAutoUnit = (custoFixoMensal && totalProdutosEstoque) ? custoFixoMensal / totalProdutosEstoque : 0;
  const activeEntrada = { ...taxEntrada, custoFixoUnit: taxEntrada.custoFixoUnit || 0 };

  // Override manual flat (taxEntrada.custoFixoUnit > 0): se setado, ignora rateio % e usa flat.
  const usarOverrideFlat = !!(taxEntrada.custoFixoUnit && taxEntrada.custoFixoUnit > 0);
  // Override manual % (custoFixoPctOverride): se setado, ignora rateio auto.
  const pctOverrideNum = parseFloat(custoFixoPctOverride);
  const usarOverridePct = !usarOverrideFlat && !isNaN(pctOverrideNum) && pctOverrideNum > 0;
  const custoFixoPctEfetivo = usarOverrideFlat ? 0 : (usarOverridePct ? pctOverrideNum / 100 : custoFixoPct);

  // ── Itens fora da margem: replica a lógica de cada linha (politicas × produto) para alimentar botões "Corrigir tudo" ──
  const outOfMarginByProduct = useMemo(() => {
    const map = new Map<string, Array<{
      gc_produto_id: string; nome_produto: string; tipo_id: string; nome_tabela: string;
      preco_atual: number; preco_sugerido: number; margem_minima: number; margem_resultante: number; custo_referencia: number;
    }>>();
    if (!filtered || !politicas) return map;
    for (const p of filtered) {
      const custoCan = custoCanonicoMap.get(p.id);
      const custoBruto = custoCan ? custoCan.custo : (parseFloat(p.valor_custo) || 0);
      const tributoRaw = tributosMap.get(p.id);
      const tributo = isTributoCompativelComProduto(p, tributoRaw) ? tributoRaw : undefined;
      const hasNF = !!tributo;
      let calc: ReturnType<typeof calcPricing>;
      const cfuFlat = usarOverrideFlat ? (taxEntrada.custoFixoUnit || 0) : 0;
      if (hasNF) {
        const nfCalc = calcPricingWithNF(tributo!, taxSaida, tipoSaidaGlobal, cfuFlat, margemAlvo, custoFixoPctEfetivo, custoBruto);
        calc = {
          creditoIcms: nfCalc.creditoIcms, creditoPis: nfCalc.creditoPis, creditoCofins: nfCalc.creditoCofins,
          totalCreditosEntrada: nfCalc.totalCreditosEntrada, custoLiquido: nfCalc.custoEfetivo,
          custoFrete: tributo!.valor_frete_unit, custoTotal: nfCalc.custoTotal, precoMinimo: nfCalc.precoMinimo,
          tributosSaida: nfCalc.tributosSaida, custoFixoEmbutido: nfCalc.custoFixoEmbutido, impostoRenda: nfCalc.impostoRenda,
          lucroAnteIR: nfCalc.lucroAnteIR, lucroLiquido: nfCalc.lucroLiquido,
          margemReal: nfCalc.precoMinimo > 0 ? (nfCalc.lucroLiquido / nfCalc.precoMinimo) * 100 : 0,
          aliquotaSaidaFaturamento: nfCalc.aliquotaSaidaFaturamento,
          custoFixoPct: nfCalc.custoFixoPct,
        };
      } else {
        calc = calcPricing(custoBruto, { ...activeEntrada, custoFixoUnit: cfuFlat }, taxSaida, tipoSaidaGlobal, margemAlvo, custoFixoPctEfetivo);
      }
      const valoresProd = valoresMap.get(p.id);
      const itemsOut: Array<{ gc_produto_id: string; nome_produto: string; tipo_id: string; nome_tabela: string; preco_atual: number; preco_sugerido: number; margem_minima: number; margem_resultante: number; custo_referencia: number; }> = [];
      for (const pol of politicas) {
        const margemMin = Number(pol.margem_minima) || 0;
        // Divisor SEM custoFixoPct: alinha com o cálculo de margem exibida na linha.
        // Custo fixo % entra só no "Preço Mín." global (coluna), não no preço por tabela.
        const divLinha = 1 - calc.aliquotaSaidaFaturamento - margemMin;
        const precoSugeridoBruto = calc.custoTotal > 0 && divLinha > 0.05 ? calc.custoTotal / divLinha : calc.custoTotal * 5;
        const precoSugerido = calc.custoTotal > 0 ? Math.min(precoSugeridoBruto, calc.custoTotal * 5) : 0;
        const vendaReal = valoresProd?.get(String(pol.tipo_id)) ?? 0;
        const temPrecoCadastrado = vendaReal > 0;
        const venda = temPrecoCadastrado ? vendaReal : precoSugerido;
        const trib = venda * calc.aliquotaSaidaFaturamento;
        const margem = venda > 0 && calc.custoTotal > 0 ? ((venda - calc.custoTotal - trib) / venda) * 100 : 0;
        const okMin = temPrecoCadastrado && margem >= (margemMin * 100 - 0.05);
        if (!okMin && precoSugerido > 0 && calc.custoTotal > 0) {
          itemsOut.push({
            gc_produto_id: String(p.id), nome_produto: p.nome, tipo_id: String(pol.tipo_id), nome_tabela: pol.nome_tabela,
            preco_atual: vendaReal, preco_sugerido: precoSugerido,
            margem_minima: margemMin, margem_resultante: margemMin, custo_referencia: calc.custoTotal,
          });
        }
      }
      if (itemsOut.length > 0) map.set(String(p.id), itemsOut);
    }
    return map;
  }, [filtered, politicas, custoCanonicoMap, tributosMap, valoresMap, taxSaida, tipoSaidaGlobal, custoFixoPctEfetivo, usarOverrideFlat, taxEntrada.custoFixoUnit, margemAlvo]);

  // ── Itens ACIMA da margem (preço alto demais — sugere reduzir pro mínimo) ──
  const aboveMarginByProduct = useMemo(() => {
    const map = new Map<string, Array<{
      gc_produto_id: string; nome_produto: string; tipo_id: string; nome_tabela: string;
      preco_atual: number; preco_sugerido: number; margem_minima: number; margem_resultante: number; custo_referencia: number;
    }>>();
    if (!filtered || !politicas) return map;
    for (const p of filtered) {
      const custoCan = custoCanonicoMap.get(p.id);
      const custoBruto = custoCan ? custoCan.custo : (parseFloat(p.valor_custo) || 0);
      const tributoRaw = tributosMap.get(p.id);
      const tributo = isTributoCompativelComProduto(p, tributoRaw) ? tributoRaw : undefined;
      const hasNF = !!tributo;
      let calc: ReturnType<typeof calcPricing>;
      const cfuFlat = usarOverrideFlat ? (taxEntrada.custoFixoUnit || 0) : 0;
      if (hasNF) {
        const nfCalc = calcPricingWithNF(tributo!, taxSaida, tipoSaidaGlobal, cfuFlat, margemAlvo, custoFixoPctEfetivo, custoBruto);
        calc = { ...nfCalc, custoLiquido: nfCalc.custoEfetivo, custoFrete: tributo!.valor_frete_unit, margemReal: 0 } as ReturnType<typeof calcPricing>;
      } else {
        calc = calcPricing(custoBruto, { ...activeEntrada, custoFixoUnit: cfuFlat }, taxSaida, tipoSaidaGlobal, margemAlvo, custoFixoPctEfetivo);
      }
      const valoresProd = valoresMap.get(p.id);
      const itemsAbove: Array<{ gc_produto_id: string; nome_produto: string; tipo_id: string; nome_tabela: string; preco_atual: number; preco_sugerido: number; margem_minima: number; margem_resultante: number; custo_referencia: number; }> = [];
      for (const pol of politicas) {
        const margemMin = Number(pol.margem_minima) || 0;
        const divLinha = 1 - calc.aliquotaSaidaFaturamento - margemMin;
        const precoSugeridoBruto = calc.custoTotal > 0 && divLinha > 0.05 ? calc.custoTotal / divLinha : calc.custoTotal * 5;
        const precoSugerido = calc.custoTotal > 0 ? Math.min(precoSugeridoBruto, calc.custoTotal * 5) : 0;
        const vendaReal = valoresProd?.get(String(pol.tipo_id)) ?? 0;
        if (vendaReal <= 0 || precoSugerido <= 0) continue;
        const trib = vendaReal * calc.aliquotaSaidaFaturamento;
        const margem = ((vendaReal - calc.custoTotal - trib) / vendaReal) * 100;
        // ACIMA: margem > margemMin + 0.5pp E preço atual maior que o sugerido (mais que R$0,01)
        if (margem > margemMin * 100 + 0.5 && vendaReal - precoSugerido > 0.01) {
          itemsAbove.push({
            gc_produto_id: String(p.id), nome_produto: p.nome, tipo_id: String(pol.tipo_id), nome_tabela: pol.nome_tabela,
            preco_atual: vendaReal, preco_sugerido: precoSugerido,
            margem_minima: margemMin, margem_resultante: margemMin, custo_referencia: calc.custoTotal,
          });
        }
      }
      if (itemsAbove.length > 0) map.set(String(p.id), itemsAbove);
    }
    return map;
  }, [filtered, politicas, custoCanonicoMap, tributosMap, valoresMap, taxSaida, tipoSaidaGlobal, custoFixoPctEfetivo, usarOverrideFlat, taxEntrada.custoFixoUnit, margemAlvo, activeEntrada]);

  const allOutOfMargin = useMemo(() => Array.from(outOfMarginByProduct.values()).flat(), [outOfMarginByProduct]);
  const allAboveMargin = useMemo(() => Array.from(aboveMarginByProduct.values()).flat(), [aboveMarginByProduct]);

  // ── Upload XMLs de NF para o bucket (suporta ZIP + lotes) ──
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState("");
  
  const extractXmlsFromZip = async (
    file: File | Blob,
    basePath = "",
    depth = 0
  ): Promise<{ xmlFiles: { name: string; blob: Blob }[]; totalEntries: number; nestedZips: number }> => {
    const JSZip = (await import("jszip")).default;
    const zip = await JSZip.loadAsync(file);
    const xmlFiles: { name: string; blob: Blob }[] = [];

    let totalEntries = 0;
    let nestedZips = 0;
    const entries = Object.entries(zip.files).filter(([, entry]) => !entry.dir);

    totalEntries += entries.length;

    for (const [name, entry] of entries) {
      const lower = name.toLowerCase();

      if (lower.endsWith(".xml")) {
        const blob = await entry.async("blob");
        xmlFiles.push({ name: `${basePath}${name}`, blob });
        continue;
      }

      // Alguns lotes da SEFAZ vêm com ZIP dentro de ZIP
      if (lower.endsWith(".zip") && depth < 4) {
        nestedZips++;
        const nestedBlob = await entry.async("blob");
        const nested = await extractXmlsFromZip(
          nestedBlob,
          `${basePath}${name.replace(/\.zip$/i, "")}/`,
          depth + 1
        );
        xmlFiles.push(...nested.xmlFiles);
        totalEntries += nested.totalEntries;
        nestedZips += nested.nestedZips;
      }
    }

    return { xmlFiles, totalEntries, nestedZips };
  };

  const parseXmlMetadata = async (blob: Blob): Promise<{
    chave: string | null;
    cnpj_emitente: string | null;
    nome_emitente: string | null;
    data_emissao: string | null;
    valor_total: number | null;
    valor_produtos: number | null;
    qtd_itens: number;
  }> => {
    const text = await blob.text();
    const chaveMatch = text.match(/Id="NFe(\d{44})"/i) || text.match(/chNFe>(\d{44})</i);
    const chave = chaveMatch?.[1] || null;

    // Extract emit block
    const emitMatch = text.match(/<emit[^>]*>([\s\S]*?)<\/emit>/i);
    const emitBlock = emitMatch?.[1] || "";
    const cnpjMatch = emitBlock.match(/<CNPJ[^>]*>(\d+)<\/CNPJ>/i);
    const cnpj_emitente = cnpjMatch?.[1] || null;
    const nomeMatch = emitBlock.match(/<xNome[^>]*>([^<]+)<\/xNome>/i);
    const nome_emitente = nomeMatch?.[1] || null;

    // Extract data emissão
    const dhEmiMatch = text.match(/<dhEmi[^>]*>([^<]+)<\/dhEmi>/i) || text.match(/<dEmi[^>]*>([^<]+)<\/dEmi>/i);
    const data_emissao = dhEmiMatch?.[1]?.substring(0, 10) || null;

    // Extract totals from ICMSTot
    const vNFMatch = text.match(/<vNF[^>]*>([^<]+)<\/vNF>/i);
    const valor_total = vNFMatch ? parseFloat(vNFMatch[1]) : null;
    const vProdMatch = text.match(/<vProd[^>]*>([^<]+)<\/vProd>/i);
    const valor_produtos = vProdMatch ? parseFloat(vProdMatch[1]) : null;

    // Count det items
    const detMatches = text.match(/<det /gi) || text.match(/<det>/gi) || [];
    const qtd_itens = detMatches.length;

    return { chave, cnpj_emitente, nome_emitente, data_emissao, valor_total, valor_produtos, qtd_itens };
  };

  const uploadBatch = async (
    items: { name: string; blob: Blob }[],
    batchSize: number,
    onProgress: (done: number, total: number) => void
  ) => {
    let uploaded = 0;
    let repeatedKeys = 0;
    let indexed = 0;
    let errors = 0;
    const total = items.length;
    const keyOccurrences = new Map<string, number>();
    const indexBatch: Record<string, unknown>[] = [];

    for (let i = 0; i < total; i += batchSize) {
      const batch = items.slice(i, i + batchSize);
      const results = await Promise.allSettled(
        batch.map(async (item) => {
          const meta = await parseXmlMetadata(item.blob);

          let path = item.name.replace(/^.*[\\/]/, "");
          if (meta.chave) {
            const count = (keyOccurrences.get(meta.chave) || 0) + 1;
            keyOccurrences.set(meta.chave, count);

            if (count === 1) {
              path = `${meta.chave}.xml`;
            } else {
              repeatedKeys++;
              path = `repetidos/${meta.chave}-${count}.xml`;
            }
          }

          const { error } = await supabase.storage.from("nf-xmls").upload(path, item.blob, {
            contentType: "text/xml",
            upsert: true,
          });
          if (error) throw error;

          // Collect index data for first occurrence only
          if (meta.chave && (keyOccurrences.get(meta.chave) || 0) <= 1) {
            indexBatch.push({
              chave: meta.chave,
              cnpj_emitente: meta.cnpj_emitente,
              nome_emitente: meta.nome_emitente,
              data_emissao: meta.data_emissao,
              valor_total: meta.valor_total,
              valor_produtos: meta.valor_produtos,
              qtd_itens: meta.qtd_itens,
              storage_path: path,
            });
          }

          return "uploaded" as const;
        })
      );

      for (const r of results) {
        if (r.status === "fulfilled") {
          if (r.value === "uploaded") uploaded++;
        } else {
          errors++;
          console.error("Upload error:", r.reason);
        }
      }

      // Upsert index in batches of 50
      if (indexBatch.length >= 50) {
        const toUpsert = indexBatch.splice(0, 50);
        const { error: idxErr, data: idxData } = await supabase
          .from("fin_nfe_xml_index")
          .upsert(toUpsert as any, { onConflict: "chave" });
        if (!idxErr) indexed += toUpsert.length;
        else console.error("Index upsert error:", idxErr.message);
      }

      onProgress(uploaded + errors, total);
    }

    // Flush remaining index records
    if (indexBatch.length > 0) {
      const { error: idxErr } = await supabase
        .from("fin_nfe_xml_index")
        .upsert(indexBatch as any, { onConflict: "chave" });
      if (!idxErr) indexed += indexBatch.length;
    }

    return { uploaded, repeatedKeys, errors, indexed };
  };

  const handleUploadXmls = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    setUploading(true);
    setUploadProgress("Preparando arquivos...");

    try {
      // Heurística: alguns navegadores limitam seleção múltipla em ~1000 arquivos
      if (files.length === 1000) {
        toast("Se você selecionou mais de 1000, prefira ZIP para enviar tudo de uma vez.");
      }

      // Collect all XML items (from .xml files and from .zip files)
      const allItems: { name: string; blob: Blob }[] = [];
      let totalZipEntries = 0;
      let totalNestedZips = 0;

      for (const file of Array.from(files)) {
        if (file.name.toLowerCase().endsWith(".zip")) {
          setUploadProgress(`Extraindo ${file.name}...`);
          const zipResult = await extractXmlsFromZip(file);
          allItems.push(...zipResult.xmlFiles);
          totalZipEntries += zipResult.totalEntries;
          totalNestedZips += zipResult.nestedZips;
          setUploadProgress(`Encontrados ${zipResult.xmlFiles.length} XML(s) em ${file.name}`);
        } else {
          allItems.push({ name: file.name, blob: file });
        }
      }

      if (allItems.length === 0) {
        toast.error("Nenhum XML encontrado nos arquivos selecionados");
        return;
      }

      if (totalZipEntries > 0) {
        toast(
          `Diagnóstico ZIP: ${totalZipEntries} entrada(s), ${allItems.length} XML(s)` +
            (totalNestedZips > 0 ? `, ${totalNestedZips} ZIP(ns) interno(s)` : "")
        );
      }

      setUploadProgress(`0 / ${allItems.length} processados`);
      const BATCH_SIZE = 15;
      const { uploaded, repeatedKeys, errors, indexed } = await uploadBatch(allItems, BATCH_SIZE, (done, total) => {
        setUploadProgress(`${done} / ${total} processados`);
      });

      toast.success(
        `${uploaded} arquivo(s) enviados, ${indexed} indexados` +
          (repeatedKeys > 0 ? `, ${repeatedKeys} chave(s) repetida(s)` : "") +
          (errors > 0 ? `, ${errors} erro(s)` : "")
      );
    } catch (err) {
      toast.error(`Erro no upload: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setUploading(false);
      setUploadProgress("");
      e.target.value = "";
    }
  };

  // ── Sync NFs de entrada: cruza pedido de compra GC + XML vinculado ──
  const handleSyncGC = async () => {
    if (activeSyncRef.current) {
      toast.error("Já existe uma sincronização em andamento.");
      return;
    }
    if (!window.confirm("⚠️ Isso consome chamadas da API do GestãoClick.\n\nDeseja continuar?")) return;

    activeSyncRef.current = "gc";
    setActiveSync("gc");

    try {
      const { checkSyncCooldown, markSyncStarted } = await import("@/lib/gc-client");
      const cooldown = checkSyncCooldown("sync-nfe-entrada-gc");
      if (!cooldown.allowed) {
        toast.error(`Aguarde ${Math.ceil(cooldown.remainingSeconds / 60)} minuto(s) antes de sincronizar novamente.`);
        return;
      }

      markSyncStarted("sync-nfe-entrada-gc");
      setSyncProgress("Cruzando pedidos GC com XMLs vinculados...");

      let offset = 0;
      const batchSize = 80;
      let totalProdutos = 0;
      while (true) {
        const { data, error } = await supabase.functions.invoke("sync-nfe-entrada", {
          body: { offset, batch_size: batchSize },
        });
        if (error) throw error;
        totalProdutos += data.produtos_processados || 0;
        setSyncProgress(`Processando lote ${offset}...`);
        if (!data.has_more) break;
        offset = data.next_offset;
      }
      toast.success(`Tributos reprocessados por Pedido GC + XML: ${totalProdutos} produtos`);
      setSyncProgress("");
      refetchTributos();
    } catch (err: unknown) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
      setSyncProgress("");
    } finally {
      activeSyncRef.current = null;
      setActiveSync(null);
    }
  };

  // ── Reprocessa tributos usando apenas itens do pedido GC + XML vinculado ──
  const [syncProgress, setSyncProgress] = useState("");
  const handleSyncNFEntrada = async () => {
    if (activeSyncRef.current) {
      toast.error("Já existe uma sincronização em andamento.");
      return;
    }

    activeSyncRef.current = "offline";
    setActiveSync("offline");

    try {
      // Cooldown check
      const { checkSyncCooldown, markSyncStarted } = await import("@/lib/gc-client");
      const cooldown = checkSyncCooldown("sync-nfe-entrada");
      if (!cooldown.allowed) {
        toast.error(`Aguarde ${Math.ceil(cooldown.remainingSeconds / 60)} minuto(s) antes de sincronizar novamente.`);
        return;
      }
      markSyncStarted("sync-nfe-entrada");

      setSyncProgress("Reprocessando Pedido GC + XML vinculado...");
      let offset = 0;
      const batchSize = 80;
      let totalProdutos = 0;
      let totalCompras = 0;
      let totalXmls = 0;

      while (true) {
        const { data, error } = await supabase.functions.invoke("sync-nfe-entrada", {
          body: { offset, batch_size: batchSize },
        });
        if (error) throw error;

        totalCompras = data.total_compras || 0;
        totalProdutos += data.produtos_processados || data.produtos_atualizados || 0;
        totalXmls += data.xmls_lidos || data.xmls_usados || 0;
        const processed = offset + (data.processed || 0);
        setSyncProgress(`Processando compras ${processed}/${totalCompras}...`);

        if (!data.has_more) break;
        offset = data.next_offset;
      }

      toast.success(`Reprocessado: ${totalProdutos} produtos de ${totalCompras} compras (${totalXmls} XMLs vinculados)`);
      setSyncProgress("");
      refetchTributos();
    } catch (err: unknown) {
      toast.error(`Erro: ${err instanceof Error ? err.message : String(err)}`);
      setSyncProgress("");
    } finally {
      activeSyncRef.current = null;
      setActiveSync(null);
    }
  };

  // ── Calculator results ──
  const calcResults = useMemo(() => {
    const custo = parseFloat(calcCusto) || 0;
    if (custo <= 0) return [];
    const icmsOv = calcIcmsSaida.trim() === "" ? undefined : parseFloat(calcIcmsSaida.replace(",", "."));
    const taxSaidaCalc = icmsOv !== undefined && isFinite(icmsOv)
      ? { ...taxSaida, icmsSaida: icmsOv }
      : taxSaida;
    return calcMargens.map((m) => ({
      margem: m,
      ...calcPricing(custo, activeEntrada, taxSaidaCalc, calcTipoSaida, m, custoFixoPctEfetivo),
    }));
  }, [calcCusto, calcMargens, activeEntrada, taxSaida, calcTipoSaida, custoFixoPctEfetivo, calcIcmsSaida]);

  const totalComTributoNF = tributosXml.length;

  // Helper to get exit tax label
  const getTipoSaidaLabel = (tipo: TipoSaida) =>
    tipo === "venda" ? "Venda Produto" : "Prestação Serviço";

  const getTipoSaidaAliquota = (tipo: TipoSaida) => {
    if (tipo === "venda") {
      return `ICMS ${taxSaida.icmsSaida}% + PIS ${taxSaida.pisSaida}% + COFINS ${taxSaida.cofinsSaida}%`;
    }
    return `ISS ${taxSaida.iss}% + PIS ${taxSaida.pisSaidaServico}% + COFINS ${taxSaida.cofinsSaidaServico}%`;
  };

  // ── Corrigir preço por produto+tabela: cria aprovação 'aprovada' + write_job (worker faz GET-before-PUT no GC) ──
  type CorrigirArgs = {
    gc_produto_id: string;
    nome_produto: string;
    tipo_id: string;
    nome_tabela: string;
    preco_atual: number;
    preco_sugerido: number;
    margem_minima: number;
    margem_resultante: number;
    custo_referencia: number;
  };
  const [corrigindoKey, setCorrigindoKey] = useState<string | null>(null);
  const [bulkCorrigindo, setBulkCorrigindo] = useState<string | null>(null); // 'produto:<id>' ou 'global'

  // Núcleo: corrige UM item, sem refetch nem estado. Retorna ok/erro.
  const corrigirPrecoCore = async (args: CorrigirArgs): Promise<{ ok: boolean; erro?: string }> => {
    if (!(args.preco_sugerido > 0) || !(args.custo_referencia > 0)) {
      return { ok: false, erro: "custo ou preço sugerido inválido" };
    }
    try {
      const { data: aprov, error: errAp } = await supabase
        .from("fin_gc_price_aprovacoes")
        .insert({
          gc_produto_id: args.gc_produto_id,
          nome_produto: args.nome_produto,
          tipo_id: args.tipo_id,
          modo_calculo: "completo",
          custo_referencia: args.custo_referencia,
          preco_atual: args.preco_atual,
          preco_solicitado: args.preco_sugerido,
          margem_resultante: args.margem_resultante,
          margem_minima_politica: args.margem_minima,
          justificativa: `Correção manual via UI: ${args.nome_tabela}. Preço ${args.preco_atual.toFixed(2)} → ${args.preco_sugerido.toFixed(2)} (margem mín ${(args.margem_minima * 100).toFixed(2)}%).`,
          status: "aprovada",
          decidido_em: new Date().toISOString(),
          decisao_observacao: "Correção manual disparada pelo CEO na UI de Precificação",
          payload: { source: "precificacao-ui-corrigir", nome_tabela: args.nome_tabela },
        })
        .select("id")
        .single();
      if (errAp) throw errAp;

      await supabase.from("fin_gc_price_history").insert({
        gc_produto_id: args.gc_produto_id,
        tipo_id: args.tipo_id,
        preco_anterior: args.preco_atual,
        preco_novo: args.preco_sugerido,
        margem_aplicada: args.margem_resultante,
        source: "precificacao-ui-corrigir",
        motivo: "Correção manual via UI",
        aprovacao_id: aprov.id,
      });

      const { data: job, error: errJob } = await supabase.from("fin_gc_write_jobs").insert({
        recurso: "produtos",
        recurso_id: args.gc_produto_id,
        payload: { valores: [{ tipo_id: String(args.tipo_id), valor_venda: args.preco_sugerido.toFixed(2) }] },
        payload_hash: `corrigir-ui-${args.gc_produto_id}-${args.tipo_id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        status: "pendente",
      }).select("id").single();
      if (errJob) throw errJob;

      const { data: workerResult, error: errWorker } = await supabase.functions.invoke("process-gc-write-jobs", {
        body: { source: "precificacao-ui-corrigir", job_id: job.id },
      });
      if (errWorker) throw errWorker;
      if (!workerResult?.sucessos) {
        const erro = workerResult?.results?.[0]?.erro || workerResult?.message || "worker não confirmou sucesso";
        return { ok: false, erro: String(erro) };
      }
      return { ok: true };
    } catch (e) {
      return { ok: false, erro: e instanceof Error ? e.message : String(e) };
    }
  };

  // Batch: processa lista sequencialmente, com toast de progresso.
  const corrigirPrecoBatch = async (items: CorrigirArgs[], scopeLabel: string, bulkKey: string) => {
    if (bulkCorrigindo || corrigindoKey) return;
    if (items.length === 0) { toast("Nada fora da margem para corrigir"); return; }
    setBulkCorrigindo(bulkKey);
    console.log(`[corrigirPrecoBatch] ${scopeLabel} → ${items.length} item(s)`, items);
    let ok = 0, fail = 0;
    const erros: string[] = [];
    const okProdutos = new Set<string>();
    try {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        toast(`${scopeLabel}: ${i + 1}/${items.length} — ${it.nome_produto.slice(0, 30)} (${it.nome_tabela})`);
        const r = await corrigirPrecoCore(it);
        if (r.ok) { ok++; okProdutos.add(it.nome_produto); }
        else { fail++; erros.push(`${it.nome_produto} [${it.nome_tabela}]: ${r.erro}`); }
      }
      await Promise.all([refetchProdutosCacheValores(), refetchProdutos()]);
      const amostra = Array.from(okProdutos).slice(0, 3).join(", ") + (okProdutos.size > 3 ? ` +${okProdutos.size - 3}` : "");
      if (fail === 0) toast.success(`${scopeLabel}: ${ok} preço(s) no GC — ${okProdutos.size} produto(s): ${amostra}`);
      else toast.error(`${scopeLabel}: ${ok} ok, ${fail} falha(s). Ex: ${erros[0]}`);
    } finally {
      setBulkCorrigindo(null);
    }
  };
  const corrigirPreco = async (args: CorrigirArgs) => {
    const key = `${args.gc_produto_id}:${args.tipo_id}`;
    if (corrigindoKey || bulkCorrigindo) return;
    setCorrigindoKey(key);
    try {
      const r = await corrigirPrecoCore(args);
      if (r.ok) {
        await Promise.all([refetchProdutosCacheValores(), refetchProdutos()]);
        toast.success(`${args.nome_tabela}: atualizado no GC (${formatCurrency(args.preco_sugerido)})`);
      } else {
        toast.error(`Falha ao corrigir: ${r.erro}`);
      }
    } finally {
      setCorrigindoKey(null);
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Calculator className="h-6 w-6 text-primary" />
            Precificação de Produtos
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Tributação de entrada (NF) + saída (Venda/Serviço) — Lucro Real
          </p>
        </div>
        <div className="flex items-center gap-3">
          {custoFixoMensal !== undefined && (
            <Badge variant="outline" className="text-xs" title={`Mark-up Divisor: ${(custoFixoPct * 100).toFixed(2)}% do faturamento mensal médio (R$ ${(faturamentoMensalMedio || 0).toLocaleString('pt-BR', {maximumFractionDigits: 0})}) é embutido no preço pra cobrir o custo fixo. ${usarOverrideFlat ? `Override flat ativo: ${formatCurrency(taxEntrada.custoFixoUnit || 0)}/un` : ''}`}>
              Custo fixo: {formatCurrency(custoFixoMensal)} · {(custoFixoPctEfetivo * 100).toFixed(2)}% do faturamento{usarOverrideFlat ? ' (override flat)' : ''}
            </Badge>
          )}
          <Badge variant="outline" className="text-xs">
            <FileText className="h-3 w-3 mr-1" />
            {totalComTributoNF} produtos c/ tributo NF
          </Badge>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={handleSyncGC} disabled={isSyncing}>
              {syncingGC ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Cruzar Pedidos GC + XML
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncEstoque} disabled={fetchingProdutos}>
              {fetchingProdutos ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Package className="h-4 w-4 mr-1" />}
              Sincronizar Cadastro GC
            </Button>
            <Button variant="outline" size="sm" onClick={handleSyncNFEntrada} disabled={isSyncing}>
              {syncingOffline ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Reprocessar Tributos
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => corrigirPrecoBatch(allOutOfMargin, `TODOS fora da margem (${allOutOfMargin.length})`, "global")}
              disabled={!!bulkCorrigindo || !!corrigindoKey || allOutOfMargin.length === 0}
              title={`Aceita o preço sugerido para todas as tabelas fora da margem em todos os produtos filtrados (${allOutOfMargin.length} correções)`}
            >
              {bulkCorrigindo === "global" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <TrendingUp className="h-4 w-4 mr-1" />}
              Aplicar sugestão a TODOS ({allOutOfMargin.length})
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
              onClick={() => corrigirPrecoBatch(allAboveMargin, `REDUZIR p/ margem mín (${allAboveMargin.length})`, "global-reduzir")}
              disabled={!!bulkCorrigindo || !!corrigindoKey || allAboveMargin.length === 0}
              title={`Reduz o preço de TODAS as tabelas acima da margem para bater exatamente na margem mínima (${allAboveMargin.length} ajustes)`}
            >
              {bulkCorrigindo === "global-reduzir" ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
              Reduzir TODOS p/ margem mín ({allAboveMargin.length})
            </Button>
            {isSyncing && syncProgress && (
              <span className="text-xs text-muted-foreground font-mono animate-pulse">{syncProgress}</span>
            )}
          </div>
          <Button variant="outline" size="sm" disabled={uploading} asChild>
            <label className="cursor-pointer">
              {uploading ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <Upload className="h-4 w-4 mr-1" />}
              {uploading && uploadProgress ? uploadProgress : "Upload XMLs / ZIP"}
              <input type="file" accept=".xml,.zip" multiple className="hidden" onChange={handleUploadXmls} />
            </label>
          </Button>
          {isSyncing && syncProgress && (
            <span className="text-xs text-muted-foreground animate-pulse">{syncProgress}</span>
          )}
        </div>
      </div>

      {/* ── Tax Config: Entrada + Saída side by side ── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* ENTRADA */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <Package className="h-4 w-4" />
              Tributos de Entrada (Créditos)
              <Tooltip>
                <TooltipTrigger><Info className="h-3.5 w-3.5 text-muted-foreground" /></TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Créditos fiscais na compra (Lucro Real). Quando o produto tem NF de entrada, os valores reais da NF são priorizados.
                </TooltipContent>
              </Tooltip>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Custo fixo % (faturamento)</Label>
                <Input type="number" step="0.1" placeholder={(custoFixoPctAutoCapeado * 100).toFixed(2)}
                  value={custoFixoPctOverride}
                  onChange={(e) => setCustoFixoPctOverride(e.target.value)}
                  className="h-8 bg-secondary text-sm" />
                <p className="text-[10px] text-muted-foreground">
                  {usarOverrideFlat ? 'Ignorado (flat ativo)' : (usarOverridePct ? `Override: ${pctOverrideNum.toFixed(2)}%` : (foiCapeado ? `Auto cap em ${(CUSTO_FIXO_PCT_MAX*100).toFixed(0)}% (real: ${(custoFixoPctRaw*100).toFixed(1)}%)` : `Auto: ${(custoFixoPct*100).toFixed(2)}%`))}
                </p>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs text-muted-foreground">Custo fixo/un (R$) — override flat</Label>
                <Input type="number" placeholder={custoFixoAutoUnit.toFixed(2)}
                  value={taxEntrada.custoFixoUnit || ""}
                  onChange={(e) => setTaxEntrada({ ...taxEntrada, custoFixoUnit: parseFloat(e.target.value) || 0 })}
                  className="h-8 bg-secondary text-sm" />
                <p className="text-[10px] text-muted-foreground">Vazio = usa o % acima</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* SAÍDA */}
        <Card className="border-border bg-card">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground uppercase tracking-wider flex items-center gap-2">
              <TrendingUp className="h-4 w-4" />
              Tributos de Saída (Faturamento)
              <Tooltip>
                <TooltipTrigger><Info className="h-3.5 w-3.5 text-muted-foreground" /></TooltipTrigger>
                <TooltipContent className="max-w-xs">
                  Tributos que incidem na venda. Muda conforme o produto sai como <strong>Venda</strong> (ICMS) ou <strong>Serviço</strong> (ISS).
                  IRPJ+CSLL incide sobre o lucro.
                </TooltipContent>
              </Tooltip>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              {/* Venda */}
              <div className="space-y-2 p-3 rounded-lg bg-secondary/50 border border-border">
                <div className="flex items-center gap-1.5">
                  <ShoppingCart className="h-3.5 w-3.5 text-blue-400" />
                  <span className="text-xs font-semibold text-blue-400 uppercase">Venda Produto</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">ICMS %</Label>
                    <Input type="number" value={taxSaida.icmsSaida}
                      onChange={(e) => setTaxSaida({ ...taxSaida, icmsSaida: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">PIS %</Label>
                    <Input type="number" value={taxSaida.pisSaida}
                      onChange={(e) => setTaxSaida({ ...taxSaida, pisSaida: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">COFINS %</Label>
                    <Input type="number" value={taxSaida.cofinsSaida}
                      onChange={(e) => setTaxSaida({ ...taxSaida, cofinsSaida: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Total: {(taxSaida.icmsSaida + taxSaida.pisSaida + taxSaida.cofinsSaida).toFixed(2)}% s/ faturamento
                </p>
              </div>

              {/* Serviço */}
              <div className="space-y-2 p-3 rounded-lg bg-secondary/50 border border-border">
                <div className="flex items-center gap-1.5">
                  <Wrench className="h-3.5 w-3.5 text-amber-400" />
                  <span className="text-xs font-semibold text-amber-400 uppercase">Serviço</span>
                </div>
                <div className="grid grid-cols-3 gap-2">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">ISS %</Label>
                    <Input type="number" value={taxSaida.iss}
                      onChange={(e) => setTaxSaida({ ...taxSaida, iss: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">PIS %</Label>
                    <Input type="number" value={taxSaida.pisSaidaServico}
                      onChange={(e) => setTaxSaida({ ...taxSaida, pisSaidaServico: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">COFINS %</Label>
                    <Input type="number" value={taxSaida.cofinsSaidaServico}
                      onChange={(e) => setTaxSaida({ ...taxSaida, cofinsSaidaServico: parseFloat(e.target.value) || 0 })}
                      className="h-7 bg-background text-xs" />
                  </div>
                </div>
                <p className="text-[10px] text-muted-foreground">
                  Total: {(taxSaida.iss + taxSaida.pisSaidaServico + taxSaida.cofinsSaidaServico).toFixed(2)}% s/ faturamento
                </p>
              </div>
            </div>

          </CardContent>
        </Card>
      </div>

      <Tabs defaultValue="estoque" className="space-y-4">
        <TabsList className="bg-secondary">
          <TabsTrigger value="estoque" className="gap-1.5">
            <Package className="h-4 w-4" /> Análise Estoque
          </TabsTrigger>
          <TabsTrigger value="calculadora" className="gap-1.5">
            <Calculator className="h-4 w-4" /> Calculadora Margem
          </TabsTrigger>
          <TabsTrigger value="tributos" className="gap-1.5">
            <FileText className="h-4 w-4" /> Tributos NF Entrada
          </TabsTrigger>
        </TabsList>

        {/* ── TAB: Análise Estoque ── */}
        <TabsContent value="estoque" className="space-y-4">
          <div className="flex items-center gap-3 flex-wrap">
            <form
              className="relative flex-1 min-w-[200px] max-w-md flex gap-2"
              onSubmit={(e) => { e.preventDefault(); setSearch(searchInput.trim()); }}
            >
              <div className="relative flex-1">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                <Input
                  placeholder="Buscar produto por nome ou código... (Enter)"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  className="pl-9 pr-9 bg-secondary"
                />
                {searchInput && (
                  <button
                    type="button"
                    onClick={() => { setSearchInput(""); setSearch(""); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground text-xs px-1"
                    aria-label="Limpar busca"
                  >
                    ✕
                  </button>
                )}
              </div>
              <Button type="submit" size="sm" variant="secondary">OK</Button>
            </form>


            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Margem:</Label>
              <Select value={marginFilter} onValueChange={(v) => setMarginFilter(v as typeof marginFilter)}>
                <SelectTrigger className="w-[180px] h-8 text-xs bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="todos">Todos os produtos</SelectItem>
                  <SelectItem value="fora">
                    <span className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3 text-destructive" /> Fora da margem mínima</span>
                  </SelectItem>
                  <SelectItem value="negativa">
                    <span className="flex items-center gap-1.5"><AlertTriangle className="h-3 w-3 text-destructive" /> Margem negativa</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Grupo:</Label>
              <SearchableSelect
                options={grupoOptions}
                value={grupoFilter}
                onValueChange={(value) => setGrupoFilter(value || "todos")}
                placeholder="Todos os grupos"
                searchPlaceholder="Pesquisar grupo..."
                emptyMessage="Nenhum grupo encontrado."
                className="w-[220px] h-8 text-xs bg-secondary"
              />
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Tipo saída:</Label>
              <Select value={tipoSaidaGlobal} onValueChange={(v) => setTipoSaidaGlobal(v as TipoSaida)}>
                <SelectTrigger className="w-[160px] h-8 text-xs bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="venda">
                    <span className="flex items-center gap-1.5"><ShoppingCart className="h-3 w-3" /> Venda Produto</span>
                  </SelectItem>
                  <SelectItem value="servico">
                    <span className="flex items-center gap-1.5"><Wrench className="h-3 w-3" /> Serviço</span>
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Tabela ref.:</Label>
              <div className="flex gap-1">
                {(["A", "B", "P"] as const).map((t) => (
                  <Badge
                    key={t}
                    variant={tabelaVenda === t ? "default" : "outline"}
                    className={`cursor-pointer text-xs px-2 py-0.5 ${tabelaVenda === t ? "" : "opacity-60 hover:opacity-100"}`}
                    onClick={() => setTabelaVenda(t)}
                  >
                    {t}
                  </Badge>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Label className="text-xs text-muted-foreground whitespace-nowrap">Margem alvo:</Label>
              <div className="w-32">
                <Slider value={[margemAlvo]} onValueChange={([v]) => setMargemAlvo(v)} min={5} max={50} step={1} />
              </div>
              <Badge variant="secondary" className="text-xs font-mono w-12 justify-center">{margemAlvo}%</Badge>
            </div>
            {loadingProdutos && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />}
          </div>

          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Info className="h-3.5 w-3.5" />
            Saída como <strong className={tipoSaidaGlobal === "venda" ? "text-blue-400" : "text-amber-400"}>
              {getTipoSaidaLabel(tipoSaidaGlobal)}
            </strong>: {getTipoSaidaAliquota(tipoSaidaGlobal)}
          </div>

          <Card className="border-border bg-card overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent [&>th]:sticky [&>th]:top-0 [&>th]:z-30 [&>th]:bg-card">
                  <TableHead className="text-xs" rowSpan={2}>Produto</TableHead>
                  <TableHead className="text-xs text-right" rowSpan={2}>Estoque</TableHead>
                  <TableHead className="text-xs text-right" rowSpan={2}>Custo</TableHead>
                  <TableHead className="text-xs text-center" rowSpan={2}>Fonte</TableHead>
                  <TableHead className="text-xs text-right" rowSpan={2}>Créd. Entrada</TableHead>
                  <TableHead className="text-xs text-right" rowSpan={2}>Custo Total</TableHead>
                  <TableHead className="text-xs text-right font-semibold text-primary" rowSpan={2}>Preço Mín.</TableHead>
                  {(politicas ?? []).map((pol, idx) => (
                    <TableHead
                      key={pol.tipo_id}
                      className={`text-xs text-center border-l border-border ${idx % 3 === 0 ? "text-blue-400" : idx % 3 === 1 ? "text-yellow-400" : "text-purple-400"}`}
                      colSpan={3}
                    >
                      {pol.nome_tabela}
                      <div className="text-[9px] font-normal text-muted-foreground">mín {(Number(pol.margem_minima) * 100).toFixed(0)}%</div>
                    </TableHead>
                  ))}
                </TableRow>
                <TableRow className="border-border hover:bg-transparent [&>th]:sticky [&>th]:top-14 [&>th]:z-30 [&>th]:bg-card">
                  {(politicas ?? []).map((pol) => (
                    <Fragment key={pol.tipo_id}>
                      <TableHead className="text-[10px] text-right border-l border-border bg-card">Venda</TableHead>
                      <TableHead className="text-[10px] text-right bg-card">Tributo</TableHead>
                      <TableHead className="text-[10px] text-center bg-card">Margem</TableHead>
                    </Fragment>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {filtered.length === 0 && !loadingProdutos && (
                  <TableRow>
                    <TableCell colSpan={16} className="text-center text-muted-foreground py-8">
                      {search ? "Nenhum produto encontrado" : "Busque produtos do estoque GestãoClick"}
                    </TableCell>
                  </TableRow>
                )}
                {paged.map((p) => {
                  // Refator v3: custo canônico vem da view v_produto_custo_atual (fonte = gc_produtos_cache.valor_custo)
                  const custoCan = custoCanonicoMap.get(p.id);
                  const custoBruto = custoCan ? custoCan.custo : (parseFloat(p.valor_custo) || 0);
                  const statusCusto = custoCan?.status || "ok_sem_tributo";
                  const estoque = Number(p.estoque) || 0;
                   const tributoRaw = tributosMap.get(p.id);
                   const tributo = isTributoCompativelComProduto(p, tributoRaw) ? tributoRaw : undefined;
                   const hasNF = !!tributo;
                    const custoBase = custoBruto;
                   // Tabelas dinâmicas — preços reais vêm de valoresMap por tipo_id (não há mais markup hardcoded A/B/P)


                  let calc: ReturnType<typeof calcPricing>;
                  const cfuFlatLinha = usarOverrideFlat ? (taxEntrada.custoFixoUnit || 0) : 0;
                  const icmsOvLinha = icmsSaidaOverrides.get(p.id);
                  const taxSaidaLinha = icmsOvLinha !== undefined
                    ? { ...taxSaida, icmsSaida: icmsOvLinha }
                    : taxSaida;
                  if (hasNF) {
                    const nfCalc = calcPricingWithNF(tributo, taxSaidaLinha, tipoSaidaGlobal, cfuFlatLinha, margemAlvo, custoFixoPctEfetivo, custoBruto);
                    calc = {
                      creditoIcms: nfCalc.creditoIcms,
                      creditoPis: nfCalc.creditoPis,
                      creditoCofins: nfCalc.creditoCofins,
                      totalCreditosEntrada: nfCalc.totalCreditosEntrada,
                      custoLiquido: nfCalc.custoEfetivo,
                      custoFrete: tributo.valor_frete_unit,
                      custoTotal: nfCalc.custoTotal,
                      precoMinimo: nfCalc.precoMinimo,
                      tributosSaida: nfCalc.tributosSaida,
                      custoFixoEmbutido: nfCalc.custoFixoEmbutido,
                      impostoRenda: nfCalc.impostoRenda,
                      lucroAnteIR: nfCalc.lucroAnteIR,
                      lucroLiquido: nfCalc.lucroLiquido,
                      margemReal: nfCalc.precoMinimo > 0 ? (nfCalc.lucroLiquido / nfCalc.precoMinimo) * 100 : 0,
                      aliquotaSaidaFaturamento: nfCalc.aliquotaSaidaFaturamento,
                      custoFixoPct: nfCalc.custoFixoPct,
                    };
                  } else {
                    calc = calcPricing(custoBruto, { ...activeEntrada, custoFixoUnit: cfuFlatLinha }, taxSaidaLinha, tipoSaidaGlobal, margemAlvo, custoFixoPctEfetivo);
                  }




                  return (
                    <TableRow key={p.id} className="border-border">
                      <TableCell>
                        <div>
                          <span className="font-medium text-foreground text-sm">{p.nome}</span>
                          {(p.codigo || p.codigo_interno) && (
                            <span className="text-xs text-muted-foreground ml-2">#{p.codigo || p.codigo_interno}</span>
                          )}
                          {p.nome_grupo && (
                            <Badge variant="outline" className="ml-2 text-[10px] py-0">{p.nome_grupo}</Badge>
                          )}
                          {statusCusto === "ok_com_tributo" && (
                            <Badge className="ml-2 text-[10px] py-0 bg-green-500/20 text-green-400 border-green-500/30">Custo + Tributo OK</Badge>
                          )}
                          {statusCusto === "ok_sem_tributo" && (
                            <Badge className="ml-2 text-[10px] py-0 bg-yellow-500/20 text-yellow-400 border-yellow-500/30">Custo OK (sem XML)</Badge>
                          )}
                          {statusCusto === "pendente_custo_zero" && (
                            <Badge className="ml-2 text-[10px] py-0 bg-red-500/20 text-red-400 border-red-500/30">⚠ Custo zero no GC</Badge>
                          )}
                          {(() => {
                            if (!hasNF) return null;
                            const nfCusto = Number(tributo.valor_unitario_nf) || 0;
                            const gcCusto = Number(p.valor_custo) || 0;
                            if (nfCusto <= 0 || gcCusto <= 0) return null;
                            const diffPct = ((gcCusto - nfCusto) / nfCusto) * 100;
                            if (Math.abs(diffPct) < 1) return null;
                            const acima = diffPct > 0;
                            return (
                              <Badge
                                className={`ml-2 text-[10px] py-0 ${
                                  acima
                                    ? "bg-red-500/20 text-red-400 border-red-500/30"
                                    : "bg-orange-500/20 text-orange-400 border-orange-500/30"
                                }`}
                                title={`GC: ${formatCurrency(gcCusto)} · NF: ${formatCurrency(nfCusto)} · diff: ${diffPct.toFixed(1)}%`}
                              >
                                ⚠ Custo GC {acima ? "acima" : "abaixo"} da NF ({diffPct > 0 ? "+" : ""}{diffPct.toFixed(1)}%)
                              </Badge>
                            );
                          })()}
                          {(() => {
                            const items = outOfMarginByProduct.get(String(p.id)) || [];
                            if (items.length === 0) return null;
                            const bulkKey = `produto:${p.id}`;
                            return (
                              <Button
                                size="sm"
                                variant="default"
                                className="ml-2 h-6 px-2 text-[10px] gap-1"
                                disabled={!!bulkCorrigindo || !!corrigindoKey}
                                onClick={() => corrigirPrecoBatch(items, `${p.nome.slice(0, 24)} (${items.length} tabela${items.length > 1 ? "s" : ""})`, bulkKey)}
                                title={`Aplica preço sugerido em ${items.length} tabela(s) fora da margem deste produto`}
                              >
                                {bulkCorrigindo === bulkKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                Corrigir {items.length} tabela{items.length > 1 ? "s" : ""}
                              </Button>
                            );
                          })()}
                          {(() => {
                            const itemsAbove = aboveMarginByProduct.get(String(p.id)) || [];
                            if (itemsAbove.length === 0) return null;
                            const bulkKey = `produto-reduzir:${p.id}`;
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                className="ml-2 h-6 px-2 text-[10px] gap-1 border-amber-500/40 text-amber-400 hover:bg-amber-500/10"
                                disabled={!!bulkCorrigindo || !!corrigindoKey}
                                onClick={() => corrigirPrecoBatch(itemsAbove, `${p.nome.slice(0, 24)} reduzir ${itemsAbove.length} tab.`, bulkKey)}
                                title={`Reduz preço em ${itemsAbove.length} tabela(s) acima da margem mínima deste produto`}
                              >
                                {bulkCorrigindo === bulkKey ? <Loader2 className="h-3 w-3 animate-spin" /> : <RefreshCw className="h-3 w-3" />}
                                Reduzir {itemsAbove.length} tabela{itemsAbove.length > 1 ? "s" : ""}
                              </Button>
                            );
                          })()}
                          {tipoSaidaGlobal === "venda" && (
                            <div className="mt-1.5 flex items-center gap-1.5 text-[10px]">
                              <span className="text-muted-foreground">ICMS saída:</span>
                              <Input
                                type="number"
                                step="0.01"
                                className="h-6 w-16 px-1.5 text-[10px] font-mono bg-secondary"
                                placeholder={String(taxSaida.icmsSaida)}
                                defaultValue={icmsSaidaOverrides.get(p.id) ?? ""}
                                key={`icms-ov-${p.id}-${icmsSaidaOverrides.get(p.id) ?? "x"}`}
                                onBlur={(e) => {
                                  const raw = e.target.value.trim().replace(",", ".");
                                  setIcmsSaidaOverrides((prev) => {
                                    const next = new Map(prev);
                                    if (raw === "") { next.delete(p.id); return next; }
                                    const n = parseFloat(raw);
                                    if (!isFinite(n) || n < 0 || n > 50) { toast.error("ICMS saída inválido (0–50%)"); return prev; }
                                    next.set(p.id, n);
                                    return next;
                                  });
                                }}
                                title="Override de ICMS de saída para este produto (vazio = usa global)"
                              />
                              <span className="text-muted-foreground">%</span>
                              {icmsSaidaOverrides.has(p.id) && (
                                <button
                                  type="button"
                                  className="text-muted-foreground hover:text-foreground"
                                  onClick={() => setIcmsSaidaOverrides((prev) => { const next = new Map(prev); next.delete(p.id); return next; })}
                                  title="Limpar override"
                                >
                                  ✕
                                </button>
                              )}
                            </div>
                          )}
                        </div>
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">{estoque}</TableCell>
                      <TableCell className="text-right font-mono text-sm">{formatCurrency(custoBase)}</TableCell>
                      <TableCell className="text-center">
                        {hasNF ? (
                          <Tooltip>
                            <TooltipTrigger>
                              {(() => {
                                const nfNum = tributo.nf_numero || (tributo.nf_chave?.length === 44 ? String(parseInt(tributo.nf_chave.substring(25, 34))) : "");
                                const pedidoNum = tributo.compra_codigo || "";
                                return (
                                  <div className="flex flex-col items-center gap-0.5">
                                    <Badge className={`text-[10px] gap-1 ${
                                      tributo.regime_fornecedor === "simples_nacional" || tributo.sem_credito
                                        ? "bg-amber-500/20 text-amber-400"
                                        : "bg-primary/20 text-primary"
                                    }`}>
                                      <FileText className="h-3 w-3" />
                                      {tributo.fornecedor_nome || "NF"}
                                      {nfNum ? ` · NF #${nfNum}` : ""}
                                      {(tributo.regime_fornecedor === "simples_nacional" || tributo.sem_credito) ? " ·SN" : ""}
                                    </Badge>
                                    {pedidoNum && (
                                      <Badge variant="outline" className="text-[9px] border-purple-500/40 text-purple-400">
                                        Pedido #{pedidoNum}
                                      </Badge>
                                    )}
                                    {tributo.match_rule && (
                                      <Badge variant="outline" className={`text-[9px] ${
                                        tributo.match_rule.startsWith("pedido_compra_gc+cprod") ? "border-green-500/40 text-green-400" :
                                        tributo.match_rule === "pedido_compra_gc_sem_xml_item" ? "border-orange-500/40 text-orange-400" :
                                        "border-muted-foreground/40 text-muted-foreground"
                                      }`}>
                                        {({
                                          "pedido_compra_gc+cprod": "✓ Pedido+Código",
                                          "pedido_compra_gc+cprod_multi": "✓ Pedido+Código",
                                          pedido_compra_gc_sem_xml_item: "Pedido GC s/XML",
                                        } as Record<string, string>)[tributo.match_rule] || tributo.match_rule}
                                      </Badge>
                                    )}
                                  </div>
                                );
                              })()}
                            </TooltipTrigger>
                            <TooltipContent className="text-xs max-w-sm">
                              <p className="font-semibold">NF #{tributo.nf_numero} — {tributo.fornecedor_nome}</p>
                              {tributo.match_rule && (
                                <p className="mt-1">
                                  <span className="font-semibold">Match: </span>
                                  <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-mono ${
                                    tributo.match_rule.startsWith("pedido_compra_gc+cprod") ? "bg-green-500/20 text-green-400" :
                                    tributo.match_rule === "pedido_compra_gc_sem_xml_item" ? "bg-orange-500/20 text-orange-400" :
                                    "bg-muted text-muted-foreground"
                                  }`}>
                                    {({
                                      "pedido_compra_gc+cprod": "✓ Pedido GC + código XML",
                                      "pedido_compra_gc+cprod_multi": "✓ Pedido GC + código XML",
                                      pedido_compra_gc_sem_xml_item: "Pedido GC sem item XML confiável",
                                    } as Record<string, string>)[tributo.match_rule] || tributo.match_rule}
                                  </span>
                                </p>
                              )}
                              {(tributo.regime_fornecedor === "simples_nacional" || tributo.sem_credito) && (
                                <p className="text-amber-400 font-semibold">⚠ Simples Nacional — Sem créditos de entrada</p>
                              )}
                              {(() => { const eff = getEffectiveRates(tributo); return (
                                <>
                                  <p>ICMS: {eff.icms}% · PIS: {eff.pis}% · COFINS: {eff.cofins}%</p>
                                  <p>IPI: {eff.ipi}% · Frete: {tributo.frete_percentual}%</p>
                                </>
                              ); })()}
                              <p>CFOP: {tributo.cfop || "—"}</p>
                            </TooltipContent>
                          </Tooltip>
                        ) : (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 text-[10px] gap-1 border-yellow-500/40 text-yellow-400 hover:bg-yellow-500/10"
                            onClick={() => abrirManualTributo(p)}
                          >
                            <Plus className="h-3 w-3" />
                            Adicionar crédito
                          </Button>
                        )}
                        {hasNF && (
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-6 px-2 mt-1 text-[10px] gap-1 border-blue-500/40 text-blue-400 hover:bg-blue-500/10"
                            onClick={() => abrirManualTributo(p, tributo)}
                            title={tributo.match_rule === "manual" ? "Editar crédito manual" : "Editar valores (frete, alíquotas) — vira override manual"}
                          >
                            <Pencil className="h-3 w-3" />
                            Editar valores
                          </Button>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm text-green-400">
                        -{formatCurrency(calc.totalCreditosEntrada)}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm font-semibold">{formatCurrency(calc.custoTotal)}</TableCell>
                      <TableCell className="text-right font-mono text-sm font-bold text-primary">
                        {formatCurrency(calc.precoMinimo)}
                      </TableCell>
                      {/* Tabelas dinâmicas (lê fin_politica_markup_tabela + valor_venda real de gc_produtos_cache) */}
                      {(() => {
                        const valoresProd = valoresMap.get(p.id);
                        return (politicas ?? []).map((pol, idx) => {
                          const margemMin = Number(pol.margem_minima) || 0;
                          // Divisor SEM custoFixoPct — alinha com a margem exibida (venda - custo - trib)/venda
                          const divInline = 1 - calc.aliquotaSaidaFaturamento - margemMin;
                          const precoBruto = calc.custoTotal > 0 && divInline > 0.05 ? calc.custoTotal / divInline : calc.custoTotal * 5;
                          const precoSugerido = calc.custoTotal > 0 ? Math.min(precoBruto, calc.custoTotal * 5) : 0;
                          const vendaReal = valoresProd?.get(String(pol.tipo_id)) ?? 0;
                          const temPrecoCadastrado = vendaReal > 0;
                          const venda = temPrecoCadastrado ? vendaReal : precoSugerido;
                          const trib = venda * calc.aliquotaSaidaFaturamento;
                          const margem = venda > 0 && calc.custoTotal > 0 ? ((venda - calc.custoTotal - trib) / venda) * 100 : 0;
                          // Tolerância de 0.05pp para evitar que 4.97% exibido como "5.0%" apareça como fora da margem
                          const okMin = temPrecoCadastrado && margem >= (margemMin * 100 - 0.05);
                          const cor = idx % 3 === 0 ? "text-blue-400" : idx % 3 === 1 ? "text-yellow-400" : "text-purple-400";
                          return (
                            <Fragment key={pol.tipo_id}>
                              <TableCell className={`text-right font-mono text-xs ${cor} border-l border-border`}>
                                {vendaReal > 0 ? formatCurrency(vendaReal) : <span className="italic text-muted-foreground">sug. {formatCurrency(precoSugerido)}</span>}
                              </TableCell>
                              <TableCell className="text-right font-mono text-[10px] text-orange-400">-{formatCurrency(trib)}</TableCell>
                              <TableCell className="text-center">
                                <div className="flex flex-col items-center gap-1">
                                  <Badge className={`text-[10px] gap-0.5 ${okMin ? "bg-green-500/20 text-green-400" : "bg-destructive/20 text-destructive"}`}>
                                    {okMin ? <TrendingUp className="h-3 w-3"/> : <AlertTriangle className="h-3 w-3"/>} {margem.toFixed(1)}%
                                  </Badge>
                                  {precoSugerido > 0 && (!temPrecoCadastrado || Math.abs(vendaReal - precoSugerido) > 0.01) && (
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className={`h-5 px-1.5 text-[9px] gap-1 ${okMin ? "border-amber-500/40 text-amber-400 hover:bg-amber-500/10" : ""}`}
                                      disabled={corrigindoKey === `${p.id}:${pol.tipo_id}`}
                                      onClick={() => corrigirPreco({
                                        gc_produto_id: String(p.id),
                                        nome_produto: p.nome,
                                        tipo_id: String(pol.tipo_id),
                                        nome_tabela: pol.nome_tabela,
                                        preco_atual: vendaReal,
                                        preco_sugerido: precoSugerido,
                                        margem_minima: margemMin,
                                        margem_resultante: margemMin,
                                        custo_referencia: calc.custoTotal,
                                      })}
                                      title={
                                        okMin
                                          ? `Ajustar p/ margem mín ${(margemMin*100).toFixed(0)}% — preço cai de ${formatCurrency(vendaReal)} → ${formatCurrency(precoSugerido)}`
                                          : `Enviar ${formatCurrency(precoSugerido)} pro GC (margem mín ${(margemMin*100).toFixed(0)}%)`
                                      }
                                    >
                                      {corrigindoKey === `${p.id}:${pol.tipo_id}` ? <Loader2 className="h-2.5 w-2.5 animate-spin"/> : <RefreshCw className="h-2.5 w-2.5"/>}
                                      {okMin ? "Ajustar" : "Corrigir"}
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            </Fragment>
                          );
                        });
                      })()}
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>

          <div className="flex items-center justify-between gap-3 flex-wrap">
            <p className="text-xs text-muted-foreground">
              {produtos ? `${produtos.length} produtos do cadastro GC · ` : "Sem cadastro GC carregado · "}
              {totalComTributoNF} com tributo NF · Filtrados {filtered.length} · Mostrando {paged.length} (pág. {currentPage}/{totalPages}) · Tipo saída: {getTipoSaidaLabel(tipoSaidaGlobal)}
            </p>
            <div className="flex items-center gap-1">
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={currentPage <= 1} onClick={() => setPage(1)}>«</Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={currentPage <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>‹ Ant</Button>
              <span className="text-xs font-mono px-2">{currentPage} / {totalPages}</span>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={currentPage >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Próx ›</Button>
              <Button size="sm" variant="outline" className="h-7 px-2 text-xs" disabled={currentPage >= totalPages} onClick={() => setPage(totalPages)}>»</Button>
            </div>
          </div>

        </TabsContent>

        {/* ── TAB: Calculadora ── */}
        <TabsContent value="calculadora" className="space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <DollarSign className="h-5 w-5 text-primary" />
                  Valor do Equipamento
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>Custo de aquisição (R$)</Label>
                  <Input type="number" placeholder="Ex: 5000.00" value={calcCusto}
                    onChange={(e) => setCalcCusto(e.target.value)}
                    className="text-lg h-12 bg-secondary font-mono" />
                </div>

                <div className="space-y-2">
                  <Label>Como o produto vai sair?</Label>
                  <Select value={calcTipoSaida} onValueChange={(v) => setCalcTipoSaida(v as TipoSaida)}>
                    <SelectTrigger className="bg-secondary">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="venda">
                        <span className="flex items-center gap-1.5"><ShoppingCart className="h-3.5 w-3.5 text-blue-400" /> Venda de Produto (ICMS)</span>
                      </SelectItem>
                      <SelectItem value="servico">
                        <span className="flex items-center gap-1.5"><Wrench className="h-3.5 w-3.5 text-amber-400" /> Prestação de Serviço (ISS)</span>
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {calcTipoSaida === "venda" && (
                  <div className="space-y-2">
                    <Label className="flex items-center gap-1.5">
                      ICMS de saída (%)
                      <Tooltip>
                        <TooltipTrigger><Info className="h-3 w-3 text-muted-foreground" /></TooltipTrigger>
                        <TooltipContent className="max-w-xs text-xs">
                          Sobrepõe o ICMS de saída global ({taxSaida.icmsSaida}%) só nesta calculadora. Deixe vazio para usar o global.
                        </TooltipContent>
                      </Tooltip>
                    </Label>
                    <Input
                      type="number"
                      step="0.01"
                      placeholder={`Padrão: ${taxSaida.icmsSaida}`}
                      value={calcIcmsSaida}
                      onChange={(e) => setCalcIcmsSaida(e.target.value)}
                      className="bg-secondary font-mono"
                    />
                  </div>
                )}

                {calcCusto && parseFloat(calcCusto) > 0 && (
                  <div className="bg-secondary/50 rounded-lg p-4 space-y-2 text-sm">
                    <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider mb-2">Composição de custo</p>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Custo bruto</span>
                      <span className="font-mono">{formatCurrency(parseFloat(calcCusto))}</span>
                    </div>
                    <div className="flex justify-between text-green-400">
                      <span>Créd. ICMS ({activeEntrada.icmsCredito}%)</span>
                      <span className="font-mono">-{formatCurrency(parseFloat(calcCusto) * activeEntrada.icmsCredito / 100)}</span>
                    </div>
                    <div className="flex justify-between text-green-400">
                      <span>Créd. PIS ({activeEntrada.pisCredito}%)</span>
                      <span className="font-mono">-{formatCurrency(parseFloat(calcCusto) * activeEntrada.pisCredito / 100)}</span>
                    </div>
                    <div className="flex justify-between text-green-400">
                      <span>Créd. COFINS ({activeEntrada.cofinsCredito}%)</span>
                      <span className="font-mono">-{formatCurrency(parseFloat(calcCusto) * activeEntrada.cofinsCredito / 100)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Frete ({activeEntrada.frete}%)</span>
                      <span className="font-mono">+{formatCurrency(parseFloat(calcCusto) * activeEntrada.frete / 100)}</span>
                    </div>
                    <div className="flex justify-between text-muted-foreground">
                      <span>Custo fixo unit.</span>
                      <span className="font-mono">+{formatCurrency(activeEntrada.custoFixoUnit)}</span>
                    </div>
                    <div className="border-t border-border pt-2 flex justify-between font-semibold">
                      <span>Custo total</span>
                      <span className="font-mono">
                        {formatCurrency(
                          parseFloat(calcCusto) * (1 - (activeEntrada.icmsCredito + activeEntrada.pisCredito + activeEntrada.cofinsCredito) / 100 + activeEntrada.frete / 100) + activeEntrada.custoFixoUnit
                        )}
                      </span>
                    </div>
                    <div className="border-t border-border pt-2 mt-1">
                      <p className="text-[10px] text-muted-foreground">
                        Tributos de saída ({calcTipoSaida === "venda" ? "Venda" : "Serviço"}): {getTipoSaidaAliquota(calcTipoSaida)}
                      </p>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>

            <Card className="border-border bg-card">
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <TrendingUp className="h-5 w-5 text-primary" />
                  Cenários de Margem
                  <Badge variant="outline" className={`text-[10px] ${calcTipoSaida === "venda" ? "text-blue-400 border-blue-400/30" : "text-amber-400 border-amber-400/30"}`}>
                    {calcTipoSaida === "venda" ? "Venda" : "Serviço"}
                  </Badge>
                </CardTitle>
              </CardHeader>
              <CardContent>
                {calcResults.length === 0 ? (
                  <p className="text-sm text-muted-foreground text-center py-8">
                    Insira o valor do equipamento para ver os cenários
                  </p>
                ) : (
                  <Table>
                    <TableHeader>
                      <TableRow className="border-border hover:bg-transparent">
                        <TableHead className="text-xs">Margem</TableHead>
                        <TableHead className="text-xs text-right">Preço Mín.</TableHead>
                        <TableHead className="text-xs text-right">Trib. Saída</TableHead>
                        
                        <TableHead className="text-xs text-right">Lucro Líq.</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {calcResults.map((r) => (
                        <TableRow key={r.margem} className="border-border">
                          <TableCell>
                            <Badge
                              variant={r.margem === 15 ? "default" : "outline"}
                              className={r.margem === 15 ? "bg-primary text-primary-foreground" : ""}
                            >
                              {r.margem}%
                            </Badge>
                          </TableCell>
                          <TableCell className="text-right font-mono font-bold text-primary">
                            {formatCurrency(r.precoMinimo)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-orange-400">
                            {formatCurrency(r.tributosSaida)}
                          </TableCell>
                          <TableCell className="text-right font-mono text-green-400">
                            {formatCurrency(r.lucroLiquido)}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                )}
              </CardContent>
            </Card>
          </div>

          <Card className="border-border bg-card">
            <CardContent className="pt-4">
              <p className="text-xs text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Fórmula (Markup Inverso — Lucro Real):</strong>{" "}
                Preço = Custo Total ÷ (1 − Tributos Saída − Margem).{" "}
                <strong>Venda:</strong> ICMS + PIS + COFINS sobre faturamento.{" "}
                <strong>Serviço:</strong> ISS + PIS + COFINS sobre faturamento.{" "}
                
                Créditos de entrada (ICMS {activeEntrada.icmsCredito}% + PIS {activeEntrada.pisCredito}% + COFINS {activeEntrada.cofinsCredito}%) reduzem o custo de aquisição.
              </p>
            </CardContent>
          </Card>
        </TabsContent>

        {/* ── TAB: Tributos NF Entrada ── */}
        <TabsContent value="tributos" className="space-y-4">
          <Card className="border-border bg-card overflow-hidden">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm flex items-center justify-between">
                <span className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-primary" />
                  Tributos Extraídos das NFs de Entrada
                  <Badge variant="outline" className="text-[10px]">
                    Clique na alíquota para editar · Marque "SN" para Simples Nacional
                  </Badge>
                </span>
                <Button variant="outline" size="sm" onClick={handleSyncNFEntrada} disabled={isSyncing}>
                  {syncingOffline ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <RefreshCw className="h-4 w-4 mr-1" />}
                  Atualizar
                </Button>
              </CardTitle>
            </CardHeader>
            <Table>
              <TableHeader>
                <TableRow className="border-border hover:bg-transparent">
                  <TableHead className="text-xs">Produto</TableHead>
                  <TableHead className="text-xs">Fornecedor / NF</TableHead>
                  <TableHead className="text-xs">NCM</TableHead>
                  <TableHead className="text-xs text-center">Regime</TableHead>
                  <TableHead className="text-xs text-right">Valor Unit.</TableHead>
                  <TableHead className="text-xs text-right">ICMS %</TableHead>
                  <TableHead className="text-xs text-right">PIS %</TableHead>
                  <TableHead className="text-xs text-right">COFINS %</TableHead>
                  <TableHead className="text-xs text-right">IPI %</TableHead>
                  <TableHead className="text-xs text-right">Frete %</TableHead>
                  <TableHead className="text-xs text-right font-semibold text-primary">Custo Efetivo</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {tributosXml.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={11} className="text-center text-muted-foreground py-8">
                      Nenhum tributo com XML de entrada indexado encontrado. Clique em "Sync NFs Entrada" para importar.
                    </TableCell>
                  </TableRow>
                )}
                {tributosXml.map((t) => {
                  const eff = getEffectiveRates(t);
                  // Recalculate effective cost
                  const effCreditoIcms = t.valor_unitario_nf * (eff.icms / 100);
                  const effCreditoPis = t.valor_unitario_nf * (eff.pis / 100);
                  const effCreditoCofins = t.valor_unitario_nf * (eff.cofins / 100);
                  const effCustoEfetivo = t.valor_unitario_nf + t.valor_ipi_unit + t.valor_frete_unit - effCreditoIcms - effCreditoPis - effCreditoCofins;
                  
                  return (
                  <TableRow key={t.gc_produto_id} className={`border-border ${eff.semCredito ? "bg-amber-500/5" : ""}`}>
                    <TableCell>
                      <span className="font-medium text-foreground text-sm">{t.nome_produto}</span>
                      {t.cfop && <span className="text-[10px] text-muted-foreground ml-1">CFOP {t.cfop}</span>}
                    </TableCell>
                    <TableCell>
                      <div className="text-xs">
                        <span className="text-foreground">{t.fornecedor_nome || "—"}</span>
                        {t.nf_numero && (
                          <span className="text-muted-foreground ml-1">NF #{t.nf_numero}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs font-mono text-muted-foreground">{t.ncm || "—"}</TableCell>
                    <TableCell className="text-center">
                      <Button
                        variant={eff.semCredito ? "default" : "outline"}
                        size="sm"
                        className={`text-[10px] h-6 px-2 ${eff.semCredito ? "bg-amber-500/20 text-amber-400 hover:bg-amber-500/30 border-amber-500/30" : ""}`}
                        onClick={async () => {
                          const newSemCredito = !eff.semCredito;
                          const { error } = await supabase
                            .from("fin_produto_tributos")
                            .update({ 
                              sem_credito: newSemCredito,
                              regime_fornecedor: newSemCredito ? "simples_nacional" : "normal"
                            })
                            .eq("gc_produto_id", t.gc_produto_id);
                          if (!error) {
                            refetchTributos();
                            toast.success(newSemCredito ? "Marcado como Simples Nacional" : "Regime alterado para Normal");
                          }
                        }}
                      >
                        {eff.semCredito ? "SN ✓" : "Normal"}
                      </Button>
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{formatCurrency(t.valor_unitario_nf)}</TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.icms} originalValue={t.icms_aliquota} disabled={eff.semCredito}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ icms_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.pis} originalValue={t.pis_aliquota} disabled={eff.semCredito}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ pis_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.cofins} originalValue={t.cofins_aliquota} disabled={eff.semCredito}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ cofins_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right">
                      <EditableRate value={eff.ipi} originalValue={t.ipi_aliquota}
                        onSave={async (v) => {
                          await supabase.from("fin_produto_tributos").update({ ipi_aliquota_manual: v }).eq("gc_produto_id", t.gc_produto_id);
                          refetchTributos();
                        }} />
                    </TableCell>
                    <TableCell className="text-right font-mono text-sm">{t.frete_percentual}%</TableCell>
                    <TableCell className="text-right font-mono text-sm font-bold text-primary">
                      {formatCurrency(effCustoEfetivo)}
                    </TableCell>
                  </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </Card>
        </TabsContent>
      </Tabs>

      <Dialog open={manualTributoOpen} onOpenChange={setManualTributoOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Crédito manual de tributos</DialogTitle>
            <DialogDescription>
              {manualTributoProduto?.nome}
              <span className="block text-xs text-muted-foreground mt-1">
                Use quando não há NF de entrada importada. Os valores informados aqui geram crédito de entrada na precificação.
              </span>
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-3 py-2">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Custo unitário (R$) *</Label>
                <Input
                  type="number" step="0.0001" min="0"
                  value={manualTributoForm.valor_unitario_nf}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, valor_unitario_nf: e.target.value }))}
                />
              </div>
              <div>
                <Label className="text-xs">Regime fornecedor</Label>
                <Select
                  value={manualTributoForm.regime}
                  onValueChange={(v) => setManualTributoForm(f => ({ ...f, regime: v as any }))}
                >
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal (gera crédito)</SelectItem>
                    <SelectItem value="simples_nacional">Simples Nacional (sem crédito)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="grid grid-cols-4 gap-2">
              <div>
                <Label className="text-xs">ICMS %</Label>
                <Input type="number" step="0.01" disabled={manualTributoForm.regime === "simples_nacional"}
                  value={manualTributoForm.icms_aliquota}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, icms_aliquota: e.target.value }))} />
              </div>
              <div>
                <Label className="text-xs">PIS %</Label>
                <Input type="number" step="0.01" disabled={manualTributoForm.regime === "simples_nacional"}
                  value={manualTributoForm.pis_aliquota}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, pis_aliquota: e.target.value }))} />
              </div>
              <div>
                <Label className="text-xs">COFINS %</Label>
                <Input type="number" step="0.01" disabled={manualTributoForm.regime === "simples_nacional"}
                  value={manualTributoForm.cofins_aliquota}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, cofins_aliquota: e.target.value }))} />
              </div>
              <div>
                <Label className="text-xs">IPI %</Label>
                <Input type="number" step="0.01"
                  value={manualTributoForm.ipi_aliquota}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, ipi_aliquota: e.target.value }))} />
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <div>
                <Label className="text-xs">Frete %</Label>
                <Input type="number" step="0.01"
                  value={manualTributoForm.frete_percentual}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, frete_percentual: e.target.value }))} />
              </div>
              <div className="col-span-2">
                <Label className="text-xs">Fornecedor (opcional)</Label>
                <Input value={manualTributoForm.fornecedor_nome}
                  onChange={(e) => setManualTributoForm(f => ({ ...f, fornecedor_nome: e.target.value }))} />
              </div>
            </div>

            <div>
              <Label className="text-xs">Nº NF de referência (opcional)</Label>
              <Input value={manualTributoForm.nf_numero}
                onChange={(e) => setManualTributoForm(f => ({ ...f, nf_numero: e.target.value }))} />
            </div>
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setManualTributoOpen(false)}>Cancelar</Button>
            <Button onClick={salvarManualTributo} disabled={savingManualTributo}>
              {savingManualTributo && <Loader2 className="h-3 w-3 animate-spin mr-1" />}
              Salvar crédito
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Editable Rate Component ──
function EditableRate({ value, originalValue, disabled, onSave }: {
  value: number;
  originalValue: number;
  disabled?: boolean;
  onSave: (v: number | null) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(String(value));
  const isOverridden = value !== originalValue;

  if (disabled) {
    return <span className="font-mono text-sm text-muted-foreground">0%</span>;
  }

  if (editing) {
    return (
      <Input
        type="number"
        step="0.01"
        value={editValue}
        onChange={(e) => setEditValue(e.target.value)}
        onBlur={async () => {
          const parsed = parseFloat(editValue);
          if (!isNaN(parsed) && parsed !== originalValue) {
            await onSave(parsed);
          } else if (parsed === originalValue) {
            await onSave(null); // remove override
          }
          setEditing(false);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          if (e.key === "Escape") setEditing(false);
        }}
        autoFocus
        className="h-6 w-16 text-xs font-mono bg-secondary text-right p-1"
      />
    );
  }

  return (
    <button
      onClick={() => { setEditValue(String(value)); setEditing(true); }}
      className={`font-mono text-sm cursor-pointer hover:underline ${isOverridden ? "text-blue-400 font-semibold" : ""}`}
      title={isOverridden ? `Original: ${originalValue}% · Editado: ${value}%` : "Clique para editar"}
    >
      {value}%
    </button>
  );
}
