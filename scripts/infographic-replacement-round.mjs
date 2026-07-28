#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";

import {
  infographicSource,
  NUGLET_INFOGRAPHIC_HEIGHT,
  NUGLET_INFOGRAPHIC_WIDTH,
  renderNugletInfographic,
} from "../apps/worker/scripts/nuglet-infographic.mjs";

export const CAMPAIGN_SCHEMA_VERSION = "knowledge-bits.infographic-replacement-campaign.v1";
export const INFOGRAPHIC_RECIPE_ID = "nuglet.visual.infographic";
export const INFOGRAPHIC_RECIPE_VERSION = "2.0.0";

const DEFAULT_LIMIT = 5;
const SYMBOLS = ["book", "speech", "thread", "steps"];

export class CampaignApi {
  constructor({ baseUrl, apiToken, reviewToken, reviewerId, fetchImpl = fetch }) {
    this.baseUrl = baseUrl;
    this.apiToken = apiToken;
    this.reviewToken = reviewToken;
    this.reviewerId = reviewerId;
    this.fetchImpl = fetchImpl;
  }

  pipeline() {
    return this.#json("/pipeline", { token: this.reviewToken });
  }

  run(runId) {
    return this.#json(`/runs/${encodeURIComponent(runId)}`, { token: this.apiToken });
  }

  review(runId) {
    return this.#json(`/runs/${encodeURIComponent(runId)}/review`, { token: this.reviewToken });
  }

  regenerateInfographic(runId, recipe) {
    return this.#json(`/runs/${encodeURIComponent(runId)}/regenerate-media`, {
      token: this.reviewToken,
      reviewer: true,
      method: "POST",
      body: {
        kinds: ["infographic"],
        recipeOverrides: { infographic: recipe },
      },
    });
  }

  async artifact(runId, artifactId) {
    const response = await this.fetchImpl(new URL(
      `/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactId)}`,
      this.baseUrl,
    ), {
      headers: { Authorization: `Bearer ${this.reviewToken}` },
    });
    if (!response.ok) {
      throw new Error(await responseError(response, "Knowledge Bits artifact read"));
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async #json(path, { token, reviewer = false, method = "GET", body } = {}) {
    const headers = { Authorization: `Bearer ${token}` };
    if (reviewer) headers["X-Knowledge-Bits-Reviewer"] = this.reviewerId;
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const response = await this.fetchImpl(new URL(path, this.baseUrl), {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error ?? `Knowledge Bits API returned ${response.status} for ${path}`);
    }
    return payload;
  }
}

