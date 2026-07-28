import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import sharp from "sharp";

import {
  infographicPlanningPrompt,
  infographicSource,
  NUGLET_INFOGRAPHIC_HEIGHT,
  NUGLET_INFOGRAPHIC_RENDERER_VERSION,
  NUGLET_INFOGRAPHIC_WIDTH,
  parseInfographicArtDirection,
  renderNugletInfographic,
} from "./nuglet-infographic.mjs";

async function fixtureContent() {
  const fixture = JSON.parse(await readFile(
    new URL("../src/providers/fixtures/notebooklm-story-playbook.json", import.meta.url),
    "utf8",
  ));
  return fixture.answer;
}

test("uses only checked lesson visual copy for the rendered teaching sequence", async () => {
  const source = infographicSource(await fixtureContent());

  assert.equal(source.title, "The restart marker");
  assert.equal(source.deck, "Show how a visible next step reduces restart friction.");
  assert.deepEqual(source.steps, [
    "Pause after a meaningful unit of work.",
    "Write the next visible step.",
    "Restart with that step for five minutes.",
  ]);
  assert.equal(source.closing, "Leave a visible next step before you stop.");
});

test("planner may choose art direction but cannot rewrite learner-facing copy", async () => {
  const prompt = infographicPlanningPrompt(await fixtureContent(), '{"version":"2.0.0"}');

  assert.match(prompt, /Do not rewrite, summarize, correct, or return the learner-facing copy/);
  assert.match(prompt, /stageLabels must contain exactly 3 labels/);
  assert.match(prompt, /book, speech, knot, bridge/);
  assert.match(prompt, /No markdown, commentary, extra keys/);
});

test("rejects open-ended or structurally invalid art direction", () => {
  assert.deepEqual(
    parseInfographicArtDirection(
      '{"stageLabels":["Pause clearly","Mark the return","Begin again"],"symbols":["book","thread","steps"],"accent":"sage","path":"loop"}',
      3,
    ),
    {
      stageLabels: ["Pause clearly", "Mark the return", "Begin again"],
      symbols: ["book", "thread", "steps"],
      accent: "sage",
      path: "loop",
    },
  );
  assert.throws(
    () => parseInfographicArtDirection(
      '{"stageLabels":["Pause","Mark","Restart"],"symbols":["book","invented","steps"],"accent":"sage","path":"loop"}',
      3,
    ),
    /invalid symbols/,
  );
  assert.throws(
    () => parseInfographicArtDirection(
      '{"stageLabels":["Pause","Mark","Restart"],"symbols":["book","thread","steps"],"accent":"sage","path":"loop","copy":"invented"}',
      3,
    ),
    /unsupported keys/,
  );
});

test("renders a full-size portrait PNG with bundled Nuglet typography", async () => {
  const content = await fixtureContent();
  const rendered = await renderNugletInfographic(content, {
    stageLabels: ["Pause clearly", "Leave a marker", "Begin again"],
    symbols: ["book", "thread", "steps"],
    accent: "sage",
    path: "loop",
  });
  const metadata = await sharp(rendered.bytes).metadata();

  assert.equal(metadata.width, NUGLET_INFOGRAPHIC_WIDTH);
  assert.equal(metadata.height, NUGLET_INFOGRAPHIC_HEIGHT);
  assert.equal(metadata.format, "png");
  assert.match(rendered.svg, /Nuglet Fraunces/);
  assert.match(rendered.svg, /The restart marker/);
  assert.match(rendered.svg, /Write the next visible step/);
  assert.equal(NUGLET_INFOGRAPHIC_RENDERER_VERSION, "nuglet-editorial-svg@1.0.0");
});

test("fails closed instead of truncating checked learner copy", async () => {
  const content = await fixtureContent();
  content.payload.visual.textEquivalent[0] = "This checked teaching step is intentionally far too long for the four-line phone layout and must remain intact rather than being silently shortened with an ellipsis or rewritten by the rendering layer.";

  await assert.rejects(
    () => renderNugletInfographic(content, {
      stageLabels: ["Pause clearly", "Leave a marker", "Begin again"],
      symbols: ["book", "thread", "steps"],
      accent: "sage",
      path: "loop",
    }),
    /checked copy exceeds/,
  );
});
