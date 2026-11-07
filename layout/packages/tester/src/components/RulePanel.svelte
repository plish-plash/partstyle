<script lang="ts">
  import type { RuleDef } from "@partstyle/layout";
  import { defaultRules } from "@partstyle/layout";
  import { app } from "../lib/state.svelte";

  const groups = $derived.by(() => {
    const map = new Map<string, RuleDef[]>();
    for (const r of app.ruleDefs) {
      const list = map.get(r.group) ?? [];
      list.push(r);
      map.set(r.group, list);
    }
    return [...map.entries()];
  });

  const defaults = $derived(defaultRules());
  const changed = $derived(app.overrides);
  let presetName = $state("");

  function savePreset(e: SubmitEvent) {
    e.preventDefault();
    if (!presetName.trim()) return;
    void app.savePreset(presetName.trim());
    presetName = "";
  }

  function onPreset(e: Event) {
    const select = e.target as HTMLSelectElement;
    if (select.value) void app.loadPreset(select.value);
    select.value = "";
  }

  const numberValue = (e: Event) => Number((e.target as HTMLInputElement).value);
</script>

<aside class="rules">
  <header class="panel-head">
    <h2>Rules</h2>
    <button class="link" disabled={app.changedRuleCount === 0} onclick={() => app.resetRules()}>
      Reset{app.changedRuleCount ? ` (${app.changedRuleCount})` : ""}
    </button>
  </header>

  <div class="preset-row">
    <select aria-label="Load preset" onchange={onPreset} disabled={app.presets.length === 0}>
      <option value="">{app.presets.length ? "Load preset" : "No presets yet"}</option>
      {#each app.presets as p (p)}
        <option value={p}>{p}</option>
      {/each}
    </select>
    <form onsubmit={savePreset}>
      <input aria-label="Preset name" placeholder="Save as" bind:value={presetName} />
    </form>
  </div>

  {#each groups as [group, rules] (group)}
    <h3>{group}</h3>
    {#each rules as rule (rule.id)}
      {@const state = app.rules[rule.id]}
      {#if state}
        <section class="rule" class:off={!state.enabled} class:changed={changed[rule.id]}>
          <label class="rule-title">
            <input
              type="checkbox"
              checked={state.enabled}
              onchange={(e) => app.setEnabled(rule.id, (e.target as HTMLInputElement).checked)}
            />
            <span>{rule.title}</span>
          </label>
          <p>{rule.description}</p>
          {#each rule.params as param (param.key)}
            {@const value = state.params[param.key]}
            {@const moved = value !== defaults[rule.id]?.params[param.key]}
            <div class="param" class:moved>
              <span class="param-label">{param.label}</span>
              {#if param.type === "number"}
                <input
                  type="range"
                  aria-label={param.label}
                  min={param.min}
                  max={param.max}
                  step={param.step}
                  value={value as number}
                  disabled={!state.enabled}
                  oninput={(e) => app.setParam(rule.id, param.key, numberValue(e))}
                />
                <output>{value}</output>
              {:else if param.type === "boolean"}
                <input
                  type="checkbox"
                  aria-label={param.label}
                  checked={value as boolean}
                  disabled={!state.enabled}
                  onchange={(e) =>
                    app.setParam(rule.id, param.key, (e.target as HTMLInputElement).checked)}
                />
              {:else}
                <div class="segments">
                  {#each param.options as option (option)}
                    <button
                      class:active={value === option}
                      disabled={!state.enabled}
                      onclick={() => app.setParam(rule.id, param.key, option)}>{option}</button
                    >
                  {/each}
                </div>
              {/if}
            </div>
          {/each}
        </section>
      {/if}
    {/each}
  {/each}
</aside>
