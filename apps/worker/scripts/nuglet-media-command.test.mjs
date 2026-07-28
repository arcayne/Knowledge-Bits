import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  authoritativeHeroDirection,
  checkedHeroDirection,
  heroPrompt,
  heroVisualReviewPrompt,
  heroReplacementPath,
  isNotebookLmArtifactPropagationDelay,
  normalizeLegacyHero,
  notebookLmPrompt,
  prepareCurrentMediaLanes,
  parseHeroVisualReview,
  publicPreviewEndCardArtwork,
  reusableNotebookLmArtifact,
  shouldReuseLegacyMedia,
} from "./nuglet-media-command.mjs";

const execFileAsync = promisify(execFile);

test("Knowledge Bits hero prompt preserves the Nuglet hero standard", () => {
  const prompt = heroPrompt({
    title: "Personal Finance 101",
    hook: "Small systems make money easier to manage.",
    takeaway: "Choose one useful money action today.",
  });

  assert.match(prompt, /single-scene editorial web hero illustration/);
  assert.match(prompt, /horizontal 4:3 composition/);
  assert.match(prompt, /imagery only/);
  assert.match(prompt, /every readable mark is removed/);
  assert.match(prompt, /warm cream paper/);
  assert.match(prompt, /pale watercolor or gouache washes/);
  assert.match(prompt, /airy and low contrast/);
  assert.match(prompt, /normally two or three object types/);
  assert.match(prompt, /one asymmetrical editorial still life/);
  assert.match(prompt, /central open ceramic vessel/);
  assert.match(prompt, /Avoid three equal objects arranged in a row/);
  assert.match(prompt, /Avoid dense foliage/);
  assert.match(prompt, /Blank notebooks, closed laptops, and simple human figures are allowed/);
  assert.match(prompt, /watercolor or gouache washes/);
  assert.match(prompt, /one clear visual metaphor/);
  assert.match(prompt, /Do not make an infographic/);
  assert.match(prompt, /No text, no words, no letters, no numbers/);
  assert.match(prompt, /no compass markings/);
});

