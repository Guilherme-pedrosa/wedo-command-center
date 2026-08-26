import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { parseNfse, ehNfse } from "../../supabase/functions/_shared/nfeXmlParser";

const DIR = "C:/Users/Admin/AppData/Local/Temp/claude/C--/6728a22d-4d40-47d8-a89b-bde639b27daa/scratchpad/fiscal/nfse";
const temFixtures = fs.existsSync(DIR);

describe.skipIf(!temFixtures)("parseNfse contra os 71 XMLs reais de julho/2026", () => {
  const arquivos = temFixtures
    ? fs.readdirSync(DIR).filter((f) => f.endsWith(".xml")).map((f) => path.join(DIR, f))
    : [];

  it("reconhece todos como NFS-e", () => {
    expect(arquivos.length).toBe(71);
    for (const f of arquivos) expect(ehNfse(fs.readFileSync(f, "utf8"))).toBe(true);
  });

  it("extrai numero, data e valores de todas", () => {
    for (const f of arquivos) {
      const r = parseNfse(fs.readFileSync(f, "utf8"));
      expect(r, f).not.toBeNull();
      expect(r!.numero, f).toMatch(/^\d+$/);
      expect(r!.dataEmissao, f).toMatch(/^2026-07-\d{2}$/);
      expect(r!.valorServicos, f).toBeGreaterThan(0);
    }
  });

  it("soma dos serviços bate com o total conhecido de julho", () => {
    const total = arquivos.reduce(
      (s, f) => s + (parseNfse(fs.readFileSync(f, "utf8"))?.valorServicos ?? 0), 0,
    );
    expect(total).toBeCloseTo(215535.61, 2);
  });

  it("ISS de 6.466,06 e nenhuma retenção de PIS/COFINS", () => {
    let iss = 0, pis = 0, cofins = 0, retidas = 0;
    for (const f of arquivos) {
      const r = parseNfse(fs.readFileSync(f, "utf8"))!;
      iss += r.valorIss; pis += r.valorPis; cofins += r.valorCofins;
      if (r.issRetido === 1) retidas++;
    }
    expect(iss).toBeCloseTo(6466.06, 2);
    expect(pis).toBe(0);
    expect(cofins).toBe(0);
    expect(retidas).toBe(0); // IssRetido = 2 em todas
  });

  it("identifica a WD como prestadora", () => {
    const r = parseNfse(fs.readFileSync(arquivos[0], "utf8"))!;
    expect(r.prestadorNome).toMatch(/WD Comercio/i);
    expect(r.tomadorNome.length).toBeGreaterThan(0);
  });
});
