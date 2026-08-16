import { describe, it, expect } from 'vitest';
import { InMemoryLinearApi } from './linear-api-fake';

describe('InMemoryLinearApi native blocked-by write half (ADR-0020)', () => {
  async function twoIssues(): Promise<{ api: InMemoryLinearApi; blocked: string; blocker: string }> {
    const api = new InMemoryLinearApi();
    const blocker = (await api.createIssue({ title: 'blocker', description: '', labels: [] })).identifier;
    const blocked = (await api.createIssue({ title: 'blocked', description: '', labels: [] })).identifier;
    return { api, blocked, blocker };
  }

  it('addBlockedBy records a native relation readable via getBlockedBy', async () => {
    const { api, blocked, blocker } = await twoIssues();
    await api.addBlockedBy(blocked, blocker);
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
    // additive, directional: the blocker itself has no blockers recorded.
    expect(await api.getBlockedBy(blocker)).toEqual([]);
  });

  it('addBlockedBy throws on an unknown blocked OR blocker identifier (models resolveIssue)', async () => {
    const { api, blocked, blocker } = await twoIssues();
    await expect(api.addBlockedBy(blocked, 'EX-999')).rejects.toThrow(/EX-999/);
    await expect(api.addBlockedBy('EX-999', blocker)).rejects.toThrow(/EX-999/);
  });

  it('failRelationWrites forces addBlockedBy to reject (models a rejected issueRelationCreate) and is clearable', async () => {
    const { api, blocked, blocker } = await twoIssues();
    api.failRelationWrites(new Error('relation write boom'));
    await expect(api.addBlockedBy(blocked, blocker)).rejects.toThrow(/boom/);
    expect(await api.getBlockedBy(blocked)).toEqual([]); // nothing landed
    api.failRelationWrites(null);
    await expect(api.addBlockedBy(blocked, blocker)).resolves.toBeUndefined();
    expect(await api.getBlockedBy(blocked)).toEqual([blocker]);
  });
});

// ── Document facet: the fake models a Document's TEAM attachment (ADR-0017
// amendment), so both directions of the scoped listing are ASSERTED here, not
// narrated: an unbound api is team-scoped, a project-bound one is unchanged.
describe('InMemoryLinearApi Document facet — team attachment (ADR-0017 amendment)', () => {
  describe('without a bound project (the team-pool consumer shape)', () => {
    it("createDocument mints a document the api's own team listing returns", async () => {
      const api = new InMemoryLinearApi('EX');
      const { id } = await api.createDocument({ title: 'PRD: thing', content: '# body\n' });
      expect(await api.listDocuments()).toEqual([{ id, title: 'PRD: thing', content: '# body\n' }]);
    });

    it("listDocuments returns ONLY the configured team's documents", async () => {
      const api = new InMemoryLinearApi('EX');
      const mine = (await api.createDocument({ title: 'mine', content: 'a' })).id;
      const sameTeam = api.seedDocument({ title: 'a teammate wrote this', content: 'b', team: 'EX' });
      api.seedDocument({ title: 'another team entirely', content: 'c', team: 'OTHER' });
      api.seedDocument({ title: "some project's doc", content: 'd', project: 'Unrelated Project' });

      const listed = (await api.listDocuments()).map((d) => d.id);
      expect(listed).toEqual([mine, sameTeam]); // and NOT the foreign team's / the project's
    });

    it('getDocument resolves an out-of-scope id — the listing is scoped, the fetch is not', async () => {
      const api = new InMemoryLinearApi('EX');
      const foreign = api.seedDocument({ title: 'another team entirely', content: 'c', team: 'OTHER' });
      expect(await api.listDocuments()).toEqual([]);
      await expect(api.getDocument(foreign)).resolves.toEqual({ id: foreign, title: 'another team entirely', content: 'c' });
    });
  });

  describe('with a bound project (unchanged)', () => {
    it('createDocument attaches to the PROJECT, and the project listing returns it', async () => {
      const api = new InMemoryLinearApi('EX', 'Example Project');
      const { id } = await api.createDocument({ title: 'PRD: thing', content: '# body\n' });
      expect(await api.listDocuments()).toEqual([{ id, title: 'PRD: thing', content: '# body\n' }]);
    });

    it("listDocuments stays project-scoped — a team-attached document of the SAME team is not drawn in", async () => {
      const api = new InMemoryLinearApi('EX', 'Example Project');
      const mine = (await api.createDocument({ title: 'mine', content: 'a' })).id;
      api.seedDocument({ title: 'team-attached, same team', content: 'b', team: 'EX' });
      api.seedDocument({ title: 'another project', content: 'c', project: 'Other Project' });

      expect((await api.listDocuments()).map((d) => d.id)).toEqual([mine]);
    });

    it('a project-bound api and an unbound one over the same team see different scopes', async () => {
      const bound = new InMemoryLinearApi('EX', 'Example Project');
      const unbound = new InMemoryLinearApi('EX');
      await bound.createDocument({ title: 'project doc', content: 'a' });
      await unbound.createDocument({ title: 'team doc', content: 'b' });
      // separate instances hold separate substrates — each sees exactly its own.
      expect((await bound.listDocuments()).map((d) => d.title)).toEqual(['project doc']);
      expect((await unbound.listDocuments()).map((d) => d.title)).toEqual(['team doc']);
    });
  });
});