export async function buildCampaignPlan({ api, recipe, reviewBaseUrl, concurrency = 4 }) {
  const pipeline = await api.pipeline();
  const rows = Array.isArray(pipeline.runs) ? pipeline.runs : [];
  const details = await mapLimit(rows, concurrency, async (row) => ({
    row,
    run: await api.run(row.id),
  }));
  const runs = details.map(({ row, run }) => {
    const sourceRecipe = run?.brief?.generationPlan?.recipes?.infographic ?? null;
    const classification = classifyRun(row, run, recipe);
    return {
      id: row.id,
      title: row.title,
      locale: row.locale,
      eligibility: classification.eligibility,
      exclusionReason: classification.reason,
      priority: classification.priority,
      source: {
        stage: row.currentStage,
        state: row.currentState,
        reviewStatus: row.reviewStatus,
        revision: row.currentRevision,
        recipe: sourceRecipe,
        updatedAt: row.updatedAt,
      },
      reviewUrl: `${reviewBaseUrl.replace(/\/$/, "")}/runs/${row.id}`,
      preflight: { status: "not_run" },
      execution: { status: "not_started" },
    };
  }).sort(compareCampaignRuns);
  return {
    schemaVersion: CAMPAIGN_SCHEMA_VERSION,
    campaignId: `infographic-v2-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    recipe,
    reviewBaseUrl,
    summary: summarizeRuns(runs),
    runs,
  };
}

export function classifyRun(row, run, recipe) {
  const sourceRecipe = run?.brief?.generationPlan?.recipes?.infographic;
  if (sourceRecipe?.id === recipe.id
    && sourceRecipe?.version === recipe.version
    && sourceRecipe?.checksum === recipe.checksum) {
    return { eligibility: "excluded", reason: "already_v2", priority: 90 };
  }
  if (row.reviewStatus === "rejected") {
    return { eligibility: "excluded", reason: "rejected", priority: 91 };
  }
  if (["research", "create", "check", "produce_assets"].includes(row.currentStage)) {
    return { eligibility: "excluded", reason: "active_pipeline_work", priority: 92 };
  }
  if (row.currentStage === "human_review"
    && row.currentState === "needs_human"
    && row.reviewStatus === "pending") {
    return { eligibility: "eligible", reason: null, priority: 0 };
  }
  if (row.currentStage === "deliver" && row.reviewStatus === "approved") {
    return { eligibility: "eligible", reason: null, priority: 1 };
  }
  return { eligibility: "excluded", reason: "unsupported_workflow_state", priority: 93 };
}

export async function preflightCampaign({ api, campaign, save, render = renderNugletInfographic }) {
  for (const entry of campaign.runs) {
    if (entry.eligibility !== "eligible") continue;
    const checkedAt = new Date().toISOString();
    try {
      const review = await api.review(entry.id);
      const target = review?.package?.content?.target;
      if (!target) throw new Error("Current review package has no checked Nuglet target");
      const source = infographicSource(target);
      const artDirection = preflightArtDirection(source.steps.length);
      const rendered = await render(target, artDirection);
      const dimensions = pngDimensions(rendered.bytes);
      if (dimensions.width !== NUGLET_INFOGRAPHIC_WIDTH || dimensions.height !== NUGLET_INFOGRAPHIC_HEIGHT) {
        throw new Error(`Preflight rendered ${dimensions.width}x${dimensions.height}`);
      }
      entry.preflight = {
        status: "passed",
        checkedAt,
        packageChecksum: review.currentPackageChecksum,
        oldArtifact: artifactSnapshot(review?.package?.content?.target?.payload?.visual?.asset),
        width: dimensions.width,
        height: dimensions.height,
        byteSize: rendered.bytes.byteLength,
      };
    } catch (error) {
      entry.preflight = {
        status: "failed",
        checkedAt,
        error: errorMessage(error),
      };
    }
    campaign.updatedAt = new Date().toISOString();
    campaign.summary = summarizeRuns(campaign.runs);
    await save(campaign);
  }
  campaign.updatedAt = new Date().toISOString();
  campaign.summary = summarizeRuns(campaign.runs);
  await save(campaign);
  return campaign;
}

export async function runCampaignRound({
  api,
  campaign,
  limit = DEFAULT_LIMIT,
  save,
  runWorker,
  loadRecipe,
  ensureWorkerIdle = async () => {},
}) {
  if (!Number.isInteger(limit) || limit <= 0 || limit > 25) {
    throw new Error("--limit must be an integer between 1 and 25");
  }
  const currentRecipe = await loadRecipe();
  if (!sameRecipe(currentRecipe, campaign.recipe)) {
    throw new Error("Campaign recipe no longer matches the checked repository manifest");
  }
  const candidates = campaign.runs
    .filter((entry) => (
      entry.eligibility === "eligible"
      && entry.preflight?.status === "passed"
      && entry.execution?.status === "not_started"
    ))
    .sort(compareCampaignRuns)
    .slice(0, limit);
  const completed = [];
  for (const entry of candidates) {
    try {
      const livePipeline = await api.pipeline();
      const row = livePipeline.runs?.find((candidate) => candidate.id === entry.id);
      if (!row) throw new Error("Run disappeared from the pipeline ledger");
      const run = await api.run(entry.id);
      const classification = classifyRun(row, run, campaign.recipe);
      if (classification.eligibility !== "eligible") {
        throw new Error(`Run is no longer eligible: ${classification.reason}`);
      }
      await ensureWorkerIdle();
      entry.execution = {
        status: "queueing",
        startedAt: new Date().toISOString(),
      };
      campaign.updatedAt = new Date().toISOString();
      await save(campaign);

      const queued = await api.regenerateInfographic(entry.id, campaign.recipe);
      if (queued.currentStage !== "produce_assets"
        || queued.state !== "queued"
        || queued.reviewStatus !== "pending") {
        throw new Error("Regeneration did not enter the expected queued Produce Assets state");
      }
      entry.execution = {
        ...entry.execution,
        status: "running",
        queuedAt: new Date().toISOString(),
      };
      campaign.updatedAt = new Date().toISOString();
      await save(campaign);

      await runWorker(entry.id);
      const verification = await verifyReviewReady({ api, runId: entry.id, recipe: campaign.recipe });
      entry.execution = {
        ...entry.execution,
        status: "review_ready",
        completedAt: new Date().toISOString(),
        ...verification,
      };
      completed.push(entry.id);
      campaign.updatedAt = new Date().toISOString();
      campaign.summary = summarizeRuns(campaign.runs);
      await save(campaign);
    } catch (error) {
      entry.execution = {
        ...entry.execution,
        status: "failed",
        failedAt: new Date().toISOString(),
        error: errorMessage(error),
      };
      campaign.updatedAt = new Date().toISOString();
      campaign.summary = summarizeRuns(campaign.runs);
      await save(campaign);
      throw new Error(`Round stopped at "${entry.title}": ${errorMessage(error)}`);
    }
  }
  return { campaign, completed };
}

export async function verifyReviewReady({ api, runId, recipe }) {
  const [pipeline, run, review] = await Promise.all([
    api.pipeline(),
    api.run(runId),
    api.review(runId),
  ]);
  const row = pipeline.runs?.find((candidate) => candidate.id === runId);
  if (!row
    || row.currentStage !== "human_review"
    || row.currentState !== "needs_human"
    || row.reviewStatus !== "pending") {
    throw new Error("Generated run did not stop at pending Human Review");
  }
  const boundRecipe = run?.brief?.generationPlan?.recipes?.infographic;
  if (!sameRecipe(boundRecipe, recipe)) {
    throw new Error("Generated run is not bound to the campaign infographic recipe");
  }
  if (review.decisionAllowed !== true) {
    throw new Error(`Review decision is blocked: ${(review.issues ?? []).join("; ") || "unknown issue"}`);
  }
  if ((review.issues ?? []).length) {
    throw new Error(`Review package has issues: ${review.issues.join("; ")}`);
  }
  if ((review.warnings ?? []).length) {
    throw new Error(`Review package has warnings: ${review.warnings.join("; ")}`);
  }
  const visual = review?.package?.content?.target?.payload?.visual;
  const artifact = visual?.asset;
  if (!artifact?.artifactId || artifact.kind !== "infographic" || artifact.mediaType !== "image/png") {
    throw new Error("Review package has no current PNG infographic");
  }
  if (visual.width !== NUGLET_INFOGRAPHIC_WIDTH || visual.height !== NUGLET_INFOGRAPHIC_HEIGHT) {
    throw new Error(`Review package reports ${visual.width}x${visual.height}`);
  }
  const bytes = await api.artifact(runId, artifact.artifactId);
  const dimensions = pngDimensions(bytes);
  if (dimensions.width !== NUGLET_INFOGRAPHIC_WIDTH || dimensions.height !== NUGLET_INFOGRAPHIC_HEIGHT) {
    throw new Error(`Stored artifact is ${dimensions.width}x${dimensions.height}`);
  }
  const checksum = createHash("sha256").update(bytes).digest("hex");
  if (checksum !== artifact.checksum || bytes.byteLength !== artifact.byteSize) {
    throw new Error("Stored artifact bytes do not match the review receipt");
  }
  return {
    packageChecksum: review.currentPackageChecksum,
    artifact: {
      artifactId: artifact.artifactId,
      checksum,
      byteSize: bytes.byteLength,
      mediaType: artifact.mediaType,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

export function preflightArtDirection(stageCount) {
  return {
    stageLabels: Array.from({ length: stageCount }, (_, index) => `Step ${index + 1}`),
    symbols: Array.from({ length: stageCount }, (_, index) => SYMBOLS[index % SYMBOLS.length]),
    accent: "sage",
    path: "loop",
  };
}

export async function loadInfographicRecipe(root) {
  const manifest = JSON.parse(await readFile(
    join(root, "recipes/nuglet.lesson.v1/manifest.json"),
    "utf8",
  ));
  const recipe = manifest.recipes?.find((candidate) => (
    candidate.id === INFOGRAPHIC_RECIPE_ID && candidate.version === INFOGRAPHIC_RECIPE_VERSION
  ));
  if (!recipe?.checksum) throw new Error("Branded infographic recipe is missing from the recipe manifest");
  return {
    id: INFOGRAPHIC_RECIPE_ID,
    version: INFOGRAPHIC_RECIPE_VERSION,
    checksum: recipe.checksum,
  };
}

export async function loadCampaign(path) {
  const parsed = JSON.parse(await readFile(path, "utf8"));
  if (parsed.schemaVersion !== CAMPAIGN_SCHEMA_VERSION || !Array.isArray(parsed.runs)) {
    throw new Error("Campaign state file has an unsupported schema");
  }
  return parsed;
}

export async function saveCampaign(path, campaign) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(campaign, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

export function summarizeRuns(runs) {
  const count = (predicate) => runs.filter(predicate).length;
  return {
    total: runs.length,
    eligible: count((entry) => entry.eligibility === "eligible"),
    alreadyV2: count((entry) => entry.exclusionReason === "already_v2"),
    activePipelineWork: count((entry) => entry.exclusionReason === "active_pipeline_work"),
    rejected: count((entry) => entry.exclusionReason === "rejected"),
    preflightPassed: count((entry) => entry.preflight?.status === "passed"),
    preflightFailed: count((entry) => entry.preflight?.status === "failed"),
    reviewReady: count((entry) => entry.execution?.status === "review_ready"),
    failed: count((entry) => entry.execution?.status === "failed"),
  };
}

export function pngDimensions(bytes) {
  const value = Buffer.from(bytes);
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (value.byteLength < 24 || !value.subarray(0, 8).equals(signature)) {
    throw new Error("Artifact is not a readable PNG");
  }
  return { width: value.readUInt32BE(16), height: value.readUInt32BE(20) };
}

export async function runWorkerForRun(root, runId, spawnImpl = spawn) {
  const script = join(root, "scripts/local-supervisor/knowledge-bits-worker-tick.zsh");
  await new Promise((resolvePromise, rejectPromise) => {
    const child = spawnImpl("/bin/zsh", [script], {
      cwd: root,
      env: {
        ...process.env,
        KNOWLEDGE_BITS_ROOT: root,
        ENGINE_WORKER_PREFERRED_RUN_ID: runId,
        ENGINE_WORKER_MAX_JOBS_PER_TICK: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", (chunk) => process.stdout.write(chunk));
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    child.on("error", rejectPromise);
    child.on("close", (code) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`Targeted worker exited with code ${code}`));
    });
  });
}

export async function assertWorkerIdle({ temporaryDirectory = process.env.TMPDIR || "/tmp" } = {}) {
  const lockOwner = join(temporaryDirectory, "knowledge-bits-worker-tick.lock", "pid");
  let value;
  try {
    value = (await readFile(lockOwner, "utf8")).trim();
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  const pid = Number(value);
  if (!Number.isInteger(pid) || pid <= 0) return;
  try {
    process.kill(pid, 0);
  } catch (error) {
    if (error?.code === "ESRCH") return;
    throw error;
  }
  throw new Error(`Another Knowledge Bits worker is active (pid ${pid}); no run was queued`);
}

function compareCampaignRuns(left, right) {
  return left.priority - right.priority
    || String(left.source?.updatedAt ?? "").localeCompare(String(right.source?.updatedAt ?? ""))
    || left.title.localeCompare(right.title);
}

function sameRecipe(left, right) {
  return left?.id === right?.id
    && left?.version === right?.version
    && left?.checksum === right?.checksum;
}

function artifactSnapshot(asset) {
  if (!asset?.artifactId) return null;
  return {
    artifactId: asset.artifactId,
    checksum: asset.checksum,
    byteSize: asset.byteSize,
    mediaType: asset.mediaType,
  };
}

async function mapLimit(values, limit, operation) {
  const result = new Array(values.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await operation(values[index], index);
    }
  });
  await Promise.all(workers);
  return result;
}

async function responseError(response, label) {
  const payload = await response.json().catch(() => ({}));
  return payload.error ?? `${label} returned ${response.status}`;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function requiredEnvironment(name, alternatives = []) {
  for (const candidate of [name, ...alternatives]) {
    const value = process.env[candidate]?.trim();
    if (value) return value;
  }
  throw new Error(`${[name, ...alternatives].join(" or ")} is required`);
}

function parseArgs(values) {
  const command = values.shift();
  if (!["plan", "preflight", "run", "status"].includes(command)) {
    throw new Error("Usage: infographic-replacement-round.mjs <plan|preflight|run|status> [--state path] [--limit 5] [--json]");
  }
  const args = { command, json: false };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (value === "--json") {
      args.json = true;
      continue;
    }
    if (!["--state", "--limit"].includes(value)) throw new Error(`Unexpected argument: ${value}`);
    const next = values[index + 1];
    if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
    args[value.slice(2)] = next;
    index += 1;
  }
  return args;
}

function printCampaign(campaign, { json = false } = {}) {
  if (json) {
    console.log(JSON.stringify(campaign, null, 2));
    return;
  }
  console.log(`Campaign: ${campaign.campaignId}`);
  console.log(`Recipe: ${campaign.recipe.id}@${campaign.recipe.version}`);
  console.log(`Summary: ${JSON.stringify(campaign.summary)}`);
  for (const entry of campaign.runs) {
    if (entry.eligibility === "eligible") {
      console.log([
        entry.execution?.status ?? "not_started",
        entry.preflight?.status ?? "not_run",
        entry.title,
        entry.reviewUrl,
      ].join("\t"));
    }
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = resolve(process.env.KNOWLEDGE_BITS_ROOT ?? process.cwd());
  const statePath = args.state
    ? (isAbsolute(args.state) ? args.state : resolve(args.state))
    : join(root, ".local-supervisor/infographic-replacement-campaign-v2.json");
  const reviewBaseUrl = process.env.KNOWLEDGE_BITS_REVIEW_URL?.trim()
    ?? `http://127.0.0.1:${process.env.KNOWLEDGE_BITS_REVIEW_PORT?.trim() || "4323"}`;
  const recipe = await loadInfographicRecipe(root);
  const api = new CampaignApi({
    baseUrl: requiredEnvironment("KNOWLEDGE_BITS_LOCAL_API_URL", ["ENGINE_API_BASE_URL"]),
    apiToken: requiredEnvironment("ENGINE_API_TOKEN"),
    reviewToken: requiredEnvironment("ENGINE_REVIEW_TOKEN"),
    reviewerId: process.env.REVIEW_LOCAL_OPERATOR_ID?.trim() || "infographic-campaign-operator",
  });
  const save = (campaign) => saveCampaign(statePath, campaign);

  if (args.command === "plan") {
    const campaign = await buildCampaignPlan({ api, recipe, reviewBaseUrl });
    printCampaign(campaign, args);
    return;
  }
  if (args.command === "preflight") {
    const campaign = await buildCampaignPlan({ api, recipe, reviewBaseUrl });
    await preflightCampaign({ api, campaign, save });
    printCampaign(campaign, args);
    console.log(`State: ${statePath}`);
    return;
  }
  const campaign = await loadCampaign(statePath);
  if (args.command === "status") {
    printCampaign(campaign, args);
    return;
  }
  const limit = args.limit === undefined ? DEFAULT_LIMIT : Number(args.limit);
  const result = await runCampaignRound({
    api,
    campaign,
    limit,
    save,
    loadRecipe: () => loadInfographicRecipe(root),
    runWorker: (runId) => runWorkerForRun(root, runId),
    ensureWorkerIdle: () => assertWorkerIdle(),
  });
  printCampaign(result.campaign, args);
  console.log(`Completed this round: ${result.completed.length}`);
  console.log(`State: ${statePath}`);
}

const executedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(errorMessage(error));
    process.exitCode = 1;
  });
}
