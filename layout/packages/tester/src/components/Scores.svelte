<script lang="ts">
  import type { Metrics } from "@partstyle/layout";
  import { deltaKind, METRIC_ROWS } from "../lib/metrics";

  interface Props {
    metrics: Metrics | undefined;
    then?: Metrics | undefined;
    thenLabel?: string;
  }
  let { metrics, then, thenLabel = "Before" }: Props = $props();

  const format = (n: number, unit?: string) => `${n}${unit ?? ""}`;
</script>

{#if metrics}
  <table class="scores">
    {#if then}
      <thead>
        <tr><th></th><th>Now</th><th>{thenLabel}</th></tr>
      </thead>
    {/if}
    <tbody>
      {#each METRIC_ROWS as row (row.key)}
        {@const now = metrics[row.key]}
        {@const old = then?.[row.key]}
        <tr>
          <th scope="row">{row.label}</th>
          <td
            class:good={old !== undefined && deltaKind(row, now, old) === "good"}
            class:bad={old !== undefined && deltaKind(row, now, old) === "bad"}
          >
            {format(now, row.unit)}
          </td>
          {#if then}
            <td class="dim">{old === undefined ? "–" : format(old, row.unit)}</td>
          {/if}
        </tr>
      {/each}
    </tbody>
  </table>
{/if}