// ── attachment upsert (issue #511, mechanics proven consumer-side) ─────────
describe('InMemoryLinearApi attachment upsert (issue #511)', () => {
  it('upsertAttachment records a card readable via listUpsertedAttachments', async () => {
    const api = new InMemoryLinearApi();
    const id = (await api.createIssue({ title: 't', description: '', labels: [] })).identifier;
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' });
    expect(api.listUpsertedAttachments(id)).toEqual([
      { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' },
    ]);
  });

  it('a second upsertAttachment call with the SAME url updates the card in place — no duplicate (models Linear\'s own upsert-by-url)', async () => {
    const api = new InMemoryLinearApi();
    const id = (await api.createIssue({ title: 't', description: '', labels: [] })).identifier;
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'open' });
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' });
    expect(api.listUpsertedAttachments(id)).toEqual([
      { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' },
    ]);
  });

  it('upsertAttachment throws on an unknown identifier (models resolveIssue)', async () => {
    const api = new InMemoryLinearApi();
    await expect(
      api.upsertAttachment('EX-999', { url: 'https://x/pr/1', title: 't', subtitle: 's' }),
    ).rejects.toThrow(/EX-999/);
  });

  it('is a substrate SEPARATE from getPrAttachments — an upserted card never appears there', async () => {
    const api = new InMemoryLinearApi();
    const id = (await api.createIssue({ title: 't', description: '', labels: [] })).identifier;
    await api.upsertAttachment(id, { url: 'https://x/pr/1', title: 'PR #1', subtitle: 'merged' });
    expect(await api.getPrAttachments(id)).toEqual([]);
  });
});

describe('InMemoryLinearApi store-preflight substrate (FOR-12)', () => {
  it('hasGitHubIntegration defaults to true and is togglable', async () => {
    const api = new InMemoryLinearApi();
    expect(await api.hasGitHubIntegration()).toBe(true);
    api.setGitHubIntegration(false);
    expect(await api.hasGitHubIntegration()).toBe(false);
    api.setGitHubIntegration(true);
    expect(await api.hasGitHubIntegration()).toBe(true);
  });

  it('listStates exposes the default catalog (including the standard claim ladder)', async () => {
    const names = (await new InMemoryLinearApi().listStates()).map((s) => s.name);
    // The claim-ledger states + unclaim/unplanned targets must all be present.
    expect(names).toEqual(expect.arrayContaining(['Todo', 'In Progress', 'In Review', 'Backlog', 'Canceled']));
  });

  it('listStates reflects a replaced catalog (the fresh-workspace fixture)', async () => {
    const api = new InMemoryLinearApi();
    api.setStateCatalog([
      { name: 'Backlog', type: 'backlog' },
      { name: 'Todo', type: 'unstarted' },
      { name: 'In Progress', type: 'started' },
      { name: 'Done', type: 'completed' },
      { name: 'Canceled', type: 'canceled' },
    ]);
    const names = (await api.listStates()).map((s) => s.name);
    expect(names).not.toContain('In Review'); // the fresh workspace lacks it
    expect(names).toContain('In Progress');
  });
});

