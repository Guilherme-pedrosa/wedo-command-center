import { useState, useEffect, useCallback, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { callGC } from "@/lib/gc-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Loader2, Search, HandshakeIcon, AlertCircle, CheckCircle2, ArrowLeft, Settings2, Banknote, ScanSearch, ExternalLink } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import toast from "react-hot-toast";
import { negotiationDueDates, buildNegotiationPlan } from "../../../supabase/functions/_shared/negotiation-plan";

// Extrai mensagem detalhada de erros vindos de supabase.functions.invoke
// (FunctionsHttpError engole o body — precisamos ler manualmente)
async function extractFnError(err: unknown, fallback = "Erro desconhecido"): Promise<string> {
  try {
    const anyErr = err as any;
    // FunctionsHttpError tem .context (Response)
    const ctx = anyErr?.context;
    if (ctx && typeof ctx.json === "function") {
      try {
        const body = await ctx.clone().json();
        if (body?.error) return String(body.error);
        if (body?.message) return String(body.message);
      } catch {
        try {
          const txt = await ctx.clone().text();
          if (txt) return txt.slice(0, 300);
        } catch { /* ignore */ }
      }
    }
    // Detectar timeout do gateway (504)
    const status = ctx?.status;
    if (status === 504 || status === 408) {
      return "A operação demorou mais de 150s e o gateway encerrou a conexão. O processamento pode continuar no servidor — aguarde alguns segundos e atualize a tela para ver o resultado real.";
    }
    if (anyErr?.message && anyErr.message !== "Edge Function returned a non-2xx status code") {
      return String(anyErr.message);
    }
    if (status) return `Falha HTTP ${status} na função.`;
    return anyErr?.message || fallback;
  } catch {
    return (err as Error)?.message || fallback;
  }
}

interface ResidualItem {
  id: string;
  valor_residual: number;
  negociacao_origem_numero: number | null;
  observacao: string | null;
  created_at: string | null;
  gc_recebimento_id: string | null;
  gc_codigo: string | null;
  os_codigos: string[] | null;
}

interface OSItem {
  id: string;
  codigo: string;
  descricao: string;
  valor_total: number;
  nome_cliente: string;
  data: string;
  nome_situacao: string;
}

interface ClientGroup {
  cliente_id: string;
  nome_cliente: string;
  os_list: OSItem[];
  valor_total: number;
  /** Soma de passivos disponíveis (usada quando o cliente não tem OS aberta) */
  passivo_total?: number;
}

interface NegotiateResult {
  os_id: string;
  status: string;
  error?: string;
}

interface GCSituacao {
  id: string;
  nome: string;
}

const CONFIG_KEY = "negociacao_situacao_ids";
const DEFAULT_SITUACAO = "7116099"; // Executado - Ag Negociação Financeira

const toCents = (value: number) => Math.round((Number.isFinite(value) ? value : 0) * 100);
const fromCents = (value: number) => value / 100;
const splitEvenlyCents = (totalCents: number, parts: number) => {
  const count = Number.isInteger(parts) && parts > 0 && parts <= 60 ? parts : 0;
  if (!count || totalCents <= 0) return Array(count).fill(0);
  return buildNegotiationPlan([{ key: "preview", availableCents: totalCents }], totalCents, undefined, parts).installmentCents;
};
const pendingStorageKey = (userId: string) => `wedo:negociacao:pending:${userId}`;

function waitForJobUpdate(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const finish = () => { clearTimeout(timer); signal.removeEventListener("abort", finish); resolve(); };
    const timer = setTimeout(finish, 3000);
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function clearRejectedDraft(error: unknown, userId: string): Promise<boolean> {
  const response = (error as any)?.context;
  if (!response || ![400, 401, 403, 409, 422].includes(response.status)) return false;
  try {
    const body = await response.clone().json();
    // O servidor confirmou recusa anterior à execução; timeout e resultado ambíguo preservam o pedido.
    if (body.success !== false || body.pending_reconciliation !== false) return false;
    const key = pendingStorageKey(userId);
    const stored = localStorage.getItem(key);
    if (stored && JSON.parse(stored).job_id) return false;
    localStorage.removeItem(key);
    return true;
  } catch { return false; }
}

export default function NegociacaoOSPage() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [executing, setExecuting] = useState(false);
  const [pendingJob, setPendingJob] = useState<string | null>(null);
  const [jobProgress, setJobProgress] = useState("");
  const [canResume, setCanResume] = useState(false);
  const recoveryStarted = useRef(false);
  const jobWatcher = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; jobWatcher.current?.abort(); };
  }, []);
  const [clients, setClients] = useState<ClientGroup[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientGroup | null>(null);
  const [selectedOSIds, setSelectedOSIds] = useState<Set<string>>(new Set());
  const [searchTerm, setSearchTerm] = useState("");

  // Config
  const [showConfig, setShowConfig] = useState(false);
  const [situacoes, setSituacoes] = useState<GCSituacao[]>([]);
  const [selectedSituacoes, setSelectedSituacoes] = useState<string[]>([DEFAULT_SITUACAO]);
  const [loadingSituacoes, setLoadingSituacoes] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);

  // Negotiation params
  const [showNegotiate, setShowNegotiate] = useState(false);
  const [parcelas, setParcelas] = useState(10);
  const [diaVencimento, setDiaVencimento] = useState(10);
  const [mesInicio, setMesInicio] = useState(() => {
    const d = new Date();
    const next = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    return `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, "0")}`;
  });
  const [valoresParcelas, setValoresParcelas] = useState<number[]>([]);
  const [valorNegociado, setValorNegociado] = useState<number>(0);

  // Residuals
  const [clientResiduais, setClientResiduais] = useState<ResidualItem[]>([]);
  const [selectedResidualIds, setSelectedResidualIds] = useState<Set<string>>(new Set());
  const [osCodeToIdMap, setOsCodeToIdMap] = useState<Record<string, string>>({});

  // Results
  const [results, setResults] = useState<NegotiateResult[] | null>(null);
  const [scanningPassivos, setScanningPassivos] = useState(false);

  // Load saved config
  useEffect(() => {
    (async () => {
      const { data } = await supabase
        .from("fin_configuracoes")
        .select("valor")
        .eq("chave", CONFIG_KEY)
        .maybeSingle();
      if (data?.valor) {
        try {
          const ids = JSON.parse(data.valor) as string[];
          if (Array.isArray(ids) && ids.length > 0) {
            setSelectedSituacoes(ids);
          }
        } catch { /* ignore */ }
      }
    })();
  }, []);

  const fetchOS = useCallback(async () => {
    setLoading(true);
    try {
      const { data, error } = await supabase.functions.invoke("negotiate-os", {
        body: { action: "list", situacao_ids: selectedSituacoes },
      });
      if (error) throw error;
      const groupedClients: ClientGroup[] = (data.clients || [])
        .map((c: ClientGroup) => {
          const osList = c.os_list.filter((os) => os.valor_total > 0);
          const valorTotal = osList.reduce((sum, os) => sum + os.valor_total, 0);
          return { ...c, os_list: osList, valor_total: valorTotal };
        })
        .filter((c: ClientGroup) => c.os_list.length >= 1 && c.valor_total > 0);

      // Clientes que só têm passivo disponível (sem OS na situação) também
      // precisam aparecer na busca — senão o passivo fica invisível.
      const { data: residuos } = await (supabase as any)
        .from("fin_residuos_negociacao")
        .select("cliente_gc_id, nome_cliente, valor_residual")
        .eq("utilizado", false)
        .eq("estado", "disponivel")
        .limit(5000);

      const existentes = new Set(groupedClients.map((c) => String(c.cliente_id)));
      const soPassivo = new Map<string, ClientGroup>();
      for (const r of residuos || []) {
        const id = String((r as any).cliente_gc_id || "");
        if (!id || existentes.has(id)) continue;
        const atual = soPassivo.get(id);
        if (atual) {
          atual.passivo_total = (atual.passivo_total || 0) + (Number((r as any).valor_residual) || 0);
        } else {
          soPassivo.set(id, {
            cliente_id: id,
            nome_cliente: String((r as any).nome_cliente || "—"),
            os_list: [],
            valor_total: 0,
            passivo_total: Number((r as any).valor_residual) || 0,
          });
        }
      }


      const todos = [...groupedClients, ...soPassivo.values()];
      setClients(todos);
      if (todos.length === 0) {
        toast("Nenhum cliente com OS nas situações selecionadas", { icon: "ℹ️" });
      }
    } catch (err) {
      const msg = await extractFnError(err, "Falha ao buscar OS");
      toast.error(`Erro ao buscar OS: ${msg}`, { duration: 8000 });
      console.error("[NegociacaoOS][list] erro detalhado:", err);
    } finally {
      setLoading(false);
    }
  }, [selectedSituacoes]);

  useEffect(() => {
    fetchOS();
  }, [fetchOS]);

  const fetchSituacoes = async () => {
    setLoadingSituacoes(true);
    try {
      const res = await callGC<{ data: GCSituacao[] }>({
        endpoint: "/api/situacoes_ordens_servicos",
        params: { limite: "200", pagina: "1" },
      });
      const items = Array.isArray(res.data?.data) ? res.data.data : [];
      setSituacoes(items.map((s: any) => ({ id: String(s.id), nome: String(s.nome || s.id) })));
    } catch (err) {
      toast.error("Erro ao carregar situações do GestãoClick");
    } finally {
      setLoadingSituacoes(false);
    }
  };

  const handleOpenConfig = () => {
    setShowConfig(true);
    if (situacoes.length === 0) fetchSituacoes();
  };

  const toggleSituacao = (id: string) => {
    setSelectedSituacoes((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]
    );
  };

  const handleSaveConfig = async () => {
    if (selectedSituacoes.length === 0) {
      toast.error("Selecione ao menos uma situação");
      return;
    }
    setSavingConfig(true);
    try {
      const { error } = await supabase
        .from("fin_configuracoes")
        .upsert(
          { chave: CONFIG_KEY, valor: JSON.stringify(selectedSituacoes), updated_at: new Date().toISOString() },
          { onConflict: "chave" }
        );
      if (error) throw error;
      toast.success("Configuração salva!");
      setShowConfig(false);
      fetchOS();
    } catch (err) {
      toast.error("Erro ao salvar configuração");
    } finally {
      setSavingConfig(false);
    }
  };

  const filteredClients = clients.filter((c) =>
    c.nome_cliente.toLowerCase().includes(searchTerm.toLowerCase())
  );

  const handleSelectClient = async (client: ClientGroup) => {
    setSelectedClient(client);
    setSelectedOSIds(new Set(client.os_list.map((os) => os.id)));
    // Fetch residuals for this client
    const { data } = await (supabase as any)
      .from("fin_residuos_negociacao")
      .select("*")
      .eq("cliente_gc_id", client.cliente_id)
      .eq("utilizado", false)
        .eq("estado", "disponivel")
      .order("created_at", { ascending: false });
    const residuals = (data as ResidualItem[]) || [];
    setClientResiduais(residuals);
    setSelectedResidualIds(new Set());

    // Lookup os_id from os_index for residual os_codigos
    const allOsCodes = residuals.flatMap(r => r.os_codigos || []);
    if (allOsCodes.length > 0) {
      const uniqueCodes = [...new Set(allOsCodes)];
      const { data: osRows } = await supabase
        .from("os_index")
        .select("os_id, os_codigo")
        .in("os_codigo", uniqueCodes);
      const map: Record<string, string> = {};
      (osRows || []).forEach((row: any) => { map[row.os_codigo] = row.os_id; });
      setOsCodeToIdMap(map);
    } else {
      setOsCodeToIdMap({});
    }
  };

  const toggleResidual = (id: string) => {
    setSelectedResidualIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleBack = () => {
    if (selectedClient) {
      setSelectedClient(null);
      setSelectedOSIds(new Set());
      setClientResiduais([]);
      setSelectedResidualIds(new Set());
      return;
    }
    navigate(-1);
  };

  const toggleOS = (osId: string) => {
    setSelectedOSIds((prev) => {
      const next = new Set(prev);
      if (next.has(osId)) next.delete(osId);
      else next.add(osId);
      return next;
    });
  };

  const toggleAll = () => {
    if (!selectedClient) return;
    if (selectedOSIds.size === selectedClient.os_list.length) {
      setSelectedOSIds(new Set());
    } else {
      setSelectedOSIds(new Set(selectedClient.os_list.map((os) => os.id)));
    }
  };

  const valorResiduaisSelecionados = clientResiduais
    .filter(r => selectedResidualIds.has(r.id))
    .reduce((sum, r) => sum + (r.valor_residual || 0), 0);

  const selectedTotalCents = (selectedClient?.os_list
    .filter((os) => selectedOSIds.has(os.id))
    .reduce((sum, os) => sum + toCents(os.valor_total), 0) || 0) + toCents(valorResiduaisSelecionados);
  const selectedTotal = fromCents(selectedTotalCents);
  const selectedOsCodeMap = Object.fromEntries(
    (selectedClient?.os_list || []).map((os) => [os.id, os.codigo])
  ) as Record<string, string>;

  const valorNegociadoCents = toCents(valorNegociado);
  const valorParcela = parcelas > 0 ? fromCents(Math.floor(valorNegociadoCents / parcelas)) : 0;
  const valorResidual = fromCents(Math.max(0, selectedTotalCents - valorNegociadoCents));

  // Reset valorNegociado when selectedTotal changes
  useEffect(() => {
    setValorNegociado(selectedTotal);
  }, [selectedTotal]);

  // Initialize parcela values when params change
  useEffect(() => {
    if (parcelas > 0 && valorNegociadoCents > 0) {
      setValoresParcelas(splitEvenlyCents(valorNegociadoCents, parcelas).map(fromCents));
    } else if (parcelas > 0) {
      setValoresParcelas(Array(parcelas).fill(0));
    }
  }, [parcelas, valorNegociadoCents]);

  const handleParcelaValueChange = (index: number, newValue: number) => {
    const updatedCents = valoresParcelas.map(toCents);
    const clamped = Math.min(Math.max(0, toCents(newValue)), valorNegociadoCents);
    updatedCents[index] = clamped;

    const others = updatedCents.map((_, i) => i).filter((i) => i !== index);
    if (others.length > 0) {
      const remaining = Math.max(0, valorNegociadoCents - clamped);
      const redistributed = splitEvenlyCents(remaining, others.length);
      others.forEach((otherIndex, position) => {
        updatedCents[otherIndex] = redistributed[position] ?? 0;
      });
    }

    const diff = valorNegociadoCents - updatedCents.reduce((sum, value) => sum + value, 0);
    if (diff !== 0) {
      const adjustIndex = index === updatedCents.length - 1 ? 0 : updatedCents.length - 1;
      updatedCents[adjustIndex] = Math.max(0, updatedCents[adjustIndex] + diff);
    }

    setValoresParcelas(updatedCents.map(fromCents));
  };

  const watchJob = useCallback(async (jobId: string, userId: string, osMap: Record<string, string>) => {
    if (!mounted.current) return;
    jobWatcher.current?.abort();
    const controller = new AbortController();
    jobWatcher.current = controller;
    const { signal } = controller;
    setPendingJob(jobId); setCanResume(false); setResults(null);
    setJobProgress("Pedido aceito. Aguardando o início do processamento.");
    const toastId = toast.loading("Acompanhando negociação no GestãoClick...", { duration: Infinity });
    try {
      while (!signal.aborted) {
        let job;
        try {
          const response = await supabase.from("fin_negociacao_jobs")
            .select("status, progresso, resultado, ok_count, erro_count, erro_msg").eq("id", jobId).maybeSingle();
          if (response.error) throw response.error;
          job = response.data;
        } catch {
          if (signal.aborted) return;
          const message = "Não foi possível consultar o andamento. Tentando novamente; o pedido permanece salvo.";
          setJobProgress(message);
          toast.loading(message, { id: toastId, duration: Infinity });
          await waitForJobUpdate(signal);
          continue;
        }
        if (signal.aborted) return;
        const progress = job?.progresso || (job?.status === "processando"
          ? "Negociação em processamento no GestãoClick."
          : "Pedido aceito. Aguardando o início do processamento.");
        setJobProgress(progress);
        toast.loading(progress, { id: toastId, duration: Infinity });
        // 'pendente' is the accepted queue state, not a reconciliation failure.
        if (job && ["concluido", "erro", "pendente_conferencia"].includes(job.status)) {
          setCanResume(job.status === "erro");
          const result = (job.resultado || {}) as any;
          setResults((result.results || []).map((entry: NegotiateResult) => ({ ...entry, os_id: osMap[entry.os_id] || entry.os_id })));
          if (job.status === "concluido" && result.success === true && result.integrity_verified === true && Number(job.erro_count || 0) === 0 && !(result.pendencias || []).length) {
            localStorage.removeItem(pendingStorageKey(userId)); setPendingJob(null);
            toast.success("Negociação concluída e composição conferida.");
          } else {
            const message = job.erro_msg || result.error || "Negociação com conferência pendente. Consulte o resultado antes de tentar outra operação.";
            setJobProgress(message);
            toast.error(message, { duration: 15000 });
          }
          return;
        }
        await waitForJobUpdate(signal);
      }
    } finally {
      toast.dismiss(toastId);
      if (jobWatcher.current === controller) jobWatcher.current = null;
    }
  }, []);

  useEffect(() => {
    if (recoveryStarted.current) return;
    recoveryStarted.current = true;
    (async () => {
      const { data } = await supabase.auth.getUser();
      if (!data.user || !mounted.current) return;
      const saved = localStorage.getItem(pendingStorageKey(data.user.id));
      if (!saved) return;
      const pending = JSON.parse(saved);
      if (!pending.idempotency_key || !pending.payload) return;
      setExecuting(true); setPendingJob(pending.job_id || "Confirmação do envio pendente");
      try {
        let jobId = pending.job_id;
        if (!jobId) {
          // Uma resposta perdida repete a mesma chave e o mesmo pedido, nunca cria outro acordo.
          const { data: enqueued, error } = await supabase.functions.invoke("negotiate-os", { body: { ...pending.payload, action: "enqueue", idempotency_key: pending.idempotency_key } });
          if (error) throw error;
          jobId = enqueued?.job_id;
          if (!jobId) throw new Error("Envio ainda sem confirmação; pedido preservado para acompanhamento.");
          localStorage.setItem(pendingStorageKey(data.user.id), JSON.stringify({ ...pending, job_id: jobId }));
        }
        await watchJob(jobId, data.user.id, pending.os_map || {});
      } catch (error) {
        if (await clearRejectedDraft(error, data.user.id)) setPendingJob(null);
        toast.error(await extractFnError(error, "Falha ao retomar acompanhamento"));
      }
      finally { setExecuting(false); }
    })().catch(error => toast.error(error instanceof Error ? error.message : "Falha ao recuperar negociação"));
  }, [watchJob]);

  const handleResume = async () => {
    if (!pendingJob || !canResume || executing) return;
    setExecuting(true);
    try {
      const { data } = await supabase.auth.getUser();
      if (!data.user) throw new Error("Sessão expirada.");
      const stored = localStorage.getItem(pendingStorageKey(data.user.id));
      const pending = stored ? JSON.parse(stored) : null;
      if (pending?.job_id !== pendingJob) throw new Error("Não foi possível confirmar a identidade do pedido salvo.");
      const { error } = await supabase.functions.invoke("negotiate-os", { body: { action: "resume", job_id: pendingJob } });
      if (error) throw error;
      await watchJob(pendingJob, data.user.id, pending.os_map || {});
    } catch (error) { toast.error(await extractFnError(error, "Não foi possível retomar a conferência")); }
    finally { setExecuting(false); }
  };

  const handleExecute = async () => {
    if (executing || (!selectedOSIds.size && !selectedResidualIds.size)) return;
    setExecuting(true); setResults(null);
    let actorId: string | null = null;
    try {
      negotiationDueDates(mesInicio, diaVencimento, parcelas);
      buildNegotiationPlan([{ key: "preview", availableCents: selectedTotalCents }], valorNegociadoCents, valoresParcelas.map(toCents), parcelas);
      const { data, error: authError } = await supabase.auth.getUser();
      if (authError || !data.user) throw new Error("Sua sessão expirou. Entre novamente antes de negociar.");
      actorId = data.user.id;
      const payload = {
        os_ids: Array.from(selectedOSIds).sort(), residual_ids: Array.from(selectedResidualIds).sort(),
        parcelas, dia_vencimento: diaVencimento, mes_inicio: mesInicio,
        valores_parcelas: valoresParcelas, valor_negociado: valorNegociado,
        nome_cliente: selectedClient?.nome_cliente, cliente_gc_id: selectedClient?.cliente_id,
        situacao_ids: [...selectedSituacoes].sort(),
      };
      const storageKey = pendingStorageKey(data.user.id);
      const stored = localStorage.getItem(storageKey);
      let pending = stored ? JSON.parse(stored) : null;
      if (pending && JSON.stringify(pending.payload) !== JSON.stringify(payload)) throw new Error("Há uma negociação anterior aguardando conferência. Consulte o acompanhamento antes de enviar outra.");
      if (!pending) pending = { idempotency_key: crypto.randomUUID(), payload, os_map: selectedOsCodeMap };
      // Persistir antes do envio garante a mesma identidade mesmo após reload/timeout.
      localStorage.setItem(storageKey, JSON.stringify(pending));
      let jobId = pending.job_id;
      if (!jobId) {
        const { data: enqueueData, error } = await supabase.functions.invoke("negotiate-os", { body: { action: "enqueue", ...pending.payload, idempotency_key: pending.idempotency_key } });
        if (error) throw error;
        jobId = enqueueData?.job_id;
        if (!jobId) throw new Error("Servidor não confirmou o pedido. A chave foi preservada para retomar com segurança.");
        localStorage.setItem(storageKey, JSON.stringify({ ...pending, job_id: jobId }));
      }
      await watchJob(jobId, data.user.id, pending.os_map || {});
    } catch (error) {
      if (actorId && await clearRejectedDraft(error, actorId)) setPendingJob(null);
      toast.error(await extractFnError(error, "Falha ao executar negociação"), { duration: 12000 });
    }
    finally { setExecuting(false); }
  };

  const handleCloseResults = () => {
    setResults(null);
    setShowNegotiate(false);
    setSelectedClient(null);
    setSelectedOSIds(new Set());
    fetchOS();
  };

  const formatCurrency = (v: number) =>
    v.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });

  // Generate preview dates
  const previewDates = (() => {
    try { return negotiationDueDates(mesInicio, diaVencimento, parcelas).map(date => date.split("-").reverse().join("/")); }
    catch { return []; }
  })();

  const jobStatusPanel = pendingJob && (
    <div className={`rounded-md border p-3 text-sm ${executing ? "border-primary/40 bg-primary/5" : "border-amber-500/40 bg-amber-500/10"}`}>
      <div role="status" aria-live="polite" aria-atomic="true">
        <p className="flex items-center gap-2 font-medium">
          {executing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {executing ? "Negociação em andamento" : "Negociação em acompanhamento"}
        </p>
        <p>{jobProgress || "Aguardando a confirmação do envio."}</p>
      </div>
      <p className="mt-1 text-muted-foreground">O pedido está salvo. Se sair desta página, o acompanhamento será retomado ao voltar.</p>
      {canResume && <Button variant="outline" disabled={executing} onClick={handleResume}>Retomar conferência</Button>}
      <Button variant="link" onClick={() => navigate("/financeiro/negociacoes")}>Ver negociações e pendências</Button>
    </div>
  );

  return (
    <div className="space-y-6">
      {!showNegotiate && jobStatusPanel}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="icon" onClick={handleBack}>
            <ArrowLeft className="h-5 w-5" />
          </Button>
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <HandshakeIcon className="h-6 w-6" />
              Negociação de OS
            </h1>
            <p className="text-sm text-muted-foreground mt-1">
              OS agrupadas por cliente ({selectedSituacoes.length} situação(ões) configurada(s))
              {clients.length > 0 && (
                <span className="ml-2 font-medium text-foreground">
                  — Total: R$ {clients.reduce((sum, c) => sum + c.valor_total + (c.passivo_total || 0), 0).toLocaleString("pt-BR", { minimumFractionDigits: 2 })}
                </span>
              )}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button
            onClick={async () => {
              setScanningPassivos(true);
              try {
                const { data, error } = await supabase.functions.invoke("scan-passivos");
                if (error) throw error;
                toast.success(`Scan concluído: ${data.inserted} passivo(s) importado(s), ${data.skipped} já existente(s)`);
                // Refresh residuals if client is selected
                if (selectedClient) {
                  const { data: residuals } = await (supabase as any)
                    .from("fin_residuos_negociacao")
                    .select("*")
                    .eq("cliente_gc_id", selectedClient.cliente_id)
                    .eq("utilizado", false)
        .eq("estado", "disponivel")
                    .order("created_at", { ascending: false });
                  const resList = (residuals as ResidualItem[]) || [];
                  setClientResiduais(resList);
                  // Update OS code→id map
                  const allCodes = resList.flatMap(r => r.os_codigos || []);
                  if (allCodes.length > 0) {
                    const { data: osRows } = await supabase
                      .from("os_index")
                      .select("os_id, os_codigo")
                      .in("os_codigo", [...new Set(allCodes)]);
                    const map: Record<string, string> = {};
                    (osRows || []).forEach((row: any) => { map[row.os_codigo] = row.os_id; });
                    setOsCodeToIdMap(map);
                  }
                }
              } catch (err) {
                const msg = await extractFnError(err, "Falha no scan");
                toast.error(`Erro: ${msg}`, { duration: 8000 });
                console.error("[NegociacaoOS][scan-passivos] erro detalhado:", err);
              } finally {
                setScanningPassivos(false);
              }
            }}
            disabled={scanningPassivos}
            variant="outline"
            size="sm"
          >
            {scanningPassivos ? <Loader2 className="h-4 w-4 animate-spin mr-1" /> : <ScanSearch className="h-4 w-4 mr-1" />}
            Scan Passivos
          </Button>
          <Button onClick={handleOpenConfig} variant="outline" size="sm">
            <Settings2 className="h-4 w-4 mr-1" />
            Situações
          </Button>
          <Button onClick={fetchOS} disabled={loading} variant="outline" size="sm">
            {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
            Atualizar
          </Button>
        </div>
      </div>

      {/* Search */}
      <div className="relative max-w-sm">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder="Buscar cliente..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          className="pl-9"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-40">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      ) : !selectedClient ? (
        /* Client list */
        <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
          {filteredClients.map((client) => (
            <Card
              key={client.cliente_id}
              className="cursor-pointer hover:border-primary/50 transition-colors"
              onClick={() => handleSelectClient(client)}
            >
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium truncate">
                  {client.nome_cliente}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center justify-between">
                  {client.os_list.length > 0 ? (
                    <Badge variant="secondary">{client.os_list.length} OS</Badge>
                  ) : (
                    <Badge variant="outline">Só passivo</Badge>
                  )}
                  <span className="text-sm font-semibold text-primary">
                    {formatCurrency(client.valor_total + (client.passivo_total || 0))}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
          {filteredClients.length === 0 && !loading && (
            <p className="text-muted-foreground col-span-full text-center py-10">
              Nenhum cliente com OS pendente de negociação ou passivo disponível.
            </p>
          )}
        </div>
      ) : (
        /* OS list for selected client */
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Button variant="ghost" size="sm" onClick={handleBack}>
                ← Voltar
              </Button>
              <span className="ml-2 font-semibold text-foreground">{selectedClient.nome_cliente}</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="text-sm text-muted-foreground">
                {selectedOSIds.size} selecionada(s) · {formatCurrency(selectedTotal)}
                {selectedClient && (
                  <span className="ml-1 text-muted-foreground/60">
                    / OS: {formatCurrency(selectedClient.valor_total)}
                    {clientResiduais.length > 0 && (
                      <> + Passivos: {formatCurrency(clientResiduais.reduce((s, r) => s + (Number(r.valor_residual) || 0), 0))}
                       = {formatCurrency(selectedClient.valor_total + clientResiduais.reduce((s, r) => s + (Number(r.valor_residual) || 0), 0))}</>
                    )}
                  </span>
                )}
              </span>
              <Button
                onClick={() => setShowNegotiate(true)}
                disabled={selectedOSIds.size === 0 && selectedResidualIds.size === 0}
                size="sm"
              >
                <HandshakeIcon className="h-4 w-4 mr-2" />
                Negociar
              </Button>
            </div>
          </div>

          <Card>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-10">
                    <Checkbox
                      checked={selectedOSIds.size === selectedClient.os_list.length}
                      onCheckedChange={toggleAll}
                    />
                  </TableHead>
                  <TableHead>Código</TableHead>
                  <TableHead>Descrição</TableHead>
                  <TableHead>Data</TableHead>
                  <TableHead className="text-right">Valor</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {selectedClient.os_list.map((os) => (
                  <TableRow key={os.id}>
                    <TableCell>
                      <Checkbox
                        checked={selectedOSIds.has(os.id)}
                        onCheckedChange={() => toggleOS(os.id)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <a
                        href={`https://gestaoclick.com/ordens_servicos/visualizar/${os.id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-primary hover:underline inline-flex items-center gap-1"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {os.codigo}
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </TableCell>
                    <TableCell className="max-w-[200px] truncate text-sm">{os.descricao || "—"}</TableCell>
                    <TableCell className="text-sm">{os.data}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(os.valor_total)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>

          {/* Residual values from previous negotiations — selectable */}
          {clientResiduais.length > 0 && (
            <Card className="border-yellow-500/30">
              <div className="px-4 py-3">
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-3">
                    <p className="text-xs text-yellow-400 font-medium flex items-center gap-1">
                      <AlertCircle className="h-3 w-3" />
                      Residuais disponíveis (Neg. anteriores)
                    </p>
                    <span className="text-xs font-semibold text-yellow-400/80">
                      Total: {formatCurrency(clientResiduais.reduce((sum, r) => sum + (Number(r.valor_residual) || 0), 0))}
                      {selectedResidualIds.size > 0 && (
                        <span className="ml-1 text-muted-foreground">
                          (selecionados: {formatCurrency(valorResiduaisSelecionados)})
                        </span>
                      )}
                    </span>
                  </div>
                  <label className="flex items-center gap-1.5 cursor-pointer text-xs text-muted-foreground hover:text-foreground">
                    <Checkbox
                      checked={clientResiduais.length > 0 && clientResiduais.every(r => selectedResidualIds.has(r.id))}
                      onCheckedChange={(checked) => {
                        setSelectedResidualIds(prev => {
                          const next = new Set(prev);
                          if (checked) {
                            clientResiduais.forEach(r => next.add(r.id));
                          } else {
                            clientResiduais.forEach(r => next.delete(r.id));
                          }
                          return next;
                        });
                      }}
                    />
                    Selecionar todos
                  </label>
                </div>
                {clientResiduais.map((r) => (
                  <div
                    key={r.id}
                    className="flex items-center justify-between py-2 px-2 rounded hover:bg-muted/40 cursor-pointer"
                    onClick={() => toggleResidual(r.id)}
                  >
                    <div className="flex items-center gap-2">
                      <Checkbox
                        checked={selectedResidualIds.has(r.id)}
                        onCheckedChange={() => toggleResidual(r.id)}
                        onClick={(e: React.MouseEvent) => e.stopPropagation()}
                      />
                      <Banknote className="h-4 w-4 text-yellow-500" />
                      <div className="flex flex-col gap-0.5">
                        <span className="text-sm text-muted-foreground">
                          Residual Neg. nº{r.negociacao_origem_numero ?? '—'}
                        </span>
                        <div className="flex items-center gap-2 flex-wrap">
                          {r.gc_codigo && (
                            <a
                              href={`https://gestaoclick.com/movimentacoes_financeiras/visualizar_recebimento/${r.gc_recebimento_id}?retorno=%2Fmovimentacoes_financeiras%2Findex_recebimento`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-xs text-primary hover:underline font-mono inline-flex items-center gap-0.5"
                            >
                              Fin. #{r.gc_codigo}
                              <ExternalLink className="h-2.5 w-2.5" />
                            </a>
                          )}
                          {r.os_codigos && r.os_codigos.length > 0 && (
                            <span className="text-xs text-muted-foreground/70 inline-flex items-center gap-1 flex-wrap">
                              {r.os_codigos.map((code, idx) => {
                                const osGcId = osCodeToIdMap[code];
                                return osGcId ? (
                                <a
                                  key={code}
                                  href={`https://gestaoclick.com/ordens_servicos/visualizar/${osGcId}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                  className="text-primary hover:underline inline-flex items-center gap-0.5"
                                >
                                  OS {code}
                                  <ExternalLink className="h-2.5 w-2.5" />
                                  {idx < (r.os_codigos?.length ?? 0) - 1 ? ',' : ''}
                                </a>
                                ) : (
                                <span key={code} className="text-muted-foreground inline-flex items-center gap-0.5">
                                  OS {code}
                                  {idx < (r.os_codigos?.length ?? 0) - 1 ? ',' : ''}
                                </span>
                                );
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                    </div>
                    <span className={`text-sm font-semibold ${
                      selectedResidualIds.has(r.id) ? 'text-yellow-400' : 'text-muted-foreground'
                    }`}>
                      {formatCurrency(Number(r.valor_residual))}
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Negotiate Dialog */}
      <Dialog open={showNegotiate} onOpenChange={setShowNegotiate}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Configurar Negociação</DialogTitle>
            <DialogDescription>
              {selectedOSIds.size} OS · Total: {formatCurrency(selectedTotal)}
            </DialogDescription>
          </DialogHeader>

          {jobStatusPanel}
          {executing ? (
            <div className="space-y-4">
              {!pendingJob && <p role="status">Enviando pedido de negociação...</p>}
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowNegotiate(false)}>Fechar acompanhamento</Button>
              </DialogFooter>
            </div>
          ) : !results ? (
            <div className="space-y-4">
              {/* Valor Negociado + Residual */}
              <div className="space-y-2">
                <Label>Valor a Negociar</Label>
                <Input
                  type="number"
                  step="0.01"
                  min={0.01}
                  max={selectedTotal}
                  value={valorNegociado}
                  onChange={(e) => {
                    const v = Math.min(Number(e.target.value), selectedTotal);
                    setValorNegociado(Math.round(v * 100) / 100);
                  }}
                />
                {valorResidual > 0.01 && (
                  <div className="flex items-center justify-between rounded-md bg-accent/50 px-3 py-2 text-sm">
                    <span className="text-muted-foreground">Valor residual (próxima negociação):</span>
                    <span className="font-semibold text-accent-foreground">{formatCurrency(valorResidual)}</span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>Nº Parcelas</Label>
                  <Input
                    type="number"
                    min={1}
                    max={60}
                    value={parcelas}
                    onChange={(e) => setParcelas(Number(e.target.value))}
                  />
                </div>
                <div className="space-y-2">
                  <Label>Dia Vencimento</Label>
                  <Input
                    type="number"
                    min={1}
                    max={31}
                    value={diaVencimento}
                    onChange={(e) => setDiaVencimento(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="space-y-2">
                <Label>Mês de Início</Label>
                <Input
                  type="month"
                  value={mesInicio}
                  onChange={(e) => setMesInicio(e.target.value)}
                />
              </div>

              {/* Editable parcelas */}
              <div className="space-y-2">
                <Label>Valores das Parcelas</Label>
                <div className="max-h-48 overflow-y-auto space-y-1.5 pr-1">
                  {valoresParcelas.map((val, i) => (
                    <div key={i} className="flex items-center gap-2">
                      <span className="text-xs text-muted-foreground w-16 shrink-0">
                        {previewDates[i] || `Parcela ${i + 1}`}
                      </span>
                      <Input
                        type="number"
                        step="0.01"
                        min={0}
                        value={val}
                        onChange={(e) => handleParcelaValueChange(i, Number(e.target.value))}
                        className="h-8 text-sm"
                      />
                    </div>
                  ))}
                </div>
                <div className="flex justify-between text-xs text-muted-foreground pt-1 border-t border-border">
                  <span>Total parcelas:</span>
                  <span className={`font-semibold ${Math.abs(valoresParcelas.reduce((a, b) => a + b, 0) - valorNegociado) > 0.02 ? 'text-destructive' : 'text-primary'}`}>
                    {formatCurrency(valoresParcelas.reduce((a, b) => a + b, 0))}
                  </span>
                </div>
                {Math.abs(valoresParcelas.reduce((a, b) => a + b, 0) - valorNegociado) > 0.02 && (
                  <div className="text-destructive text-xs flex items-center gap-1">
                    <AlertCircle className="h-3 w-3" />
                    Soma das parcelas ({formatCurrency(valoresParcelas.reduce((a, b) => a + b, 0))}) diverge do valor negociado ({formatCurrency(valorNegociado)})
                  </div>
                )}
              </div>

              <DialogFooter>
                <Button variant="outline" onClick={() => setShowNegotiate(false)}>Cancelar</Button>
                <Button onClick={handleExecute} disabled={
                  executing || 
                  (selectedOSIds.size === 0 && selectedResidualIds.size === 0) || 
                  valorNegociado <= 0 || 
                  valorNegociado > selectedTotal ||
                  parcelas < 1 ||
                  valoresParcelas.length !== parcelas ||
                  Math.abs(valoresParcelas.reduce((a, b) => a + b, 0) - valorNegociado) > 0.02
                }>
                  {executing ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
                  Executar Negociação
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="max-h-60 overflow-y-auto space-y-1">
                {results.map((r) => (
                  <div key={r.os_id} className="flex items-center gap-2 text-sm">
                    {r.status === "ok" ? (
                      <CheckCircle2 className="h-4 w-4 text-primary shrink-0" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-destructive shrink-0" />
                    )}
                    <span className="font-mono">{r.os_id}</span>
                    {r.error && <span className="text-destructive text-xs">{r.error}</span>}
                  </div>
                ))}
              </div>
              <DialogFooter>
                <Button onClick={handleCloseResults}>Fechar</Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Config Dialog */}
      <Dialog open={showConfig} onOpenChange={setShowConfig}>
        <DialogContent className="max-w-lg max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>Configurar Situações</DialogTitle>
            <DialogDescription>
              Selecione quais situações de OS serão analisadas para negociação.
            </DialogDescription>
          </DialogHeader>

          {loadingSituacoes ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              <span className="ml-2 text-sm text-muted-foreground">Carregando situações do GestãoClick...</span>
            </div>
          ) : (
            <div className="max-h-[50vh] overflow-y-auto space-y-1 pr-1">
              {situacoes.map((sit) => (
                <label
                  key={sit.id}
                  className="flex items-center gap-3 px-3 py-2 rounded-md hover:bg-muted/50 cursor-pointer"
                >
                  <Checkbox
                    checked={selectedSituacoes.includes(sit.id)}
                    onCheckedChange={() => toggleSituacao(sit.id)}
                  />
                  <span className="text-sm flex-1">{sit.nome}</span>
                  <span className="text-xs text-muted-foreground font-mono">{sit.id}</span>
                </label>
              ))}
              {situacoes.length === 0 && (
                <p className="text-sm text-muted-foreground text-center py-4">
                  Nenhuma situação encontrada.
                </p>
              )}
            </div>
          )}

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowConfig(false)}>Cancelar</Button>
            <Button onClick={handleSaveConfig} disabled={savingConfig || selectedSituacoes.length === 0}>
              {savingConfig ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : null}
              Salvar ({selectedSituacoes.length})
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
