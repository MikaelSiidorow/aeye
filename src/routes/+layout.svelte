<script lang="ts">
  let { children } = $props();
</script>

{@render children()}

<style>
  :global(:root) {
    color-scheme: light;
    --color-ink: #19221c;
    --color-muted: #647269;
    --color-accent: #355c45;
    --color-accent-soft: #edf3ee;
    --color-canvas: #f3f5f1;
    --color-surface: #ffffff;
    --color-surface-subtle: #f8faf7;
    --color-line: #dce2dc;
    --color-line-strong: #c8d2ca;
    --radius-small: 0.5rem;
    --radius-medium: 0.875rem;
    --shadow-card: 0 1px 2px rgb(24 34 27 / 0.04);
    font-synthesis: none;
  }

  :global(*),
  :global(*::before),
  :global(*::after) {
    box-sizing: border-box;
  }

  :global(html) {
    text-size-adjust: 100%;
  }

  :global(body) {
    min-height: 100vh;
    margin: 0;
    color: var(--color-ink);
    background: var(--color-canvas);
    font-family: ui-sans-serif, system-ui, sans-serif;
    line-height: 1.5;
    text-rendering: optimizeLegibility;
  }

  :global(h1),
  :global(h2),
  :global(h3),
  :global(h4),
  :global(p),
  :global(figure),
  :global(blockquote),
  :global(dl),
  :global(dd) {
    margin: 0;
  }

  :global(button),
  :global(input),
  :global(textarea),
  :global(select) {
    font: inherit;
  }

  :global(img),
  :global(picture) {
    display: block;
    max-width: 100%;
  }

  :global(a) {
    text-underline-offset: 0.18em;
  }
</style>
