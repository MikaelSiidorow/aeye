export type SessionRelationship = "native" | "delegate" | "review" | "transfer" | null;

export interface HierarchicalSession {
  id: string;
  presentationParentId: string | null;
  relationship: SessionRelationship;
}

export interface SessionTreeEntry<Session extends HierarchicalSession> {
  session: Session;
  depth: number;
}

export interface SessionTreeGroup<Session extends HierarchicalSession> {
  root: Session;
  descendants: SessionTreeEntry<Session>[];
}

export function buildSessionGroups<Session extends HierarchicalSession>(input: readonly Session[]) {
  const sessions: Session[] = [];
  const byId = new Map<string, Session>();
  for (const session of input) {
    if (byId.has(session.id)) continue;
    byId.set(session.id, session);
    sessions.push(session);
  }

  const childrenByParent = new Map<string, Session[]>();
  for (const session of sessions) {
    if (
      session.relationship === null ||
      session.presentationParentId === null ||
      session.presentationParentId === session.id ||
      !byId.has(session.presentationParentId)
    ) {
      continue;
    }
    const children = childrenByParent.get(session.presentationParentId) ?? [];
    children.push(session);
    childrenByParent.set(session.presentationParentId, children);
  }

  const seen = new Set<string>();

  function descendantsOf(parent: Session, startingDepth = 1) {
    const descendants: SessionTreeEntry<Session>[] = [];

    function visit(session: Session, depth: number) {
      for (const child of childrenByParent.get(session.id) ?? []) {
        if (seen.has(child.id)) continue;
        seen.add(child.id);
        descendants.push({ session: child, depth });
        visit(child, depth + 1);
      }
    }

    visit(parent, startingDepth);
    return descendants;
  }

  const groups: SessionTreeGroup<Session>[] = [];
  for (const root of sessions) {
    if (root.relationship !== null || seen.has(root.id)) continue;
    seen.add(root.id);
    groups.push({ root, descendants: descendantsOf(root) });
  }

  const unresolved: SessionTreeEntry<Session>[] = [];
  for (const session of sessions) {
    if (seen.has(session.id)) continue;
    seen.add(session.id);
    unresolved.push({ session, depth: 1 });
    unresolved.push(...descendantsOf(session, 2));
  }

  return { groups, unresolved };
}
