import { describe, expect, test } from "bun:test";
import { contrast, PALETTE, SURFACES } from "./palette";

describe("contestant palette", () => {
  test("every swatch keeps 3:1 against both surfaces of its theme", () => {
    const failures: string[] = [];

    for (const [name, swatch] of Object.entries(PALETTE))
      for (const theme of ["light", "dark"] as const)
        for (const surface of SURFACES[theme]) {
          const ratio = contrast(swatch[theme], surface);

          if (ratio < 3)
            failures.push(`${name} ${theme} ${swatch[theme]} on ${surface}: ${ratio.toFixed(2)}`);
        }

    expect(failures).toEqual([]);
  });
});
