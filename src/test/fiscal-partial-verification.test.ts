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
  it("envia a origem pelo nome canônico ICMS_orig sem inventar token de sessão", () => {
    expect(gcWorkerSource).not.toContain("GC_WEB_TOKEN");
    expect(gcWorkerSource).not.toContain("GC_FISCAL_SESSION_TOKEN");
    expect(gcWorkerSource).toContain('source: origemVerificada ? "gc_public_icms_get" : "gc_public_get"');
    expect(gcWorkerSource).not.toContain("updateAndVerifyInternalFiscal");
    expect(gcWorkerSource).not.toContain('"x-token-auth"');
    expect(gcWorkerSource).toContain('origin_write_status: "sent_icms_orig_not_confirmed"');
    expect(gcWorkerSource).not.toContain('origin_write_status: "sent_via_public_api_unverified"');
    expect(gcWorkerSource).toContain("ICMS_orig: origem");
    expect(gcWorkerSource).toContain("origem: origemConfirmada ?? normalizeOrigem(cacheRow?.origem)");
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

  it("confirma a origem quando o GET público devolve o ICMS_orig canônico", () => {
    expect(classifyFiscalVerification({
      _argus_verification: {
        source: "gc_public_icms_get",
        ncm: "39201099",
        origem: "2",
      },
    }, "39201099", "2")).toEqual({
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
    expect(isFiscalJobOperationallyComplete("sucesso_parcial")).toBe(true);
    expect(isFiscalJobOperationallyComplete("erro_retentavel")).toBe(false);
    expect(isFiscalJobOperationallyComplete("erro_fatal")).toBe(false);
  });
});
