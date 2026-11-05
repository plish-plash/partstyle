<script lang="ts">
import type { AppliedWaiver, Comment, Issue } from "@partstyle/engine";

interface Props {
  issues: Issue[];
  waivers: AppliedWaiver[];
  comments: Comment[];
  onshow: (subjects: string[]) => void;
}
let { issues, waivers, comments, onshow }: Props = $props();

const open = $derived(comments.filter((c) => c.status === "open"));
const order = { error: 0, warning: 1, info: 2 } as const;
const sorted = $derived([...issues].sort((a, b) => order[a.severity] - order[b.severity]));
</script>

<section class="issue-list">
  <h3>Issues ({issues.length})</h3>
  {#if sorted.length === 0}
    <p class="muted">None.</p>
  {/if}
  <ul>
    {#each sorted as i, k (k)}
      <li class={i.severity}>
        <button class="link" disabled={i.subjects.length === 0} onclick={() => onshow(i.subjects)}>
          <code>{i.code}</code>
          {i.message}
        </button>
        {#if i.location}<small>{i.location.file}:{i.location.line}</small>{/if}
      </li>
    {/each}
  </ul>
  {#if waivers.length > 0}
    <h3>Waived ({waivers.length})</h3>
    <ul>
      {#each waivers as w, k (k)}
        <li>
          <b>{w.subject}</b> <code>{w.code}</code>
          {w.reason}
          <small>{w.location.file}:{w.location.line}</small>
          <ul>
            {#each w.issues as i, n (n)}
              <li>
                <button class="link" onclick={() => onshow(i.subjects)}>{i.message}</button>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
  <h3>Open comments ({open.length})</h3>
  <ul>
    {#each open as c (c.id)}
      <li class="comment-item">
        <button class="link" onclick={() => onshow([c.subject])}><b>{c.subject}</b> {c.text}</button>
      </li>
    {/each}
  </ul>
</section>
