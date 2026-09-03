import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { classificarDocumento } from "@/lib/importarXmlFiscal";

/**
 * Roda a classificação contra os documentos reais de julho/2026 da WeDo:
 * 33 NF-e emitidas, 71 NFS-e emitidas e 189 NF-e recebidas de fornecedor.
 *
 * É o teste que sustenta a promessa da tela de importação: descobrir sozinho
 * o que é cada XML, sem consultar o GestãoClick e sem depender de nome de
 * arquivo. Errar aqui significa contar receita como crédito ou o contrário.
 */
const BASE = "C:/Users/Admin/AppData/Local/Temp/claude/C--/6728a22d-4d40-47d8-a89b-bde639b27daa/scratchpad/fiscal";
const CNPJ_WEDO = "43572954000181";

function listar(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const saida: string[] = [];
  for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...listar(p));
    else if (entrada.name.endsWith(".xml")) saida.push(p);
  }
  return saida;
}

const nfeSaida = listar(path.join(BASE, "nfe"));
const nfseSaida = listar(path.join(BASE, "nfse"));
const entradas = listar(path.join(BASE, "compras"));
const temFixtures = nfeSaida.length > 0 && nfseSaida.length > 0 && entradas.length > 0;

describe.skipIf(!temFixtures)("classificarDocumento contra os XMLs reais de julho/2026", () => {
  it("reconhece as 33 NF-e emitidas pela WeDo como SAÍDA", () => {
    expect(nfeSaida).toHaveLength(33);
    for (const f of nfeSaida) {
      const tipo = classificarDocumento(fs.readFileSync(f, "utf8"), CNPJ_WEDO);
      expect(tipo, path.basename(f)).toBe("nfe_saida");
    }
  });

  it("reconhece as 71 NFS-e emitidas pela WeDo como SAÍDA de serviço", () => {
    expect(nfseSaida).toHaveLength(71);
    for (const f of nfseSaida) {
      const tipo = classificarDocumento(fs.readFileSync(f, "utf8"), CNPJ_WEDO);
      expect(tipo, path.basename(f)).toBe("nfse_saida");
    }
  });

  it("classifica todo o lote de fornecedor sem sobra e sem saída", () => {
    const contagem: Record<string, number> = {};
    for (const f of entradas) {
      const tipo = classificarDocumento(fs.readFileSync(f, "utf8"), CNPJ_WEDO);
      contagem[tipo] = (contagem[tipo] ?? 0) + 1;
    }
    const total = Object.values(contagem).reduce((s, n) => s + n, 0);
    expect(total).toBe(entradas.length);
    expect(contagem.nfe_entrada).toBeGreaterThan(180);
    // O que não pode acontecer de jeito nenhum:
    expect(contagem.nfe_saida ?? 0).toBe(0);
    expect(contagem.nfse_saida ?? 0).toBe(0);
    expect(contagem.ignorado ?? 0).toBe(0);
  });

  it("nenhum documento é classificado como saída por engano", () => {
    // O risco real: contar nota de fornecedor como receita própria, o que
    // inflaria o débito e destruiria o crédito ao mesmo tempo.
    const saidasIndevidas = entradas.filter(
      (f) => classificarDocumento(fs.readFileSync(f, "utf8"), CNPJ_WEDO).endsWith("_saida"),
    );
    expect(saidasIndevidas).toHaveLength(0);
  });

  it("com o CNPJ errado, tudo vira entrada — prova que a decisão depende dele", () => {
    const tipo = classificarDocumento(fs.readFileSync(nfeSaida[0], "utf8"), "00000000000000");
    expect(tipo).toBe("nfe_entrada");
  });
});
