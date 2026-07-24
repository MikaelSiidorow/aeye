<script lang="ts">
  import Breadcrumbs from "$lib/components/Breadcrumbs.svelte";
  import LiveStatus from "$lib/components/LiveStatus.svelte";
  import { formatLocalDateTime } from "$lib/date";
  import { getProject } from "$lib/projects.remote";
  import { buildSessionGroups } from "$lib/session-hierarchy";

  import type { PageProps } from "./$types";

  type Project = Awaited<ReturnType<typeof getProject>>;
  type ProjectSession = Project["sessions"][number];

  let { params }: PageProps = $props();
  const projectQuery = $derived(getProject(params.id));
  const project = $derived(await projectQuery);
  const hierarchy = $derived(buildSessionGroups(project.sessions));
  const number = new Intl.NumberFormat("en");

  function relationshipLabel(session: ProjectSession) {
    if (session.relationship === "delegate") return "Delegated";
    if (session.relationship === "review") return "Review";
    if (session.relationship === "transfer") return "Transfer";
    return session.isSubagent ? "Subagent" : "Child";
  }

  function isLinkedSession(session: ProjectSession) {
    return session.relationship !== null && session.relationship !== "native";
  }

  function sourceLabel(session: ProjectSession) {
    return session.source === "claude" ? "Claude" : "Codex";
  }

  function activityTimestamp(session: ProjectSession) {
    return session.endedAt ?? session.startedAt;
  }

  function sessionHref(session: ProjectSession) {
    return `/sessions/${encodeURIComponent(session.id)}`;
  }

  function turns(session: ProjectSession) {
    return session.userTurns + session.assistantTurns;
  }
</script>

<svelte:head>
  <title>{project.name} · Aeye</title>
  <meta name="description" content="Local coding session statistics for {project.name}" />
</svelte:head>

