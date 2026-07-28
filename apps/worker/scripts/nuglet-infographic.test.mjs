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

test("uses checked playbook copy when a legacy visual text equivalent is production direction", async () => {
  const content = await fixtureContent();
  content.payload.visual.textEquivalent = [
    "An infographic showing a dense production description that is intentionally much too long to serve as learner-facing stage copy in the branded visual summary layout.",
    "A second panel description with implementation language that remains checked content but is not the clearest available learner-facing sequence for this visual.",
  ];
  content.payload.read.playbook.steps = [
    {
      title: "Notice the fragments",
      body: "This checked body is intentionally far too long for the five-line stage layout because the concise checked title is the safer learner-facing source for the deterministic visual summary without any rewriting.",
    },
    {
      title: "Protect real rest",
      body: "This second checked body is also intentionally far too long for the five-line stage layout so the renderer must select the concise checked title instead of truncating or asking the planner to rewrite it.",
    },
  ];

  const source = infographicSource(content);

  assert.deepEqual(source.steps, ["Notice the fragments", "Protect real rest"]);
});

test("supports a three-line checked closing across the full footer width", async () => {
  const content = await fixtureContent();
  content.payload.learning.oneLineToKeep = "Because our intuition is calibrated for linear change, early exponential growth feels unremarkable until explosive acceleration arrives as a surprise.";

  const rendered = await renderNugletInfographic(content, {
    stageLabels: ["Pause clearly", "Leave a marker", "Begin again"],
    symbols: ["book", "thread", "steps"],
    accent: "sage",
    path: "loop",
  });

  assert.match(rendered.svg, /BECAUSE OUR INTUITION IS CALIBRATED FOR LINEAR CHANGE/);
  assert.match(rendered.svg, /EXPLOSIVE/);
  assert.match(rendered.svg, /ACCELERATION/);
  assert.match(rendered.svg, /SURPRISE/);
});

test("fails closed instead of truncating checked learner copy", async () => {
  const content = await fixtureContent();
  const tooLongA = "This first checked teaching step is intentionally far too long for the five-line phone layout and must remain intact rather than being silently shortened with an ellipsis or rewritten by the rendering layer. It remains deliberately verbose so no available checked sequence can fit.";
  const tooLongB = "This second checked teaching step is intentionally far too long for the five-line phone layout and must remain intact rather than being silently shortened with an ellipsis or rewritten by the rendering layer. It remains deliberately verbose so no available checked sequence can fit.";
  content.payload.visual.textEquivalent = [tooLongA, tooLongB];
  content.payload.read.playbook.steps = [
    { title: tooLongA, body: tooLongA },
    { title: tooLongB, body: tooLongB },
  ];
  content.payload.learning.whyItMatters = tooLongA;
  content.payload.learning.action.instruction = tooLongB;

  await assert.rejects(
    () => renderNugletInfographic(content, {
      stageLabels: ["First step", "Second step"],
      symbols: ["book", "thread"],
      accent: "sage",
      path: "loop",
    }),
    /checked copy exceeds/,
  );
});
