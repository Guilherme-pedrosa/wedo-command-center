import { describe, expect, it } from "vitest";
import { dividirNfeEmLotes, NFE_FILES_PER_LOT } from "@/lib/nfeUpload";

describe("upload de lotes de NF-e", () => {
  it("divide 2.940 notas em lotes de 1.000, 1.000 e 940", () => {
    const notas = Array.from({ length: 2940 }, (_, index) => index);
    const lotes = dividirNfeEmLotes(notas);

    expect(NFE_FILES_PER_LOT).toBe(1000);
    expect(lotes).toHaveLength(3);
    expect(lotes.map((lote) => lote.length)).toEqual([1000, 1000, 940]);
    expect(lotes.flat()).toEqual(notas);
  });

  it("não cria lote para uma seleção vazia", () => {
    expect(dividirNfeEmLotes([])).toEqual([]);
  });
});
