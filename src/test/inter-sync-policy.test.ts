import { describe, expect, it } from "vitest";
import {
  cooldownAte,
  decidirRetry,
  deveAguardar,
  janelaIncremental,
} from "../../supabase/functions/_shared/inter-sync-policy";

/**
 * Casos tirados do incidente de 17–18/09/2026: pipeline relendo 89 dias a
 * cada 15 min, 92 corridas em erro em 24 h, Inter devolvendo 429 no OAuth.
 */

describe("janelaIncremental", () => {
  it("sem sucesso anterior usa sete dias, não oitenta e nove", () => {
    const j = janelaIncremental({ hoje: "2026-09-18", ultimoSucessoFim: null });
    expect(j).toMatchObject({ dataInicio: "2026-09-11", dataFim: "2026-09-18" });
  });

  it("recomeça três dias antes do último sucesso", () => {
    // Último pipeline bem-sucedido cobriu até 08/09. Inter lança com atraso,
    // então volta a 05/09; o upsert por id torna a releitura inofensiva.
    const j = janelaIncremental({ hoje: "2026-09-18", ultimoSucessoFim: "2026-09-08" });
    expect(j.dataInicio).toBe("2026-09-05");
    expect(j.dataFim).toBe("2026-09-18");
  });

  it("nunca ultrapassa o teto, mesmo com sucesso muito antigo", () => {
    const j = janelaIncremental({ hoje: "2026-09-18", ultimoSucessoFim: "2026-01-10" });
    expect(j.dataInicio).toBe("2026-06-21"); // 89 dias antes de 18/09
    expect(j.motivo).toContain("teto");
  });

  it("último sucesso hoje vira janela de três dias, não zero nem negativa", () => {
    const j = janelaIncremental({ hoje: "2026-09-18", ultimoSucessoFim: "2026-09-18" });
    expect(j.dataInicio).toBe("2026-09-15");
  });

  it("último sucesso no futuro não gera início depois de hoje", () => {
    const j = janelaIncremental({ hoje: "2026-09-18", ultimoSucessoFim: "2026-09-25" });
    expect(j.dataInicio <= "2026-09-18").toBe(true);
  });
});

describe("deveAguardar", () => {
  const agora = Date.parse("2026-09-18T16:00:00Z");
  const ha = (min: number) => new Date(agora - min * 60_000).toISOString();

  it("corrida em erro recente também segura a próxima", () => {
    // Era o buraco: 92 erros em 24 h porque error não contava.
    const d = deveAguardar({ status: "error", created_at: ha(10) }, agora);
    expect(d.aguardar).toBe(true);
    expect(d.motivo).toContain("falhou");
  });

  it("running e success continuam segurando", () => {
    expect(deveAguardar({ status: "running", created_at: ha(3) }, agora).aguardar).toBe(true);
    expect(deveAguardar({ status: "success", created_at: ha(20) }, agora).aguardar).toBe(true);
  });

  it("depois da janela, libera independentemente do status", () => {
    expect(deveAguardar({ status: "error", created_at: ha(26) }, agora).aguardar).toBe(false);
    expect(deveAguardar({ status: "running", created_at: ha(40) }, agora).aguardar).toBe(false);
  });

  it("sem corrida recente, libera", () => {
    expect(deveAguardar(null, agora).aguardar).toBe(false);
  });
});

describe("cooldownAte", () => {
  const agora = 1_000_000;

  it("respeita Retry-After em segundos", () => {
    expect(cooldownAte("120", agora)).toBe(agora + 120_000);
  });

  it("sem Retry-After, um minuto", () => {
    expect(cooldownAte(null, agora)).toBe(agora + 60_000);
    expect(cooldownAte("abc", agora)).toBe(agora + 60_000);
  });

  it("Retry-After zero não vira loop: mínimo de cinco segundos", () => {
    expect(cooldownAte("0", agora)).toBe(agora + 60_000);
    expect(cooldownAte("1", agora)).toBe(agora + 5_000);
  });
});

describe("decidirRetry", () => {
  it("429 com retry_after não insiste — insistir só alonga o bloqueio", () => {
    const d = decidirRetry(429, 0, 3, 60);
    expect(d.tentar).toBe(false);
  });

  it("429 sem instrução tenta uma única vez", () => {
    expect(decidirRetry(429, 0, 3).tentar).toBe(true);
    expect(decidirRetry(429, 1, 3).tentar).toBe(false);
  });

  it("500 ganha uma repetição só: pode ser a proxy sem token", () => {
    // Antes eram quatro tentativas por endpoint, quatro endpoints, quatro
    // chunks: até 64 pedidos de token numa corrida.
    expect(decidirRetry(500, 0, 3).tentar).toBe(true);
    expect(decidirRetry(500, 1, 3).tentar).toBe(false);
  });

  it("503 mantém as tentativas normais", () => {
    expect(decidirRetry(503, 2, 3).tentar).toBe(true);
    expect(decidirRetry(503, 3, 3).tentar).toBe(false);
  });

  it("status que não é transitório não repete", () => {
    expect(decidirRetry(401, 0, 3).tentar).toBe(false);
    expect(decidirRetry(200, 0, 3).tentar).toBe(false);
  });
});
