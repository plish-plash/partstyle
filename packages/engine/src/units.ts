export interface Quantity {
  value: number;
  /** Unit symbol with any SI prefix removed, e.g. `V`, `A`, `F`; empty when unitless. */
  unit: string;
  /** Symmetric tolerance as a fraction (`±10%` → 0.1). */
  tolerance?: number;
}

const prefixes: Record<string, number> = {
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  m: 1e-3,
  R: 1,
  k: 1e3,
  K: 1e3,
  M: 1e6,
  G: 1e9,
};

// 330n, 4k7, 1.5A, 100mA, 50V, 2k2Ω, 4R7
const quantityPattern = /^([+-]?\d+(?:\.\d+)?)([pnuµmRkKMG])?(\d+)?([A-Za-zΩ]*)$/;
const tolerancePattern = /^(?:±|\+\/?-)(\d+(?:\.\d+)?)%$/;

/** Parses an engineering quantity such as `330n`, `4k7`, `12V ±10%`; returns undefined if malformed. */
export function parseQuantity(text: string): Quantity | undefined {
  const [main, tol, ...rest] = text.trim().split(/\s+/);
  if (main === undefined || main === "" || rest.length > 0) return undefined;

  const m = quantityPattern.exec(main);
  if (!m) return undefined;
  const [, digits = "", prefix, fraction, unit = ""] = m;
  // "4k7" style: the prefix acts as the decimal point, so the integer part must be whole.
  if (fraction !== undefined && (prefix === undefined || digits.includes("."))) return undefined;
  const base = Number(fraction === undefined ? digits : `${digits}.${fraction}`);
  const value = prefix === undefined ? base : base * (prefixes[prefix] ?? 1);

  const quantity: Quantity = { value, unit };
  if (tol !== undefined) {
    const t = tolerancePattern.exec(tol);
    if (!t) return undefined;
    quantity.tolerance = Number(t[1]) / 100;
  }
  return quantity;
}
