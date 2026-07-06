import { auth, defineMcp } from "@lovable.dev/mcp-js";
import listOpenReceivables from "./tools/list-open-receivables";
import listOpenPayables from "./tools/list-open-payables";
import financeSummary from "./tools/finance-summary";

// Build the direct Supabase issuer from the project ref (Vite inlines this at build).
const projectRef = import.meta.env.VITE_SUPABASE_PROJECT_ID ?? "project-ref-unset";

export default defineMcp({
  name: "argus-finance-mcp",
  title: "ARGUS Finance OS",
  version: "0.1.0",
  instructions:
    "Ferramentas somente-leitura sobre o financeiro do ARGUS. Use finance_summary para totais rápidos, list_open_receivables e list_open_payables para detalhar recebimentos e pagamentos em aberto.",
  auth: auth.oauth.issuer({
    issuer: `https://${projectRef}.supabase.co/auth/v1`,
    acceptedAudiences: "authenticated",
  }),
  tools: [financeSummary, listOpenReceivables, listOpenPayables],
});
