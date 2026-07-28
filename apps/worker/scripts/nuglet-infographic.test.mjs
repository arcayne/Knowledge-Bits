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
  assert.equal(source.deck, "A visible next step makes interrupted work easier to resume.");
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

test("keeps authoritative Feynman copy intact when it needs the long-copy layout", async () => {
  const content = await fixtureContent();
  content.payload.visual.title = "The One-Sentence Test for True Understanding";
  content.payload.identity.deck = "Stop rereading your notes. Discover the fastest way to expose your knowledge gaps and master complex ideas.";
  content.payload.visual.mediaBrief.objective = "Make You can test whether you understand one idea by explaining it plainly, from memory, and naming the first unclear step. easy to remember.";
  content.payload.visual.textEquivalent = [
    "You can test whether you understand one idea by explaining it plainly, from memory, and naming the first unclear step.",
    "Familiarity is not understanding; true comprehension requires you to explain the idea plainly from memory.",
    "Pick one idea and explain it in plain language from memory. Circle the part where you get vague.",
  ];
  content.payload.learning.oneLineToKeep = "Familiarity is not understanding; true comprehension requires you to explain the idea plainly from memory.";

  const rendered = await renderNugletInfographic(content, {
    stageLabels: ["Explain plainly", "Test familiarity", "Circle the gap"],
    symbols: ["speech", "mirror", "knot"],
    accent: "sage",
    path: "loop",
  });
  const metadata = await sharp(rendered.bytes).metadata();

  assert.equal(metadata.width, NUGLET_INFOGRAPHIC_WIDTH);
  assert.equal(metadata.height, NUGLET_INFOGRAPHIC_HEIGHT);
  for (const line of content.payload.visual.textEquivalent) {
    assert.match(rendered.svg, new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("fails closed instead of truncating checked learner copy", async () => {
  const content = await fixtureContent();
  content.payload.visual.textEquivalent[0] = "This checked teaching step is intentionally far too long for the five-line phone layout and must remain intact rather than being silently shortened with an ellipsis or rewritten by the rendering layer.";

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
