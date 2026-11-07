<script lang="ts">
  import type { LayoutResult, PlacedPart, Rect } from "@partstyle/layout";
  import { app } from "../lib/state.svelte";

  interface Props {
    result: LayoutResult;
    interactive?: boolean;
  }
  let { result, interactive = false }: Props = $props();

  const PAD = 3;
  const ROLE_COLOR: Record<string, string> = {
    anchor: "var(--role-anchor)",
    series: "var(--role-series)",
    shunt: "var(--role-shunt)",
    chain: "var(--role-chain)",
    decoupling: "var(--role-decoupling)",
    feedback: "var(--role-feedback)",
    bridge: "var(--role-feedback)",
    free: "var(--role-free)",
  };

  const fit = $derived<Rect>({
    x: result.bounds.x - PAD,
    y: result.bounds.y - PAD,
    w: result.bounds.w + PAD * 2,
    h: result.bounds.h + PAD * 2,
  });
  /** Pan and zoom, relative to the fitted view. */
  let zoom = $state(1);
  let panX = $state(0);
  let panY = $state(0);
  const view = $derived.by(() => {
    const w = fit.w / zoom;
    const h = fit.h / zoom;
    return { x: fit.x + (fit.w - w) / 2 + panX, y: fit.y + (fit.h - h) / 2 + panY, w, h };
  });

  let svg = $state<SVGSVGElement>();
  let dragging: { x: number; y: number; moved: boolean } | null = null;

  function onWheel(e: WheelEvent) {
    if (!interactive || !svg) return;
    e.preventDefault();
    const rect = svg.getBoundingClientRect();
    const fx = (e.clientX - rect.left) / rect.width - 0.5;
    const fy = (e.clientY - rect.top) / rect.height - 0.5;
    const next = Math.min(12, Math.max(0.5, zoom * Math.exp(-e.deltaY * 0.0015)));
    panX += fx * view.w * (1 - zoom / next);
    panY += fy * view.h * (1 - zoom / next);
    zoom = next;
  }

  function onDown(e: PointerEvent) {
    if (interactive) dragging = { x: e.clientX, y: e.clientY, moved: false };
  }

  function onMove(e: PointerEvent) {
    if (!dragging || !svg) return;
    const scale = view.w / svg.getBoundingClientRect().width;
    panX -= (e.clientX - dragging.x) * scale;
    panY -= (e.clientY - dragging.y) * scale;
    dragging = { x: e.clientX, y: e.clientY, moved: true };
  }

  function onUp() {
    dragging = null;
  }

  function resetView() {
    zoom = 1;
    panX = 0;
    panY = 0;
  }

  const gridLines = $derived.by(() => {
    if (!app.overlays.grid || !interactive) return [];
    const out: { x1: number; y1: number; x2: number; y2: number }[] = [];
    const x0 = Math.floor(fit.x / 5) * 5;
    const y0 = Math.floor(fit.y / 5) * 5;
    for (let x = x0; x <= fit.x + fit.w; x += 5) {
      out.push({ x1: x, y1: fit.y, x2: x, y2: fit.y + fit.h });
    }
    for (let y = y0; y <= fit.y + fit.h; y += 5) {
      out.push({ x1: fit.x, y1: y, x2: fit.x + fit.w, y2: y });
    }
    return out;
  });

  const columns = $derived.by(() => {
    if (!app.overlays.columns) return [];
    const byCol = new Map<number, Rect>();
    for (const p of result.parts) {
      if (p.column < 0 || p.role !== "anchor") continue;
      const r = byCol.get(p.column);
      if (!r) byCol.set(p.column, { ...p.box });
      else {
        const x1 = Math.max(r.x + r.w, p.box.x + p.box.w);
        r.x = Math.min(r.x, p.box.x);
        r.w = x1 - r.x;
      }
    }
    return [...byCol.entries()].sort((a, b) => a[0] - b[0]);
  });

  const hot = (net: string | undefined) => net !== undefined && net === app.hoverNet;

  /** Draws a two-terminal glyph from pin 1 to pin 2, however its symbol is defined. */
  const transform = (p: PlacedPart) => {
    const [a, b] = p.pins;
    if (!a || !b) return "";
    const angle = (Math.atan2(b.at.y - a.at.y, b.at.x - a.at.x) * 180) / Math.PI;
    return `translate(${a.at.x} ${a.at.y}) rotate(${angle})`;
  };

  /** Length of a two-terminal part between its pins. */
  const span = (p: PlacedPart) => {
    const [a, b] = p.pins;
    if (!a || !b) return 3;
    return Math.abs(a.at.x - b.at.x) + Math.abs(a.at.y - b.at.y);
  };

  const isTwo = (p: PlacedPart) =>
    ["resistor", "capacitor", "inductor", "ferrite", "diode", "led", "crystal"].includes(p.kind);

  function selectPart(e: Event, id: string) {
    if (!interactive) return;
    e.stopPropagation();
    app.selectedPart = app.selectedPart === id ? null : id;
  }

  /** Where a box's body sits inside its pins. */
  function body(p: PlacedPart): Rect {
    const has = (d: number) => p.pins.some((x) => x.outward === d);
    const l = has(180) ? 1 : 0;
    const r = has(0) ? 1 : 0;
    const t = has(90) ? 1 : 0;
    const b = has(270) ? 1 : 0;
    return { x: p.box.x + l, y: p.box.y + t, w: p.box.w - l - r, h: p.box.h - t - b };
  }

  const stub = (d: number) => (d === 0 ? [-1, 0] : d === 180 ? [1, 0] : d === 90 ? [0, 1] : [0, -1]);
