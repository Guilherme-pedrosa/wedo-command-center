import { describe, expect, it } from "vitest";
import { formatDate, formatDateTime } from "../lib/format";

describe("vencimentos são datas civis, sem conversão de fuso", () => {
  it("mostra o vencimento real do recebimento 36392 sem recuar um dia", () => {
    expect(formatDate("2026-09-23")).toBe("23/09/2026");
  });
  it.each([ ["2026-01-01", "01/01/2026"], ["2028-02-29", "29/02/2028"],
    ["2026-12-31", "31/12/2026"] ])("preserva %s", (input, expected) => {
    expect(formatDate(input)).toBe(expected);
  });
  it("mantém conversão local para instantes que possuem horário", () => {
    const instant = new Date("2026-09-09T17:29:25Z");
    expect(formatDate(instant.toISOString())).toBe(formatDate(instant));
    expect(formatDateTime(instant.toISOString())).toBe(formatDateTime(instant));
  });
});