describe('InMemoryLinearApi projects (the Goal container substrate, ADR-0044)', () => {
  it('createProject → getProject round-trips', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: '1.0.0', description: 'the freeze' });
    expect(await api.getProject(id)).toEqual({
      id,
      name: '1.0.0',
      description: 'the freeze',
      // A Linear project is BORN bare (ADR-0045 decision 3): the `backlog`
      // category carries no eligibility semantics, which is exactly why minting
      // one as a goal member costs no bare invariant.
      statusType: 'backlog',
    });
  });

  it('project ids are their own space — never a `<TEAM>-<n>` issue identifier', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: 'p', description: '' });
    const { identifier } = await api.createIssue({ title: 'i', description: '', labels: [] });
    expect(id).not.toBe(identifier);
    expect(identifier).toMatch(/^EX-\d+$/);
  });

  it('getProject / listProjectIssues / setIssueProject throw on an unknown project', async () => {
    const api = new InMemoryLinearApi();
    const { identifier } = await api.createIssue({ title: 'i', description: '', labels: [] });
    await expect(api.getProject('nope')).rejects.toThrow(/project not found/i);
    await expect(api.listProjectIssues('nope')).rejects.toThrow(/project not found/i);
    await expect(api.setIssueProject(identifier, 'nope')).rejects.toThrow(/project not found/i);
  });

  it('setIssueProject throws on an unknown issue', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: 'p', description: '' });
    await expect(api.setIssueProject('EX-404', id)).rejects.toThrow(/issue not found/i);
  });

  it('membership is a per-ISSUE pointer, so re-assigning is idempotent and re-pointing MOVES', async () => {
    const api = new InMemoryLinearApi();
    const a = await api.createProject({ name: 'a', description: '' });
    const b = await api.createProject({ name: 'b', description: '' });
    const { identifier } = await api.createIssue({ title: 'i', description: '', labels: [] });

    await api.setIssueProject(identifier, a.id);
    await api.setIssueProject(identifier, a.id); // idempotent
    expect((await api.listProjectIssues(a.id)).map((i) => i.identifier)).toEqual([identifier]);

    await api.setIssueProject(identifier, b.id);
    expect(await api.listProjectIssues(a.id)).toEqual([]);
    expect((await api.listProjectIssues(b.id)).map((i) => i.identifier)).toEqual([identifier]);
  });

  it('listProjectIssues returns members OPEN AND CLOSED — `done` is a frontier reading', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: 'p', description: '' });
    const open = await api.createIssue({ title: 'open', description: '', labels: [] });
    const closed = await api.createIssue({ title: 'closed', description: '', labels: [] });
    await api.setIssueProject(open.identifier, id);
    await api.setIssueProject(closed.identifier, id);
    await api.setState(closed.identifier, 'Done');

    expect((await api.listProjectIssues(id)).map((i) => i.identifier).sort()).toEqual(
      [open.identifier, closed.identifier].sort(),
    );
    // …and listOpenIssues still filters, so the two reads are genuinely different.
    expect((await api.listOpenIssues()).map((i) => i.identifier)).toEqual([open.identifier]);
  });

  it('listProjects returns every project this api minted', async () => {
    const api = new InMemoryLinearApi();
    await api.createProject({ name: 'a', description: '' });
    await api.createProject({ name: 'b', description: '' });
    expect((await api.listProjects()).map((p) => p.name).sort()).toEqual(['a', 'b']);
  });

  it('the curation write moves the issue\'s updatedAt — a write is observably a write', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: 'p', description: '' });
    const { identifier } = await api.createIssue({ title: 'i', description: '', labels: [] });
    const before = (await api.getIssue(identifier)).updatedAt;
    await api.setIssueProject(identifier, id);
    const after = (await api.getIssue(identifier)).updatedAt;
    expect(Date.parse(after as string)).toBeGreaterThan(Date.parse(before as string));
  });
});

