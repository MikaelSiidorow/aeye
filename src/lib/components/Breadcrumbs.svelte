<script lang="ts">
  let {
    items,
  }: {
    items: Array<{ label: string; href?: string }>;
  } = $props();
</script>

<nav aria-label="Breadcrumb">
  <ol>
    {#each items as item}
      <li>
        {#if item.href}
          <a href={item.href}>{item.label}</a>
        {:else}
          <span aria-current="page">{item.label}</span>
        {/if}
      </li>
    {/each}
  </ol>
</nav>

<style>
  nav {
    margin-bottom: 1rem;
  }

  ol {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0;
    padding: 0;
    color: var(--color-muted);
    font-size: 0.875rem;
    list-style: none;
  }

  li {
    display: flex;
    align-items: center;
    min-width: 0;
    gap: 0.35rem;
  }

  li + li::before {
    color: var(--color-line-strong);
    content: "/";
  }

  a {
    color: var(--color-accent);
  }

  span {
    max-width: min(28rem, 70vw);
    overflow: hidden;
    color: var(--color-ink);
    font-weight: 650;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
