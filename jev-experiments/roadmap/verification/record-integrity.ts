/** Public preparation may enrich objects, but must preserve every source value and shape. */
export function assertPreserved(source: any, output: any, path = "root"): void {
  if (Array.isArray(source)) {
    if (!Array.isArray(output) || source.length !== output.length)
      throw Error(`Public array changed at ${path}`);
    source.forEach((value, i) =>
      assertPreserved(value, output[i], `${path}[${i}]`),
    );
  } else if (source !== null && typeof source === "object") {
    if (output === null || typeof output !== "object" || Array.isArray(output))
      throw Error(`Public object changed at ${path}`);
    for (const key of Object.keys(source)) {
      if (!output || !Object.hasOwn(output, key))
        throw Error(`Public field missing at ${path}.${key}`);
      assertPreserved(source[key], output[key], `${path}.${key}`);
    }
  } else if (source !== output) throw Error(`Public value changed at ${path}`);
}
