import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  PUBLIC_PREVIEW_END_CARD_VERSION,
  PUBLIC_PREVIEW_MAX_SECONDS,
  publicPreviewEndCardPlan,
  renderPublicPreviewVideo,
  wrapEndCardTitle,
} from "./nuglet-public-preview-renderer.mjs";

const execFileAsync = promisify(execFile);

test("end-card plan replaces the provider tail without cutting its narration", () => {
  const plan = publicPreviewEndCardPlan({
    durationSeconds: 63.39,
    width: 720,
    height: 1280,
    hasAudio: true,
  }, "Protect Your Attention");

  assert.deepEqual(plan.titleLines, ["Protect Your", "Attention"]);
  assert.equal(plan.providerTailSeconds, 8);
  assert.equal(plan.contentDurationSeconds, 55.39);
  assert.equal(plan.audioSourceDurationSeconds, 63.39);
  assert.equal(plan.audioTailTrimSeconds, 0);
  assert.equal(plan.endCardDurationSeconds, 8);
  assert.equal(plan.finalDurationSeconds, 63.39);
});

test("title wrapping remains bounded for longer Nuglet names", () => {
  assert.deepEqual(
    wrapEndCardTitle("Why Your Best Explanation Can Still Be Wrong"),
    ["Why Your Best", "Explanation Can", "Still Be Wrong"],
  );
});

test("long provider videos are trimmed to the review duration ceiling", () => {
  const plan = publicPreviewEndCardPlan({
    durationSeconds: 95.124,
    width: 720,
    height: 1280,
    hasAudio: true,
  }, "The hard book was teaching me how to think slowly");

  assert.equal(plan.finalDurationSeconds, PUBLIC_PREVIEW_MAX_SECONDS);
  assert.equal(plan.audioSourceDurationSeconds, PUBLIC_PREVIEW_MAX_SECONDS);
  assert.equal(plan.contentDurationSeconds, 87);
  assert.ok(Math.abs(plan.providerTailSeconds - 8.124) < 0.001);
  assert.equal(plan.endCardDurationSeconds, 3);
  assert.ok(Math.abs(plan.audioTailTrimSeconds - 5.124) < 0.001);
});

test("renderer creates a branded vertical review artifact without provider generation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "knowledge-bits-end-card-test-"));
  const sourcePath = join(directory, "source.mp4");
  const finalPath = join(directory, "final.mp4");
  try {
    await execFileAsync("ffmpeg", [
      "-y",
      "-f", "lavfi",
      "-i", "color=c=0xF7F3EE:s=720x1280:d=3",
      "-f", "lavfi",
      "-i", "sine=frequency=440:duration=3",
      "-shortest",
      "-c:v", "libx264",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      sourcePath,
    ], { timeout: 120_000 });
    const rendered = await renderPublicPreviewVideo(
      await readFile(sourcePath),
      "The book that fixed my overthinking wasn't about overthinking at all",
      {
        providerTailSeconds: 1,
        endCardDurationSeconds: 1,
        endCardArtworkBytes: await readFile(
          new URL("../assets/nuglet-style/not-every-thought-is-your-task-hero.png", import.meta.url),
        ),
      },
    );
    await writeFile(finalPath, rendered.bytes);

    assert.equal(rendered.endCardVersion, PUBLIC_PREVIEW_END_CARD_VERSION);
    assert.equal(rendered.providerTailTrimSeconds, 1);
    assert.equal(rendered.narrativeDurationSeconds, 2);
    assert.equal(rendered.audioSourceDurationSeconds, 3);
    assert.equal(rendered.audioTailTrimSeconds, 0);
    assert.equal(rendered.endCardTransitionSeconds, 0.45);
    assert.equal(rendered.endCardVoiceOverlapSeconds, 0.65);
    assert.ok(Math.abs(rendered.metadata.durationSeconds - 3) < 0.1);
    assert.equal(rendered.metadata.width, 720);
    assert.equal(rendered.metadata.height, 1280);
    assert.equal(rendered.metadata.hasAudio, true);
    assert.match(rendered.endCardBackgroundChecksum, /^sha256:[a-f0-9]{64}$/);
    assert.match(rendered.endCardArtworkChecksum, /^sha256:[a-f0-9]{64}$/);
    assert.match(rendered.logoChecksum, /^sha256:[a-f0-9]{64}$/);

    const audioCheck = await execFileAsync("ffmpeg", [
      "-i", finalPath,
      "-af", "silencedetect=noise=-35dB:d=0.2",
      "-f", "null",
      "-",
    ], { timeout: 120_000 });
    assert.doesNotMatch(
      audioCheck.stderr,
      /silence_start/,
      "provider audio should continue through the rendered end card",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
