import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listOpenReceivables from "./tools/list-open-receivables";
import listOpenPayables from "./tools/list-open-payables";
import financeSummary from "./tools/finance-summary";
import { gcReadTools } from "./tools/gc-read";
import { gcWriteTools } from "./tools/gc-write";
import { auvoTools } from "./tools/auvo";

// Build the direct Supabase issuer from the project ref (Vite inlines this at build).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "wedo-operacoes",
  title: "WeDo Operações — GestãoClick e Auvo",
  version: "0.2.0",
  instructions:
    "Ferramentas operacionais da WeDo para GestãoClick, Auvo e financeiro. Resolva IDs com as ferramentas de busca antes de detalhar ou preparar uma ação. Nunca escolha silenciosamente quando houver múltiplos clientes ou equipamentos. Consultas podem executar diretamente. Criações usam obrigatoriamente duas etapas: primeiro preparar, mostrar a prévia ao usuário e aguardar confirmação explícita; somente então chamar a ferramenta confirmar com a ação pendente recebida. Nunca repita automaticamente uma criação que falhou.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [
    ...gcReadTools,
    ...auvoTools,
    ...gcWriteTools,
    financeSummary,
    listOpenReceivables,
    listOpenPayables,
  ],
});
