import assert from "node:assert/strict";
import test from "node:test";

import { buildSessionGroups, type HierarchicalSession } from "./session-hierarchy.ts";

await test("builds nested native and delegated sessions exactly once", () => {
  const sessions = [
    { id: "root", presentationParentId: null, relationship: null },
    { id: "agent", presentationParentId: "root", relationship: "native" },
    { id: "codex", presentationParentId: "agent", relationship: "delegate" },
    { id: "independent", presentationParentId: null, relationship: null },
  ] satisfies HierarchicalSession[];

  const hierarchy = buildSessionGroups(sessions);
  assert.deepEqual(
    hierarchy.groups.map(({ root, descendants }) => ({
      root: root.id,
      descendants: descendants.map(({ session, depth }) => [session.id, depth]),
    })),
    [
      {
        root: "root",
        descendants: [
          ["agent", 1],
          ["codex", 2],
        ],
      },
      { root: "independent", descendants: [] },
    ],
  );
  assert.deepEqual(hierarchy.unresolved, []);

  const visibleIds = hierarchy.groups.flatMap(({ root, descendants }) => [
    root.id,
    ...descendants.map(({ session }) => session.id),
  ]);
  assert.equal(visibleIds.length, sessions.length);
  assert.equal(new Set(visibleIds).size, sessions.length);
});

await test("keeps missing-parent and cyclic sessions in one unresolved list", () => {
  const sessions = [
    { id: "missing", presentationParentId: "outside-window", relationship: "delegate" },
    { id: "cycle-a", presentationParentId: "cycle-b", relationship: "native" },
    { id: "cycle-b", presentationParentId: "cycle-a", relationship: "delegate" },
    { id: "missing", presentationParentId: "outside-window", relationship: "delegate" },
  ] satisfies HierarchicalSession[];

  const hierarchy = buildSessionGroups(sessions);
  assert.deepEqual(hierarchy.groups, []);
  assert.deepEqual(
    hierarchy.unresolved.map(({ session }) => session.id),
    ["missing", "cycle-a", "cycle-b"],
  );
});
