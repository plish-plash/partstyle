<script lang="ts">
import type { ViewerModel } from "@partstyle/engine";
import * as api from "./api";

interface Props {
  model: ViewerModel;
  selection: string[];
  onselect: (subjects: string[], additive: boolean) => void;
}
let { model, selection, onselect }: Props = $props();

const subject = $derived(selection[0]);
const part = $derived(subject ? model.parts[subject] : undefined);
const pin = $derived.by(() => {
  if (!subject || part) return undefined;
  const dot = subject.lastIndexOf(".");
  const owner = dot > 0 ? model.parts[subject.slice(0, dot)] : undefined;
  const key = subject.slice(dot + 1);
  const p = owner?.pins.find((q) => q.name === key || q.number === key);
  return owner && p ? { owner, pin: p } : undefined;
});
const netName = $derived.by(() => {
  if (!subject || part || pin) return undefined;
  return Object.keys(model.nets).find(
    (n) => n === subject || model.nets[n]?.aliases.includes(subject),
  );
});
const net = $derived(netName ? model.nets[netName] : undefined);
const subjectIssues = $derived(
  subject ? model.issues.filter((i) => i.subjects.includes(subject)) : [],
);
const subjectComments = $derived(
  subject ? model.comments.filter((c) => c.subject === subject) : [],
);

let draft = $state("");
let busy = $state(false);
let message = $state("");

async function comment() {
  if (!subject || !draft.trim()) return;
  busy = true;
  try {
    await api.addComment(subject, draft);
    draft = "";
    message = "";
  } catch (e) {
    message = String(e);
  } finally {
    busy = false;
  }
}
async function verify(id: string) {
  busy = true;
  try {
    message = (await api.verifyPart(id)).text;
  } catch (e) {
    message = String(e);
  } finally {
    busy = false;
  }
}
</script>

<section class="inspector">
  {#if !subject}
    <p class="hint">Click a part, pin, wire or sheet to inspect it. The AI sees your selection through <code>focus</code>; shift-click selects several.</p>
  {:else if part}
    <h2>{part.ref} <small>{part.path}</small></h2>
    <p class="spec"><code>{part.spec}</code> — {part.value}</p>
    {#if part.intent}<p class="intent">@ {part.intent}</p>{/if}
    {#if part.record}
      {@const r = part.record}
      <dl>
        <dt>Part</dt>
        <dd>{r.manufacturer} {r.mpn}</dd>
        <dt>Summary</dt>
        <dd>{r.summary}</dd>
        <dt>Footprint</dt>
        <dd>{r.footprint}</dd>
        <dt>Record</dt>
        <dd>
          {#if r.verified}
            <span class="ok">verified</span>
          {:else}
            <span class="warn">unverified</span>
            <button disabled={busy} onclick={() => verify(r.id)}>Mark verified</button>
          {/if}
          <small>{r.file}</small>
        </dd>
        {#if r.datasheet}
          <dt>Datasheet</dt>
          <dd><a href={r.datasheet} target="_blank" rel="noreferrer">open</a></dd>
        {/if}
      </dl>
      {#if Object.keys(r.ratings).length > 0}
        <h3>Ratings</h3>
        <p>{Object.entries(r.ratings).map(([k, v]) => `${k} ${v}`).join(" · ")}</p>
      {/if}
      {#if r.requirements.length > 0}
        <h3>Requirements</h3>
        <ul>{#each r.requirements as q (q)}<li>{q}</li>{/each}</ul>
      {/if}
    {:else}
      <p class="warn">{part.bom.status === "unresolved" ? "Generic part, not resolved to an MPN yet" : ""}</p>
    {/if}
    <h3>Pins</h3>
    <table>
      <tbody>
        {#each part.pins as p (p.number)}
          <tr>
            <td>{p.number}</td>
            <td><button class="link" onclick={() => onselect([`${part.path}.${p.name}`], false)}>{p.name}</button></td>
            <td class="muted">{p.type}</td>
            <td>
              {#if p.net}<button class="link" onclick={() => p.net && onselect([p.net], false)}>{p.net}</button>{:else}<span class="muted">—</span>{/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {:else if pin}
    <h2>{pin.owner.ref}.{pin.pin.name} <small>pin {pin.pin.number}, {pin.pin.type}</small></h2>
    <p>
      On
      {#if pin.pin.net}<button class="link" onclick={() => pin.pin.net && onselect([pin.pin.net], false)}>{pin.pin.net}</button>{:else}no net{/if}
      · part <button class="link" onclick={() => onselect([pin.owner.path], false)}>{pin.owner.path}</button>
    </p>
  {:else if net && netName}
    <h2>Net {netName}</h2>
    {#if Object.keys(net.attrs).length > 0}
      <p>{Object.entries(net.attrs).map(([k, v]) => `${k}: ${v}`).join(" · ")}</p>
    {/if}
    {#if net.aliases.length > 1}<p class="muted">joins {net.aliases.join(", ")}</p>{/if}
    <h3>{net.pins.length} pins</h3>
    <ul class="pins">
      {#each net.pins as p (p)}
        <li><button class="link" onclick={() => onselect([p], false)}>{p}</button></li>
      {/each}
    </ul>
  {:else if subject.endsWith("/")}
    <h2>Sheet {subject.slice(0, -1)}</h2>
    <p class="hint">Double-click the sheet to open it.</p>
  {:else}
    <h2>{subject}</h2>
    <p class="muted">No longer in the design.</p>
  {/if}

  {#if subject}
    {#if subjectIssues.length > 0}
      <h3>Issues</h3>
      <ul class="issues">
        {#each subjectIssues as i, k (k)}<li class={i.severity}><code>{i.code}</code> {i.message}</li>{/each}
      </ul>
    {/if}
    <h3>Comments</h3>
    {#each subjectComments as c (c.id)}
      <div class="comment" class:resolved={c.status === "resolved"}>
        <span>{c.text}</span>
        {#if c.status === "open"}
          <button class="link" onclick={() => api.resolveComment(c.id)}>resolve</button>
        {:else}
          <small>resolved</small>
        {/if}
      </div>
    {/each}
    <form
      onsubmit={(e) => {
        e.preventDefault();
        void comment();
      }}
    >
      <textarea bind:value={draft} placeholder={`Comment on ${subject} for the AI…`} rows="3"></textarea>
      <button type="submit" disabled={busy || !draft.trim()}>Add comment</button>
    </form>
    {#if selection.length > 1}<p class="muted">{selection.length} items selected: {selection.join(", ")}</p>{/if}
  {/if}
  {#if message}<p class="message">{message}</p>{/if}
</section>
