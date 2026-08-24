import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  classifyFiscalVerification,
  isFiscalJobOperationallyComplete,
} from "@/pages/financeiro/PrecificacaoPage";

const gcWorkerSource = readFileSync(
  path.resolve(process.cwd(), "supabase/functions/process-gc-write-jobs/index.ts"),
  "utf8",
);

describe("confirmação parcial de NCM e origem no GestãoClick", () => {
  it("restaura o envio público da origem sem depender de token inexistente", () => {
    expect(gcWorkerSource).not.toContain("GC_WEB_TOKEN");
    expect(gcWorkerSource).not.toContain("GC_FISCAL_SESSION_TOKEN");
    expect(gcWorkerSource).toContain('source: "gc_public_get"');
    expect(gcWorkerSource).toContain('...(origemSolicitada ? { origem: origemSolicitada } : {})');
    expect(gcWorkerSource).toContain('origin_write_status: "sent_via_public_api_unverified"');
  });

  it("confirma o NCM pela API pública e mantém a origem como pendente", () => {
    expect(classifyFiscalVerification({
      _argus_verification: {
        source: "gc_public_get",
        ncm: "3920.10.99",
        origem: null,
      },
    }, "39201099", "3")).toEqual({
      ncmConfirmado: true,
      origemSolicitada: true,
      origemConfirmada: false,
      origemPendente: true,
    });
  });

  it("não presume origem nem quando uma resposta pública antiga devolve o mesmo código", () => {
    expect(classifyFiscalVerification({
      _argus_verification: {
        source: "gc_public_get",
        ncm: "39201099",
        origem: "3",
      },
    }, "39201099", "3")).toMatchObject({
      ncmConfirmado: true,
      origemConfirmada: false,
      origemPendente: true,
    });
  });

  it("só confirma a origem com releitura fiscal interna exata", () => {
    expect(classifyFiscalVerification({
      _argus_verification: {
        source: "gc_internal_get",
        ncm: "39201099",
        origem: "3",
      },
    }, "39201099", "3")).toEqual({
      ncmConfirmado: true,
      origemSolicitada: true,
      origemConfirmada: true,
      origemPendente: false,
    });
  });

  it("não aceita HTTP ou payload antigo como prova sem GET de conferência", () => {
    expect(classifyFiscalVerification({
      code: 200,
      status: "success",
      data: { fiscal: { ncm: "39201099", origem: "3" } },
    }, "39201099", "3")).toEqual({
      ncmConfirmado: false,
      origemSolicitada: true,
      origemConfirmada: false,
      origemPendente: false,
    });
  });

  it("não cria pendência de origem quando só o NCM foi solicitado", () => {
    expect(classifyFiscalVerification({
      _argus_verification: {
        source: "gc_public_get",
        ncm: "39201099",
        origem: null,
      },
    }, "39201099")).toEqual({
      ncmConfirmado: true,
      origemSolicitada: false,
      origemConfirmada: false,
      origemPendente: false,
    });
  });

  it("preserva a origem zero como solicitação válida e pendente", () => {
    expect(classifyFiscalVerification({
      _argus_verification: {
        source: "gc_public_get",
        ncm: "39201099",
        origem: null,
      },
    }, "39201099", "0")).toMatchObject({
      ncmConfirmado: true,
      origemSolicitada: true,
      origemConfirmada: false,
      origemPendente: true,
    });
  });

  it("não esconde falha do cache mesmo quando o GET do GC confirmou o NCM", () => {
    expect(isFiscalJobOperationallyComplete("sucesso")).toBe(true);
    expect(isFiscalJobOperationallyComplete("erro_retentavel")).toBe(false);
    expect(isFiscalJobOperationallyComplete("erro_fatal")).toBe(false);
  });
});
