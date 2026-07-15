<script lang="ts">
  import { getSession } from "$lib/sessions.remote";

  import type { PageProps } from "./$types";

  type Session = Awaited<ReturnType<typeof getSession>>;

  let { params }: PageProps = $props();
  const session = $derived(await getSession(params.id));
  const graph = $derived(layoutGraph(session.graph));
  const number = new Intl.NumberFormat("en");
  const cost = new Intl.NumberFormat("en", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
  const date = new Intl.DateTimeFormat("en", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  });

  function formatTimestamp(timestamp: number | null) {
    return timestamp === null ? "Unknown" : `${date.format(timestamp)} UTC`;
  }

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
  <title>{session.summary.isSubagent ? "Subagent" : "Session"} · {session.summary.projectName} · Aeye</title>
  <meta name="description" content="Local session statistics for {session.summary.projectName}" />
</svelte:head>

<main>
  <a class="back" href="/projects/{session.summary.projectId}">← {session.summary.projectName}</a>

  <header>
    <p class="eyebrow">{session.summary.isSubagent ? "Subagent session" : "Root session"}</p>
    <h1>{session.summary.isSubagent ? "Subagent" : "Session"}</h1>
    <p>
      <time
        datetime={session.summary.startedAt === null
          ? undefined
          : new Date(session.summary.startedAt).toISOString()}
      >
        {formatTimestamp(session.summary.startedAt)}
      </time>
      {#if session.summary.claudeVersion}
        · Claude Code {session.summary.claudeVersion}
      {/if}
    </p>

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
      <h2 id="graph-heading">Event graph</h2>
      <span>
        {number.format(session.graph.totalNodes)} nodes ·
        {number.format(session.graph.totalEdges)} edges
      </span>
    </div>

    {#if graph.nodes.length === 0}
      <p>No events recorded.</p>
    {:else}
      {#if graph.nodes.length < session.graph.totalNodes}
        <p class="graph-note">Showing the latest {number.format(graph.nodes.length)} events.</p>
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

  .headline-metrics,
  .metrics {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(8rem, 1fr));
    gap: 1rem;
    margin-bottom: 0;
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

  dt,
  .section-heading span,
  .graph-note,
  time {
    color: #607067;
    font-size: 0.875rem;
  }

  dd {
    margin-bottom: 0;
    font-size: 1.1rem;
    font-weight: 700;
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
</style>