describe('InMemoryLinearApi initiatives (the second Goal container substrate, ADR-0045)', () => {
  it('createInitiative → getInitiative round-trips, and the id is its OWN space', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createInitiative({ name: 'Epic', description: 'the span' });
    expect(await api.getInitiative(id)).toEqual({ id, name: 'Epic', description: 'the span' });
    // Not a project id and not an issue identifier — three id spaces, three
    // shapes, so a mixed-up id fails loudly instead of resolving to the wrong
    // object.
    const { id: projectId } = await api.createProject({ name: 'p', description: '' });
    const { identifier } = await api.createIssue({ title: 'i', description: '', labels: [] });
    expect(id).not.toBe(projectId);
    expect(id).not.toBe(identifier);
  });

  it('getInitiative / listInitiativeProjects / addProjectToInitiative throw on an unknown initiative', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: 'p', description: '' });
    await expect(api.getInitiative('nope')).rejects.toThrow(/initiative not found/i);
    await expect(api.listInitiativeProjects('nope')).rejects.toThrow(/initiative not found/i);
    await expect(api.addProjectToInitiative('nope', id)).rejects.toThrow(/initiative not found/i);
  });

  it('addProjectToInitiative throws on an unknown PROJECT too — a member must exist to be joined', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createInitiative({ name: 'Epic', description: '' });
    await expect(api.addProjectToInitiative(id, 'nope')).rejects.toThrow(/project not found/i);
  });

  it('membership is a JOIN SET — the join is idempotent, and a project can sit in two initiatives', async () => {
    // The shape difference from `setIssueProject` that the store has to buy
    // idempotence around: an issue's project is a POINTER (re-pointing moves
    // it), while an initiative's membership is a join entity, so the same
    // project can legitimately belong to two initiatives at once.
    const api = new InMemoryLinearApi();
    const a = (await api.createInitiative({ name: 'A', description: '' })).id;
    const b = (await api.createInitiative({ name: 'B', description: '' })).id;
    const p = (await api.createProject({ name: 'p', description: '' })).id;

    await api.addProjectToInitiative(a, p);
    await api.addProjectToInitiative(a, p); // idempotent
    await api.addProjectToInitiative(b, p);

    expect((await api.listInitiativeProjects(a)).map((x) => x.id)).toEqual([p]);
    expect((await api.listInitiativeProjects(b)).map((x) => x.id)).toEqual([p]);
  });

  it('listInitiatives is WORKSPACE-wide: no team predicate exists to apply', async () => {
    // The substrate half of ADR-0045 decision 5. Two apis on DIFFERENT teams,
    // and the team key changes nothing about what an initiative listing can be
    // scoped by — because an initiative carries no team at all.
    const api = new InMemoryLinearApi('EX');
    const a = (await api.createInitiative({ name: 'Design epic', description: '' })).id;
    const b = (await api.createInitiative({ name: 'Dev epic', description: '' })).id;
    expect((await api.listInitiatives()).map((i) => i.id).sort()).toEqual([a, b].sort());
  });

  it('a member project keeps its own status CATEGORY — the frontier fact substrate', async () => {
    const api = new InMemoryLinearApi();
    const init = (await api.createInitiative({ name: 'Epic', description: '' })).id;
    const p = (await api.createProject({ name: 'story', description: '' })).id;
    await api.addProjectToInitiative(init, p);
    expect((await api.listInitiativeProjects(init))[0].statusType).toBe('backlog');

    api.setProjectStatus(p, 'started');
    expect((await api.listInitiativeProjects(init))[0].statusType).toBe('started');
    expect((await api.getProject(p)).statusType).toBe('started');
  });

  it('project relations: the write is additive and idempotent, and the read is the BLOCKED side', async () => {
    const api = new InMemoryLinearApi();
    const blocked = (await api.createProject({ name: 'B', description: '' })).id;
    const blocker = (await api.createProject({ name: 'A', description: '' })).id;

    expect(await api.getProjectBlockedBy(blocked)).toEqual([]);
    await api.addProjectBlockedBy(blocked, blocker);
    await api.addProjectBlockedBy(blocked, blocker); // additive-only, no duplicate

    expect(await api.getProjectBlockedBy(blocked)).toEqual([blocker]);
    // …and the edge is DIRECTED: the blocker is not itself blocked.
    expect(await api.getProjectBlockedBy(blocker)).toEqual([]);
  });

  it('the fake stores the same WIRE VALUES the real adapter sends — measured live 2026-08-16', async () => {
    // The half this fake did not have, and the reason it stayed green for the
    // whole life of two values a real workspace refuses: it modelled "A blocks
    // B" as an abstract edge and never held `type`/`anchorType` at all, so
    // there was nothing here for a wrong string to disagree with. It holds the
    // wire record now, minted from the same two bindings production sends —
    // and these expectations are LITERALS, matching real-linear-api.spec.ts
    // exactly, so the fake-backed path and the real path fail together.
    const api = new InMemoryLinearApi();
    const blocked = (await api.createProject({ name: 'B', description: '' })).id;
    const blocker = (await api.createProject({ name: 'A', description: '' })).id;
    await api.addProjectBlockedBy(blocked, blocker);

    expect(api.projectRelationInputs()).toEqual([
      {
        projectId: blocker, // the BLOCKER is the source …
        relatedProjectId: blocked, // … the BLOCKED project is the target
        type: 'dependency', // the ONLY value the live enum permits
        anchorType: 'end', // finish-to-start: the blocker's END …
        relatedAnchorType: 'start', // … onto the blocked project's START
      },
    ]);
  });

  it('project-relation uniqueness is per (project pair, TYPE) — not per anchor pair', async () => {
    // The live rule the same probe measured: a second relation between the same
    // two projects is refused with "A dependency of the same type already
    // exists between the two projects", regardless of anchors. That is the
    // granularity the facet's find-before-create idempotence relies on, so the
    // fake models it at that granularity rather than at the edge's.
    const api = new InMemoryLinearApi();
    const blocked = (await api.createProject({ name: 'B', description: '' })).id;
    const blocker = (await api.createProject({ name: 'A', description: '' })).id;

    await api.addProjectBlockedBy(blocked, blocker);
    await api.addProjectBlockedBy(blocked, blocker);
    expect(api.projectRelationInputs()).toHaveLength(1);

    // The REVERSE pair is a different (ordered) relation and is recorded — the
    // uniqueness rule is not "these two projects may only ever touch once".
    await api.addProjectBlockedBy(blocker, blocked);
    expect(api.projectRelationInputs()).toHaveLength(2);
    expect(await api.getProjectBlockedBy(blocker)).toEqual([blocked]);
  });

  it('project relations throw on either unknown side', async () => {
    const api = new InMemoryLinearApi();
    const p = (await api.createProject({ name: 'p', description: '' })).id;
    await expect(api.addProjectBlockedBy('nope', p)).rejects.toThrow(/project not found/i);
    await expect(api.addProjectBlockedBy(p, 'nope')).rejects.toThrow(/project not found/i);
    await expect(api.getProjectBlockedBy('nope')).rejects.toThrow(/project not found/i);
  });

  it('failProjectRelationWrites drives the residue case, and clears again', async () => {
    const api = new InMemoryLinearApi();
    const blocked = (await api.createProject({ name: 'B', description: '' })).id;
    const blocker = (await api.createProject({ name: 'A', description: '' })).id;

    api.failProjectRelationWrites(new Error('projectRelationCreate rejected'));
    await expect(api.addProjectBlockedBy(blocked, blocker)).rejects.toThrow(/rejected/);

    api.failProjectRelationWrites(null);
    await api.addProjectBlockedBy(blocked, blocker);
    expect(await api.getProjectBlockedBy(blocked)).toEqual([blocker]);
  });

  it('forgetProject leaves the relation behind — the unreadable-blocker state the frontier is about', async () => {
    const api = new InMemoryLinearApi();
    const story = (await api.createProject({ name: 'story', description: '' })).id;
    const ghost = (await api.createProject({ name: 'ghost', description: '' })).id;
    await api.addProjectBlockedBy(story, ghost);

    api.forgetProject(ghost);

    // The edge survives its target — which is exactly the state a deleted or
    // unreachable blocker leaves behind, and the one `actionable` must never be
    // able to claim its way out of.
    expect(await api.getProjectBlockedBy(story)).toEqual([ghost]);
    await expect(api.getProject(ghost)).rejects.toThrow(/project not found/i);
  });

  it('seedProject puts a REALISTICALLY-shaped (UUID) project id into the substrate', async () => {
    // `createProject` mints the fake's short `prj-N` form, which cannot exercise
    // the id shape the id-kind predicate will actually meet in production.
    const api = new InMemoryLinearApi();
    const uuid = '550e8400-e29b-41d4-a716-446655440000';
    api.seedProject({ id: uuid, name: 'real-shaped', statusType: 'started' });
    const prj = await api.getProject(uuid);
    expect(prj.id).toBe(uuid);
    expect(prj.statusType).toBe('started');
    expect(prj.description).toBe('');
  });
});

