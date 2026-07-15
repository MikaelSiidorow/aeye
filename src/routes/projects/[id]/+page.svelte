<script lang="ts">
  import { getProject } from "$lib/projects.remote";

  import type { PageProps } from "./$types";

  let { params }: PageProps = $props();
  const project = $derived(await getProject(params.id));
  const number = new Intl.NumberFormat("en");
  const date = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

  function formatTimestamp(timestamp: number | null) {
    return timestamp === null ? "Unknown" : `${date.format(timestamp)} UTC`;
  }
</script>

<svelte:head>
  <title>{project.name} · Aeye</title>
  <meta name="description" content="Local coding session statistics for {project.name}" />
</svelte:head>

<main>
  <a class="back" href="/">← Projects</a>

  <header>
    <p class="eyebrow">Project</p>
    <h1>{project.name}</h1>
    <p>
      {number.format(project.sessionCount)} sessions ·
      {number.format(project.tokens.total)} active tokens
    </p>

    <dl>
      <div>
        <dt>Root sessions</dt>
        <dd>{number.format(project.rootSessionCount)}</dd>
      </div>
      <div>
        <dt>Subagents</dt>
        <dd>{number.format(project.subagentSessionCount)}</dd>
      </div>
      <div>
        <dt>Tool calls</dt>
        <dd>{number.format(project.toolCalls)}</dd>
      </div>
      <div>
        <dt>Dead-branch tokens</dt>
        <dd>{number.format(project.tokens.deadBranch)}</dd>
      </div>
    </dl>
  </header>

  <section aria-labelledby="sessions-heading">
    <div class="section-heading">
      <h2 id="sessions-heading">Latest sessions</h2>
      {#if project.sessions.length < project.sessionCount}
        <span>Showing {number.format(project.sessions.length)}</span>
      {/if}
    </div>

    {#if project.sessions.length === 0}
      <p>No indexed sessions yet.</p>
    {:else}
      <ul>
        {#each project.sessions as session}
          {@const timestamp = session.endedAt ?? session.startedAt}
          <li>
            <a class="session-link" href="/sessions/{encodeURIComponent(session.id)}">
              <div>
                <strong>{session.isSubagent ? "Subagent" : "Root session"}</strong>
                <time datetime={timestamp === null ? undefined : new Date(timestamp).toISOString()}>
                  {formatTimestamp(timestamp)}
                </time>
              </div>
              <span>
                {number.format(session.tokens)} tokens ·
                {number.format(session.toolCalls)} tools ·
                {number.format(session.userTurns + session.assistantTurns)} turns
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
    width: min(56rem, calc(100% - 2rem));
    margin: 0 auto;
    padding: 2rem 0 4rem;
  }

  .back {
    display: inline-block;
    margin-bottom: 1rem;
    color: #46604f;
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
  p,
  dl,
  dd {
    margin-top: 0;
  }

  h1 {
    margin-bottom: 0.25rem;
    font-size: clamp(2rem, 7vw, 3.5rem);
    letter-spacing: -0.05em;
  }

  h2 {
    margin-bottom: 0;
    font-size: 1rem;
  }

  .eyebrow {
    color: #607067;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  dl {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 1rem;
    margin-bottom: 0;
    padding-top: 1rem;
    border-top: 1px solid #e8ebe7;
  }

  dt,
  .section-heading span,
  time,
  .session-link > span {
    color: #607067;
    font-size: 0.875rem;
  }

  dd {
    margin-bottom: 0;
    font-size: 1.25rem;
    font-weight: 700;
  }

  .section-heading,
  .session-link,
  .session-link div {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  ul {
    display: grid;
    gap: 0.75rem;
    margin: 1rem 0 0;
    padding: 0;
    list-style: none;
  }

  li {
    padding-top: 0.75rem;
    border-top: 1px solid #e8ebe7;
  }

  .session-link {
    color: inherit;
    text-decoration: none;
  }

  .session-link:hover strong {
    text-decoration: underline;
  }

  .session-link div {
    flex-direction: column;
    gap: 0.15rem;
  }

  .session-link > span {
    text-align: right;
  }

  @media (max-width: 34rem) {
    .session-link {
      flex-direction: column;
    }

    .session-link > span {
      text-align: left;
    }
  }
</style>
