<script lang="ts">
import type { Comment, Issue } from "@partstyle/engine";

interface Props {
  issues: Issue[];
  comments: Comment[];
  onshow: (subjects: string[]) => void;
}
let { issues, comments, onshow }: Props = $props();

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
  <h3>Open comments ({open.length})</h3>
  <ul>
    {#each open as c (c.id)}
      <li class="comment-item">
        <button class="link" onclick={() => onshow([c.subject])}><b>{c.subject}</b> {c.text}</button>
      </li>
    {/each}
  </ul>
</section>
