import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.resolve(process.cwd(), file), "utf8");

const page = read("src/pages/financeiro/PrecificacaoPage.tsx");
const offline = read("supabase/functions/sync-nfe-entrada-offline/index.ts");
const worker = read("supabase/functions/process-gc-write-jobs/index.ts");
const migration = read("supabase/migrations/20260824170000_preservar_origem_fiscal_manual.sql");

describe("persistência da origem fiscal manual", () => {
  it("separa a correção manual do valor original do XML", () => {
    expect(migration).toContain("ADD COLUMN IF NOT EXISTS origem_manual text");
    expect(migration).toContain("origem_manual IS NULL OR btrim(origem_manual) ~ '^[0-8]$'");
    expect(page).toContain("const origemFinal = origemManual || nfOrig");
    expect(page).toContain("origem_manual: origemFinal");
  });

  it("preserva a correção 3 já informada para o produto afetado", () => {
    expect(migration).toContain("'93413152'");
    expect(migration).toContain("'3'");
  });

  it("o importador ZIP grava a origem do item e não apaga overrides", () => {
    expect(offline).toContain('.is("origem_manual", null)');
    expect(offline).toContain("origem: normalizeOrigemXml(xmlItem.icms_orig)");
    expect(offline).toContain("origem: origemUnicaDosItens(xmlItems)");
  });

  it("não anuncia envio público não confirmado como sucesso", () => {
    expect(page).not.toContain("enviada automaticamente ao GC; a API de leitura");
    expect(page).toContain("nenhum sucesso foi presumido");
    expect(migration).toContain("'sucesso_parcial'");
    expect(worker).toContain('? "sucesso_parcial"');
    expect(worker).toContain('origin_write_status: "not_sent_public_api_unsupported"');
    expect(worker).toContain("finalUpdateError");
    expect(worker).toContain("sucessos_parciais: sucessosParciais");
  });
});
