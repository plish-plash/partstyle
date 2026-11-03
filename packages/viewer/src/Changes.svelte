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
let newDescription = $state("");
let busy = $state(false);
let result = $state("");

const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const blockName = (file: string) => file.replace(/^.*\//, "").replace(/\.ckt$/, "");
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
    const r = await api.variantOp("create", name, newDescription.trim() || undefined);
    if (r.ok) {
      newVariant = "";
      newDescription = "";
      onvariant(name);
    }
    return r;
  });
}
function adopt(name: string) {
  if (!confirm(`Make variant ${name}'s changes the main circuit's? It becomes one changeset you can revert, and the variant then matches main.`)) return;
  void run(() => api.variantOp("adopt", name));
}
function remove(name: string) {
  if (!confirm(`Delete variant ${name}? Its blocks are lost unless a checkpoint holds them.`)) return;
  if (variant === name) onvariant(undefined);
  void run(() => api.variantOp("remove", name));
}
</script>

<section class="changes">
  {#if !versions.git}
    <p class="hint">This project is not in a git repository, so changes are tracked but cannot be checkpointed. Run <code>git init</code> in the project to enable checkpoints and variants.</p>
  {:else}
    <h3>Checkpoint <span class="muted">(main and every variant)</span></h3>
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

  <label class="row mode" title="When on, each patch the AI applies waits here until you accept it">
    <input
      type="checkbox"
      checked={versions.mode === "accept"}
      disabled={busy}
      onchange={(e) => run(() => api.setReviewMode(e.currentTarget.checked ? "accept" : "auto", variant))}
    />
    Approve each AI edit before it lands
  </label>

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

  <h3>Changes since the checkpoint{variant ? ` to variant ${variant}` : ""}</h3>
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

  <h3>Variants</h3>
  {#each versions.variants as v (v.name)}
    <div class="row variant">
      <button class="link" class:active={variant === v.name} onclick={() => onvariant(v.name)}>{v.name}</button>
      {#if v.description}<span class="muted">{v.description}</span>{/if}
      <span class="actions">
        <button disabled={busy} onclick={() => adopt(v.name)}>Adopt</button>
        <button disabled={busy} onclick={() => remove(v.name)}>Remove</button>
      </span>
      <span class="blocks muted">
        {#if v.blocks.length === 0 && !v.projectFile}
          same as main
        {:else}
          own: {[...(v.projectFile ? ["project file"] : []), ...v.blocks.map(blockName)].join(", ")}
        {/if}
        {#if v.diverged.length > 0}
          · <span class="warn">main changed {v.diverged.map(blockName).join(", ")} since</span>
        {/if}
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
    <input bind:value={newVariant} placeholder="Name, e.g. buck" />
    <input bind:value={newDescription} placeholder="What it explores (optional)" />
    <button type="submit" disabled={busy || !newVariant.trim()}>Create</button>
  </form>
  <p class="hint">A variant shares every block it doesn't change, so edits to main reach it. Switch between versions in the header; adopting makes a variant's changes main's, as one changeset.</p>

  {#if result}<p class="message">{result}</p>{/if}
</section>