<main>
  <Breadcrumbs items={[{ label: "Projects", href: "/" }, { label: project.name }]} />

  <header class="project-header">
    <div class="eyebrow-row">
      <p class="eyebrow">Project overview</p>
      <LiveStatus
        connected={projectQuery.connected}
        loading={projectQuery.loading}
        reconnect={() => projectQuery.reconnect()}
      />
    </div>
    <h1>{project.name}</h1>
    <p class="project-summary">
      {number.format(project.sessionCount)} indexed sessions across
      {number.format(project.topLevelSessionCount)} top-level
      {project.topLevelSessionCount === 1 ? "session" : "sessions"}
    </p>

    <dl class="project-metrics">
      <div class="primary-metric">
        <dt>Active tokens</dt>
        <dd>{number.format(project.tokens.total)}</dd>
      </div>
      <div>
        <dt>Tool calls</dt>
        <dd>{number.format(project.toolCalls)}</dd>
      </div>
      <div>
        <dt>Top-level sessions</dt>
        <dd>{number.format(project.topLevelSessionCount)}</dd>
      </div>
      <div>
        <dt>Nested sessions</dt>
        <dd>{number.format(project.nestedSessionCount)}</dd>
      </div>
    </dl>

    <p class:has-dead-branches={project.tokens.deadBranch > 0} class="branch-status">
      <span aria-hidden="true"></span>
      {project.tokens.deadBranch === 0
        ? "No tokens on abandoned branches"
        : `${number.format(project.tokens.deadBranch)} tokens on abandoned branches`}
    </p>
  </header>

  <section class="sessions-panel" aria-labelledby="sessions-heading">
    <div class="section-heading">
      <div>
        <p class="eyebrow">Activity</p>
        <h2 id="sessions-heading">Session tree</h2>
      </div>
      <p>
        {number.format(project.topLevelSessionCount)} top-level ·
        {number.format(project.nestedSessionCount)} nested
      </p>
    </div>

    {#if project.sessions.length === 0}
      <p class="empty-state">No indexed sessions yet.</p>
    {:else}
      <ol class="session-groups">
        {#each hierarchy.groups as group}
          {@const rootTimestamp = activityTimestamp(group.root)}
          <li class="session-group">
            <a class="session-row root-row" href={sessionHref(group.root)}>
              <div class="session-identity">
                <div class="session-title">
                  <span class="badge root-badge">Root</span>
                  <strong>{group.root.displayName}</strong>
                  <span class="session-source">{sourceLabel(group.root)}</span>
                </div>
                <time
                  datetime={rootTimestamp === null
                    ? undefined
                    : new Date(rootTimestamp).toISOString()}
                >
                  Last activity {formatLocalDateTime(rootTimestamp)}
                </time>
              </div>
              <div class="row-end">
                <div class="session-metrics" aria-label="Root session statistics">
                  <span><strong>{number.format(group.root.tokens)}</strong> tokens</span>
                  <span><strong>{number.format(group.root.toolCalls)}</strong> tools</span>
                  <span><strong>{number.format(turns(group.root))}</strong> turns</span>
                </div>
                <span class="arrow" aria-hidden="true">→</span>
              </div>
            </a>

            {#if group.descendants.length > 0}
              <div class="connection-branch">
                <div class="branch-heading">
                  <strong>
                    {number.format(group.descendants.length)} connected
                    {group.descendants.length === 1 ? "session" : "sessions"}
                  </strong>
                  <span>Subagents and linked sessions</span>
                </div>
                <ol class="connection-list">
                  {#each group.descendants as entry}
                    {@const child = entry.session}
                    {@const childTimestamp = activityTimestamp(child)}
                    <li
                      class="tree-entry"
                      class:linked-entry={isLinkedSession(child)}
                      style={`--tree-depth: ${entry.depth}`}
                    >
                      <a class="session-row child-row" href={sessionHref(child)}>
                        <div class="session-identity">
                          <div class="session-title">
                            <span
                              class="badge"
                              class:linked-badge={isLinkedSession(child)}
                              class:subagent-badge={!isLinkedSession(child)}
                            >
                              {relationshipLabel(child)}
                            </span>
                            <strong>{child.displayName}</strong>
                            <span class="session-source">{sourceLabel(child)}</span>
                          </div>
                          <time
                            datetime={childTimestamp === null
                              ? undefined
                              : new Date(childTimestamp).toISOString()}
                          >
                            Last activity {formatLocalDateTime(childTimestamp)}
                          </time>
                        </div>
                        <div class="row-end">
                          <div
                            class="session-metrics"
                            aria-label={`${relationshipLabel(child)} session statistics`}
                          >
                            <span><strong>{number.format(child.tokens)}</strong> tokens</span>
                            <span><strong>{number.format(child.toolCalls)}</strong> tools</span>
                            <span><strong>{number.format(turns(child))}</strong> turns</span>
                          </div>
                          <span class="arrow" aria-hidden="true">→</span>
                        </div>
                      </a>
                    </li>
                  {/each}
                </ol>
              </div>
            {/if}
          </li>
        {/each}

        {#if hierarchy.unresolved.length > 0}
          <li class="session-group orphan-group">
            <div class="connection-branch">
              <div class="branch-heading">
                <strong>Other connected sessions</strong>
                <span>Their parent sessions are outside this result window</span>
              </div>
              <ol class="connection-list">
                {#each hierarchy.unresolved as entry}
                  {@const child = entry.session}
                  {@const childTimestamp = activityTimestamp(child)}
                  <li
                    class="tree-entry"
                    class:linked-entry={isLinkedSession(child)}
                    style={`--tree-depth: ${entry.depth}`}
                  >
                    <a class="session-row child-row" href={sessionHref(child)}>
                      <div class="session-identity">
                        <div class="session-title">
                          <span
                            class="badge"
                            class:linked-badge={isLinkedSession(child)}
                            class:subagent-badge={!isLinkedSession(child)}
                          >
                            {relationshipLabel(child)}
                          </span>
                          <strong>{child.displayName}</strong>
                          <span class="session-source">{sourceLabel(child)}</span>
                        </div>
                        <time
                          datetime={childTimestamp === null
                            ? undefined
                            : new Date(childTimestamp).toISOString()}
                        >
                          Last activity {formatLocalDateTime(childTimestamp)}
                        </time>
                      </div>
                      <div class="row-end">
                        <div
                          class="session-metrics"
                          aria-label={`${relationshipLabel(child)} session statistics`}
                        >
                          <span><strong>{number.format(child.tokens)}</strong> tokens</span>
                          <span><strong>{number.format(child.toolCalls)}</strong> tools</span>
                          <span><strong>{number.format(turns(child))}</strong> turns</span>
                        </div>
                        <span class="arrow" aria-hidden="true">→</span>
                      </div>
                    </a>
                  </li>
                {/each}
              </ol>
            </div>
          </li>
        {/if}
      </ol>

      {#if project.sessions.length < project.sessionCount}
        <p class="result-note">
          Showing the latest {number.format(project.sessions.length)} of
          {number.format(project.sessionCount)} sessions.
        </p>
      {/if}
    {/if}
  </section>
</main>

<style>
  main {
    width: min(60rem, calc(100% - 2rem));
    margin: 0 auto;
    padding: clamp(1.5rem, 4vw, 3rem) 0 5rem;
  }

  .project-header,
  .sessions-panel {
    border: 1px solid var(--color-line);
    border-radius: var(--radius-medium);
    background: var(--color-surface);
    box-shadow: var(--shadow-card);
  }

  .project-header {
    padding: clamp(1.5rem, 4vw, 2.5rem);
  }

  .sessions-panel {
    margin-top: 1.25rem;
    padding: clamp(1.25rem, 3vw, 2rem);
  }

  h1,
  h2,
  p,
  dl,
  dd {
    margin: 0;
  }

  h1 {
    margin-top: 0.35rem;
    font-size: clamp(2.35rem, 7vw, 4rem);
    line-height: 0.98;
    letter-spacing: -0.055em;
    overflow-wrap: anywhere;
  }

  h2 {
    margin-top: 0.2rem;
    font-size: clamp(1.35rem, 3vw, 1.75rem);
    line-height: 1.2;
    letter-spacing: -0.025em;
  }

  .eyebrow {
    color: var(--color-muted);
    font-size: 0.7rem;
    font-weight: 750;
    letter-spacing: 0.11em;
    text-transform: uppercase;
  }

  .eyebrow-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .project-summary {
    margin-top: 0.85rem;
    color: var(--color-muted);
    font-size: 1rem;
  }

  .project-metrics {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 0.75rem;
    margin-top: 2rem;
  }

  .project-metrics > div {
    min-width: 0;
    padding: 0.95rem 1rem;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-small);
    background: var(--color-surface-subtle);
  }

  .project-metrics .primary-metric {
    border-color: #cbd9ce;
    background: var(--color-accent-soft);
  }

  dt {
    color: var(--color-muted);
    font-size: 0.75rem;
    font-weight: 650;
  }

  dd {
    margin-top: 0.3rem;
    font-size: clamp(1.15rem, 2.5vw, 1.4rem);
    font-weight: 750;
    font-variant-numeric: tabular-nums;
    line-height: 1.15;
  }

  .branch-status {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    margin-top: 1rem;
    color: var(--color-muted);
    font-size: 0.8rem;
  }

  .branch-status span {
    width: 0.45rem;
    height: 0.45rem;
    border-radius: 50%;
    background: #5d896a;
  }

  .branch-status.has-dead-branches span {
    background: #ad5546;
  }

  .section-heading {
    display: flex;
    align-items: end;
    justify-content: space-between;
    gap: 1rem;
    padding-bottom: 1.25rem;
    border-bottom: 1px solid var(--color-line);
  }

  .section-heading > p,
  .result-note,
  .empty-state {
    color: var(--color-muted);
    font-size: 0.85rem;
  }

  .session-groups,
  .connection-list {
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .session-groups {
    display: grid;
    gap: 1rem;
    margin-top: 1.25rem;
  }

  .session-group {
    overflow: hidden;
    border: 1px solid var(--color-line-strong);
    border-radius: 0.7rem;
    background: var(--color-surface);
  }

  .session-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1.5rem;
    color: inherit;
    text-decoration: none;
    transition: background-color 120ms ease;
  }

  .session-row:hover {
    background: var(--color-accent-soft);
  }

  .session-row:focus-visible {
    outline: 2px solid var(--color-accent);
    outline-offset: -2px;
  }

  .root-row {
    padding: 1.15rem 1.25rem;
  }

  .session-identity {
    min-width: 0;
  }

  .session-title,
  .row-end,
  .session-metrics,
  .branch-heading {
    display: flex;
    align-items: center;
  }

  .session-title {
    gap: 0.6rem;
    flex-wrap: wrap;
  }

  .session-title strong {
    font-size: 0.95rem;
  }

  .badge {
    flex: 0 0 auto;
    padding: 0.18rem 0.45rem;
    border-radius: 999px;
    font-size: 0.65rem;
    font-weight: 750;
    letter-spacing: 0.06em;
    line-height: 1.4;
    text-transform: uppercase;
  }

  .root-badge {
    color: #fff;
    background: var(--color-accent);
  }

  .subagent-badge {
    color: #4f5f55;
    background: #e3e9e4;
  }

  .linked-badge {
    color: #755a21;
    background: #f4e8c9;
  }

  .session-source {
    color: var(--color-muted);
    font-size: 0.7rem;
    font-weight: 650;
  }

  time {
    display: block;
    margin-top: 0.35rem;
    color: var(--color-muted);
    font-size: 0.78rem;
  }

  .row-end {
    flex: 0 0 auto;
    gap: 1rem;
  }

  .session-metrics {
    justify-content: end;
    gap: 0.8rem;
    color: var(--color-muted);
    font-size: 0.75rem;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .session-metrics strong {
    color: var(--color-ink);
    font-weight: 700;
  }

  .arrow {
    display: grid;
    width: 1.75rem;
    height: 1.75rem;
    place-items: center;
    border: 1px solid var(--color-line);
    border-radius: 50%;
    color: var(--color-accent);
  }

  .connection-branch {
    padding: 1rem 1.25rem 1.15rem;
    border-top: 1px solid var(--color-line);
    background: var(--color-surface-subtle);
  }

  .branch-heading {
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.45rem;
    padding-left: 1.25rem;
  }

  .branch-heading strong {
    color: var(--color-accent);
    font-size: 0.78rem;
  }

  .branch-heading span {
    color: var(--color-muted);
    font-size: 0.72rem;
  }

  .connection-list {
    border-left: 2px solid #cbd8ce;
  }

  .connection-list li {
    position: relative;
  }

  .connection-list li::before {
    position: absolute;
    top: 1.45rem;
    left: 0;
    width: 0.85rem;
    border-top: 2px solid #cbd8ce;
    content: "";
  }

  .connection-list li + li {
    border-top: 1px solid var(--color-line);
  }

  .tree-entry {
    margin-left: calc((var(--tree-depth) - 1) * 1.25rem);
  }

  .tree-entry.linked-entry::before {
    border-color: #d7bd7d;
  }

  .child-row {
    padding: 0.8rem 0.5rem 0.8rem 1.25rem;
  }

  .child-row .session-title strong {
    font-size: 0.85rem;
  }

  .child-row .session-metrics {
    font-size: 0.72rem;
  }

  .orphan-group .connection-branch {
    border-top: 0;
  }

  .result-note,
  .empty-state {
    margin-top: 1.25rem;
  }

  @media (max-width: 46rem) {
    .project-metrics {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .session-row {
      align-items: stretch;
      flex-direction: column;
      gap: 0.8rem;
    }

    .row-end {
      justify-content: space-between;
    }

    .session-metrics {
      justify-content: start;
      flex-wrap: wrap;
      white-space: normal;
    }
  }

  @media (max-width: 30rem) {
    main {
      width: min(100% - 1rem, 60rem);
    }

    .project-metrics {
      grid-template-columns: 1fr;
    }

    .section-heading,
    .branch-heading {
      align-items: start;
      flex-direction: column;
      gap: 0.35rem;
    }

    .root-row,
    .connection-branch {
      padding-right: 1rem;
      padding-left: 1rem;
    }

    .branch-heading {
      padding-left: 1rem;
    }
  }
</style>
