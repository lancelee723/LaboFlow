/**
 * LaboFlow module 03 (R5-1): client-side cron syntax validation.
 *
 * Mirrors the authoritative Rust parser (host-core `scheduled/cron.rs`) so the
 * scheduled editor can give instant feedback; the host still rejects invalid
 * expressions at RPC time, so this may never accept what Rust rejects.
 */
export function validateCronExpr(expr: string): { ok: boolean; error?: string } {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    return { ok: false, error: `expected 5 fields, got ${fields.length}` };
  }
  const bounds: Array<[number, number]> = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]];
  for (let index = 0; index < 5; index++) {
    const [min, max] = bounds[index];
    for (const part of fields[index].split(",")) {
      if (part === "") return { ok: false, error: `field ${index + 1}: empty list item` };
      const [range, stepText] = part.includes("/") ? part.split("/", 2) : [part, "1"];
      const step = Number(stepText);
      if (!Number.isInteger(step) || step < 1) {
        return { ok: false, error: `field ${index + 1}: invalid step '${stepText}'` };
      }
      const parseValue = (text: string): number | null => {
        const value = Number(text);
        return Number.isInteger(value) && value >= min && value <= max ? value : null;
      };
      if (range === "*") {
        continue;
      }
      if (range.includes("-")) {
        const [a, b] = range.split("-", 2).map(parseValue);
        if (a === null || b === null || a > b) {
          return { ok: false, error: `field ${index + 1}: invalid or reversed range '${range}'` };
        }
        continue;
      }
      if (parseValue(range) === null) {
        return { ok: false, error: `field ${index + 1}: value out of range ${min}-${max}` };
      }
    }
  }
  return { ok: true };
}
