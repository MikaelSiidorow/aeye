<script lang="ts">
  import LiveStatus from "$lib/components/LiveStatus.svelte";
  import { getOverview } from "$lib/overview.remote";

  const overviewQuery = getOverview();
  const data = $derived(await overviewQuery);
  const number = new Intl.NumberFormat();
</script>

<svelte:head>
  <title>Aeye</title>
  <meta name="description" content="Local coding session statistics" />
</svelte:head>

<main>
  <header>
    <div class="eyebrow-row">
      <p class="eyebrow">Local session index</p>
      <LiveStatus
        connected={overviewQuery.connected}
        loading={overviewQuery.loading}
        reconnect={() => overviewQuery.reconnect()}
      />
    </div>
    <h1>Aeye</h1>
    <p>
      {number.format(data.overview.sessionCount)} sessions ·
      {number.format(data.overview.tokens.total)} active tokens
    </p>
  </header>

  <section aria-labelledby="projects-heading">
    <h2 id="projects-heading">Projects</h2>
    {#if data.projects.length === 0}
      <p>No indexed sessions yet.</p>
    {:else}
      <ul>
        {#each data.projects as project}
          <li>
            <a href="/projects/{project.id}">
              <strong>{project.name}</strong>
              <span>
                {number.format(project.sessionCount)} sessions ·
                {number.format(project.tokens)} tokens
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>

<style>
  main {
    width: min(48rem, calc(100% - 2rem));
    margin: 0 auto;
    padding: 4rem 0;
  }

  header,
  section {
    padding: 1.5rem;
    border: 1px solid #d9ded8;
    border-radius: 0.75rem;
    background: #fff;
  }

  section {
    margin-top: 1rem;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 0.25rem;
    font-size: clamp(2.5rem, 8vw, 4rem);
    letter-spacing: -0.06em;
  }

  h2 {
    margin-bottom: 1rem;
    font-size: 1rem;
  }

  .eyebrow {
    color: #607067;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .eyebrow-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  ul {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  li {
    border-top: 1px solid #e8ebe7;
  }

  li a {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
    padding-top: 0.75rem;
    color: inherit;
    text-decoration: none;
  }

  li a:hover strong {
    text-decoration: underline;
  }

  li a span {
    color: #607067;
    text-align: right;
  }
</style>
