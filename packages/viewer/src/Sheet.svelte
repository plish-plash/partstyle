<script lang="ts" module>
import type { SymbolGraphics as Graphics } from "@partstyle/engine";

/** KiCad shows units of a multi-unit part as U3A, U3B, ... */
export function unitSuffix(unit: number, graphics: Graphics | undefined): string {
  const count = Object.keys(graphics?.units ?? {}).length;
  return count > 1 ? String.fromCharCode(64 + unit) : "";
}
</script>

<script lang="ts">
  import type { Comment, Issue, PartInfo, SymbolGraphics, ViewerSheet } from "@partstyle/engine";
  import { direction, textProps } from "./geometry";
  import SymbolView from "./SymbolView.svelte";

  interface Props {
    sheet: ViewerSheet;
    prefix: string;
    symbols: Record<string, SymbolGraphics>;
    parts: Record<string, PartInfo>;
    issues: Issue[];
    comments: Comment[];
    selection: string[];
    onselect: (subjects: string[], additive: boolean) => void;
    onenter: (prefix: string) => void;
    /** Statements changed since the checkpoint (or by a previewed patch), to highlight. */
    changes?: { block: string; kind: string; key: string; op: string }[];
  }
  let { sheet, prefix, symbols, parts, issues, comments, selection, onselect, onenter, changes = [] }: Props =
    $props();

  /** Change class of a part or net of this sheet's block: "added" or "modified". */
  const changeOf = $derived.by(() => {
    const map = new Map<string, string>();
    for (const c of changes) {
      if (c.block !== sheet.block || c.op === "-") continue;
      map.set(`${c.kind}|${c.key}`, c.op === "+" ? "added" : "modified");
    }
    return (kind: "part" | "net", key: string) => map.get(`${kind}|${key}`);
  });

  const layout = $derived(sheet.layout);
  const instance = $derived(sheet.instances.find((i) => i.prefix === prefix) ?? sheet.instances[0]);
  const flatNet = (local: string) => instance?.nets[local] ?? prefix + local;
  const partPath = (ref: string) => prefix + ref;
  const selected = $derived(new Set(selection));

  // Which nets and parts are highlighted: selected directly, or the net of a selected pin.
  const selectedNets = $derived(
    new Set(
      selection.flatMap((s) => {
        const dot = s.lastIndexOf(".");
        const part = dot > 0 ? parts[s.slice(0, dot)] : undefined;
        const pin = part?.pins.find((p) => p.name === s.slice(dot + 1) || p.number === s.slice(dot + 1));
        return pin?.net ? [pin.net] : [s];
      }),
    ),
  );

  /** Issues and open comments on this sheet, anchored at the item they concern. */
  const markers = $derived.by(() => {
    const out: { x: number; y: number; kind: "error" | "warning" | "info" | "comment"; title: string; subjects: string[] }[] = [];
    const anchor = (subject: string): { x: number; y: number } | undefined => {
      const unit = layout.units.find((u) => partPath(u.ref) === subject);
      if (unit) return { x: unit.box.x + unit.box.w, y: unit.box.y };
      const dot = subject.lastIndexOf(".");
      if (dot > 0) {
        const owner = layout.units.find((u) => partPath(u.ref) === subject.slice(0, dot));
        const info = parts[subject.slice(0, dot)];
        const key = subject.slice(dot + 1);
        const number = info?.pins.find((p) => p.name === key || p.number === key)?.number;
        const pin = owner?.pins.find((p) => p.number === number);
        if (pin) return pin.at;
      }
      const wire = layout.wires.find((w) => flatNet(w.net) === subject);
      if (wire) return { x: (wire.a.x + wire.b.x) / 2, y: (wire.a.y + wire.b.y) / 2 };
      const pin = layout.units.flatMap((u) => u.pins).find((p) => p.net !== undefined && flatNet(p.net) === subject);
      return pin?.at;
    };
    for (const issue of issues) {
      for (const s of issue.subjects) {
        const at = anchor(s);
        if (at) {
          out.push({ ...at, kind: issue.severity, title: `${issue.code}: ${issue.message}`, subjects: issue.subjects });
          break;
        }
      }
    }
    for (const c of comments) {
      if (c.status !== "open") continue;
      const at = anchor(c.subject);
      if (at) out.push({ x: at.x - 2.5, y: at.y, kind: "comment", title: `${c.id}: ${c.text}`, subjects: [c.subject] });
    }
    return out;
  });

  // Pan and zoom by editing the viewBox; fit the sheet whenever it changes.
  let view = $state({ x: 0, y: 0, w: 297, h: 210 });
  let svg: SVGSVGElement | undefined = $state();
  $effect(() => {
    view = { x: 0, y: 0, w: Math.max(layout.width, 60), h: Math.max(layout.height, 40) };
  });
  function toView(e: { clientX: number; clientY: number }) {
    const r = svg?.getBoundingClientRect();
    if (!r) return { x: 0, y: 0 };
    const scale = Math.max(view.w / r.width, view.h / r.height);
    const ox = view.x + (view.w - r.width * scale) / 2;
    const oy = view.y + (view.h - r.height * scale) / 2;
    return { x: ox + (e.clientX - r.left) * scale, y: oy + (e.clientY - r.top) * scale, scale };
  }
  function wheel(e: WheelEvent) {
    e.preventDefault();
    const p = toView(e);
    const k = Math.exp(e.deltaY * 0.0015);
    view = { x: p.x - (p.x - view.x) * k, y: p.y - (p.y - view.y) * k, w: view.w * k, h: view.h * k };
  }
  let drag: { x: number; y: number; vx: number; vy: number; moved: boolean } | undefined;
  function down(e: PointerEvent) {
    drag = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y, moved: false };
  }
  function move(e: PointerEvent) {
    if (!drag || !(e.buttons & 1)) return;
    const r = svg?.getBoundingClientRect();
    if (!r) return;
    const scale = Math.max(view.w / r.width, view.h / r.height);
    if (Math.abs(e.clientX - drag.x) + Math.abs(e.clientY - drag.y) > 3) drag.moved = true;
    view = { ...view, x: drag.vx - (e.clientX - drag.x) * scale, y: drag.vy - (e.clientY - drag.y) * scale };
  }
  function up(e: PointerEvent) {
    if (drag && !drag.moved && e.target === svg) onselect([], false);
    drag = undefined;
  }
  /** Click handler factory: select `subject`, shift-click adds to the selection. */
  const pick = (subject: string) => (e: MouseEvent) => {
    e.stopPropagation();
    if (drag?.moved) return;
    onselect([subject], e.shiftKey);
  };

  /** Each group's extent and stage, shown while a part of this sheet is selected. */
  const groupTags = $derived.by(() => {
    const local = selection.flatMap((s) => (s.startsWith(prefix) ? [s.slice(prefix.length).replace(/\/$/, "")] : []));
    const mine = new Set(layout.hints.filter((h) => local.includes(h.ref)).map((h) => h.group));
    if (mine.size === 0) return [];
    const boxes = new Map<string, { x: number; y: number; stage: number }>();
    const grow = (group: string, x: number, y: number, stage: number) => {
      const b = boxes.get(group);
      boxes.set(group, b ? { x: Math.min(b.x, x), y: Math.min(b.y, y), stage } : { x, y, stage });
    };
    for (const u of layout.units) grow(u.group, u.box.x, u.box.y, u.stage);
    for (const s of layout.sheets) grow(s.instance, s.at.x, s.at.y, s.stage);
    return [...boxes].map(([group, b]) => ({ group, ...b, mine: mine.has(group) }));
  });

  /** Label text runs away from its connection point. */
  const labelJustify = (angle: number) => (angle === 180 || angle === 270 ? ["right"] : ["left"]);
