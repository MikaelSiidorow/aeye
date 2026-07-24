<script lang="ts">
  import Breadcrumbs from "$lib/components/Breadcrumbs.svelte";
  import LiveStatus from "$lib/components/LiveStatus.svelte";
  import { formatLocalDateTime } from "$lib/date";
  import { getSession, launchSession } from "$lib/sessions.remote";

  import type { PageProps } from "./$types";

  type Session = Awaited<ReturnType<typeof getSession>>;

  let { params }: PageProps = $props();
  let resumeMessage = $state<string | null>(null);
  const sessionQuery = $derived(getSession(params.id));
  const session = $derived(await sessionQuery);
  const graph = $derived(layoutGraph(session.graph));
  const contexts = $derived(groupAnnotations(session.annotations));
  const number = new Intl.NumberFormat("en");
  const cost = new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  function formatDuration(durationMs: number | null) {
    if (durationMs === null) return "n/a";
    if (durationMs < 1_000) return `${number.format(durationMs)} ms`;
    const seconds = Math.round(durationMs / 1_000);
    if (seconds < 60) return `${number.format(seconds)} sec`;
    const minutes = Math.floor(seconds / 60);
    const remainder = seconds % 60;
    if (minutes < 60) return `${number.format(minutes)} min ${number.format(remainder)} sec`;
    const hours = Math.floor(minutes / 60);
    return `${number.format(hours)} hr ${number.format(minutes % 60)} min`;
  }

  function providerLabel(source: "claude" | "codex") {
    return source === "codex" ? "Codex" : "Claude Code";
  }

  function connectionLabel(link: Session["links"][number]) {
    if (link.kind === "review") {
      return link.direction === "outgoing" ? "Reviewed by" : "Review requested by";
    }
    if (link.kind === "transfer") {
      return link.direction === "outgoing" ? "Transferred to" : "Transferred from";
    }
    return link.direction === "outgoing" ? "Delegated to" : "Delegated from";
  }

  function groupAnnotations(input: Session["annotations"]) {
    const grouped = new Map<
      string,
      Session["annotations"][number] & {
        count: number;
      }
    >();
    for (const annotation of input) {
      const key = `${annotation.kind}\0${annotation.value}`;
      const existing = grouped.get(key);
      if (existing === undefined) grouped.set(key, { ...annotation, count: 1 });
      else existing.count++;
    }
    return [...grouped.values()];
  }

  function contextLabel(kind: Session["annotations"][number]["kind"]) {
    if (kind === "skill") return session.summary.isSubagent ? "Agent skill" : "Skill";
    if (kind === "scratchpad") return "Scratchpad";
    if (kind === "worktree") return "Worktree";
    return "Context";
  }

  function contextValue(annotation: (typeof contexts)[number]) {
    if (annotation.kind === "scratchpad") return "Used in this session";
    if (annotation.kind === "worktree") {
      if (annotation.value === "t3") return "T3 worktree";
      if (annotation.value === "claude") return "Claude worktree";
      return "Linked worktree";
    }
    return annotation.value;
  }

  function contextSource(annotation: (typeof contexts)[number]) {
    if (annotation.kind === "skill" && session.summary.isSubagent) {
      return "Declared by delegation metadata";
    }
    if (annotation.kind === "skill") {
      return annotation.count === 1 ? "1 invocation" : `${annotation.count} invocations`;
    }
    if (annotation.kind === "scratchpad") {
      return annotation.count === 1 ? "1 tool call" : `${annotation.count} tool calls`;
    }
    return "Working directory";
  }

  async function copyResumeCommand() {
    if (session.resume === null) return;
    try {
      await navigator.clipboard.writeText(session.resume.command);
      resumeMessage = "Resume command copied.";
    } catch {
      resumeMessage = "The resume command could not be copied.";
    }
  }

  function commandErrorMessage(cause: unknown) {
    if (cause instanceof Error) return cause.message;
    if (cause !== null && typeof cause === "object" && "body" in cause) {
      const body = cause.body;
      if (
        body !== null &&
        typeof body === "object" &&
        "message" in body &&
        typeof body.message === "string"
      ) {
        return body.message;
      }
    }
    return "The terminal could not be opened.";
  }

  async function openResumeSession() {
    resumeMessage = null;
    try {
      const result = await launchSession(params.id);
      resumeMessage = `Opened in ${result.terminal}.`;
    } catch (cause) {
      resumeMessage = commandErrorMessage(cause);
    }
  }

  function layoutGraph(input: Session["graph"]) {
    const childrenBySource = new Map<number, number[]>();
    const parentByTarget = new Map<number, number>();
    for (const edge of input.edges) {
      const children = childrenBySource.get(edge.sourceEventId) ?? [];
      children.push(edge.targetEventId);
      childrenBySource.set(edge.sourceEventId, children);
      parentByTarget.set(edge.targetEventId, edge.sourceEventId);
    }

    const laneById = new Map<number, number>();
    let nextLane = 0;
    const nodes = input.nodes.map((node, index) => {
      const parentId = parentByTarget.get(node.eventId);
      const parentLane = parentId === undefined ? undefined : laneById.get(parentId);
      let lane: number;
      if (parentId !== undefined && parentLane !== undefined) {
        const siblings = childrenBySource.get(parentId) ?? [];
        lane = siblings[0] === node.eventId ? parentLane : nextLane++;
      } else {
        lane = nextLane++;
      }
      laneById.set(node.eventId, lane);
      return { ...node, x: 24 + index * 24, y: 24 + lane * 34 };
    });

    const nodesById = new Map(nodes.map((node) => [node.eventId, node]));
    const edges = input.edges.flatMap((edge) => {
      const source = nodesById.get(edge.sourceEventId);
      const target = nodesById.get(edge.targetEventId);
      return source && target ? [{ source, target }] : [];
    });

    return {
      nodes,
      edges,
      width: Math.max(640, nodes.length * 24 + 48),
      height: Math.max(88, nextLane * 34 + 48),
    };
  }
