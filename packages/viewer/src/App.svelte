<script lang="ts">
import type { ViewerModel } from "@partstyle/engine";
import { onMount } from "svelte";
import * as api from "./api";
import Inspector from "./Inspector.svelte";
import IssueList from "./IssueList.svelte";
import Sheet from "./Sheet.svelte";

let model = $state<ViewerModel | undefined>();
let error = $state<string | undefined>();
let prefix = $state("");
let selection = $state<string[]>([]);
let live = $state(false);
let restored = false;

/** Every sheet instance in page order: the top block first, then depth-first. */
const pages = $derived(
  (model?.sheets ?? [])
    .flatMap((s) => s.instances.map((i) => ({ block: s.block, prefix: i.prefix, page: i.page })))
    .sort((a, b) => a.page - b.page),
);
const current = $derived(model?.sheets.find((s) => s.instances.some((i) => i.prefix === prefix)));

async function refresh() {
  try {
    model = await api.fetchModel();
    error = undefined;
    if (!restored) {
      restored = true;
      selection = model.focus.selection;
      if (model.focus.sheet !== undefined && pages.some((p) => p.prefix === model?.focus.sheet)) {
        prefix = model.focus.sheet;
      }
    }
    if (!pages.some((p) => p.prefix === prefix)) prefix = pages[0]?.prefix ?? "";
  } catch (e) {
    error = String(e);
  }
}

onMount(() => {
  void refresh();
  // ?live=0 shows a snapshot without the update stream (screenshots, embedding).
  if (new URLSearchParams(location.search).get("live") === "0") return;
  const unsubscribe = api.subscribe(() => {
    live = true;
    void refresh();
  });
  live = true;
  return unsubscribe;
});

function publish() {
  void api.sendFocus({ selection, sheet: prefix }).catch(() => {});
}
function select(subjects: string[], additive: boolean) {
  if (additive) {
    const set = new Set(selection);
    for (const s of subjects) {
      if (set.has(s)) set.delete(s);
      else set.add(s);
    }
    selection = [...set];
  } else {
    selection = subjects;
  }
  publish();
}
function open(p: string) {
  prefix = p;
  publish();
}
/** Selects subjects and opens the sheet that draws the first of them. */
function show(subjects: string[]) {
  const first = subjects[0];
  if (first !== undefined && model) {
    const owner = model.parts[first]
      ? first
      : Object.keys(model.parts).find((p) => first.startsWith(`${p}.`));
    const path = owner ?? first;
    const target = path.slice(0, path.lastIndexOf("/") + 1);
    if (pages.some((p) => p.prefix === target)) prefix = target;
  }
  select(subjects, false);
}
const pageLabel = (p: { block: string; prefix: string }) =>
  p.prefix === "" ? p.block : `${p.prefix.slice(0, -1)} (${p.block})`;
</script>

<header>
  <h1>{model?.project ?? "partstyle"}</h1>
  {#if model}
    <span class="chip" class:bad={model.summary.errors > 0}>{model.summary.errors} errors</span>
    <span class="chip" class:meh={model.summary.warnings > 0}>{model.summary.warnings} warnings</span>
    {#if model.summary.waived > 0}<span class="chip muted">{model.summary.waived} waived</span>{/if}
  {/if}
  <nav>
    {#each pages as p (p.prefix)}
      <button class:active={p.prefix === prefix} onclick={() => open(p.prefix)}>{pageLabel(p)}</button>
    {/each}
  </nav>
  <span class="live" title={live ? "Updates as the files change" : "Connecting…"}>{live ? "● live" : "○"}</span>
</header>

<main>
  <div class="canvas">
    {#if error}
      <p class="error">Could not load the design: {error}</p>
    {:else if !model}
      <p class="muted">Loading…</p>
    {:else if current}
      <Sheet
        sheet={current}
        {prefix}
        symbols={model.symbols}
        parts={model.parts}
        issues={model.issues}
        comments={model.comments}
        {selection}
        onselect={select}
        onenter={open}
      />
    {:else}
      <p class="error">Nothing to draw: fix the errors listed on the right.</p>
    {/if}
  </div>
  <aside>
    {#if model}
      <Inspector {model} {selection} onselect={select} />
      <IssueList issues={model.issues} comments={model.comments} onshow={show} />
    {/if}
  </aside>
</main>
