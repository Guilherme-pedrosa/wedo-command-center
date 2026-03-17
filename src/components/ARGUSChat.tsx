import { useState, useRef, useEffect } from "react";
import { useLocation } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Brain, X, Send, Loader2, ChevronDown, Trash2, MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  content: string;
  timestamp: Date;
}

const QUICK_COMMANDS = [
  "Qual o resumo do caixa hoje?",
  "Quais títulos vencem essa semana?",
  "Tem inadimplência crítica?",
  "Como está a conciliação?",
  "Qual o resultado do mês?",
];

interface ARGUSChatProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function ARGUSChat({ open, onOpenChange }: ARGUSChatProps) {
  const location = useLocation();
  const [minimized, setMinimized] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [messages, setMessages] = useState<Message[]>([
    {
      role: "assistant",
      content: "**ARGUS online.** Tenho acesso aos dados em tempo real do ARGUS. O que você precisa analisar?",
      timestamp: new Date(),
    },
  ]);
  const bottomRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = async (text?: string) => {
    const msg = (text ?? input).trim();
    if (!msg || loading) return;

    const userMsg: Message = { role: "user", content: msg, timestamp: new Date() };
    setMessages((prev) => [...prev, userMsg]);
    setInput("");
    setLoading(true);

    try {
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      const { data, error } = await supabase.functions.invoke("argus-chat", {
        body: {
          message: msg,
          page: location.pathname,
          history,
        },
      });

      if (error) throw error;

      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: data?.reply ?? "Sem resposta.",
          timestamp: new Date(),
        },
      ]);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        {
          role: "assistant",
          content: `🔴 Erro: ${err.message ?? "Falha na comunicação com ARGUS."}`,
          timestamp: new Date(),
        },
      ]);
    } finally {
      setLoading(false);
      textareaRef.current?.focus();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const renderContent = (content: string) => {
    return content
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/^## (.*)/gm, '<p class="font-semibold text-sm mt-2">$1</p>')
      .replace(/^### (.*)/gm, '<p class="font-medium text-xs mt-1.5">$1</p>')
      .replace(/^- (.*)/gm, '<p class="pl-2">• $1</p>')
      .replace(/\n/g, "<br/>");
  };

  if (!open) {
    return null; // Button is rendered in AppLayout header
  }

  return (
    <div className="fixed top-12 right-4 z-50 w-[380px] bg-card border border-border rounded-xl shadow-2xl flex flex-col max-h-[calc(100vh-4rem)] overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2.5 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2 min-w-0">
          <Brain className="h-4 w-4 text-primary shrink-0" />
          <span className="font-semibold text-sm text-foreground">ARGUS</span>
          <Badge variant="outline" className="text-[8px] px-1.5 py-0 h-4 shrink-0">
            GPT-5 · LIVE
          </Badge>
          <span className="text-[9px] text-muted-foreground truncate">
            {location.pathname}
          </span>
        </div>
        <div className="flex items-center gap-0.5 shrink-0">
          <Button
            variant="ghost" size="icon" className="h-6 w-6"
            onClick={() => setMessages([{
              role: "assistant",
              content: "Histórico limpo. ARGUS online.",
              timestamp: new Date(),
            }])}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => setMinimized(!minimized)}>
            <ChevronDown className={cn("h-3 w-3 transition-transform", minimized && "rotate-180")} />
          </Button>
          <Button variant="ghost" size="icon" className="h-6 w-6" onClick={() => onOpenChange(false)}>
            <X className="h-3 w-3" />
          </Button>
        </div>
      </div>

      {!minimized && (
        <>
          {/* Messages */}
          <div className="overflow-y-auto" style={{ maxHeight: 360 }}>
            <div className="p-3 space-y-3">
              {messages.map((msg, i) => (
                <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                  <div className={cn(
                    "max-w-[85%] rounded-lg px-3 py-2 text-xs leading-relaxed",
                    msg.role === "user"
                      ? "bg-primary text-primary-foreground"
                      : "bg-muted/50 text-foreground border border-border"
                  )}>
                    {msg.role === "assistant" ? (
                      <div dangerouslySetInnerHTML={{ __html: renderContent(msg.content) }} />
                    ) : (
                      msg.content
                    )}
                    <div className={cn(
                      "text-[9px] mt-1 opacity-60",
                      msg.role === "user" ? "text-right" : "text-left"
                    )}>
                      {msg.timestamp.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
                    </div>
                  </div>
                </div>
              ))}
              {loading && (
                <div className="flex justify-start">
                  <div className="bg-muted/50 border border-border rounded-lg px-3 py-2 text-xs flex items-center gap-2 text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Analisando dados...
                  </div>
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          </div>

          {/* Quick commands */}
          <div className="flex gap-1.5 px-3 py-1.5 overflow-x-auto border-t border-border scrollbar-hide">
            {QUICK_COMMANDS.map((cmd) => (
              <button
                key={cmd}
                onClick={() => sendMessage(cmd)}
                disabled={loading}
                className="shrink-0 text-[9px] px-2 py-1 rounded border border-border bg-muted/50 hover:bg-muted text-muted-foreground hover:text-foreground transition-colors whitespace-nowrap"
              >
                {cmd}
              </button>
            ))}
          </div>

          {/* Input */}
          <div className="p-3 border-t border-border">
            <div className="flex gap-2">
              <Textarea
                ref={textareaRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="Pergunte sobre financeiro, OS, caixa, inadimplência..."
                className="min-h-[40px] max-h-[100px] text-xs resize-none"
                disabled={loading}
              />
              <Button
                size="icon"
                className="shrink-0 h-10 w-10"
                onClick={() => sendMessage()}
                disabled={loading || !input.trim()}
              >
                {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
              </Button>
            </div>
            <p className="text-[9px] text-muted-foreground mt-1 text-center">
              Enter para enviar · Shift+Enter para nova linha
            </p>
          </div>
        </>
      )}
    </div>
  );
}
