<script lang="ts">
  import Inspector from "./components/Inspector.svelte";
  import RulePanel from "./components/RulePanel.svelte";
  import Schematic from "./components/Schematic.svelte";
  import Scores from "./components/Scores.svelte";
  import { app, type View } from "./lib/state.svelte";

  const views: { id: View; label: string }[] = [
    { id: "case", label: "Case" },
    { id: "gallery", label: "All cases" },
    { id: "compare", label: "Compare" },
  ];

  const run = $derived(app.run);
  const then = $derived(app.reference.get(app.caseId));
  const hardCases = $derived(
    [...app.runs.values()].filter((r) => r.error || (r.metrics?.hardFailures ?? 0) > 0).length,
  );
  const totalCrossings = $derived(
    [...app.runs.values()].reduce((s, r) => s + (r.metrics?.crossings ?? 0), 0),
  );
  const changedCases = $derived(app.cases.filter((c) => app.isChanged(c.id)).length);

  let baselineName = $state("");

  function saveBaseline(e: SubmitEvent) {
    e.preventDefault();
    if (!baselineName.trim()) return;
    void app.saveBaseline(baselineName.trim());
    baselineName = "";
  }

  function onKey(e: KeyboardEvent) {
    const t = e.target as HTMLElement;
    if (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT") return;
    if (e.key === "j") app.step(1);
    else if (e.key === "k") app.step(-1);
    else if (e.key === "1") app.setView("case");
    else if (e.key === "2") app.setView("gallery");
    else if (e.key === "3") app.setView("compare");
  }

  function dotClass(id: string) {
    const r = app.runs.get(id);
    if (r?.error || (r?.metrics?.hardFailures ?? 0) > 0) return "fail";
    const note = app.notes[id];
    if (note?.resolved) return "review";
    return `${note?.verdict ?? ""}${app.isStale(id) ? " stale" : ""}`;
  }
</script>

<svelte:window onkeydown={onKey} />

<div class="shell">
  <header class="top">
    <h1>Layout tester</h1>
    <nav class="tabs" aria-label="View">
      {#each views as v (v.id)}
        <button class:active={app.view === v.id} onclick={() => app.setView(v.id)}>{v.label}</button>
      {/each}
    </nav>

    <div class="overlays">
      {#each Object.keys(app.overlays) as key (key)}
        <label>
          <input
            type="checkbox"
            bind:checked={app.overlays[key as keyof typeof app.overlays]}
          />
          {key}
        </label>
      {/each}
    </div>

    <div class="shuffle">
      <button
        title="Lay out every case again with its parts and nets declared in a different order"
        onclick={() => app.shuffle()}>Shuffle order</button
      >
      {#if app.seed !== 0}
        <span class="seed">Shuffle {app.seed}</span>
        <button class="link" onclick={() => app.unshuffle()}>As declared</button>
      {/if}
    </div>

    <div class="spacer"></div>

    <div class="compare-to">
      <label>
        Compare to
        <select value={app.compareTo} onchange={(e) => app.setCompare((e.target as HTMLSelectElement).value)}>
          <option value="previous">Before last reload</option>
          <option value="defaults">Default rules</option>
          <option value="declared">As declared</option>
          {#each app.baselines as b (b)}
            <option value={b}>Baseline {b}</option>
          {/each}
        </select>
      </label>
      <form onsubmit={saveBaseline}>
        <input aria-label="Baseline name" placeholder="Save baseline" bind:value={baselineName} />
      </form>
    </div>
  </header>

  <aside class="cases">
    {#each app.grouped as [category, list] (category)}
      <h3>{category}</h3>
      {#each list as c (c.id)}
        <button class="case" class:active={c.id === app.caseId} onclick={() => app.select(c.id)}>
          <span class="dot {dotClass(c.id)}"></span>
          <span class="case-title">{c.title}</span>
          {#if app.isChanged(c.id)}<span class="changed-mark" title="Changed">●</span>{/if}
        </button>
      {/each}
    {/each}
  </aside>

  <main class="stage">
    {#if app.view === "gallery"}
      <div class="gallery">
        {#each app.cases as c (c.id)}
          {@const r = app.runs.get(c.id)}
          <button class="card" class:changed={app.isChanged(c.id)} onclick={() => app.select(c.id)}>
            <div class="card-head">
              <span class="dot {dotClass(c.id)}"></span>
              <span>{c.title}</span>
            </div>
            <div class="thumb">
              {#if r?.result}
                <Schematic result={r.result} />
              {:else}
                <p class="error">{r?.error}</p>
              {/if}
            </div>
            <div class="card-foot">
              <span>{r?.metrics?.crossings ?? "–"} crossings</span>
              <span>{r?.metrics?.bends ?? "–"} bends</span>
              {#if (r?.metrics?.hardFailures ?? 0) > 0}
                <span class="bad">{r?.metrics?.hardFailures} failures</span>
              {/if}
            </div>
          </button>
        {/each}
      </div>
    {:else if app.view === "compare"}
      <div class="compare">
        <div class="pane">
          <h2>Now</h2>
          {#if run?.result}<Schematic result={run.result} interactive />{/if}
        </div>
        <div class="pane">
          <h2>{app.reference.label}</h2>
          {#if then?.result}
            <Schematic result={then.result} interactive />
          {:else}
            <p class="dim empty">Nothing to compare yet.</p>
          {/if}
        </div>
      </div>
      <div class="compare-scores">
        <Scores metrics={run?.metrics} then={then?.metrics} thenLabel="Then" />
      </div>
    {:else if run?.result}
      <div class="case-head">
        <h2>{app.current?.title}</h2>
        <p>{app.current?.description}</p>
      </div>
      <div class="canvas">
        <Schematic result={run.result} interactive />
      </div>
      <p class="hint">Scroll to zoom, drag to pan, double-click to fit. j and k change case.</p>
    {:else}
      <div class="case-head">
        <h2>{app.current?.title}</h2>
        <p class="error">The engine threw an error: {run?.error}</p>
      </div>
    {/if}
  </main>

  {#if app.view === "case"}
    <Inspector />
  {/if}
  <RulePanel />

  <footer class="status">
    <span class:bad={hardCases > 0}>{hardCases} of {app.cases.length} cases broken</span>
    <span>{totalCrossings} crossings in total</span>
    <span>{changedCases} changed from {app.reference.label.toLowerCase()}</span>
    <span class="spacer"></span>
    {#if app.status}<span class="flash">{app.status}</span>{/if}
    {#if app.lastReload}<span class="dim">Engine reloaded {app.lastReload}</span>{/if}
  </footer>
</div>