</script>

<svelte:head>
  <title>{session.summary.displayName} · {session.summary.projectName} · Aeye</title>
  <meta name="description" content="Local session statistics for {session.summary.projectName}" />
</svelte:head>

<main>
  <Breadcrumbs
    items={[
      { label: "Projects", href: "/" },
      { label: session.summary.projectName, href: `/projects/${session.summary.projectId}` },
      ...(session.parent === null
        ? []
        : [
            {
              label: session.parent.displayName,
              href: `/sessions/${encodeURIComponent(session.parent.id)}`,
            },
          ]),
      { label: session.summary.displayName },
    ]}
  />

  <header>
    <div class="header-top">
      <div>
        <div class="eyebrow-row">
          <p class="eyebrow">
            {session.summary.isSubagent ? "Subagent session" : "Root session"}
          </p>
          <LiveStatus
            connected={sessionQuery.connected}
            loading={sessionQuery.loading}
            reconnect={() => sessionQuery.reconnect()}
          />
        </div>
        <h1>{session.summary.displayName}</h1>
        <p>
          <time
            datetime={session.summary.startedAt === null
              ? undefined
              : new Date(session.summary.startedAt).toISOString()}
          >
            {formatLocalDateTime(session.summary.startedAt)}
          </time>
          {#if session.summary.source === "codex"}
            · Codex {session.summary.clientVersion ?? ""}
            {#if session.summary.clientName && session.summary.clientName !== "codex-tui"}
              · via {session.summary.clientName}
            {/if}
          {:else if session.summary.clientVersion ?? session.summary.claudeVersion}
            · Claude Code {session.summary.clientVersion ?? session.summary.claudeVersion}
          {/if}
        </p>
      </div>

      {#if session.resume !== null}
        <div class="resume-panel">
          <div class="resume-actions">
            <button
              type="button"
              class="resume-primary"
              disabled={!session.resume.canLaunch || launchSession.pending > 0}
              title={session.resume.unavailableReason ?? undefined}
              onclick={openResumeSession}
            >
              {launchSession.pending > 0 ? "Opening…" : session.resume.label}
            </button>
            <button type="button" onclick={copyResumeCommand}>Copy command</button>
          </div>
          <p class="resume-status" aria-live="polite">
            {resumeMessage ??
              (session.resume.canLaunch
                ? `Opens in ${session.resume.terminal}.`
                : session.resume.unavailableReason)}
          </p>
        </div>
      {/if}
    </div>

    <dl class="headline-metrics">
      <div>
        <dt>Active tokens</dt>
        <dd>{number.format(session.summary.tokens.total)}</dd>
      </div>
      <div>
        <dt>Turns</dt>
        <dd>{number.format(session.summary.userTurns + session.summary.assistantTurns)}</dd>
      </div>
      <div>
        <dt>Tool calls</dt>
        <dd>{number.format(session.summary.toolCalls)}</dd>
      </div>
      <div>
        <dt>Duration</dt>
        <dd>{formatDuration(session.summary.durationMs)}</dd>
      </div>
    </dl>
  </header>

  {#if contexts.length > 0}
    <section class="context" aria-labelledby="context-heading">
      <h2 id="context-heading">Execution context</h2>
      <ul>
        {#each contexts as annotation (`${annotation.kind}:${annotation.value}`)}
          <li>
            <span class="context-kind">{contextLabel(annotation.kind)}</span>
            <strong>{contextValue(annotation)}</strong>
            <span class="context-source">{contextSource(annotation)}</span>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  {#if session.links.length > 0}
    <section class="connections" aria-labelledby="connections-heading">
      <h2 id="connections-heading">Connections</h2>
      <ul>
        {#each session.links as link (link.id)}
          <li>
            <a href={`/sessions/${encodeURIComponent(link.related.id)}`}>
              <span class="connection-copy">
                <span class="connection-relation">{connectionLabel(link)}</span>
                <strong>{link.related.displayName}</strong>
                <span class="connection-meta">
                  {providerLabel(link.related.source)} · {link.related.projectName} ·
                  {formatLocalDateTime(link.related.startedAt)}
                </span>
              </span>
              <span class="connection-arrow" aria-hidden="true">→</span>
            </a>
          </li>
        {/each}
      </ul>
    </section>
  {/if}

  <section aria-labelledby="tokens-heading">
    <div class="section-heading">
      <h2 id="tokens-heading">Tokens</h2>
      <span>{cost.format(session.summary.costUsd)}</span>
    </div>
    <dl class="metrics">
      <div>
        <dt>Input</dt>
        <dd>{number.format(session.summary.tokens.input)}</dd>
      </div>
      <div>
        <dt>Output</dt>
        <dd>{number.format(session.summary.tokens.output)}</dd>
      </div>
      <div>
        <dt>Cache read</dt>
        <dd>{number.format(session.summary.tokens.cacheRead)}</dd>
      </div>
      <div>
        <dt>Cache write</dt>
        <dd>{number.format(session.summary.tokens.cacheWrite)}</dd>
      </div>
      <div>
        <dt>Dead branch</dt>
        <dd>{number.format(session.summary.tokens.deadBranch)}</dd>
      </div>
    </dl>
  </section>

  <section aria-labelledby="models-heading">
    <h2 id="models-heading">Models</h2>
    {#if session.models.length === 0}
      <p>No model usage recorded.</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Tokens</th>
              <th scope="col">Input</th>
              <th scope="col">Output</th>
              <th scope="col">Cache read</th>
              <th scope="col">Cache write</th>
            </tr>
          </thead>
          <tbody>
            {#each session.models as model}
              <tr>
                <th scope="row">{model.model}</th>
                <td>{number.format(model.tokens.total)}</td>
                <td>{number.format(model.tokens.input)}</td>
                <td>{number.format(model.tokens.output)}</td>
                <td>{number.format(model.tokens.cacheRead)}</td>
                <td>{number.format(model.tokens.cacheWrite)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section aria-labelledby="tools-heading">
    <h2 id="tools-heading">Tools</h2>
    {#if session.tools.length === 0}
      <p>No tool calls recorded.</p>
    {:else}
      <div class="table-scroll">
        <table>
          <thead>
            <tr>
              <th scope="col">Tool</th>
              <th scope="col">Calls</th>
              <th scope="col">Completed</th>
              <th scope="col">Errors</th>
              <th scope="col">Interrupted</th>
              <th scope="col">p50</th>
              <th scope="col">p95</th>
            </tr>
          </thead>
          <tbody>
            {#each session.tools as tool}
              <tr>
                <th scope="row">{tool.name}</th>
                <td>{number.format(tool.calls)}</td>
                <td>{number.format(tool.completed)}</td>
                <td>{number.format(tool.errors)}</td>
                <td>{number.format(tool.interrupted)}</td>
                <td>{formatDuration(tool.p50DurationMs)}</td>
                <td>{formatDuration(tool.p95DurationMs)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  </section>

  <section aria-labelledby="graph-heading">
    <div class="section-heading">
      <h2 id="graph-heading">Conversation graph</h2>
      <span>
        {number.format(session.graph.totalNodes)} nodes ·
        {number.format(session.graph.totalEdges)} edges
      </span>
    </div>

    {#if graph.nodes.length === 0}
      <p>No conversation events recorded.</p>
    {:else}
      {#if graph.nodes.length < session.graph.totalNodes}
        <p class="graph-note">
          Showing the latest {number.format(graph.nodes.length)} conversation events.
        </p>
      {/if}
      {#if session.graph.auxiliaryEvents > 0}
        <p class="graph-note">
          {number.format(session.graph.auxiliaryEvents)} auxiliary events are omitted from the DAG.
        </p>
      {/if}
      <div class="graph-scroll">
        <svg
          viewBox={`0 0 ${graph.width} ${graph.height}`}
          width={graph.width}
          height={graph.height}
          role="img"
          aria-label="Session event graph"
        >
          {#each graph.edges as edge}
            <line
              x1={edge.source.x}
              y1={edge.source.y}
              x2={edge.target.x}
              y2={edge.target.y}
              class:dead={edge.target.isDeadBranch}
              class:sidechain={edge.target.isSidechain}
            />
          {/each}
          {#each graph.nodes as node}
            <circle
              cx={node.x}
              cy={node.y}
              r="5"
              class:dead={node.isDeadBranch}
              class:sidechain={node.isSidechain}
              class:meta={node.isMeta}
              class:interrupt={node.isInterrupt}
              class:duplicate={node.isUsageDuplicate}
            >
              <title>
                Event {node.seq}: {node.kind}, {number.format(node.totalTokens)} tokens{node.model
                  ? `, ${node.model}`
                  : ""}
              </title>
            </circle>
          {/each}
        </svg>
      </div>
      <ul class="legend" aria-label="Event graph legend">
        <li><span class="active"></span>Active</li>
        <li><span class="sidechain"></span>Sidechain</li>
        <li><span class="dead"></span>Dead branch</li>
        <li><span class="meta"></span>Meta</li>
        <li><span class="interrupt"></span>Interrupt</li>
      </ul>
    {/if}
  </section>
</main>

<style>
  main {
    width: min(68rem, calc(100% - 2rem));
    margin: 0 auto;
    padding: 2rem 0 4rem;
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
    margin: 0;
  }

  h1 {
    margin-bottom: 0.25rem;
    font-size: clamp(2rem, 7vw, 3.5rem);
    letter-spacing: -0.05em;
    overflow-wrap: anywhere;
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
    gap: 0.75rem;
  }

  .header-top {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1.5rem;
  }

  .resume-panel {
    flex: none;
    padding-top: 0.25rem;
    text-align: right;
  }

  .resume-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }

  .resume-actions button {
    padding: 0.6rem 0.85rem;
    border: 1px solid #bac4bd;
    border-radius: 0.45rem;
    background: #fff;
    color: #263229;
    font: inherit;
    font-size: 0.875rem;
    font-weight: 700;
    cursor: pointer;
  }

  .resume-actions button:hover:not(:disabled) {
    border-color: #73847a;
    background: #f7f8f6;
  }

  .resume-actions .resume-primary {
    border-color: #334d3c;
    background: #334d3c;
    color: #fff;
  }

  .resume-actions .resume-primary:hover:not(:disabled) {
    border-color: #263b2e;
    background: #263b2e;
  }

  .resume-actions button:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }

  .resume-status {
    max-width: 22rem;
    margin-top: 0.45rem;
    color: #607067;
    font-size: 0.75rem;
  }

  .headline-metrics,
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 1rem;
    margin-bottom: 0;
  }

  .headline-metrics > div,
  .metrics > div {
    min-width: 0;
  }

  .headline-metrics {
    padding-top: 1rem;
    border-top: 1px solid #e8ebe7;
  }

  .section-heading {
    display: flex;
    justify-content: space-between;
    gap: 1rem;
  }

  .section-heading h2 {
    margin-bottom: 1rem;
  }

  .connections ul {
    display: grid;
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .context ul {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr));
    gap: 0.75rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .context li {
    min-width: 0;
    padding-left: 0.75rem;
    border-left: 3px solid #8c9c91;
  }

  .context-kind,
  .context-source,
  .context strong {
    display: block;
  }

  .context-kind {
    color: #607067;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .context strong {
    margin-top: 0.15rem;
    overflow-wrap: anywhere;
    font-size: 1rem;
  }

  .context-source {
    margin-top: 0.15rem;
    color: #607067;
    font-size: 0.75rem;
  }

  .connections a {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    padding: 1rem;
    border: 1px solid #e1e6e0;
    border-radius: 0.5rem;
    color: #202923;
    text-decoration: none;
  }

  .connections a:hover {
    border-color: #8c9c91;
    background: #f7f8f6;
  }

  .connection-copy,
  .connection-copy strong,
  .connection-meta {
    display: block;
  }

  .connection-relation {
    color: #607067;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .connection-copy strong {
    margin-top: 0.15rem;
    font-size: 1.1rem;
  }

  .connection-meta {
    margin-top: 0.2rem;
    color: #607067;
    font-size: 0.875rem;
  }

  .connection-arrow {
    color: #46604f;
    font-size: 1.25rem;
  }

  dt,
  .section-heading span,
  .graph-note,
  time {
    color: #607067;
    font-size: 0.875rem;
  }

  dd {
    font-size: 1.1rem;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .table-scroll,
  .graph-scroll {
    overflow-x: auto;
  }

  table {
    width: 100%;
    border-collapse: collapse;
    font-variant-numeric: tabular-nums;
  }

  th,
  td {
    padding: 0.65rem 0.75rem;
    border-top: 1px solid #e8ebe7;
    text-align: right;
    white-space: nowrap;
  }

  th:first-child,
  td:first-child {
    padding-left: 0;
    text-align: left;
  }

  th:last-child,
  td:last-child {
    padding-right: 0;
  }

  thead th {
    color: #607067;
    font-size: 0.75rem;
  }

  tbody th {
    font-size: 0.875rem;
  }

  .graph-note {
    margin-bottom: 0.75rem;
  }

  svg {
    display: block;
    border-radius: 0.5rem;
    background: #f7f8f6;
  }

  line {
    stroke: #b7c2ba;
    stroke-width: 2;
  }

  line.sidechain {
    stroke: #7b79a8;
  }

  line.dead {
    stroke: #c28b80;
  }

  circle {
    fill: #46604f;
    stroke: #fff;
    stroke-width: 2;
  }

  circle.sidechain,
  .legend .sidechain {
    fill: #66639a;
    background: #66639a;
  }

  circle.dead,
  .legend .dead {
    fill: #ad5546;
    background: #ad5546;
  }

  circle.meta,
  .legend .meta {
    fill: #8a918c;
    background: #8a918c;
  }

  circle.interrupt,
  .legend .interrupt {
    fill: #202923;
    background: #202923;
  }

  circle.duplicate {
    stroke: #e1a62b;
    stroke-width: 3;
  }

  .legend {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 1rem;
    margin: 1rem 0 0;
    padding: 0;
    color: #607067;
    font-size: 0.75rem;
    list-style: none;
  }

  .legend li {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .legend span {
    width: 0.65rem;
    height: 0.65rem;
    border-radius: 50%;
  }

  .legend .active {
    background: #46604f;
  }

  @media (max-width: 42rem) {
    .header-top {
      display: block;
    }

    .resume-panel {
      margin-top: 1rem;
      text-align: left;
    }

    .resume-actions {
      justify-content: flex-start;
    }
  }
</style>
