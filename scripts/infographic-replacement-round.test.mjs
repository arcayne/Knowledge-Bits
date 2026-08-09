import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertWorkerIdle,
  buildCampaignPlan,
  classifyRun,
  INFOGRAPHIC_RECIPE_ID,
  INFOGRAPHIC_RECIPE_VERSION,
  pngDimensions,
  preflightCampaign,
  runCampaignRound,
} from "./infographic-replacement-round.mjs";

const recipe = {
  id: INFOGRAPHIC_RECIPE_ID,
  version: INFOGRAPHIC_RECIPE_VERSION,
  checksum: `sha256:${"a".repeat(64)}`,
};

test("classifies pending review first, approved delivery second, and excludes unsafe states", () => {
  const run = (version = "1.0.0") => ({
    brief: {
      generationPlan: {
        recipes: {
          infographic: {
            id: INFOGRAPHIC_RECIPE_ID,
            version,
            checksum: version === INFOGRAPHIC_RECIPE_VERSION ? recipe.checksum : `sha256:${"b".repeat(64)}`,
          },
        },
      },
    },
  });
  assert.deepEqual(
    classifyRun({ currentStage: "human_review", currentState: "needs_human", reviewStatus: "pending" }, run(), recipe),
    { eligibility: "eligible", reason: null, priority: 0 },
  );
  assert.deepEqual(
    classifyRun({ currentStage: "deliver", currentState: "done", reviewStatus: "approved" }, run(), recipe),
    { eligibility: "eligible", reason: null, priority: 1 },
  );
  assert.equal(
    classifyRun({ currentStage: "produce_assets", currentState: "waiting", reviewStatus: "pending" }, run(), recipe).reason,
    "active_pipeline_work",
  );
  assert.equal(
    classifyRun({ currentStage: "human_review", currentState: "needs_human", reviewStatus: "pending" }, run("2.0.0"), recipe).reason,
    "already_v2",
  );
});

test("preflight renders checked copy without provider work and persists each result", async () => {
  const fixture = JSON.parse(await readFile(
    new URL("../apps/worker/src/providers/fixtures/notebooklm-story-playbook.json", import.meta.url),
    "utf8",
  ));
  const row = pipelineRow("pending", "Pending review", "human_review", "needs_human", "pending");
  const api = {
    async pipeline() {
      return { runs: [row] };
    },
    async run() {
      return runDetail("1.0.0");
    },
    async review() {
      return {
        currentPackageChecksum: "package-a",
        package: {
          content: {
            target: fixture.answer,
          },
        },
      };
    },
  };
  const campaign = await buildCampaignPlan({
    api,
    recipe,
    reviewBaseUrl: "http://review.test",
    concurrency: 1,
  });
  const saves = [];
  await preflightCampaign({
    api,
    campaign,
    save: async (value) => saves.push(structuredClone(value)),
  });

  assert.equal(campaign.summary.preflightPassed, 1);
  assert.equal(campaign.runs[0].preflight.status, "passed");
  assert.deepEqual(
    {
      width: campaign.runs[0].preflight.width,
      height: campaign.runs[0].preflight.height,
    },
    { width: 1080, height: 1920 },
  );
  assert.ok(saves.length >= 2);
});

test("round processes pending review before approved delivery and stops each at review", async () => {
  const pending = campaignEntry("pending", "Pending review", 0);
  const approved = campaignEntry("approved", "Approved delivery", 1);
  const campaign = campaignState([approved, pending]);
  const events = [];
  const readyRows = new Set();
  const api = {
    async pipeline() {
      return {
        runs: [pending, approved].map((entry) => (
          readyRows.has(entry.id)
            ? pipelineRow(entry.id, entry.title, "human_review", "needs_human", "pending")
            : pipelineRow(
              entry.id,
              entry.title,
              entry.priority === 0 ? "human_review" : "deliver",
              entry.priority === 0 ? "needs_human" : "done",
              entry.priority === 0 ? "pending" : "approved",
            )
        )),
      };
    },
    async run(runId) {
      return runDetail(readyRows.has(runId) ? "2.0.0" : "1.0.0");
    },
    async regenerateInfographic(runId) {
      events.push(`queue:${runId}`);
      return { currentStage: "produce_assets", state: "queued", reviewStatus: "pending" };
    },
    async review(runId) {
      return readyReview(runId);
    },
    async artifact() {
      return pngHeader(1080, 1920);
    },
  };
  const saves = [];
  const result = await runCampaignRound({
    api,
    campaign,
    limit: 2,
    save: async (value) => saves.push(structuredClone(value)),
    loadRecipe: async () => recipe,
    runWorker: async (runId) => {
      events.push(`worker:${runId}`);
      readyRows.add(runId);
    },
  });

  assert.deepEqual(events, [
    "queue:pending",
    "worker:pending",
    "queue:approved",
    "worker:approved",
  ]);
  assert.deepEqual(result.completed, ["pending", "approved"]);
  assert.equal(campaign.summary.reviewReady, 2);
  assert.ok(saves.length >= 6);
});

