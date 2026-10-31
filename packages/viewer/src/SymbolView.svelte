<script lang="ts">
import type { Prim, SymbolGraphics } from "@partstyle/engine";
import { arcPath, direction, textProps, toSheet } from "./geometry";

interface Props {
  graphics: SymbolGraphics | undefined;
  unit: number;
  at: { x: number; y: number };
  rotation?: number;
  /** Mirrored left to right before rotation, as KiCad's `(mirror y)`. */
  mirror?: boolean;
  /** Power symbols are drawn in the power colour, without pin numbers. */
  power?: boolean;
}
let { graphics, unit, at, rotation = 0, mirror = false, power = false }: Props = $props();

const prims: Prim[] = $derived(graphics?.units[unit] ?? []);
const transform = $derived(
  `translate(${at.x} ${at.y}) rotate(${-rotation}) scale(${mirror ? -1 : 1} -1)`,
);
/** A symbol point on the sheet, mirrored first when the symbol is. */
const place = (x: number, y: number) => toSheet(at, rotation, mirror ? -x : x, y);
const fillOf = (f: string) =>
  f === "outline" ? "var(--symbol)" : f === "background" ? "var(--body)" : "none";

/** Pin texts drawn unflipped on the sheet: number above the pin line, name inside the body. */
function pinTexts(p: Extract<Prim, { kind: "pin" }>) {
  const angle = mirror ? 180 - p.angle : p.angle;
  const t = (((angle + rotation) % 360) + 360) % 360;
  const [dx, dy] = direction(t);
  const [sx, sy] = place(p.x, p.y);
  const vertical = dx === 0;
  const out: {
    text: string;
    x: number;
    y: number;
    anchor: "start" | "middle" | "end";
    baseline: string;
    transform: string;
    cls: string;
  }[] = [];
  if (!graphics?.pinNumbersHidden && !power && p.number) {
    const mx = sx + (dx * p.length) / 2;
    const my = sy + (dy * p.length) / 2;
    const props = vertical
      ? textProps(mx - 0.4, my, [], 90)
      : textProps(mx, my - 0.4, ["bottom"], 0);
    out.push({ text: p.number, ...props, cls: "pin-number" });
  }
  if (!graphics?.pinNames.hidden && !power && p.name && p.name !== "~") {
    const off = (graphics?.pinNames.offset ?? 0.508) + 0.3;
    const ex = sx + dx * (p.length + off);
    const ey = sy + dy * (p.length + off);
    // Text runs away from the pin, into the body.
    const justify = vertical ? (dy < 0 ? ["left"] : ["right"]) : dx > 0 ? ["left"] : ["right"];
    out.push({
      text: p.name.replace(/~\{([^}]*)\}/g, "$1"),
      ...textProps(ex, ey, justify, vertical ? 90 : 0),
      cls: "pin-name",
    });
  }
  return out;
}
</script>

<g class:power>
  <g {transform}>
    {#each prims as p, i (i)}
      {#if p.kind === "rect"}
        <rect
          x={Math.min(p.x1, p.x2)}
          y={Math.min(p.y1, p.y2)}
          width={Math.abs(p.x2 - p.x1)}
          height={Math.abs(p.y2 - p.y1)}
          fill={fillOf(p.fill)}
          class="outline"
        />
      {:else if p.kind === "poly"}
        <polyline points={p.pts.map(([x, y]) => `${x},${y}`).join(" ")} fill={fillOf(p.fill)} class="outline" />
      {:else if p.kind === "circle"}
        <circle cx={p.cx} cy={p.cy} r={p.r} fill={fillOf(p.fill)} class="outline" />
      {:else if p.kind === "arc"}
        <path d={arcPath(p.start, p.mid, p.end)} fill={fillOf(p.fill)} class="outline" />
      {:else if p.kind === "pin" && !p.hidden}
        <line
          x1={p.x}
          y1={p.y}
          x2={p.x + p.length * Math.cos((p.angle * Math.PI) / 180)}
          y2={p.y + p.length * Math.sin((p.angle * Math.PI) / 180)}
          class="pin"
        />
      {/if}
    {/each}
  </g>
  {#each prims as p, i (i)}
    {#if p.kind === "pin" && !p.hidden}
      {#each pinTexts(p) as t, j (j)}
        <text
          x={t.x}
          y={t.y}
          text-anchor={t.anchor}
          dominant-baseline={t.baseline}
          transform={t.transform}
          class={t.cls}>{t.text}</text
        >
      {/each}
    {:else if p.kind === "text"}
      {@const [x, y] = place(p.x, p.y)}
      <text {x} {y} text-anchor="middle" dominant-baseline="central" class="sym-text">{p.text}</text>
    {/if}
  {/each}
</g>
