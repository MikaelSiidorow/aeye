<script lang="ts">
  let { children } = $props();
</script>

{@render children()}

<style>
  :global(*) {
    box-sizing: border-box;
  }

  :global(body) {
    margin: 0;
    color: #18211b;
    background: #f4f6f2;
    font-family: ui-sans-serif, system-ui, sans-serif;
  }
</style>