test("PNG verification rejects non-PNG provider bytes", () => {
  assert.throws(() => pngDimensions(Buffer.from("not a png")), /not a readable PNG/);
});

test("round never retries a failed campaign entry automatically", async () => {
  const failed = campaignEntry("failed", "Needs operator attention", 0);
  failed.execution = { status: "failed", error: "prior provider failure" };
  const campaign = campaignState([failed]);
  let queued = false;
  const result = await runCampaignRound({
    api: {
      async regenerateInfographic() {
        queued = true;
      },
    },
    campaign,
    limit: 5,
    save: async () => {},
    loadRecipe: async () => recipe,
    runWorker: async () => {},
  });

  assert.equal(queued, false);
  assert.deepEqual(result.completed, []);
});

test("worker precondition blocks queueing while another tick owns the lock", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-bits-campaign-test-"));
  const lock = join(directory, "knowledge-bits-worker-tick.lock");
  await mkdir(lock);
  await writeFile(join(lock, "pid"), String(process.pid));
  try {
    await assert.rejects(
      () => assertWorkerIdle({ temporaryDirectory: directory }),
      /Another Knowledge Bits worker is active/,
    );
  } finally {
    await rm(directory, { recursive: true });
  }
});

test("JSON mode remains machine-readable without trailing status text", async () => {
  const source = await readFile(
    new URL("./infographic-replacement-round.mjs", import.meta.url),
    "utf8",
  );

  assert.match(source, /if \(!args\.json\) console\.log\(`State:/);
  assert.match(source, /if \(!args\.json\) \{\s+console\.log\(`Completed this round:/);
});

function pipelineRow(id, title, currentStage, currentState, reviewStatus) {
  return {
    id,
    title,
    locale: "en",
    currentStage,
    currentState,
    currentRevision: 1,
    reviewStatus,
    updatedAt: "2026-07-28T00:00:00.000Z",
  };
}

function runDetail(version) {
  return {
    brief: {
      generationPlan: {
        recipes: {
          infographic: {
            id: INFOGRAPHIC_RECIPE_ID,
            version,
            checksum: version === "2.0.0" ? recipe.checksum : `sha256:${"b".repeat(64)}`,
          },
        },
      },
    },
  };
}

function campaignEntry(id, title, priority) {
  return {
    id,
    title,
    eligibility: "eligible",
    exclusionReason: null,
    priority,
    source: {
      stage: priority === 0 ? "human_review" : "deliver",
      state: priority === 0 ? "needs_human" : "done",
      reviewStatus: priority === 0 ? "pending" : "approved",
      updatedAt: "2026-07-28T00:00:00.000Z",
    },
    preflight: { status: "passed" },
    execution: { status: "not_started" },
  };
}

function campaignState(runs) {
  return {
    schemaVersion: "knowledge-bits.infographic-replacement-campaign.v1",
    campaignId: "test-campaign",
    createdAt: "2026-07-28T00:00:00.000Z",
    updatedAt: "2026-07-28T00:00:00.000Z",
    recipe,
    reviewBaseUrl: "http://review.test",
    summary: {},
    runs,
  };
}

function readyReview(runId) {
  const bytes = pngHeader(1080, 1920);
  return {
    decisionAllowed: true,
    issues: [],
    warnings: [],
    currentPackageChecksum: `package-${runId}`,
    package: {
      content: {
        target: {
          payload: {
            visual: {
              width: 1080,
              height: 1920,
              asset: {
                artifactId: `artifact-${runId}`,
                kind: "infographic",
                mediaType: "image/png",
                checksum: checksum(bytes),
                byteSize: bytes.byteLength,
              },
            },
          },
        },
      },
    },
  };
}

function pngHeader(width, height) {
  const bytes = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes, 0);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function checksum(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
