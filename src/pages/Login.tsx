import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle, Loader2, LogIn } from "lucide-react";
import toast from "react-hot-toast";
import { logAudit } from "@/lib/auditLog";

function safeNext(raw: string | null): string {
  if (!raw) return "/";
  // Only allow same-origin relative paths.
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = safeNext(params.get("next"));

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrorMessage(null);

    try {
      const { error } = await supabase.auth.signInWithPassword({ email, password });

      if (error) {
        const message = error.message === "Invalid login credentials"
          ? "Email ou senha incorretos. Verifique os dados e tente novamente."
          : `Falha no login: ${error.message}`;

        setErrorMessage(message);
        logAudit({
          actionType: "auth",
          action: "login_failed",
          context: { email_tentado: email, motivo: error.message },
          severity: "warning",
        });
        toast.error(message);
        return;
      }

      logAudit({ actionType: "auth", action: "login", context: { email } });
      // Preserve OAuth consent redirect if present.
      if (next.startsWith("/.lovable/oauth/")) {
        window.location.href = next;
      } else {
        navigate(next, { replace: true });
      }
    } catch (err) {
      const rawMessage = err instanceof Error ? err.message : String(err);
      const message = rawMessage.toLowerCase().includes("failed to fetch")
        ? "Não foi possível conectar ao servidor de autenticação. Verifique sua internet e tente novamente."
        : `Falha inesperada no login: ${rawMessage}`;

      setErrorMessage(message);
      logAudit({
        actionType: "auth",
        action: "login_failed",
        context: { email_tentado: email, motivo: rawMessage },
        severity: "warning",
      });
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-background p-4">
      <Card className="w-full max-w-sm border-border">
        <CardHeader className="text-center space-y-1">
          <CardTitle className="text-2xl font-bold text-foreground">WeDo Flow</CardTitle>
          <p className="text-sm text-muted-foreground">Entre com suas credenciais</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleLogin} className="space-y-4">
            {errorMessage && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive" role="alert">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>{errorMessage}</span>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="seu@email.com"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="password">Senha</Label>
              <Input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={loading}>
              {loading ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <LogIn className="h-4 w-4 mr-2" />}
              Entrar
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
