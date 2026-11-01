<script lang="ts">
import type { ViewerModel } from "@partstyle/engine";
import { onMount } from "svelte";
import * as api from "./api";
import Changes from "./Changes.svelte";
import Inspector from "./Inspector.svelte";
import IssueList from "./IssueList.svelte";
import Sheet from "./Sheet.svelte";

const params = new URLSearchParams(location.search);
let model = $state<ViewerModel | undefined>();
let error = $state<string | undefined>();
let prefix = $state("");
let selection = $state<string[]>([]);
let live = $state(false);
let restored = false;
/** The variant shown (?variant=NAME), and a pending patch drawn as if accepted. */
let variant = $state<string | undefined>(params.get("variant") ?? undefined);
let preview = $state<string | undefined>();
let tab = $state<"inspect" | "changes">(params.get("tab") === "changes" ? "changes" : "inspect");
const changeCount = $derived(
  (model?.versions?.changesets.length ?? 0) + (model?.versions?.pending.length ?? 0),
);

/** Every sheet instance in page order: the top block first, then depth-first. */
const pages = $derived(
  (model?.sheets ?? [])
    .flatMap((s) => s.instances.map((i) => ({ block: s.block, prefix: i.prefix, page: i.page })))
    .sort((a, b) => a.page - b.page),
);
const current = $derived(model?.sheets.find((s) => s.instances.some((i) => i.prefix === prefix)));

async function refresh() {
  try {
    model = await api.fetchModel({
      ...(variant && { variant }),
      ...(preview && { preview }),
    });
    error = undefined;
    // A preview ends when its patch is accepted or rejected.
    if (preview && !model.versions?.pending.some((p) => p.id === preview)) {
      preview = undefined;
      void refresh();
      return;
    }
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
  const unsubscribe = api.subscribe(
    () => {
      live = true;
      void refresh();
    },
    // The server now shows another project: start over on it (sheets, variants and selection
    // belonged to the old one).
    (name) => {
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("project", name);
      location.replace(url);
    },
  );
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

function setVariant(name: string | undefined) {
  variant = name;
  preview = undefined;
  const url = new URL(location.href);
  if (name) url.searchParams.set("variant", name);
  else url.searchParams.delete("variant");
  history.replaceState(null, "", url);
  void refresh();
}
function setPreview(id: string | undefined) {
  preview = id;
  void refresh();
}
/** Shows a changed part or net: every instance of its block. */
function showChange(c: { block: string; kind: string; key: string }) {
  const sheet = model?.sheets.find((s) => s.block === c.block);
  if (!sheet) return;
  const subjects =
    c.kind === "part"
      ? sheet.instances.map((i) => i.prefix + c.key)
      : c.kind === "net"
        ? sheet.instances.flatMap((i) => (i.nets[c.key] ? [i.nets[c.key] as string] : []))
        : [];
  const first = sheet.instances[0];
  if (first) prefix = first.prefix;
  select(subjects, false);
}
</script>

<header>
  <h1>{model?.project ?? "Partstyle"}</h1>
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
  {#if variant}
    <span class="chip variant-chip">variant {variant} <button class="link" onclick={() => setVariant(undefined)}>back to main</button></span>
  {/if}
  {#if preview}<span class="chip meh">previewing {preview}</span>{/if}
  {#if model && params.get("project") && params.get("project") !== model.project}
    <span class="chip meh" title="The MCP server has opened another project since this page was opened">now showing {model.project}, not {params.get("project")}</span>
  {/if}
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
        changes={tab === "changes" ? (model.preview?.changed ?? model.versions?.changed ?? []) : []}
      />
    {:else}
      <p class="error">Nothing to draw: fix the errors listed on the right.</p>
    {/if}
  </div>
  <aside>
    {#if model}
      <div class="tabs">
        <button class:active={tab === "inspect"} onclick={() => (tab = "inspect")}>Inspect</button>
        <button class:active={tab === "changes"} onclick={() => (tab = "changes")}>
          Changes{changeCount > 0 ? ` (${changeCount})` : ""}
        </button>
      </div>
      {#if tab === "inspect"}
        <Inspector {model} {selection} onselect={select} />
        <IssueList issues={model.issues} comments={model.comments} onshow={show} />
      {:else if model.versions}
        <Changes
          versions={model.versions}
          {variant}
          {preview}
          onpreview={setPreview}
          onvariant={setVariant}
          onshow={showChange}
          ondone={() => void refresh()}
        />
      {/if}
    {/if}
  </aside>
</main>
