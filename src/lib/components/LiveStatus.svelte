<script lang="ts">
  import { onMount } from "svelte";

  interface Props {
    connected: boolean;
    loading: boolean;
    reconnect: () => void | Promise<void>;
  }

  let { connected, loading, reconnect }: Props = $props();
  let mounted = $state(false);
  const label = $derived(!mounted || loading ? "Connecting" : connected ? "Live" : "Reconnect");

  onMount(() => {
    mounted = true;
  });
</script>

{#if label === "Reconnect"}
  <button class="live-state disconnected" type="button" onclick={reconnect}>
    <span aria-hidden="true"></span>
    {label}
  </button>
{:else}
  <span class:connected class="live-state" role="status">
    <span aria-hidden="true"></span>
    {label}
  </span>
{/if}

<style>
  .live-state {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    min-height: 1.5rem;
    padding: 0.15rem 0.5rem;
    border: 1px solid var(--color-line);
    border-radius: 999px;
    color: var(--color-muted);
    background: var(--color-surface-subtle);
    font: inherit;
    font-size: 0.68rem;
    font-weight: 700;
    line-height: 1;
    letter-spacing: 0.04em;
  }

  .live-state > span {
    width: 0.42rem;
    height: 0.42rem;
    border-radius: 50%;
    background: #9aa69e;
  }

  .live-state.connected > span {
    background: #3f7756;
  }

  button.live-state {
    cursor: pointer;
  }

  button.live-state:hover {
    border-color: #b98a79;
    color: #8c4d38;
    background: #fff8f5;
  }

  button.live-state > span {
    background: #b5654a;
  }
</style>