test("checked nested hero brief overrides the generic intake direction", () => {
  const content = {
    kind: "nuglet.lesson.v1",
    schemaVersion: "1.1.0",
    payload: {
      learning: {
        centralIdea: "Match the message to the customer's state of awareness.",
        oneLineToKeep: "Channel existing desire instead of manufacturing it.",
      },
      read: {
        story: { title: "Stop Pushing and Start Channeling" },
      },
      hero: {
        mediaBrief: {
          concept: "Tuning into the customer's exact frequency.",
          metaphor: "A hand adjusts one radio dial until a single signal becomes clear.",
          compositionFamily: "single-scene editorial",
        },
      },
    },
  };
  const intakeDirection = {
    concept: "Your Customer Is Not Ready for the Same Message",
    metaphor: "A clear bridge from uncertainty to practical understanding.",
    mustInclude: ["a visible transition from uncertainty"],
  };

  assert.deepEqual(checkedHeroDirection(content), content.payload.hero.mediaBrief);
  assert.deepEqual(authoritativeHeroDirection(content, intakeDirection), content.payload.hero.mediaBrief);
  const prompt = heroPrompt(content, intakeDirection);
  assert.match(prompt, /Stop Pushing and Start Channeling/);
  assert.match(prompt, /Tuning into the customer's exact frequency/);
  assert.match(prompt, /hand adjusts one radio dial/);
  assert.match(prompt, /single-scene editorial/);
  assert.match(prompt, /Every visible object must be explicitly required/);
  assert.doesNotMatch(prompt, /Knowledge Bit/);
  assert.doesNotMatch(prompt, /clear bridge/i);
  assert.doesNotMatch(prompt, /visible transition from uncertainty/i);
  assert.doesNotMatch(prompt, /generic bridge, path, notebook/);
});

test("checked hero brief also overrides older title-specific scene hacks", () => {
  const prompt = heroPrompt({
    payload: {
      read: { story: { title: "You Logged Off. Your Mind Did Not." } },
      hero: {
        mediaBrief: {
          concept: "Close the loop before leaving work.",
          metaphor: "One hand places a single unfinished card into a quiet holding tray.",
          compositionFamily: "single-scene editorial",
        },
      },
    },
  }, {});
  assert.match(prompt, /single unfinished card/);
  assert.doesNotMatch(prompt, /plain closed laptop/);
  assert.doesNotMatch(prompt, /clay-orange watercolor thought loop/);
});

test("hero prompt retains intake direction only when checked content has no hero brief", () => {
  const intakeDirection = {
    concept: "A specific lesson",
    metaphor: "One hand places a final stone into a stable arch.",
    compositionFamily: "asymmetrical-story",
  };
  assert.deepEqual(authoritativeHeroDirection({
    payload: { learning: { centralIdea: "A specific lesson" } },
  }, intakeDirection), intakeDirection);
});

test("hero visual review checks semantic, style, clutter, and crop conformance", () => {
  const content = {
    payload: {
      hero: {
        mediaBrief: {
          concept: "Tune into the customer's exact frequency.",
          metaphor: "One hand adjusts a radio dial until a single signal becomes clear.",
          compositionFamily: "single-scene editorial",
        },
      },
    },
  };
  const prompt = heroVisualReviewPrompt(content, {});
  assert.match(prompt, /Tune into the customer's exact frequency/);
  assert.match(prompt, /one hand adjusts a radio dial/i);
  assert.match(prompt, /generic bridge/);
  assert.match(prompt, /readable icon glyphs/);
  assert.match(prompt, /centered wide lesson-header crop/);
});

test("hero visual review requires a strict decision with concrete failed corrections", () => {
  assert.deepEqual(parseHeroVisualReview('{"passed":true,"issues":[]}'), { passed: true, issues: [] });
  assert.deepEqual(
    parseHeroVisualReview('```json\n{"passed":false,"issues":["Remove the icon tiles.","Use one radio."]}\n```'),
    { passed: false, issues: ["Remove the icon tiles.", "Use one radio."] },
  );
  assert.throws(() => parseHeroVisualReview('{"passed":false,"issues":[]}'), /invalid decision/);
  assert.throws(() => parseHeroVisualReview("not json"), /invalid JSON/);
});

test("Knowledge Bits hero prompt keeps the work and care story specific", () => {
  const prompt = heroPrompt({
    title: "When Two Important Things Need You",
    hook: "Sometimes two real responsibilities arrive at once.",
    takeaway: "Choose what needs you now without pretending the other does not matter.",
  });

  assert.match(prompt, /quiet collision between work and care/);
  assert.match(prompt, /closed, unmarked laptop/);
  assert.match(prompt, /open blank notebook/);
  assert.match(prompt, /adult-and-child pair/);
  assert.match(prompt, /clay-orange thread to connect/);
  assert.match(prompt, /Avoid scales, split screens/);
  assert.match(prompt, /generic stone-to-seedling growth metaphor/);
});

test("Knowledge Bits hero prompt gives logged-off work one coherent action", () => {
  const prompt = heroPrompt({
    title: "You Logged Off. Your Mind Did Not.",
    hook: "Unfinished work can follow attention home.",
    takeaway: "Park one next action before logging off.",
  });

  assert.match(prompt, /integrated editorial moment/);
  assert.match(prompt, /plain closed laptop/);
  assert.match(prompt, /small open blank notebook/);
  assert.match(prompt, /clay-orange watercolor thought loop/);
  assert.match(prompt, /never a physical cord, string, cable, ribbon, path, or arrow/);
  assert.match(prompt, /pillow, blanket, cup, mug/);
  assert.doesNotMatch(prompt, /task token/);
  assert.doesNotMatch(prompt, /paper task card/);
  assert.doesNotMatch(prompt, /follow attention home/);
  assert.doesNotMatch(prompt, /You Logged Off/);
  assert.match(prompt, /normally two or three object types/);
  assert.doesNotMatch(prompt, /usually three to six/);
});

test("Knowledge Bits hero generation converts narrative references into blurred style swatches", async () => {
  const source = await readFile(new URL("./nuglet-media-command.mjs", import.meta.url), "utf8");
  assert.match(source, /personal-finance-101-hero\.png/);
  assert.match(source, /not-every-thought-is-your-task-hero\.png/);
  assert.match(source, /and-then-what-the-question-behind-every-good-decision-hero\.png/);
  assert.match(source, /styleReferences\.map/);
  assert.equal(source.includes(".resize(96, 96"), true);
  assert.equal(source.includes(".blur(10)"), true);
  assert.match(source, /blurred palette-and-texture swatches only/);
});

test("operator hero replacement is restricted to one explicit run", () => {
  const env = {
    KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_RUN_ID: "run-target",
    KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_PATH: "/tmp/replacement.png",
  };
  assert.equal(heroReplacementPath({ runId: "another-run" }, env), undefined);
  assert.throws(
    () => heroReplacementPath({ runId: "run-target" }, {
      KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_RUN_ID: "run-target",
    }),
    /Both KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_RUN_ID/,
  );
});

test("NotebookLM media prompts are stable and keep Brief and Discussion distinct", () => {
  const input = {
    content: {
      title: "Noticing the Gap Does Not Make It Yours",
      hook: "A visible problem is not automatically your responsibility.",
      takeaway: "Choose ownership deliberately.",
    },
    generationInputChecksum: "a".repeat(64),
    recipeSnapshots: {
      infographic: recipe("nuglet.visual.infographic"),
      audioBrief: recipe("nuglet.audio.brief"),
      audioDiscussion: recipe("nuglet.audio.discussion"),
    },
  };

  const infographic = notebookLmPrompt(input, "infographic");
  const brief = notebookLmPrompt(input, "audio_brief");
  const discussion = notebookLmPrompt(input, "audio_discussion");
  assert.match(infographic, /knowledge-bits:aaaaaaaaaaaaaaaa:infographic/);
  assert.match(brief, /nuglet\.audio\.brief/);
  assert.match(discussion, /nuglet\.audio\.discussion/);
  assert.notEqual(brief, discussion);
});

test("public preview marker binds the prompt contract version", () => {
  const prompt = notebookLmPrompt({
    content: {
      kind: "nuglet.lesson.v1",
      schemaVersion: "1.1.0",
      payload: {
        identity: { title: "Protect Your Attention" },
        learning: {
          centralIdea: "Visible cues make attention easier to pull away.",
          oneLineToKeep: "Design the setup before relying on effort.",
          action: { instruction: "Put the phone away for one focus block." },
        },
      },
    },
    generationInputChecksum: "a".repeat(64),
  }, "public_preview");

  assert.match(
    prompt,
    /\[knowledge-bits:aaaaaaaaaaaaaaaa:public_preview:nuglet\.public-preview@1\.4\.0\]/,
  );
});

test("NotebookLM artifact propagation 404s remain retryable", () => {
  assert.equal(
    isNotebookLmArtifactPropagationDelay(
      "Audio media URL returned 404 while propagating; retrying in 60s",
    ),
    true,
  );
  assert.equal(
    isNotebookLmArtifactPropagationDelay("Artifact returned 404 and is not yet available"),
    true,
  );
  assert.equal(isNotebookLmArtifactPropagationDelay("NotebookLM authentication failed"), false);
  assert.equal(isNotebookLmArtifactPropagationDelay("Source URL returned 404"), false);
});

test("Nuglet infographic recipe reserves a disposable footer and rejects dense poster styling", async () => {
  const recipePath = new URL(
    "../../../recipes/nuglet.lesson.v1/nuglet.visual.infographic-1.1.0.json",
    import.meta.url,
  );
  const visualRecipe = JSON.parse(await readFile(recipePath, "utf8"));
  const prompt = visualRecipe.instructions.join(" ");
  const adapter = await readFile(
    new URL("./nuglet-media-command.mjs", import.meta.url),
    "utf8",
  );

  assert.equal(visualRecipe.version, "1.1.0");
  assert.match(prompt, /bottom 4 percent/);
  assert.match(prompt, /production pipeline crops the band away/);
  assert.match(prompt, /one memorable editorial metaphor/);
  assert.match(prompt, /70 words or fewer/);
  assert.match(prompt, /not a classroom poster/);
  assert.match(prompt, /Victorian or retro scientific plate/);
  assert.match(adapter, /"--detail", "concise", "--style", "editorial"/);
});

test("hero and NotebookLM media preparation start concurrently", async () => {
  let releaseHero;
  let releaseNotebookLm;
  const started = [];
  const hero = new Promise((resolve) => { releaseHero = resolve; });
  const notebookLm = new Promise((resolve) => { releaseNotebookLm = resolve; });

  const pending = prepareCurrentMediaLanes({}, ["hero", "infographic"], {
    generateHeroAsset: async () => {
      started.push("hero");
      return hero;
    },
    ensureNotebookLm: async () => {
      started.push("notebooklm");
      return notebookLm;
    },
  });

  await Promise.resolve();
  assert.deepEqual(started.sort(), ["hero", "notebooklm"]);
  releaseHero({ kind: "hero" });
  releaseNotebookLm({ notebookId: "notebook", tracked: new Map() });
  assert.deepEqual(await pending, [
    { kind: "hero" },
    { notebookId: "notebook", tracked: new Map() },
  ]);
});

test("public preview regeneration bypasses retained legacy media", () => {
  const legacyMediaReuse = { source: "nuglet_published" };

  assert.equal(shouldReuseLegacyMedia({
    kinds: ["public_preview"],
    legacyMediaReuse,
    mediaOperation: "generate",
  }), false);
  assert.equal(shouldReuseLegacyMedia({
    kinds: ["hero", "infographic"],
    legacyMediaReuse,
    mediaOperation: "attach_existing",
  }), true);
  assert.equal(shouldReuseLegacyMedia({
    kinds: ["hero", "infographic"],
    legacyMediaReuse,
  }), true);
});

test("public preview end card uses the immutable Nuglet hero receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-bits-end-card-artwork-test-"));
  const relativePath = "migration/hero.png";
  const sourcePath = join(root, relativePath);
  const bytes = await readFile(
    new URL("../assets/nuglet-style/personal-finance-101-hero.png", import.meta.url),
  );
  try {
    await mkdir(join(root, "migration"), { recursive: true });
    await writeFile(sourcePath, bytes);
    const artwork = await publicPreviewEndCardArtwork({
      legacyMediaReuse: {
        artifacts: {
          hero: {
            path: relativePath,
            mediaType: "image/png",
            byteSize: bytes.byteLength,
            checksum: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
          },
        },
      },
    }, undefined, { NUGLET_LEGACY_REUSE_ROOT: root });

    assert.equal(artwork?.source, "legacy_nuglet_hero");
    assert.deepEqual(artwork?.bytes, bytes);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("forced NotebookLM regeneration creates once, then reuses its current-prompt sidecar", () => {
  const marker = "[knowledge-bits:aaaaaaaaaaaaaaaa:public_preview:nuglet.public-preview@1.4.0]";
  const artifacts = [
    {
      id: "matching-video",
      type: "video",
      status: "completed",
      custom_instructions: marker,
    },
    {
      id: "old-sidecar-video",
      type: "video",
      status: "completed",
      custom_instructions: "[knowledge-bits:aaaaaaaaaaaaaaaa:public_preview]",
    },
    {
      id: "current-sidecar-video",
      type: "video",
      status: "in_progress",
      custom_instructions: marker,
    },
  ];
  const input = {
    artifacts,
    kind: "public_preview",
    marker,
    stateArtifactId: "old-sidecar-video",
    wantedKinds: ["public_preview"],
  };

  assert.equal(reusableNotebookLmArtifact(input)?.id, "matching-video");
  assert.equal(reusableNotebookLmArtifact({
    ...input,
    regeneratedKinds: ["public_preview"],
  }), undefined);
  assert.equal(reusableNotebookLmArtifact({
    ...input,
    stateArtifactId: "current-sidecar-video",
    regeneratedKinds: ["public_preview"],
  })?.id, "current-sidecar-video");
});

function recipe(id) {
  const canonical = JSON.stringify({ id, version: "1.0.0", instructions: [`Create ${id}.`] });
  return {
    id,
    version: "1.0.0",
    checksum: `sha256:${"b".repeat(64)}`,
    canonicalBase64: Buffer.from(canonical).toString("base64"),
  };
}

test("legacy heroes are cropped to 4:3 after receipt verification", {
  skip: process.platform !== "darwin" && "The local migration worker uses macOS sips",
}, async () => {
  const root = await mkdtemp(join(tmpdir(), "knowledge-bits-legacy-hero-test-"));
  const source = new URL("../assets/nuglet-style/personal-finance-101-hero.png", import.meta.url).pathname;
  const wide = join(root, "wide.png");
  const square = join(root, "square.png");
  const squareWebp = join(root, "square.webp");
  try {
    await execFileAsync("sips", ["--resampleHeightWidth", "864", "1184", source, "--out", wide]);
    const normalized = await normalizeLegacyHero(await readFile(wide), "image/png");
    assert.deepEqual(normalized.dimensions, { width: 1152, height: 864 });
    assert.notDeepEqual(normalized.bytes, await readFile(wide));

    await execFileAsync("sips", ["--resampleHeightWidth", "1254", "1254", source, "--out", square]);
    const normalizedSquare = await normalizeLegacyHero(await readFile(square), "image/png");
    assert.deepEqual(normalizedSquare.dimensions, { width: 1252, height: 939 });

    await execFileAsync("cwebp", ["-quiet", "-resize", "1254", "1254", source, "-o", squareWebp]);
    const normalizedWebp = await normalizeLegacyHero(await readFile(squareWebp), "image/webp");
    assert.deepEqual(normalizedWebp.dimensions, { width: 1252, height: 939 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
