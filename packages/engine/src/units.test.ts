import { describe, expect, it } from "vitest";
import { parseQuantity } from "./units.js";

describe("parseQuantity", () => {
  it.each([
    ["330n", 330e-9, ""],
    ["10u", 10e-6, ""],
    ["10uF", 10e-6, "F"],
    ["4k7", 4700, ""],
    ["4R7", 4.7, ""],
    ["1M", 1e6, ""],
    ["100mA", 0.1, "A"],
    ["1.5A", 1.5, "A"],
    ["50V", 50, "V"],
    ["2k2Ω", 2200, "Ω"],
    ["330", 330, ""],
  ])("%s", (text, value, unit) => {
    const q = parseQuantity(text);
    expect(q?.value).toBeCloseTo(value, 15);
    expect(q?.unit).toBe(unit);
  });

  it("parses a tolerance", () => {
    expect(parseQuantity("12V ±10%")).toEqual({ value: 12, unit: "V", tolerance: 0.1 });
    expect(parseQuantity("5V +-5%")).toEqual({ value: 5, unit: "V", tolerance: 0.05 });
  });

  it.each(["", "X7R", "4.2k7", "k7", "12V 10%", "12V ±10% extra"])("rejects %j", (text) => {
    expect(parseQuantity(text)).toBeUndefined();
  });
});
