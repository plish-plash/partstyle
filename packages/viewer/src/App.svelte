<script lang="ts">
import type { ViewerModel } from "@partstyle/engine";
import { onMount } from "svelte";
import * as api from "./api";
import Changes from "./Changes.svelte";
import Inspector from "./Inspector.svelte";
import IssueList from "./IssueList.svelte";
import LayoutPanel from "./LayoutPanel.svelte";
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
type Tab = "inspect" | "changes" | "layout";
const startTab = params.get("tab");
let tab = $state<Tab>(startTab === "changes" || startTab === "layout" ? startTab : "inspect");
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

// The project's name in the browser tab, so several open viewers can be told apart.
$effect(() => {
  document.title = model ? `${model.project} — Partstyle` : "Partstyle viewer";
});

const partPaths = $derived(Object.keys(model?.parts ?? {}));
const isApproved = (p: string) => model?.parts[p]?.approval?.status === "approved";
const approvedCount = $derived(partPaths.filter(isApproved).length);
/** Selects the next part still to sign off, after the one selected. */
function nextToApprove() {
  const from = partPaths.indexOf(selection[0] ?? "");
  const order = [...partPaths.slice(from + 1), ...partPaths.slice(0, from + 1)];
  const next = order.find((p) => !isApproved(p));
  if (next) show([next]);
}
function approveSelected() {
  const paths = selection.filter((s) => model?.parts[s] && !isApproved(s));
  if (paths.length > 0) void api.approve(paths, false, variant);
}
function key(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.toLowerCase() === "a") {
    e.preventDefault();
    approveSelected();
  }
}

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
  void api.sendFocus({ selection, sheet: prefix, ...(variant && { variant }) }).catch(() => {});
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
  publish();
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

<svelte:window onkeydown={key} />

<header>
  <h1>{model?.project ?? "Partstyle"}</h1>
  {#if model}
    <span class="chip" class:bad={model.summary.errors > 0}>{model.summary.errors} errors</span>
    <span class="chip" class:meh={model.summary.warnings > 0}>{model.summary.warnings} warnings</span>
    {#if model.summary.waived > 0}<span class="chip muted">{model.summary.waived} waived</span>{/if}
    {#if partPaths.length > 0}
      <button class="chip approvals" title="Go to the next part to sign off" onclick={nextToApprove}>
        {approvedCount}/{partPaths.length} approved
      </button>
    {/if}
  {/if}
  <nav>
    {#each pages as p (p.prefix)}
      <button class:active={p.prefix === prefix} onclick={() => open(p.prefix)}>{pageLabel(p)}</button>
    {/each}
  </nav>
  {#if model?.versions && (model.versions.variants.length > 0 || variant)}
    <label class="variant-switch" class:on={variant !== undefined} title="Which version of the design to show">
      <select
        value={variant ?? ""}
        onchange={(e) => setVariant(e.currentTarget.value || undefined)}
      >
        <option value="">main circuit</option>
        {#each model.versions.variants as v (v.name)}
          <option value={v.name}>{v.name}{v.description ? ` — ${v.description}` : ""}</option>
        {/each}
      </select>
    </label>
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
        changes={model.preview?.changed ??
          (tab === "changes" ? model.versions?.changed : model.versions?.vsMain) ??
          []}
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
        <button class:active={tab === "layout"} onclick={() => (tab = "layout")}>Layout</button>
      </div>
      {#if tab === "inspect"}
        <Inspector
          {model}
          {selection}
          onselect={select}
        />
        <IssueList
          issues={model.issues}
          waivers={model.waivers}
          comments={model.comments}
          onshow={show}
        />
      {:else if tab === "layout"}
        <LayoutPanel controls={model.layout} {variant} ondone={refresh} />
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
