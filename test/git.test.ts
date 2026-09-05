import { test } from "bun:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Static } from "@sinclair/typebox";
import { ApprovalRecordSchema, RunRecordSchema, assertSchema, digestJson, type TrustedConfirmation } from "../src/contracts.ts";
import {
  GitPause, captureBaseline, capturePatch, checkIntegration, commitApproved, createOutputBranch,
  integrateChecked, observeCode, prepareCommitGroups, preparePush, pushConfirmed, selectReviewScope,
  type BaselineRecord, type CommitConsent, type CommitPlan, type PatchEvidence, type PushPlan,
} from "../src/git.ts";

if (!process.env.SUPERSHIP_GIT_FIXTURE_ROOT) {
  test("Git operations run against temporary repositories with inherited network denial", () => {
    const root = mkdtempSync(join(tmpdir(), "supership-git-tests-"));
    const launcher = join(root, "deny-network");
    const compilation = spawnSync("gcc", ["-std=c11", "-O2", "-Wall", "-Wextra", "-Werror", "-o", launcher, resolve("test/support/deny-network.c")], { encoding: "utf8" });
    assert.equal(compilation.status, 0, compilation.stderr);
    const home = join(root, "home"); mkdirSync(home);
    const result = spawnSync(launcher, [process.execPath, "test", import.meta.path], {
      encoding: "utf8", timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
      env: { PATH: `${dirname(process.execPath)}:/usr/local/bin:/usr/bin:/bin`, HOME: home, TMPDIR: root,
        XDG_CONFIG_HOME: home, SUPERSHIP_GIT_FIXTURE_ROOT: root, GIT_CONFIG_NOSYSTEM: "1", LC_ALL: "C",
        GIT_AUTHOR_NAME: "Offline Fixture", GIT_AUTHOR_EMAIL: "fixture@invalid", GIT_COMMITTER_NAME: "Offline Fixture", GIT_COMMITTER_EMAIL: "fixture@invalid" },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}\nFixture evidence: ${root}`);
    console.log(result.stdout + result.stderr);
    rmSync(root, { recursive: true, force: true });
  }, 200_000);
} else {
  const root = process.env.SUPERSHIP_GIT_FIXTURE_ROOT;
  const original = Array.from({ length: 90 }, (_, index) => `line-${index + 1}\n`).join("");
  function git(repo: string, args: string[], input?: string | Buffer) {
    const result = spawnSync("git", args, { cwd: repo, input, maxBuffer: 8 * 1024 * 1024 });
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr.toString());
    return result.stdout.toString().trim();
  }
  function fixture() {
    const directory = mkdtempSync(join(root, "case-")); const repo = join(directory, "repo"); mkdirSync(repo);
    git(repo, ["init", "-q", "-b", "main"]);
    writeFileSync(join(repo, "same.txt"), original); writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 128, 255]));
    writeFileSync(join(repo, "script.sh"), "#!/bin/sh\nexit 0\n"); chmodSync(join(repo, "script.sh"), 0o755);
    symlinkSync("same.txt", join(repo, "link"));
    git(repo, ["add", "--", "same.txt", "binary.bin", "script.sh", "link"]); git(repo, ["commit", "-qm", "fixture baseline"]);
    git(repo, ["switch", "-qc", "feature"]);
    return { directory, repo };
  }
  function editLine(repo: string, line: number, value: string) {
    const path = join(repo, "same.txt"); const lines = readFileSync(path, "utf8").split("\n"); lines[line - 1] = value; writeFileSync(path, lines.join("\n"));
  }
  async function worker(repo: string, before: BaselineRecord, mutate: (child: string) => void, workId = "build", paths = ["same.txt"]) {
    const child = join(dirname(repo), `worker-${workId}-${Date.now()}-${Math.random()}`);
    git(repo, ["worktree", "add", "--quiet", "--detach", child, before.identity.head]);
    // Materialize the captured parent baseline, including user bytes, into the isolated fixture.
    for (const entry of before.head) if (!before.worktree.some(current => current.path === entry.path)) rmSync(join(child, entry.path));
    for (const entry of before.worktree) {
      const path = join(child, entry.path); mkdirSync(dirname(path), { recursive: true });
      if (existsSync(path) || entry.image.mode === "120000") rmSync(path, { force: true });
      if (entry.image.mode === "120000") symlinkSync(Buffer.from(entry.image.bytes, "base64").toString(), path);
      else { writeFileSync(path, Buffer.from(entry.image.bytes, "base64")); chmodSync(path, entry.image.mode === "100755" ? 0o755 : 0o644); }
    }
    const captured = await captureBaseline(child); mutate(child);
    return capturePatch(captured, await captureBaseline(child), { kind: "isolated", workId }, paths);
  }
  async function integrated(repo: string, baseline: BaselineRecord, patch: PatchEvidence, prior: PatchEvidence[] = []) {
    return integrateChecked({ repo, ownership: { baseline, patches: prior }, incoming: patch, expected: (await captureBaseline(repo)).identity });
  }
  function approval(scopeHash: string, kind: Static<typeof ApprovalRecordSchema>["kind"] = "safety"): Static<typeof ApprovalRecordSchema> {
    return { id: "approval", kind, decision: "approve", authority: "omp-tui", scopeHash, planRevision: 1, ownerEpoch: 1, toolVersions: [], createdAt: 1, rationale: "Fixture confirmation", evidence: [] };
  }
  function confirmed(plan: CommitPlan): CommitConsent { return { approval: plan.authorization, reviewedPlanHash: plan.approvedPlanHash }; }
  function pushConfirmation(plan: PushPlan): TrustedConfirmation { return { approval: approval(plan.scopeHash, "push"), reviewedPlanHash: plan.scopeHash }; }
  /** A succeeded active-checkout builder: the only source that can own a commit-bound patch. */
  function succeededBuild(id: string, paths: string[]): Static<typeof RunRecordSchema>["work"][number] {
    return { schemaVersion: 1, id, revision: 1, kind: "build", dependencies: [], seatId: "builder", expectedPaths: paths, expectedOutputs: ["build"], verificationCheckIds: [], mutation: "repository", isolation: { kind: "active-checkout" }, toolGrants: [], outputSchema: { name: "build", version: 1 }, instructions: "write " + paths.join(" "), evidence: [], attempt: { id: `${id}:r1:1`, number: 1, validationStage: "initial", seatId: "builder" }, status: "succeeded", runtimeOwners: [], completedAt: 2, result: { schemaVersion: 1, kind: "build", workId: id, workRevision: 1, attemptId: `${id}:r1:1`, outcome: "changed", summary: "wrote", changes: paths.map(path => ({ path, description: "written" })), verificationClaims: [], evidence: [], proposedTools: [] } };
  }
  /** The successful workspace bridge return through which an active-checkout builder changed the parent checkout. */
  function bridgeReturn(id: string, baseline: BaselineRecord): Static<typeof RunRecordSchema>["toolInvocations"][number] {
    return { schemaVersion: 1, id: `workspace-${id}`, name: "supership_workspace", version: 1, kernelGeneration: 0, caller: { id, revision: 1, attemptId: `${id}:r1:1` }, actionId: "build", parentBefore: baseline.identity, parentAfter: { ...baseline.identity, worktreeDigest: digestJson(["bridge-effect", id]) }, outcome: "success", evidence: [] };
  }
  async function stateFor(repo: string, baseline: BaselineRecord, groups = [{ id: "one", title: "feat: first slice", workIds: ["build"], paths: ["same.txt"], dependencies: [] as string[] }]): Promise<Static<typeof RunRecordSchema>> {
    const observation = await observeCode(repo, []);
    const workIds = groups.flatMap(group => group.workIds), work = groups.flatMap(group => group.workIds.map(id => succeededBuild(id, group.paths)));
    const state: Static<typeof RunRecordSchema> = {
      schemaVersion: 1, runId: "run", slug: "fixture", owner: { sessionId: "session", epoch: 1, leaseId: "lease" },
      repository: { root: repo, gitDir: baseline.gitDir, commonDir: baseline.commonDir, initialHead: baseline.identity.head, baselineDigest: digestJson(baseline), baselineRef: { id: "baseline", kind: "artifact", uri: "artifact://baseline", digest: digestJson(baseline), mediaType: "application/json", summary: "fixture", availability: "available" } },
      invocation: { command: "supership", mode: "interactive", topology: "normal", intent: "fixture", commitRequested: true, pushRequested: true },
      policy: { schemaVersion: 1, seats: [], namedFallbackSeats: [], limits: {}, requiredLenses: [], verificationChecks: [], phaseGates: [], pathRouting: [], instructionRefs: [] },
      phase: "commit", lifecycle: "active", planRevision: 1, eventSequence: 1, lastEventHash: digestJson([]), createdAt: 1, updatedAt: 1, seats: [], limits: {},
      usage: { tokens: 0, cost: { amount: null, pricedSubtotal: 0, currency: "USD", unpricedModels: [] }, startedAt: 1, observedAt: 1, activeOwners: 0, ompConcurrencyCeiling: 2, overshoot: { tokens: 0, cost: null, wallMs: 0 } },
      plan: { schemaVersion: 1, revision: 1, title: "fixture", objective: "fixture", scope: { included: [], excluded: [], paths: ["same.txt"], effects: [], publicContracts: [], dependencies: [] }, evidence: [], items: [], risks: [], requiredLenses: ["correctness", "simplicity"], verificationChecks: [{ id: "smoke", description: "fixture check", scenario: { kind: "command", command: ["true"], cwd: repo }, scopePaths: [], required: true, source: [] }], commitGroups: groups, toolProposals: [] },
      work, actions: [], tools: [], approvals: [approval("0".repeat(64), "initial-plan")], findings: [], reviewRounds: [],
      verification: [{ schemaVersion: 1, id: "verified", checkId: "smoke", scenario: { kind: "command", command: ["true"], cwd: repo }, codeIdentity: observation.identity, scopePaths: [], startedAt: 1, endedAt: 2, outcome: "passed", exitCode: 0, evidence: [], verifier: { kind: "runtime", id: "fixture" }, actionId: "verify" }],
      instructions: [], evidence: [], kernelGeneration: 0, inputReceipts: [], receiptDigests: [], code: observation,
      pools: [], toolInvocations: workIds.map(id => bridgeReturn(id, baseline)), worktrees: [], gitOutcomes: [], patches: [], usageSources: [], usageCoverage: [],
    };
    state.approvals[0].scopeHash = digestJson(state.plan);
    assertSchema(RunRecordSchema, state); return state;
  }

  test("baseline preserves staged, unstaged, binary, symlink, executable and untracked identities", async () => {
    const { repo } = fixture();
    editLine(repo, 3, "user staged"); git(repo, ["add", "same.txt"]); editLine(repo, 23, "user unstaged");
    const untracked = Buffer.from([0, 255, 128, 1, 10]); writeFileSync(join(repo, "user.bin"), untracked);
    const indexBytes = readFileSync(join(repo, ".git/index")); const baseline = await captureBaseline(repo);
    assert.equal(Buffer.from(baseline.index.find(entry => entry.path === "same.txt")!.image.bytes, "base64").toString().split("\n")[2], "user staged");
    assert.equal(Buffer.from(baseline.worktree.find(entry => entry.path === "same.txt")!.image.bytes, "base64").toString().split("\n")[22], "user unstaged");
    assert.deepEqual(Buffer.from(baseline.worktree.find(entry => entry.path === "user.bin")!.image.bytes, "base64"), untracked);
    assert.equal(baseline.worktree.find(entry => entry.path === "link")!.image.mode, "120000");
    assert.equal(baseline.worktree.find(entry => entry.path === "script.sh")!.image.mode, "100755");
    assert.deepEqual(readFileSync(join(repo, ".git/index")), indexBytes);
    const before = baseline.identity.worktreeDigest; chmodSync(join(repo, "script.sh"), 0o644);
    assert.notEqual((await captureBaseline(repo)).identity.worktreeDigest, before);
  });

  test("isolated same-file integration preserves staged and unstaged user hunks plus independent external edits", async () => {
    const { repo } = fixture(); editLine(repo, 3, "user staged"); git(repo, ["add", "same.txt"]); editLine(repo, 23, "user unstaged");
    writeFileSync(join(repo, "notes"), "user untracked\n"); const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "generated"));
    editLine(repo, 75, "external same file"); writeFileSync(join(repo, "external"), "external untracked");
    const indexBytes = readFileSync(join(repo, ".git/index"));
    await integrated(repo, baseline, patch);
    const lines = readFileSync(join(repo, "same.txt"), "utf8").split("\n");
    assert.deepEqual([lines[2], lines[22], lines[44], lines[74]], ["user staged", "user unstaged", "generated", "external same file"]);
    assert.deepEqual(readFileSync(join(repo, ".git/index")), indexBytes);
    assert.equal(readFileSync(join(repo, "notes"), "utf8"), "user untracked\n");
    assert.equal(readFileSync(join(repo, "external"), "utf8"), "external untracked");
  });

  test("overlapping baseline, external and identical ambiguous hunks pause before any integration or staging", async () => {
    const { repo } = fixture(); editLine(repo, 3, "user staged"); git(repo, ["add", "same.txt"]);
    const baseline = await captureBaseline(repo); const indexBytes = readFileSync(join(repo, ".git/index"));
    const overlap = await worker(repo, baseline, child => { editLine(child, 3, "replace user"); writeFileSync(join(child, "new.txt"), "otherwise safe"); }, "overlap", ["same.txt", "new.txt"]);
    await assert.rejects(integrated(repo, baseline, overlap), GitPause);
    assert.equal(existsSync(join(repo, "new.txt")), false); assert.deepEqual((await captureBaseline(repo)).worktree, baseline.worktree);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "generated"));
    editLine(repo, 45, "external overlap"); const external = await captureBaseline(repo);
    await assert.rejects(integrated(repo, baseline, patch), GitPause); assert.deepEqual((await captureBaseline(repo)).worktree, external.worktree);
    editLine(repo, 45, "generated"); await assert.rejects(integrated(repo, baseline, patch), GitPause);
    assert.deepEqual(readFileSync(join(repo, ".git/index")), indexBytes);
  });

  test("binary, symlink and untracked additions integrate without lossy text conversion; user overlap pauses", async () => {
    const { repo } = fixture(); writeFileSync(join(repo, "user.bin"), Buffer.from([0, 8, 255]));
    const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => {
      writeFileSync(join(child, "binary.bin"), Buffer.from([0, 200, 255, 3]));
      rmSync(join(child, "link")); symlinkSync("binary.bin", join(child, "link"));
      writeFileSync(join(child, "new.bin"), Buffer.from([0, 129, 10])); chmodSync(join(child, "script.sh"), 0o644);
    }, "binary", ["binary.bin", "link", "new.bin", "script.sh"]);
    await integrated(repo, baseline, patch);
    assert.deepEqual(readFileSync(join(repo, "binary.bin")), Buffer.from([0, 200, 255, 3]));
    assert.deepEqual(readFileSync(join(repo, "new.bin")), Buffer.from([0, 129, 10])); assert.equal(readlinkSync(join(repo, "link")), "binary.bin");
    assert.equal((await captureBaseline(repo)).worktree.find(entry => entry.path === "script.sh")!.image.mode, "100644");
    const userPatch = await worker(repo, baseline, child => writeFileSync(join(child, "user.bin"), Buffer.from([0, 9])), "user", ["user.bin"]);
    await assert.rejects(integrated(repo, baseline, userPatch), GitPause); assert.deepEqual(readFileSync(join(repo, "user.bin")), Buffer.from([0, 8, 255]));
    const collision = await worker(repo, baseline, child => writeFileSync(join(child, "collision"), "child"), "collision", ["collision"]);
    writeFileSync(join(repo, "collision"), "external"); await assert.rejects(integrated(repo, baseline, collision), GitPause);
    assert.equal(readFileSync(join(repo, "collision"), "utf8"), "external");
  });

  test("parent callbacks have separate attribution and cannot be applied as isolated output", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const isolated = await worker(repo, baseline, child => editLine(child, 45, "child"));
    editLine(repo, 3, "parent callback"); const parent = capturePatch(baseline, await captureBaseline(repo), { kind: "parent-callback", workId: "callback" }, ["same.txt"]);
    await assert.rejects(integrated(repo, baseline, parent), /Parent callbacks/);
    const result = await integrated(repo, baseline, isolated, [parent]);
    assert.deepEqual(result.parentEffects, [parent]);
    const without = await observeCode(repo, []); const withParent = await observeCode(repo, [], [parent]);
    assert.notEqual(withParent.identity.parentEffectDigest, without.identity.parentEffectDigest);
    assert.equal(withParent.identity.worktreeDigest, without.identity.worktreeDigest);
  });

  test("empty callbacks and patch attribution metadata do not count as code progress", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const empty = ["repair-one", "repair-two"].map(workId => capturePatch(baseline, baseline, { kind: "parent-callback", workId }, ["same.txt"]));
    const before = await observeCode(repo, ["same.txt"]);
    for (let count = 1; count <= empty.length; count++) {
      assert.deepEqual((await observeCode(repo, ["same.txt"], empty.slice(0, count))).identity, before.identity);
    }
    editLine(repo, 45, "parent output"); const after = await captureBaseline(repo);
    const first = capturePatch(baseline, after, { kind: "parent-callback", workId: "first" }, ["same.txt"]);
    const renamed = capturePatch(baseline, after, { kind: "parent-callback", workId: "renamed" }, ["same.txt"]);
    assert.notEqual(first.digest, renamed.digest);
    const reviewed = await observeCode(repo, ["same.txt"], [first]);
    assert.deepEqual((await observeCode(repo, ["same.txt"], [empty[0], renamed, empty[1]])).identity, reviewed.identity);
  });

  test("parent code identity detects byte and mode changes but cancels same-interval reversions", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo); const patches: PatchEvidence[] = [];
    let previous = await observeCode(repo, ["same.txt"]);
    const cases = [
      { path: "binary.bin", change: () => writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 200, 129])), revert: () => writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 128, 255])) },
      { path: "script.sh", change: () => chmodSync(join(repo, "script.sh"), 0o644), revert: () => chmodSync(join(repo, "script.sh"), 0o755) },
      { path: "link", change: () => { rmSync(join(repo, "link")); symlinkSync("binary.bin", join(repo, "link")); }, revert: () => { rmSync(join(repo, "link")); symlinkSync("same.txt", join(repo, "link")); } },
      { path: "binary.bin", change: () => rmSync(join(repo, "binary.bin")), revert: () => writeFileSync(join(repo, "binary.bin"), Buffer.from([0, 1, 128, 255])) },
      { path: "added.bin", change: () => writeFileSync(join(repo, "added.bin"), Buffer.from([0, 255])), revert: () => rmSync(join(repo, "added.bin")) },
    ];
    for (const { path, change, revert } of cases) {
      for (const mutate of [change, revert]) {
        const before = await captureBaseline(repo); mutate(); const after = await captureBaseline(repo);
        const source = { kind: "parent-callback" as const, workId: "callback" };
        assert.throws(() => capturePatch(before, after, source, ["same.txt"]), /outside its assignment/);
        patches.push(capturePatch(before, after, source, [path]));
        const observation = await observeCode(repo, ["same.txt"], patches);
        assert.notEqual(observation.identity.parentEffectDigest, previous.identity.parentEffectDigest, path);
        assert.equal(observation.identity.scopeDigest, previous.identity.scopeDigest, path);
        previous = observation;
      }
      assert.equal(previous.identity.worktreeDigest, baseline.identity.worktreeDigest);
      assert.equal(previous.identity.parentEffectDigest, baseline.identity.parentEffectDigest);
    }
  }, 30_000);

  test("commit authorization uses byte-semantic parent effects without discarding attribution checks", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    editLine(repo, 45, "parent output"); const after = await captureBaseline(repo);
    const parent = capturePatch(baseline, after, { kind: "parent-callback", workId: "build" }, ["same.txt"]);
    const renamed = capturePatch(baseline, after, { kind: "parent-callback", workId: "repair" }, ["same.txt"]);
    const empty = capturePatch(after, after, { kind: "parent-callback", workId: "build" }, ["same.txt"]);
    const state = await stateFor(repo, baseline, [{ id: "one", title: "feat: parent output", workIds: ["build", "repair"], paths: ["same.txt"], dependencies: [] }]);
    state.code = await observeCode(repo, [], [parent]); state.verification[0].codeIdentity = state.code.identity;
    await assert.rejects(prepareCommitGroups(state, state.code, { baseline, patches: [] }), /Parent callback effects/);
    // A patch whose source is not a known succeeded owner is never attributed, even when a plan group names that foreign id.
    const unassigned = capturePatch(baseline, after, { kind: "parent-callback", workId: "unassigned" }, ["same.txt"]);
    await assert.rejects(prepareCommitGroups(state, state.code, { baseline, patches: [unassigned] }), /no attributed output to commit/);
    const crafted = { ...state, plan: { ...state.plan!, commitGroups: [{ ...state.plan!.commitGroups[0], workIds: ["build", "repair", "unassigned"] }] } };
    crafted.approvals = [{ ...approval("0".repeat(64), "initial-plan"), scopeHash: digestJson(crafted.plan) }];
    await assert.rejects(prepareCommitGroups(crafted, state.code, { baseline, patches: [unassigned] }), /no attributed output to commit/);
    const ownership = { baseline, patches: [renamed, empty, empty] };
    const plan = await prepareCommitGroups(state, await observeCode(repo, [], ownership.patches), ownership);
    const committed = await commitApproved(plan, confirmed(plan));
    assert.equal(git(repo, ["show", committed.after.head + ":same.txt"]), original.replace("line-45\n", "parent output\n").trim());
    assert.equal(git(repo, ["diff", "--cached"]), "");
    assert.deepEqual((await captureBaseline(repo)).worktree, after.worktree);
  });

  test("branch selection waits for approval, respects user names and rejects default branch commits", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    await assert.rejects(createOutputBranch({ repo, slug: "topic", expected: baseline.identity, needed: true, planApproved: false }), /approval/);
    assert.equal(git(repo, ["branch", "--show-current"]), "feature");
    await createOutputBranch({ repo, slug: "topic", userBranch: "chosen/name", expected: baseline.identity, needed: true, planApproved: true });
    assert.equal(git(repo, ["branch", "--show-current"]), "chosen/name");
    await createOutputBranch({ repo, slug: "topic", expected: baseline.identity, needed: true, planApproved: true });
    assert.equal(git(repo, ["branch", "--show-current"]), "supership/topic");
    await assert.rejects(createOutputBranch({ repo, slug: "topic", userBranch: "main", expected: baseline.identity, needed: true, planApproved: true }), /default branch/);
    git(repo, ["update-ref", "refs/remotes/team/upstream/trunk", baseline.identity.head]);
    git(repo, ["symbolic-ref", "refs/remotes/team/upstream/HEAD", "refs/remotes/team/upstream/trunk"]);
    await assert.rejects(createOutputBranch({ repo, slug: "topic", userBranch: "trunk", expected: baseline.identity, needed: true, planApproved: true }), /default branch/);
  });

  test("logical opt-in commits exclude staged user hunks and preserve the working tree and user staging", async () => {
    const { repo } = fixture(); editLine(repo, 3, "user staged"); git(repo, ["add", "same.txt"]); editLine(repo, 23, "user unstaged");
    writeFileSync(join(repo, "user.txt"), "untracked user"); const baseline = await captureBaseline(repo);
    const first = await worker(repo, baseline, child => editLine(child, 45, "slice one"), "first"); await integrated(repo, baseline, first);
    const second = await worker(repo, await captureBaseline(repo), child => editLine(child, 75, "slice two"), "second"); await integrated(repo, baseline, second, [first]);
    const state = await stateFor(repo, baseline, [
      { id: "one", title: "feat: first slice", workIds: ["first"], paths: ["same.txt"], dependencies: [] },
      { id: "two", title: "feat: second slice", workIds: ["second"], paths: ["same.txt"], dependencies: ["one"] },
    ]);
    const ownership = { baseline, patches: [first, second] }; const observation = await observeCode(repo, []);
    await assert.rejects(prepareCommitGroups({ ...state, invocation: { ...state.invocation, commitRequested: false } }, observation, ownership), /not requested/);
    await assert.rejects(prepareCommitGroups({ ...state, verification: [] }, observation, ownership), /verification/);
    const plan = await prepareCommitGroups(state, observation, ownership);
    await assert.rejects(commitApproved(plan, { ...confirmed(plan), approval: { ...confirmed(plan).approval!, authority: "autonomous-policy" } }), GitPause);
    const workBytes = readFileSync(join(repo, "same.txt")); const result = await commitApproved(plan, confirmed(plan));
    assert.equal(result.commits.length, 2);
    const firstLines = git(repo, ["show", `${result.commits[0]}:same.txt`]).split("\n");
    const finalLines = git(repo, ["show", "HEAD:same.txt"]).split("\n");
    assert.deepEqual([firstLines[2], firstLines[22], firstLines[44], firstLines[74]], ["line-3", "line-23", "slice one", "line-75"]);
    assert.deepEqual([finalLines[2], finalLines[22], finalLines[44], finalLines[74]], ["line-3", "line-23", "slice one", "slice two"]);
    const stagedDiff = git(repo, ["diff", "--cached"]); assert.match(stagedDiff, /user staged/); assert.doesNotMatch(stagedDiff, /user unstaged|slice one|slice two/);
    assert.deepEqual(readFileSync(join(repo, "same.txt")), workBytes); assert.equal(readFileSync(join(repo, "user.txt"), "utf8"), "untracked user");
    await assert.rejects(commitApproved(plan, confirmed(plan)), /changed since/);
  });

  test("explicit final push confirms exact target and commits against a local bare remote", async () => {
    const { directory, repo } = fixture(); const bare = join(directory, "remote.git"); git(repo, ["init", "--bare", "--quiet", bare]); git(repo, ["remote", "add", "origin", bare]);
    git(repo, ["push", "--quiet", "origin", "HEAD:refs/heads/feature"]);
    const baseline = await captureBaseline(repo); const patch = await worker(repo, baseline, child => editLine(child, 45, "output")); await integrated(repo, baseline, patch);
    const state = await stateFor(repo, baseline); const plan = await prepareCommitGroups(state, await observeCode(repo, []), { baseline, patches: [patch] });
    const committed = await commitApproved(plan, confirmed(plan));
    git(repo, ["tag", "-am", "fixture tag", "not-confirmed"]); git(repo, ["config", "push.followTags", "true"]);
    git(repo, ["config", "remote.origin.push", "refs/heads/feature:refs/heads/not-confirmed"]);
    const request = { repo, remote: "origin", branch: "feature", commits: committed.commits, requested: true, expected: committed.after, planRevision: 1, ownerEpoch: 1 };
    await assert.rejects(preparePush({ ...request, requested: false }), /not requested/);
    const push = await preparePush(request);
    await assert.rejects(pushConfirmed(push, { ...pushConfirmation(push), approval: { ...pushConfirmation(push).approval, scopeHash: "0".repeat(64) } }), /confirmation/);
    assert.equal(git(repo, ["--git-dir", bare, "rev-parse", "refs/heads/feature"]), baseline.identity.head);
    const alternate = join(directory, "alternate.git"); git(repo, ["init", "--bare", "--quiet", alternate]);
    git(repo, ["remote", "set-url", "origin", alternate]); await assert.rejects(pushConfirmed(push, pushConfirmation(push)), GitPause);
    assert.equal(git(repo, ["--git-dir", alternate, "for-each-ref", "--format=%(refname)"]), ""); git(repo, ["remote", "set-url", "origin", bare]);
    const published = await pushConfirmed(push, pushConfirmation(push)); assert.deepEqual(published.commits, committed.commits);
    assert.equal(git(repo, ["--git-dir", bare, "for-each-ref", "--format=%(refname)"]), "refs/heads/feature");
    assert.equal(git(repo, ["--git-dir", bare, "rev-parse", "refs/heads/feature"]), committed.after.head);
    await assert.rejects(pushConfirmed(push, pushConfirmation(push)), /target changed/);
    await assert.rejects(preparePush({ ...request, branch: "main" }), /default branch/);
  });

  test("review-only uses explicit base, dirty untracked scope, or verified default merge base without inventing history", async () => {
    const { repo } = fixture(); await assert.rejects(selectReviewScope(repo), /empty/);
    const baseline = await captureBaseline(repo); writeFileSync(join(repo, "only-untracked"), "review me");
    const dirty = await selectReviewScope(repo); assert.equal(dirty.kind, "dirty"); assert.deepEqual(dirty.paths, ["only-untracked"]); assert.equal(dirty.untracked[0].path, "only-untracked");
    assert.equal((await selectReviewScope(repo, baseline.identity.head)).kind, "explicit");
    await assert.rejects(selectReviewScope(repo, ""), /empty/); await assert.rejects(selectReviewScope(repo, "missing"), GitPause);
    rmSync(join(repo, "only-untracked")); editLine(repo, 45, "committed feature"); git(repo, ["add", "same.txt"]); git(repo, ["commit", "-qm", "feature fixture"]);
    const clean = await selectReviewScope(repo); assert.equal(clean.kind, "merge-base"); assert.equal(clean.base, baseline.identity.head); assert.deepEqual(clean.paths, ["same.txt"]);
    git(repo, ["branch", "master", "HEAD"]); await assert.rejects(selectReviewScope(repo), /unambiguous/);
    assert.equal((await selectReviewScope(repo, "main")).base, baseline.identity.head);
  });

  test("staged reverse hunks, forged evidence, stale review and a replaced symlink ancestor cannot bypass ownership", async () => {
    const { repo } = fixture(); editLine(repo, 3, "staged user"); git(repo, ["add", "same.txt"]); writeFileSync(join(repo, "same.txt"), original);
    const baseline = await captureBaseline(repo); const patch = await worker(repo, baseline, child => editLine(child, 3, "generated"));
    assert.equal(checkIntegration(baseline, baseline, patch).kind, "pause");
    const cleanPatch = await worker(repo, baseline, child => editLine(child, 45, "generated"), "clean");
    const forged = structuredClone(cleanPatch); forged.changes[0].after!.bytes = Buffer.from("forged").toString("base64");
    await assert.rejects(integrated(repo, baseline, forged), /digest mismatch/);
    const stale = baseline.identity; writeFileSync(join(repo, "new-user"), "external");
    await assert.rejects(integrateChecked({ repo, ownership: { baseline, patches: [] }, incoming: cleanPatch, expected: stale }), /changed since/);
    const directory = join(repo, "dir"); mkdirSync(directory); writeFileSync(join(directory, "file"), "tracked"); git(repo, ["add", "dir/file"]); git(repo, ["commit", "-qm", "directory fixture"]);
    const outside = join(dirname(repo), "outside"); mkdirSync(outside); writeFileSync(join(outside, "file"), "protected");
    rmSync(directory, { recursive: true }); symlinkSync(outside, directory);
    await assert.rejects(captureBaseline(repo), /symlink ancestor/); assert.equal(readFileSync(join(outside, "file"), "utf8"), "protected");
  });
  test("commit attribution accepts independent external hunks and pauses on staged overlaps, default branches and locks", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "generated")); await integrated(repo, baseline, patch);
    editLine(repo, 3, "external staged");
    const generatedWork = readFileSync(join(repo, "same.txt")); editLine(repo, 45, "line-45"); git(repo, ["add", "same.txt"]); writeFileSync(join(repo, "same.txt"), generatedWork);
    editLine(repo, 75, "external unstaged"); const state = await stateFor(repo, baseline);
    const ownership = { baseline, patches: [patch] }; const plan = await prepareCommitGroups(state, await observeCode(repo, []), ownership);
    writeFileSync(join(repo, ".git/index.lock"), "another Git operation");
    await assert.rejects(commitApproved(plan, confirmed(plan)), /index is locked/);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), baseline.identity.head); rmSync(join(repo, ".git/index.lock"));
    git(repo, ["symbolic-ref", "HEAD", "refs/heads/main"]);
    await assert.rejects(commitApproved(plan, confirmed(plan)), /default branch/); git(repo, ["symbolic-ref", "HEAD", "refs/heads/feature"]);
    const before = readFileSync(join(repo, "same.txt")); await commitApproved(plan, confirmed(plan));
    assert.deepEqual(readFileSync(join(repo, "same.txt")), before);
    assert.match(git(repo, ["diff", "--cached"]), /external staged/);
    assert.doesNotMatch(git(repo, ["show", "HEAD:same.txt"]), /external staged|external unstaged/);
    const fresh = fixture(); const freshBase = await captureBaseline(fresh.repo);
    const freshPatch = await worker(fresh.repo, freshBase, child => editLine(child, 45, "generated")); await integrated(fresh.repo, freshBase, freshPatch);
    editLine(fresh.repo, 45, "external staged overlap"); git(fresh.repo, ["add", "same.txt"]); editLine(fresh.repo, 45, "generated");
    const overlapState = await stateFor(fresh.repo, freshBase); const untouchedIndex = readFileSync(join(fresh.repo, ".git/index"));
    await assert.rejects(prepareCommitGroups(overlapState, await observeCode(fresh.repo, []), { baseline: freshBase, patches: [freshPatch] }), /Overlapping/);
    assert.deepEqual(readFileSync(join(fresh.repo, ".git/index")), untouchedIndex);
  });

  test("binary, executable, symlink and new-file commits preserve baseline user blobs", async () => {
    const { repo } = fixture(); writeFileSync(join(repo, "user.bin"), Buffer.from([0, 222])); const baseline = await captureBaseline(repo);
    const paths = ["binary.bin", "link", "script.sh", "new.bin"];
    const patch = await worker(repo, baseline, child => {
      writeFileSync(join(child, "binary.bin"), Buffer.from([0, 200, 255]));
      rmSync(join(child, "link")); symlinkSync("binary.bin", join(child, "link"));
      chmodSync(join(child, "script.sh"), 0o644); writeFileSync(join(child, "new.bin"), Buffer.from([0, 199]));
    }, "build", paths);
    await integrated(repo, baseline, patch); const state = await stateFor(repo, baseline, [{ id: "one", title: "feat: binary output", workIds: ["build"], paths, dependencies: [] }]);
    state.invocation.mode = "autonomous"; state.invocation.command = "shipit"; state.approvals[0].authority = "autonomous-policy";
    const plan = await prepareCommitGroups(state, await observeCode(repo, []), { baseline, patches: [patch] }); await commitApproved(plan, confirmed(plan));
    const committed = await captureBaseline(repo);
    for (const path of paths) assert.deepEqual(committed.head.find(item => item.path === path)!.image, committed.worktree.find(item => item.path === path)!.image);
    assert.equal(committed.head.some(item => item.path === "user.bin"), false);
    assert.deepEqual(readFileSync(join(repo, "user.bin")), Buffer.from([0, 222]));
  });

  test("review keeps both staged and inverse unstaged hunks and rejects missing default branches", async () => {
    const { repo } = fixture(); editLine(repo, 3, "staged only"); git(repo, ["add", "same.txt"]); writeFileSync(join(repo, "same.txt"), original);
    const scope = await selectReviewScope(repo); assert.equal(scope.kind, "dirty");
    assert.match(Buffer.from(scope.stagedPatch, "base64").toString(), /\+staged only/);
    assert.match(Buffer.from(scope.unstagedPatch, "base64").toString(), /-staged only/);
    const clean = fixture(); git(clean.repo, ["update-ref", "-d", "refs/heads/main"]);
    await assert.rejects(selectReviewScope(clean.repo), /unambiguous/);
  });

  test("SHA-256 Git and clean deletions retain exact ownership, while untracked replacements do not", async () => {
    const directory = mkdtempSync(join(root, "sha256-")); const repo = join(directory, "repo"); mkdirSync(repo);
    git(repo, ["init", "-q", "--object-format=sha256", "-b", "feature"]); writeFileSync(join(repo, "same.txt"), original);
    git(repo, ["add", "same.txt"]); git(repo, ["commit", "-qm", "SHA-256 fixture"]);
    const baseline = await captureBaseline(repo); assert.equal(baseline.head[0].image.blob, git(repo, ["hash-object", "same.txt"]));
    const patch = await worker(repo, baseline, child => rmSync(join(child, "same.txt"))); await integrated(repo, baseline, patch);
    assert.equal(existsSync(join(repo, "same.txt")), false);
    assert.equal(git(repo, ["show", ":same.txt"]), original.trim());
    const fresh = fixture(); writeFileSync(join(fresh.repo, "user-only"), "user"); const before = await captureBaseline(fresh.repo);
    const removeUser = await worker(fresh.repo, before, child => rmSync(join(child, "user-only")), "remove", ["user-only"]);
    await assert.rejects(integrated(fresh.repo, before, removeUser), GitPause);
    assert.equal(readFileSync(join(fresh.repo, "user-only"), "utf8"), "user");
  });
  test("integration preserves raw bytes despite attributes, filters, ident and line-ending configuration", async () => {
    const { repo } = fixture(); writeFileSync(join(repo, ".gitattributes"), "*.txt text eol=crlf ident filter=uppercase\n");
    writeFileSync(join(repo, ".git/info/attributes"), "*.txt text eol=crlf ident filter=uppercase\n");
    git(repo, ["config", "filter.uppercase.clean", "tr a-z A-Z"]); git(repo, ["config", "filter.uppercase.smudge", "tr a-z A-Z"]);
    git(repo, ["config", "core.autocrlf", "true"]);
    editLine(repo, 3, "$Id$"); const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "raw output"));
    await integrated(repo, baseline, patch);
    assert.equal(readFileSync(join(repo, "same.txt"), "utf8"), original.replace("line-3\n", "$Id$\n").replace("line-45\n", "raw output\n"));
  });

  test("Git display prefixes and colors do not alter integration or exported patches", async () => {
    const { repo } = fixture(); git(repo, ["config", "diff.noprefix", "true"]); git(repo, ["config", "color.ui", "always"]);
    const baseline = await captureBaseline(repo); const patch = await worker(repo, baseline, child => editLine(child, 45, "generated"));
    await integrated(repo, baseline, patch); const review = await selectReviewScope(repo);
    const diff = Buffer.from(review.patch, "base64").toString();
    assert.match(diff, /diff --git a\/same.txt b\/same.txt/); assert.equal(diff.includes("\u001b["), false);
  });

  test("already-attributed generated hunks may be staged before opt-in commits", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "generated")); await integrated(repo, baseline, patch);
    git(repo, ["add", "same.txt"]); const state = await stateFor(repo, baseline);
    const plan = await prepareCommitGroups(state, await observeCode(repo, []), { baseline, patches: [patch] }); await commitApproved(plan, confirmed(plan));
    assert.equal(git(repo, ["diff", "--cached"]), ""); assert.equal(git(repo, ["show", "HEAD:same.txt"]), original.replace("line-45\n", "generated\n").trim());
  });

  test("identical external overlap remains ambiguous when another independent external hunk exists", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "identical"));
    editLine(repo, 45, "identical"); editLine(repo, 75, "independent external"); const before = await captureBaseline(repo);
    await assert.rejects(integrated(repo, baseline, patch), GitPause);
    assert.deepEqual((await captureBaseline(repo)).worktree, before.worktree);
  });
  test("dependent workers may revise an earlier generated hunk without adopting user hunks", async () => {
    const { repo } = fixture(); editLine(repo, 3, "user"); const baseline = await captureBaseline(repo);
    const first = await worker(repo, baseline, child => editLine(child, 45, "first")); await integrated(repo, baseline, first);
    const second = await worker(repo, await captureBaseline(repo), child => editLine(child, 45, "revised")); await integrated(repo, baseline, second, [first]);
    const state = await stateFor(repo, baseline); const plan = await prepareCommitGroups(state, await observeCode(repo, []), { baseline, patches: [first, second] });
    await commitApproved(plan, confirmed(plan));
    assert.match(readFileSync(join(repo, "same.txt"), "utf8"), /user/); assert.doesNotMatch(git(repo, ["show", "HEAD:same.txt"]), /user|first/);
    assert.match(git(repo, ["show", "HEAD:same.txt"]), /revised/);
  });

  test("raw integration handles clean file-directory transitions and protects ignored directory contents", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const toDirectory = await worker(repo, baseline, child => { rmSync(join(child, "same.txt")); mkdirSync(join(child, "same.txt")); writeFileSync(join(child, "same.txt/inside"), "output"); });
    await integrated(repo, baseline, toDirectory); assert.equal(readFileSync(join(repo, "same.txt/inside"), "utf8"), "output");
    const toFile = await worker(repo, await captureBaseline(repo), child => { rmSync(join(child, "same.txt"), { recursive: true }); writeFileSync(join(child, "same.txt"), "replaced"); });
    writeFileSync(join(repo, ".git/info/exclude"), "same.txt/protected\n"); writeFileSync(join(repo, "same.txt/protected"), "ignored user bytes");
    const before = readFileSync(join(repo, "same.txt/inside")); await assert.rejects(integrated(repo, baseline, toFile, [toDirectory]), GitPause);
    assert.deepEqual(readFileSync(join(repo, "same.txt/inside")), before); assert.equal(readFileSync(join(repo, "same.txt/protected"), "utf8"), "ignored user bytes");
  });
  test("ordinary plan amendments and owner transfer retain opt-in commit consent without permitting material scope changes", async () => {
    const { repo } = fixture(); const baseline = await captureBaseline(repo);
    const patch = await worker(repo, baseline, child => editLine(child, 45, "generated")); await integrated(repo, baseline, patch);
    const state = await stateFor(repo, baseline); const priorApproval = structuredClone(state.approvals[0]);
    state.plan = { ...state.plan!, revision: 2, title: "Execution detail" }; state.planRevision = 2; state.owner.epoch = 2;
    state.planChange = { classification: "ordinary", approvedScopeHash: priorApproval.scopeHash };
    const observation = await observeCode(repo, []); const ownership = { baseline, patches: [patch] };
    await assert.rejects(prepareCommitGroups({ ...state, planChange: { classification: "material" } }, observation, ownership), GitPause);
    const plan = await prepareCommitGroups(state, observation, ownership);
    assert.deepEqual(plan.authorization, priorApproval);
    await assert.rejects(commitApproved(plan, { approval: priorApproval, reviewedPlanHash: priorApproval.scopeHash }), GitPause);
    await commitApproved(plan, confirmed(plan));
    assert.match(git(repo, ["show", "HEAD:same.txt"]), /generated/);
  });
  test("a review-only repair commits under the invocation's own request while user baseline and staged bytes survive", async () => {
    const { repo } = fixture(); editLine(repo, 3, "user staged"); git(repo, ["add", "same.txt"]); editLine(repo, 75, "user unstaged");
    const baseline = await captureBaseline(repo);
    editLine(repo, 45, "repaired"); const after = await captureBaseline(repo);
    const repair = capturePatch(baseline, after, { kind: "parent-callback", workId: "fix-1-repair" }, ["same.txt"]);
    const state = await stateFor(repo, baseline, []);
    state.invocation = { ...state.invocation, command: "superreview", mode: "review-only", topology: "crossreview", pushRequested: false };
    state.approvals = []; state.planChange = { classification: "ordinary" }; state.baselineCode = baseline.identity;
    state.work = [{ ...succeededBuild("fix-1-repair", ["same.txt"]), kind: "fix" }]; state.toolInvocations = [bridgeReturn("fix-1-repair", baseline)];
    state.code = await observeCode(repo, [], [repair]); state.verification[0].codeIdentity = state.code.identity;
    const ownership = { baseline, patches: [repair] };
    await assert.rejects(prepareCommitGroups({ ...state, invocation: { ...state.invocation, command: "supership", mode: "interactive", topology: "normal" } }, state.code, ownership), /lacks current approval/);
    // A discarded worker's bytes are disowned: with nothing attributed there is nothing to commit; beside attributed output they are
    // unattributed checkout bytes, kept out of HEAD when independent and a pause when they overlap the attributed hunk.
    await assert.rejects(prepareCommitGroups({ ...state, work: [{ ...state.work[0], status: "cancelled" }] }, state.code, ownership), /no attributed output to commit/);
    const { result: _result, ...succeededShape } = state.work[0]; const discarded = { ...succeededShape, id: "discarded", status: "cancelled" as const, attempt: { ...state.work[0].attempt, id: "discarded:r1:1" } };
    writeFileSync(join(repo, "script.sh"), "#!/bin/sh\nexit 1\n"); const disownedAfter = await captureBaseline(repo);
    const disowned = capturePatch(after, disownedAfter, { kind: "parent-callback", workId: "discarded" }, ["script.sh"]);
    const withDisowned = { ...state, work: [state.work[0], discarded], code: await observeCode(repo, [], [repair, disowned]) };
    withDisowned.verification = [{ ...state.verification[0], codeIdentity: withDisowned.code!.identity }];
    const independent = await prepareCommitGroups(withDisowned, withDisowned.code!, { baseline, patches: [repair, disowned] });
    assert.deepEqual(independent.groups.map(item => item.group.workIds), [["fix-1-repair"]]);
    assert.equal(git(repo, ["show", `${independent.groups[0].tree}:script.sh`]), "#!/bin/sh\nexit 0");
    writeFileSync(join(repo, "script.sh"), "#!/bin/sh\nexit 0\n"); editLine(repo, 46, "disowned neighbour"); const overlapAfter = await captureBaseline(repo);
    const overlapping = capturePatch(after, overlapAfter, { kind: "parent-callback", workId: "discarded" }, ["same.txt"]);
    const withOverlap = { ...withDisowned, code: await observeCode(repo, [], [repair, overlapping]) };
    withOverlap.verification = [{ ...state.verification[0], codeIdentity: withOverlap.code!.identity }];
    await assert.rejects(prepareCommitGroups(withOverlap, withOverlap.code!, { baseline, patches: [repair, overlapping] }), /Overlapping or ambiguous/);
    editLine(repo, 46, "line-46"); assert.deepEqual((await captureBaseline(repo)).worktree, after.worktree);
    const plan = await prepareCommitGroups(state, state.code, ownership);
    assert.equal(plan.authorization, null); assert.deepEqual(plan.groups.map(item => item.group.id), ["attributed-output"]);
    await assert.rejects(commitApproved(plan, { approval: approval(plan.approvedPlanHash, "initial-plan"), reviewedPlanHash: plan.approvedPlanHash }), /Commit consent/);
    await assert.rejects(commitApproved(plan, { approval: null, reviewedPlanHash: "0".repeat(64) }), /Commit consent/);
    assert.equal(git(repo, ["rev-parse", "HEAD"]), baseline.identity.head);
    const worktree = readFileSync(join(repo, "same.txt")); const committed = await commitApproved(plan, confirmed(plan));
    assert.equal(committed.commits.length, 1); assert.deepEqual(readFileSync(join(repo, "same.txt")), worktree);
    assert.equal(git(repo, ["show", "HEAD:same.txt"]), original.replace("line-45\n", "repaired\n").trim());
    assert.match(git(repo, ["diff", "--cached"]), /user staged/); assert.doesNotMatch(git(repo, ["show", "HEAD:same.txt"]), /user staged|user unstaged/);
  });
}