</script>

{#snippet twoTerminal(p: PlacedPart)}
  {@const s = span(p)}
  {@const m = s / 2}
  <g class="ink" transform={transform(p)}>
    {#if p.kind === "resistor"}
      <path d="M0 0H{m - 1.1}M{m + 1.1} 0H{s}" />
      <rect x={m - 1.1} y={-0.42} width={2.2} height={0.84} />
    {:else if p.kind === "ferrite"}
      <path d="M0 0H{m - 1.1}M{m + 1.1} 0H{s}" />
      <rect class="filled" x={m - 1.1} y={-0.42} width={2.2} height={0.84} />
    {:else if p.kind === "capacitor"}
      <path d="M0 0H{m - 0.22}M{m + 0.22} 0H{s}M{m - 0.22} -0.8V0.8M{m + 0.22} -0.8V0.8" />
    {:else if p.kind === "inductor"}
      {@const r = 0.42}
      <path
        d="M0 0H{m - r * 4}a{r} {r} 0 0 1 {r * 2} 0a{r} {r} 0 0 1 {r * 2} 0a{r} {r} 0 0 1 {r * 2} 0a{r} {r} 0 0 1 {r * 2} 0H{s}"
      />
    {:else if p.kind === "crystal"}
      <path d="M0 0H{m - 0.7}M{m + 0.7} 0H{s}M{m - 0.7} -0.7V0.7M{m + 0.7} -0.7V0.7" />
      <rect x={m - 0.42} y={-0.7} width={0.84} height={1.4} />
    {:else}
      <path d="M0 0H{m - 0.55}M{m + 0.55} 0H{s}M{m + 0.55} -0.65V0.65" />
      <path class={p.kind === "led" ? "" : "filled"} d="M{m - 0.55} -0.65L{m + 0.55} 0L{m - 0.55} 0.65Z" />
      {#if p.kind === "led"}
        <path class="thin" d="M{m - 0.1} -0.75l0.55 -0.55m-0.3 0h0.3v0.3M{m + 0.45} -0.6l0.55 -0.55m-0.3 0h0.3v0.3" />
      {/if}
    {/if}
  </g>
{/snippet}

{#snippet boxPart(p: PlacedPart)}
  {@const b = body(p)}
  <g class="ink">
    {#each p.pins as pin (pin.id)}
      {@const [dx, dy] = stub(pin.outward)}
      <line x1={pin.at.x} y1={pin.at.y} x2={pin.at.x + (dx ?? 0)} y2={pin.at.y + (dy ?? 0)} />
    {/each}
    {#if p.kind === "opamp"}
      {@const out = p.pins.find((x) => x.outward === 0)}
      <path
        class="body"
        d="M{b.x} {b.y}L{b.x + b.w} {out?.at.y ?? b.y + b.h / 2}L{b.x} {b.y + b.h}Z"
      />
    {:else if p.kind === "transistor"}
      {@const gate = p.pins.find((x) => x.id === "G")}
      {@const drain = p.pins.find((x) => x.id === "D")}
      {@const source = p.pins.find((x) => x.id === "S")}
      {#if gate && drain && source}
        {@const x = gate.at.x + 1.6}
        <path
          d="M{gate.at.x + 1} {gate.at.y}H{x - 0.3}M{x - 0.3} {gate.at.y - 1}V{gate.at.y + 1}M{x} {gate.at.y - 1.2}V{gate.at.y + 1.2}M{x} {gate.at.y - 1}H{drain.at.x}V{drain.at.y + 1}M{x} {gate.at.y + 1}H{source.at.x}V{source.at.y - 1}M{x} {gate.at.y}H{source.at.x}V{gate.at.y + 1}"
        />
      {/if}
    {:else}
      <rect class="body" x={b.x} y={b.y} width={b.w} height={b.h} />
    {/if}
  </g>
  {#each p.pins as pin (pin.id)}
    {#if p.kind !== "transistor" && !/^\d+$/.test(pin.name)}
      {#if pin.outward === 0}
        <text class="pin-name" x={pin.at.x - 1.25} y={pin.at.y + 0.22} text-anchor="end">{pin.name}</text>
      {:else if pin.outward === 180}
        <text class="pin-name" x={pin.at.x + 1.25} y={pin.at.y + 0.22}>{pin.name}</text>
      {:else if pin.outward === 90}
        <text class="pin-name" x={pin.at.x} y={pin.at.y + 1.75} text-anchor="middle">{pin.name}</text>
      {:else}
        <text class="pin-name" x={pin.at.x} y={pin.at.y - 1.3} text-anchor="middle">{pin.name}</text>
      {/if}
    {/if}
  {/each}
{/snippet}

<!-- svelte-ignore a11y_no_static_element_interactions -->
<svg
  bind:this={svg}
  class="schematic"
  class:interactive
  viewBox="{view.x} {view.y} {view.w} {view.h}"
  preserveAspectRatio="xMidYMid meet"
  onwheel={onWheel}
  onpointerdown={onDown}
  onpointermove={onMove}
  onpointerup={onUp}
  onpointerleave={onUp}
  ondblclick={resetView}
>
  {#each gridLines as l, i (i)}
    <line class="grid" {...l} />
  {/each}

  {#each columns as [col, r] (col)}
    <rect class="column" x={r.x} y={fit.y} width={r.w} height={fit.h} />
    <text class="column-label" x={r.x + 0.3} y={fit.y + 1.2}>column {col}</text>
  {/each}

  {#each result.wires as w, i (i)}
    <line
      class="wire"
      class:hot={hot(w.net)}
      x1={w.a.x}
      y1={w.a.y}
      x2={w.b.x}
      y2={w.b.y}
    />
  {/each}

  {#each result.parts as p (p.id)}
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <g
      class="part"
      class:selected={app.selectedPart === p.id && interactive}
      style={app.overlays.roles ? `--part-ink: ${ROLE_COLOR[p.role] ?? "var(--ink)"}` : ""}
      onclick={(e) => selectPart(e, p.id)}
      role="button"
      tabindex="-1"
    >
      <rect class="hit" x={p.box.x} y={p.box.y} width={p.box.w} height={p.box.h} />
      {#if isTwo(p)}
        {@render twoTerminal(p)}
      {:else}
        {@render boxPart(p)}
      {/if}
      {#if app.overlays.text}
        {#each p.text as t, i (i)}
          <text
            class={i === 0 ? "ref" : "value"}
            x={t.at.x}
            y={t.at.y}
            text-anchor={t.anchor}>{t.text}</text
          >
        {/each}
      {/if}
    </g>
  {/each}

  {#each result.power as s, i (i)}
    <g class="power" class:hot={hot(s.net)}>
      {#if s.role === "ground"}
        <path d="M{s.at.x} {s.at.y}v1m-0.8 0h1.6m-1.2 0.35h0.8m-0.45 0.35h0.1" />
        {#if s.showName}
          <text class="rail" x={s.at.x} y={s.at.y + 3.2} text-anchor="middle">{s.name}</text>
        {/if}
      {:else if s.outward === 270}
        <path d="M{s.at.x} {s.at.y}v1.2m-0.7 0h1.4" />
        <text class="rail" x={s.at.x} y={s.at.y + 2.1} text-anchor="middle">{s.name}</text>
      {:else}
        <path d="M{s.at.x} {s.at.y}v-1.2m-0.7 0h1.4" />
        <text class="rail" x={s.at.x} y={s.at.y - 1.6} text-anchor="middle">{s.name}</text>
      {/if}
    </g>
  {/each}

  {#each result.labels as l, i (i)}
    {@const vertical = l.outward === 90 || l.outward === 270}
    <g class="label" class:hot={hot(l.net)} class:port={l.kind === "port"}>
      {#if l.kind === "port"}
        <rect class="port-box" x={l.box.x} y={l.box.y} width={l.box.w} height={l.box.h} rx={0.2} />
        <text x={l.box.x + l.box.w / 2} y={l.at.y + 0.26} text-anchor="middle">{l.text}</text>
      {:else if vertical}
        <text
          transform="translate({l.at.x + 0.25} {l.outward === 90 ? l.at.y - 0.3 : l.at.y + 0.3}) rotate(-90)"
          text-anchor={l.outward === 90 ? "start" : "end"}>{l.text}</text
        >
      {:else}
        <text
          x={l.outward === 0 ? l.at.x + 0.3 : l.at.x - 0.3}
          y={l.at.y + 0.26}
          text-anchor={l.outward === 0 ? "start" : "end"}>{l.text}</text
        >
      {/if}
    </g>
  {/each}

  {#each result.markers ?? [] as m, i (i)}
    {@const dx = m.outward === 0 ? 1 : m.outward === 180 ? -1 : 0}
    {@const dy = m.outward === 90 ? -1 : m.outward === 270 ? 1 : 0}
    <path
      class="marker"
      d="M{m.at.x} {m.at.y}l{dx * 1.2} {dy * 1.2}l{dx * 0.5 - dy * 0.5} {dy * 0.5 - dx * 0.5}l{dx * 0.8 + dy} {dy * 0.8 + dx}l{-dx * 0.5 - dy * 0.5} {-dy * 0.5 - dx * 0.5}"
    />
  {/each}

  {#each result.noConnects as p, i (i)}
    <path class="nc" d="M{p.x - 0.3} {p.y - 0.3}l0.6 0.6m0 -0.6l-0.6 0.6" />
  {/each}

  {#each result.junctions as j, i (i)}
    <circle class="junction" class:hot={hot(j.net)} cx={j.at.x} cy={j.at.y} r={0.2} />
  {/each}

  {#if interactive}
    {#each result.wires as w, i (i)}
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <line
        class="wire-hit"
        x1={w.a.x}
        y1={w.a.y}
        x2={w.b.x}
        y2={w.b.y}
        onpointerenter={() => (app.hoverNet = w.net)}
        onpointerleave={() => (app.hoverNet = null)}
      />
    {/each}
  {/if}
</svg>