describe('InMemoryLinearApi update surfaces (the mirror-pass substrate, ADR-0046)', () => {
  it('records a project update against the right container and returns an id', async () => {
    const api = new InMemoryLinearApi();
    const { id: projectId } = await api.createProject({ name: 'M3', description: '' });

    const result = await api.createProjectUpdate({ projectId, body: 'the anchor' });

    expect(typeof result.id).toBe('string');
    const [rec] = api.publishedUpdates();
    expect(rec.surface).toBe('project');
    expect(rec.containerId).toBe(projectId);
    expect(rec.body).toBe('the anchor');
  });

  it('records an initiative update on the OTHER surface — the branch is observable', async () => {
    const api = new InMemoryLinearApi();
    const { id: initiativeId } = await api.createInitiative({ name: 'M3', description: '' });

    await api.createInitiativeUpdate({ initiativeId, body: 'the anchor' });

    const [rec] = api.publishedUpdates();
    expect(rec.surface).toBe('initiative');
    expect(rec.containerId).toBe(initiativeId);
  });

  it('an omitted health is stored as an ABSENT KEY, so the prohibition is ASSERTABLE', async () => {
    const api = new InMemoryLinearApi();
    const { id: projectId } = await api.createProject({ name: 'M3', description: '' });

    await api.createProjectUpdate({ projectId, body: 'a', health: 'onTrack' });
    await api.createProjectUpdate({ projectId, body: 'b' });

    const [withHealth, withoutHealth] = api.publishedUpdates();
    expect(withHealth.health).toBe('onTrack');
    // The distinction that matters: `health === undefined` would ALSO pass for a
    // key set to `undefined`, and those are different wire acts. Only `in` can
    // tell them apart, so only `in` can prove nothing defaulted a value in.
    expect('health' in withoutHealth).toBe(false);
  });

  it('an EMPTY-STRING health is stored as an ABSENT KEY too — the fake models what the wire does (#628)', async () => {
    const api = new InMemoryLinearApi();
    const { id: projectId } = await api.createProject({ name: 'M3', description: '' });
    const { id: initiativeId } = await api.createInitiative({ name: 'M3', description: '' });

    // `''` is not a member of the vendor's health enum, so the real transport
    // (`healthIfSupplied`, real-linear-api.ts) sends no key at all. A fake that
    // stored `''` could not SEE that divergence: every spec written against this
    // substrate would pass while production sent something else.
    await api.createProjectUpdate({ projectId, body: 'a', health: '' });
    await api.createInitiativeUpdate({ initiativeId, body: 'b', health: '' });
    // The non-vacuity control: a REAL value is still stored, on both surfaces —
    // this is a gate, not a blanket drop.
    await api.createProjectUpdate({ projectId, body: 'c', health: 'onTrack' });

    const [emptyProject, emptyInitiative, real] = api.publishedUpdates();
    expect('health' in emptyProject).toBe(false);
    expect('health' in emptyInitiative).toBe(false);
    expect(real.health).toBe('onTrack');
  });

  it('refuses to publish against a container that does not exist', async () => {
    const api = new InMemoryLinearApi();
    await expect(api.createProjectUpdate({ projectId: 'nope', body: 'x' })).rejects.toThrow(
      /project not found/i,
    );
    await expect(
      api.createInitiativeUpdate({ initiativeId: 'nope', body: 'x' }),
    ).rejects.toThrow(/initiative not found/i);
  });

  it('setProjectHealth seeds and CLEARS a member health — absence is reachable, not just describable', async () => {
    const api = new InMemoryLinearApi();
    const { id } = await api.createProject({ name: 'M3', description: '' });

    // A freshly minted project has never reported a health — the vendor's
    // documented null, and the state the transport must not paper over.
    expect('health' in (await api.getProject(id))).toBe(false);

    api.setProjectHealth(id, 'offTrack');
    expect((await api.getProject(id)).health).toBe('offTrack');

    // …and back to genuinely absent, not to an empty string.
    api.setProjectHealth(id, null);
    expect('health' in (await api.getProject(id))).toBe(false);
  });
});
