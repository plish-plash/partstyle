<script lang="ts">
  import { app, type Verdict } from "../lib/state.svelte";
  import Scores from "./Scores.svelte";

  const run = $derived(app.run);
  const part = $derived(run?.result?.parts.find((p) => p.id === app.selectedPart));
  const trace = $derived(part ? (run?.result?.trace[part.id] ?? []) : []);
  const nets = $derived(
    part ? [...new Set(part.pins.map((p) => p.net).filter((n) => n !== undefined))] : [],
  );
  const saved = $derived(app.notes[app.caseId]);

  let verdict = $state<Verdict | undefined>();
  let note = $state("");
  let loadedFor = $state("");

  // Show what was saved whenever another case opens, or the saved notes finish loading.
  $effect(() => {
    const key = `${app.caseId}\u0000${saved?.updatedAt ?? ""}`;
    if (loadedFor === key) return;
    loadedFor = key;
    verdict = saved?.verdict;
    note = saved?.note ?? "";
  });

  const verdicts: { id: Verdict; label: string }[] = [
    { id: "good", label: "Good" },
    { id: "needs-work", label: "Needs work" },
    { id: "bad", label: "Bad" },
  ];

  function choose(v: Verdict) {
    verdict = verdict === v ? undefined : v;
    // Good means nothing is left to do, so its note is finished with.
    if (verdict === "good") note = "";
    void app.saveNote(verdict, note);
  }

  function clearNote() {
    note = "";
    void app.saveNote(verdict, "");
  }

  const dirty = $derived(note !== (saved?.note ?? ""));
</script>

<aside class="inspector">
  <section>
    <h2>Your verdict</h2>
    {#if saved?.resolved}
      <p class="resolved"><strong>Ready to review:</strong> {saved.resolved}</p>
    {/if}
    {#if app.isStale(app.caseId)}
      <p class="stale">The layout has changed since you judged it.</p>
    {/if}
    <div class="verdicts">
      {#each verdicts as v (v.id)}
        <button class={v.id} class:active={verdict === v.id} onclick={() => choose(v.id)}>
          {v.label}
        </button>
      {/each}
    </div>
    <textarea
      aria-label="Note on this layout"
      placeholder="What should change here?"
      rows="4"
      bind:value={note}
    ></textarea>
    <div class="note-actions">
      <button disabled={!dirty} onclick={() => app.saveNote(verdict, note)}>Save note</button>
      <button disabled={!saved?.note} onclick={clearNote}>Clear</button>
      {#if saved?.updatedAt}
        <span class="dim">Saved {new Date(saved.updatedAt).toLocaleString()}</span>
      {/if}
    </div>
  </section>

  {#if part}
    <section>
      <h2>{part.ref}{part.value ? ` · ${part.value}` : ""}</h2>
      <p class="dim">
        Role: {part.role}{part.column >= 0 ? ` · column ${part.column}` : ""}
      </p>
      {#if trace.length > 0}
        <ul class="trace">
          {#each trace as t, i (i)}
            <li><code>{t.rule}</code> {t.note}</li>
          {/each}
        </ul>
      {:else}
        <p class="dim">No rule moved this part.</p>
      {/if}
      <p class="dim">Nets: {nets.join(", ") || "none"}</p>
    </section>
  {:else}
    <section>
      <p class="dim">Click a part to see which rules placed it.</p>
    </section>
  {/if}

  {#if run?.issues.length}
    <section>
      <h2>Issues ({run.issues.length})</h2>
      <ul class="issues">
        {#each run.issues as issue, i (i)}
          <li>{issue.message}</li>
        {/each}
      </ul>
    </section>
  {/if}

  <section>
    <h2>Scores</h2>
    <Scores metrics={run?.metrics} />
  </section>
</aside>