</script>

<svg
  bind:this={svg}
  viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`}
  role="application"
  aria-label={`sheet ${sheet.block}`}
  onwheel={wheel}
  onpointerdown={down}
  onpointermove={move}
  onpointerup={up}
>
  <rect x="0" y="0" width={layout.width} height={layout.height} class="paper" />

  {#each layout.wires as w, i (i)}
    <line
      x1={w.a.x}
      y1={w.a.y}
      x2={w.b.x}
      y2={w.b.y}
      class={`wire ${changeOf("net", w.net) ?? ""}`}
      class:hot={selectedNets.has(flatNet(w.net))}
      role="button"
      tabindex="-1"
      aria-label={`net ${flatNet(w.net)}`}
      onclick={pick(flatNet(w.net))}
      onkeydown={() => {}}
    />
  {/each}
  {#each layout.junctions as j, i (i)}
    <circle cx={j.at.x} cy={j.at.y} r="0.5" class="junction" class:hot={selectedNets.has(flatNet(j.net))} />
  {/each}

  {#each layout.units as u (`${u.ref}:${u.unit}`)}
    {@const path = partPath(u.ref)}
    {@const info = parts[path]}
    <g
      class="unit"
      class:hot={selected.has(path)}
      role="button"
      tabindex="-1"
      aria-label={`part ${path}`}
      onclick={pick(path)}
      onkeydown={() => {}}
    >
      {#if changeOf("part", u.ref)}
        <rect
          x={u.box.x - 1.2}
          y={u.box.y - 1.2}
          width={u.box.w + 2.4}
          height={u.box.h + 2.4}
          rx="0.8"
          class={`change ${changeOf("part", u.ref)}`}
        />
      {/if}
      <rect x={u.box.x - 0.6} y={u.box.y - 0.6} width={u.box.w + 1.2} height={u.box.h + 1.2} class="hitbox" />
      <SymbolView graphics={symbols[u.libId]} unit={u.unit} at={u.at} rotation={u.rotation} mirror={u.mirror} />
      {#each [u.refField, u.valueField] as f, k (k)}
        {@const t = textProps(f.at.x, f.at.y, f.justify, f.angle)}
        <text
          x={t.x}
          y={t.y}
          text-anchor={t.anchor}
          dominant-baseline={t.baseline}
          transform={t.transform}
          class={k === 0 ? "ref" : "value"}
          >{k === 0 ? `${info?.ref ?? u.ref}${unitSuffix(u.unit, symbols[u.libId])}` : (info?.value ?? "")}</text
        >
      {/each}
    </g>
    {#each u.pins as p (p.number)}
      <circle
        cx={p.at.x}
        cy={p.at.y}
        r="0.7"
        class="pin-hit"
        class:hot={selected.has(`${path}.${info?.pins.find((q) => q.number === p.number)?.name ?? p.number}`)}
        role="button"
        tabindex="-1"
        aria-label={`pin ${p.number}`}
        onclick={pick(`${path}.${info?.pins.find((q) => q.number === p.number)?.name ?? p.number}`)}
        onkeydown={() => {}}
      />
    {/each}
  {/each}

  {#each layout.power as p, i (i)}
    <g
      class="power-symbol"
      class:hot={selectedNets.has(flatNet(p.net))}
      role="button"
      tabindex="-1"
      aria-label={`net ${p.name}`}
      onclick={pick(flatNet(p.net))}
      onkeydown={() => {}}
    >
      <SymbolView graphics={symbols[p.libId]} unit={1} at={p.at} rotation={p.rotation} power />
      {#if !p.hideValue}
        <text x={p.valueAt.x} y={p.valueAt.y} text-anchor="middle" dominant-baseline="central" class:flag={p.flag} class="power-name"
          >{p.name}</text
        >
      {/if}
    </g>
  {/each}

  {#each layout.labels as l, i (i)}
    {@const [dx, dy] = direction(l.angle)}
    {@const t = textProps(l.at.x + dx * (l.kind === "hier" ? 2.4 : 0.4), l.at.y + dy * (l.kind === "hier" ? 2.4 : 0.4) - (l.kind === "local" && dx !== 0 ? 0.4 : 0), labelJustify(l.angle), dx === 0 ? 90 : 0)}
    <g
      class="label"
      class:hier={l.kind === "hier"}
      class:hot={selectedNets.has(flatNet(l.net))}
      role="button"
      tabindex="-1"
      aria-label={`net ${flatNet(l.net)}`}
      onclick={pick(flatNet(l.net))}
      onkeydown={() => {}}
    >
      {#if l.kind === "hier"}
        <polygon
          points={dx !== 0
            ? `${l.at.x},${l.at.y} ${l.at.x + dx * 1},${l.at.y - 0.8} ${l.at.x + dx * 2},${l.at.y - 0.8} ${l.at.x + dx * 2},${l.at.y + 0.8} ${l.at.x + dx * 1},${l.at.y + 0.8}`
            : `${l.at.x},${l.at.y} ${l.at.x - 0.8},${l.at.y + dy} ${l.at.x - 0.8},${l.at.y + dy * 2} ${l.at.x + 0.8},${l.at.y + dy * 2} ${l.at.x + 0.8},${l.at.y + dy}`}
          class="hier-shape"
        />
      {/if}
      <text x={t.x} y={t.y} text-anchor={t.anchor} dominant-baseline={l.kind === "local" ? "auto" : "central"} transform={t.transform}
        >{l.text}</text
      >
    </g>
  {/each}

  {#each layout.noConnects as p, i (i)}
    <path d={`M ${p.x - 0.6} ${p.y - 0.6} L ${p.x + 0.6} ${p.y + 0.6} M ${p.x + 0.6} ${p.y - 0.6} L ${p.x - 0.6} ${p.y + 0.6}`} class="nc" />
  {/each}

  {#each layout.sheets as s (s.instance)}
    {@const child = `${prefix}${s.instance}/`}
    <g
      class="sheet"
      class:hot={selected.has(child)}
      role="button"
      tabindex="-1"
      aria-label={`sheet ${s.instance}`}
      onclick={pick(child)}
      ondblclick={() => onenter(child)}
      onkeydown={(e) => e.key === "Enter" && onenter(child)}
    >
      <rect x={s.at.x} y={s.at.y} width={s.size.w} height={s.size.h} class="sheet-box" />
      <text x={s.at.x} y={s.at.y - 0.8} class="sheet-name">{s.instance}</text>
      <text x={s.at.x} y={s.at.y + s.size.h + 0.8} dominant-baseline="hanging" class="sheet-file">{s.block} (double-click to open)</text>
      {#each s.pins as p (p.port)}
        <text
          x={p.at.x + (p.outward === 180 ? 1.5 : -1.5)}
          y={p.at.y}
          text-anchor={p.outward === 180 ? "start" : "end"}
          dominant-baseline="central"
          class="sheet-pin">{p.port}</text
        >
      {/each}
    </g>
  {/each}

  {#each groupTags as t (t.group)}
    <text x={t.x} y={t.y - 5} class="stage-tag" class:mine={t.mine}>stage {t.stage}</text>
  {/each}

  {#each markers as m, i (i)}
    <g
      class={`marker ${m.kind}`}
      role="button"
      tabindex="-1"
      aria-label={m.title}
      onclick={(e) => {
        e.stopPropagation();
        onselect(m.subjects, e.shiftKey);
      }}
      onkeydown={() => {}}
    >
      <title>{m.title}</title>
      <circle cx={m.x} cy={m.y} r="1.3" />
      <text x={m.x} y={m.y} text-anchor="middle" dominant-baseline="central">{m.kind === "comment" ? "✎" : "!"}</text>
    </g>
  {/each}
</svg>
