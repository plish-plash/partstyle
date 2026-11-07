<script lang="ts">
import type { LayoutControls } from "@partstyle/engine";
import * as api from "./api";

interface Props {
  controls: LayoutControls;
  /** The variant being viewed, if not the main line. */
  variant: string | undefined;
  /** Called after a change, so the app redraws. */
  ondone: () => Promise<void>;
}
let { controls, variant, ondone }: Props = $props();

/** Values being changed, shown until the redrawn design arrives. */
let drafts = $state<Record<string, number | string>>({});
let error = $state("");
let busy = $state(false);

type Param = LayoutControls["groups"][number]["params"][number];
/** Preferences are never booleans. */
const initial = (p: Param) => p.default as number | string;
const draftKey = (rule: string, key: string) => `${rule}.${key}`;
const saved = (rule: string, key: string, fallback: number | string) =>
  controls.values[rule]?.[key] ?? fallback;
const shown = (rule: string, key: string, fallback: number | string) =>
  drafts[draftKey(rule, key)] ?? saved(rule, key, fallback);

const anyChanged = $derived(
  controls.groups.some((g) => g.params.some((p) => saved(g.rule, p.key, initial(p)) !== p.default)),
);

async function run(action: () => Promise<{ ok: boolean; text: string }>) {
  try {
    const r = await action();
    error = r.ok ? "" : r.text;
  } catch (e) {
    error = String(e);
  }
  await ondone();
}

async function commit(rule: string, key: string, value: number | string) {
  drafts[draftKey(rule, key)] = value;
  await run(() => api.setLayoutPreference(rule, key, value, variant));
  delete drafts[draftKey(rule, key)];
}

async function reset() {
  busy = true;
  await run(() => api.resetLayoutPreferences(variant));
  busy = false;
}
</script>

<section class="layout-panel">
  <p class="muted">These apply to every sheet of this design and to the KiCad export.</p>
  {#each controls.groups as g (g.rule)}
    <h3>{g.title}</h3>
    {#each g.params as p (p.key)}
      {@const value = shown(g.rule, p.key, initial(p))}
      <div class="pref" class:changed={value !== p.default}>
        <label for={draftKey(g.rule, p.key)}>{p.label}</label>
        {#if p.type === "number"}
          <output for={draftKey(g.rule, p.key)}>{value}</output>
          <input
            id={draftKey(g.rule, p.key)}
            type="range"
            min={p.min}
            max={p.max}
            step={p.step}
            {value}
            oninput={(e) => (drafts[draftKey(g.rule, p.key)] = e.currentTarget.valueAsNumber)}
            onchange={(e) => void commit(g.rule, p.key, e.currentTarget.valueAsNumber)}
          />
        {:else if p.type === "enum"}
          <select
            id={draftKey(g.rule, p.key)}
            {value}
            onchange={(e) => void commit(g.rule, p.key, e.currentTarget.value)}
          >
            {#each p.options as option (option)}
              <option value={option}>{option}</option>
            {/each}
          </select>
        {/if}
        <p class="muted">{p.preference}</p>
      </div>
    {/each}
  {/each}
  {#if error}<p class="error">{error}</p>{/if}
  <button disabled={busy || (!anyChanged && !variant)} onclick={() => void reset()}>
    {variant ? "Use main's layout" : "Reset to defaults"}
  </button>
</section>
