<script lang="ts">
import type { ChangeItem, VersionState } from "@partstyle/engine";
import * as api from "./api";

interface Props {
  versions: VersionState;
  /** The variant being viewed, if not the main line. */
  variant: string | undefined;
  /** The pending change being previewed. */
  preview: string | undefined;
  onpreview: (id: string | undefined) => void;
  onvariant: (name: string | undefined) => void;
  /** Selects what a change is about on the sheets. */
  onshow: (item: Omit<ChangeItem, "id" | "text">) => void;
  /** Called after any action, so the app reloads. */
  ondone: () => void;
}
let { versions, variant, preview, onpreview, onvariant, onshow, ondone }: Props = $props();

let message = $state("");
let newVariant = $state("");
let busy = $state(false);
let result = $state("");

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const opClass = (op: string) => (op === "+" ? "added" : op === "-" ? "removed" : "modified");

async function run(action: () => Promise<{ ok: boolean; text: string }>) {
  busy = true;
  try {
    const r = await action();
    result = r.text;
  } catch (e) {
    result = String(e);
  } finally {
    busy = false;
    ondone();
  }
}

function checkpoint() {
  const m = message.trim();
  if (!m) return;
  void run(async () => {
    const r = await api.checkpoint(m, variant);
    if (r.ok) message = "";
    return r;
  });
}
function createVariant() {
  const name = newVariant.trim();
  if (!name) return;
  void run(async () => {
    const r = await api.variantOp("create", name);
    if (r.ok) newVariant = "";
    return r;
  });
}
function adopt(name: string) {
  if (!confirm(`Copy variant ${name}'s design over the main line? It becomes one changeset you can revert.`)) return;
  void run(() => api.variantOp("adopt", name));
}
function remove(name: string) {
  if (!confirm(`Delete variant ${name} and its branch? Its unsaved and checkpointed work is lost.`)) return;
  if (variant === name) onvariant(undefined);
  void run(() => api.variantOp("remove", name));
}
</script>

<section class="changes">
  {#if !versions.git}
    <p class="hint">This project is not in a git repository, so changes are tracked but cannot be checkpointed. Run <code>git init</code> in the project to enable checkpoints and variants.</p>
  {:else}
    <h3>Checkpoint{variant ? ` (variant ${variant})` : ""}</h3>
    <p class="muted">
      {#if versions.checkpoint}
        Last: <code>{versions.checkpoint.id}</code> “{versions.checkpoint.message}”, {new Date(versions.checkpoint.date).toLocaleString()}
      {:else}
        None yet.
      {/if}
    </p>
    <form
      class="row"
      onsubmit={(e) => {
        e.preventDefault();
        checkpoint();
      }}
    >
      <input bind:value={message} placeholder="What these changes do…" />
      <button type="submit" disabled={busy || !message.trim()}>Checkpoint</button>
    </form>
  {/if}

  {#if versions.pending.length > 0}
    <h3>Waiting for your approval</h3>
    {#each versions.pending as p (p.id)}
      <div class="changeset pending" class:previewing={preview === p.id}>
        <div class="head">
          <strong>{p.id}</strong> <span class="muted">{time(p.created)}</span>
          <span class="actions">
            <button class="link" onclick={() => onpreview(preview === p.id ? undefined : p.id)}>{preview === p.id ? "hide" : "preview"}</button>
            <button disabled={busy} onclick={() => run(() => api.decidePending("accept", p.id, variant))}>Accept</button>
            <button disabled={busy} onclick={() => run(() => api.decidePending("reject", p.id, variant))}>Reject</button>
          </span>
        </div>
        <ul>{#each p.log as l, i (i)}<li><code>{l}</code></li>{/each}</ul>
      </div>
    {/each}
  {/if}

  <h3>Changes since the checkpoint</h3>
  {#if versions.changesets.length === 0}
    <p class="muted">None.</p>
  {/if}
  {#each [...versions.changesets].reverse() as cs (cs.id)}
    <div class="changeset">
      <div class="head">
        <strong>{cs.id}</strong>
        <span class="muted">{cs.source} · {time(cs.time)}</span>
        {#if cs.note}<span class="muted">· {cs.note}</span>{/if}
        <span class="actions">
          <button disabled={busy} title="Undo this whole changeset" onclick={() => run(() => api.revert(cs.id, variant))}>Revert</button>
        </span>
      </div>
      <ul>
        {#each cs.items as i (i.id)}
          <li class={opClass(i.op)}>
            <button class="link" disabled={i.op === "-"} onclick={() => onshow(i)}>
              <span class="block">{i.block}</span> <code>{i.text}</code>
            </button>
            <button class="link undo" disabled={busy} title={`Undo ${i.id}`} onclick={() => run(() => api.revert(i.id, variant))}>undo</button>
          </li>
        {/each}
      </ul>
    </div>
  {/each}

  {#if versions.git && !variant}
    <h3>Variants</h3>
    {#each versions.variants as v (v)}
      <div class="row variant">
        <button class="link" onclick={() => onvariant(v)}>{v}</button>
        <span class="actions">
          <button disabled={busy} onclick={() => adopt(v)}>Adopt</button>
          <button disabled={busy} onclick={() => remove(v)}>Remove</button>
        </span>
      </div>
    {/each}
    <form
      class="row"
      onsubmit={(e) => {
        e.preventDefault();
        createVariant();
      }}
    >
      <input bind:value={newVariant} placeholder="New variant name, e.g. buck" />
      <button type="submit" disabled={busy || !newVariant.trim()}>Create</button>
    </form>
    <p class="hint">A variant starts from the last checkpoint. Open one to view and review it; adopting copies its design here as one changeset.</p>
  {/if}

  {#if result}<p class="message">{result}</p>{/if}
</section>
