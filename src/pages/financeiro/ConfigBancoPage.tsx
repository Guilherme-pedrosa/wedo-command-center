import { useState, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { testInterConnection } from "@/api/financeiro";
import { Landmark, Save, TestTube, CheckCircle, XCircle, Loader2 } from "lucide-react";
import toast from "react-hot-toast";

export default function ConfigBancoPage() {
  const queryClient = useQueryClient();
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  const { data: config } = useQuery({
    queryKey: ["fin-configuracoes"],
    queryFn: async () => {
      const { data } = await supabase.from("fin_configuracoes").select("*");
      const map: Record<string, string> = {};
      data?.forEach((c: any) => { if (c.valor !== null) map[c.chave] = c.valor; });
      return map;
    },
  });

  const [pixKey, setPixKey] = useState("");
  const [conta, setConta] = useState("");
  const [titular, setTitular] = useState("");
  const [pollingAtivo, setPollingAtivo] = useState(true);
  const [pollingInterval, setPollingInterval] = useState("30");

  useEffect(() => {
    if (config) {
      setPixKey(config.inter_chave_pix || "");
      setConta(config.inter_numero_conta || "");
      setTitular(config.inter_titular_conta || "");
      setPollingAtivo(config.inter_polling_ativo !== "false");
      setPollingInterval(config.inter_polling_interval || "30");
    }
  }, [config]);

  const save = async (chave: string, valor: string) => {
    await supabase.from("fin_configuracoes").upsert({ chave, valor, updated_at: new Date().toISOString() }, { onConflict: "chave" });
  };

  const handleSave = async () => {
    await Promise.all([
      save("inter_chave_pix", pixKey),
      save("inter_numero_conta", conta),
      save("inter_titular_conta", titular),
      save("inter_polling_ativo", String(pollingAtivo)),
      save("inter_polling_interval", pollingInterval),
    ]);
    queryClient.invalidateQueries({ queryKey: ["fin-configuracoes"] });
    toast.success("Configurações salvas");
  };

  const handleTest = async () => {
    setTesting(true); setTestResult(null);
    try {
      const r = await testInterConnection();
      setTestResult(r);
      r.ok ? toast.success(r.message) : toast.error(r.message);
    } catch (err) { setTestResult({ ok: false, message: err instanceof Error ? err.message : "Erro" }); }
    finally { setTesting(false); }
  };

  return (
    <div className="space-y-6 max-w-2xl">
      <div className="flex items-center justify-between">
        <div><h1 className="text-2xl font-bold text-foreground">Configuração Banco Inter</h1><p className="text-sm text-muted-foreground">Parâmetros da integração bancária</p></div>
        <Button size="sm" onClick={handleSave}><Save className="h-3.5 w-3.5 mr-1.5" />Salvar</Button>
      </div>

      <div className="rounded-lg border border-border bg-card p-6 space-y-6">
        <div className="rounded-md bg-muted/50 p-3 text-xs text-muted-foreground">
          Os certificados mTLS (INTER_CLIENT_ID, INTER_CLIENT_SECRET, INTER_CERT, INTER_KEY) estão configurados como <strong>Cloud Secrets</strong>.
        </div>

        <div className="space-y-4">
          <div className="space-y-2"><Label>Chave PIX (cobranças)</Label><Input value={pixKey} onChange={e => setPixKey(e.target.value)} placeholder="Chave PIX para gerar cobranças" /></div>
          <div className="space-y-2"><Label>Número da conta</Label><Input value={conta} onChange={e => setConta(e.target.value)} /></div>
          <div className="space-y-2"><Label>Titular</Label><Input value={titular} onChange={e => setTitular(e.target.value)} /></div>
        </div>

        <div className="border-t border-border pt-4 space-y-4">
          <div className="flex items-center gap-3"><Switch checked={pollingAtivo} onCheckedChange={setPollingAtivo} /><Label>Polling de extrato ativo</Label></div>
          <div className="space-y-2"><Label>Intervalo (minutos)</Label><Input type="number" value={pollingInterval} onChange={e => setPollingInterval(e.target.value)} className="w-[100px]" /></div>
        </div>

        <div className="border-t border-border pt-4 space-y-3">
          {testResult && (
            <div className={`flex items-center gap-2 rounded-md p-3 text-sm ${testResult.ok ? "bg-wedo-green/10 text-wedo-green" : "bg-wedo-red/10 text-wedo-red"}`}>
              {testResult.ok ? <CheckCircle className="h-4 w-4" /> : <XCircle className="h-4 w-4" />}{testResult.message}
            </div>
          )}
          <Button variant="outline" size="sm" onClick={handleTest} disabled={testing}>
            {testing ? <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> : <TestTube className="h-3.5 w-3.5 mr-1.5" />}Testar Conexão Inter
          </Button>
        </div>
      </div>
    </div>
  );
}
