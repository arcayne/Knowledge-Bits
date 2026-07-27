import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { GoogleGenAI } from "@google/genai";
import sharp from "sharp";
import {
  compilePublicPreview,
  protectedLeakage,
  publicPreviewSourceTitle,
  renderPublicPreviewPrompt,
  renderPublicPreviewSource,
} from "./nuglet-public-preview.mjs";
import { renderPublicPreviewVideo } from "./nuglet-public-preview-renderer.mjs";

const DEFAULT_MODEL = "gemini-2.5-flash-image";
const DEFAULT_VISUAL_REVIEW_MODEL = "gemini-2.5-flash";
const MAX_HERO_GENERATION_ATTEMPTS = 2;
const DEFAULT_STYLE_REFERENCES = [
  new URL("../assets/nuglet-style/personal-finance-101-hero.png", import.meta.url).pathname,
  new URL("../assets/nuglet-style/not-every-thought-is-your-task-hero.png", import.meta.url).pathname,
  new URL("../assets/nuglet-style/and-then-what-the-question-behind-every-good-decision-hero.png", import.meta.url).pathname,
];
const NOTEBOOKLM_POLL_INTERVAL_MS = 15_000;
const NOTEBOOKLM_POLL_TIMEOUT_MS = 8 * 60_000;
const execFileAsync = promisify(execFile);

class MediaWaitingError extends Error {}

function required(value, name) {
  if (!value?.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function heroReplacementPath(input, env = process.env) {
  const configuredRunId = env.KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_RUN_ID?.trim();
  const configuredPath = env.KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_PATH?.trim();
  if (!configuredRunId && !configuredPath) return undefined;
  if (!configuredRunId || !configuredPath) {
    throw new Error("Both KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_RUN_ID and KNOWLEDGE_BITS_MEDIA_HERO_REPLACEMENT_PATH are required");
  }
  if (input.runId !== configuredRunId) return undefined;
  if (!existsSync(configuredPath)) throw new Error(`operator hero replacement missing: ${configuredPath}`);
  return configuredPath;
}

function heroStyleReferencePaths() {
  const configuredReferences = (process.env.KNOWLEDGE_BITS_MEDIA_STYLE_REFERENCES
    || process.env.KNOWLEDGE_BITS_MEDIA_STYLE_REFERENCE
    || "")
    .split(",")
    .map((path) => path.trim())
    .filter(Boolean);
  return configuredReferences.length ? configuredReferences : DEFAULT_STYLE_REFERENCES;
}

async function heroStyleReferenceChecksums() {
  return (await heroStyleReferences()).map(({ bytes }) => checksum(bytes));
}

async function heroStyleReferences() {
  const paths = heroStyleReferencePaths();
  for (const path of paths) {
    if (!existsSync(path)) throw new Error(`hero style reference missing: ${path}`);
  }
  return Promise.all(paths.map(async (path) => ({
    // Full narrative references caused the image model to copy their subjects
    // and layouts. A heavily blurred swatch preserves palette and paper
    // texture while removing notebooks, icons, props, and composition.
    bytes: await sharp(await readFile(path))
      .resize(96, 96, { fit: "fill" })
      .blur(10)
      .png()
      .toBuffer(),
    mediaType: "image/png",
  })));
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function lessonPayload(content) {
  const value = record(content);
  const payload = record(value.payload);
  return Object.keys(payload).length ? payload : value;
}

function contentText(content) {
  const value = lessonPayload(content);
  const learning = record(value.learning);
  const story = record(record(value.read).story);
  return {
    title: String(value.title ?? story.title ?? learning.centralIdea ?? "Knowledge Bit"),
    hook: String(value.hook ?? learning.centralIdea ?? ""),
    takeaway: String(value.takeaway ?? learning.oneLineToKeep ?? ""),
  };
}

function checkedHeroDirection(content) {
  const mediaBrief = record(record(lessonPayload(content).hero).mediaBrief);
  const concept = typeof mediaBrief.concept === "string" ? mediaBrief.concept.trim() : "";
  const metaphor = typeof mediaBrief.metaphor === "string" ? mediaBrief.metaphor.trim() : "";
  const compositionFamily = typeof mediaBrief.compositionFamily === "string"
    ? mediaBrief.compositionFamily.trim()
    : "";
  return concept && metaphor ? { concept, metaphor, compositionFamily } : undefined;
}

function authoritativeHeroDirection(content, intakeDirection) {
  return checkedHeroDirection(content) ?? record(intakeDirection);
}

function visualDirection(content, heroDirection) {
  const { title } = contentText(content);
  const checkedDirection = checkedHeroDirection(content);
  const direction = authoritativeHeroDirection(content, heroDirection);
  const concept = typeof direction.concept === "string" ? direction.concept.trim() : "";
  const metaphor = typeof direction.metaphor === "string" ? direction.metaphor.trim() : "";
  const compositionFamily = typeof direction.compositionFamily === "string"
    ? direction.compositionFamily.trim()
    : "";
  if (checkedDirection && concept && metaphor) {
    return [
      `Create one physical scene for this exact concept: ${concept}.`,
      `Use this exact metaphor as the sole narrative idea: ${metaphor}.`,
      compositionFamily ? `Composition guidance: ${compositionFamily}.` : "",
      "Do not substitute a generic bridge, path, notebook, tile sequence, or before-and-after transition.",
      "Use one focal action and at most two supporting object types.",
    ].filter(Boolean).join(" ");
  }
  if (/you logged off.*your mind did not/i.test(title)) {
    return [
      "Create one integrated editorial moment about attention residue after work.",
      "Place one plain closed laptop with a blank outer lid in the lower-left and one small open blank notebook in the lower-right.",
      "Above the laptop, paint one loose clay-orange watercolor thought loop. Let it become calmer and smaller as it settles onto the blank notebook page.",
      "The thought loop is a broad translucent watercolor wash, never a physical cord, string, cable, ribbon, path, or arrow.",
      "Use rich layered watercolor, delicate linework, foreground overlap, and soft grounding shadows. Keep generous warm cream breathing room above the compact scene.",
      "Do not add any tray, envelope, card, bowl, jar, tokens, stones, plant, leaves, compass, pillow, blanket, cup, mug, pot, furniture, room, person, phone, destination, arrowhead, decorative prop, or fourth object type.",
    ].join(" ");
  }
  if (/when two important things need you/i.test(title)) {
    return [
      "Create one asymmetrical narrative still life about a quiet collision between work and care.",
      "Place a closed, unmarked laptop in the upper-left background, an open blank notebook in the lower center, and a small adult-and-child pair on the right.",
      "Use one loose clay-orange thread to connect the laptop, notebook, and family so the competing responsibilities feel related rather than presented as separate icons.",
      "Add only restrained leaves, stones, or one small plant as supporting accents, with clear foreground and background depth.",
      "Keep the adult-and-child relationship readable at card size.",
      "Avoid scales, split screens, isolated symbolic objects, a generic stone-to-seedling growth metaphor, and a centered row of objects.",
    ].join(" ");
  }
  if (/personal finance/i.test(title)) {
    return "For this personal finance lesson, create one asymmetrical editorial still life that tells a small story about moving from saving to growth. Use one central open ceramic vessel as the focal point. Let a loose clay-orange thread travel through a few rounded tokens toward a protected seedling. Add only a few soft stones or restrained leaves for depth. Create gentle visual movement across the frame. Avoid three equal objects arranged in a row, repeated icon-like forms, rigid symmetry, panels, and diagram-like composition.";
  }
  if (concept && metaphor) {
    return [
      `Create one physical scene for this exact concept: ${concept}.`,
      `Use this exact metaphor as the sole narrative idea: ${metaphor}.`,
      compositionFamily ? `Composition guidance: ${compositionFamily}.` : "",
      "Do not substitute a generic bridge, path, notebook, tile sequence, or before-and-after transition.",
      "Use one focal action and at most two supporting object types.",
    ].filter(Boolean).join(" ");
  }
  return "Prefer one small narrative action with one focal object and no more than two supporting objects. Do not assemble a decorative lifestyle still life.";
}

function heroDirectionPrompt(content, heroDirection) {
  const { title } = contentText(content);
  const checkedDirection = checkedHeroDirection(content);
  if (!checkedDirection && /you logged off.*your mind did not/i.test(title)) {
    return "Run-specific intent: work is closed, but one lingering watercolor thought loop remains and is given a blank notebook page on which to settle. This scene replaces every older metaphor or object requirement. Use only the final scene decision below.";
  }
  const direction = authoritativeHeroDirection(content, heroDirection);
  if (!Object.keys(direction).length) return "";
  const mustInclude = Array.isArray(direction.mustInclude) ? direction.mustInclude.filter(Boolean) : [];
  const mustAvoid = Array.isArray(direction.mustAvoid) ? direction.mustAvoid.filter(Boolean) : [];
  return [
    `Run-specific intent: ${String(direction.concept ?? "").trim()}.`,
    `Preferred metaphor: ${String(direction.metaphor ?? "").trim()}.`,
    mustInclude.length ? `Semantic requirements: ${mustInclude.join("; ")}.` : "",
    mustAvoid.length ? `Avoid: ${mustAvoid.join("; ")}.` : "",
    "Treat these as an intent hierarchy, not an object checklist. Express them through one physical action and one coherent metaphor.",
    "Collapse overlapping requirements into the same objects. Do not create a separate prop for every noun or phrase.",
    checkedDirection
      ? "This checked content brief is authoritative. Ignore conflicting intake-time metaphors."
      : "The lesson-specific direction above is authoritative when it narrows or simplifies these requirements.",
  ].filter(Boolean).join(" ");
}

function heroPrompt(content, heroDirection) {
  const { title, hook, takeaway } = contentText(content);
  const usesCuratedScene = /you logged off.*your mind did not/i.test(title);
  return [
    "Create one single-scene editorial web hero illustration for a calm, source-backed learning lesson.",
    usesCuratedScene ? "" : `Visual subject guidance only: ${title}.`,
    usesCuratedScene ? "" : `Visual concept guidance only: ${hook || takeaway}.`,
    usesCuratedScene ? "" : `Visual action guidance only: ${takeaway}.`,
    visualDirection(content, heroDirection),
    "Use a horizontal 4:3 composition with the subject centered enough to survive a small card crop.",
    "Match the supplied Nuglet palette-and-texture swatches: warm cream paper, pale watercolor or gouache washes, muted clay orange, moss olive, dusty blue, delicate linework, soft painted edges, quiet editorial illustration, tactile and human.",
    "Keep the image airy and low contrast with one clear visual metaphor, one focal composition, and generous open cream space. Use only the objects needed for one readable action, normally two or three object types and never more than four.",
    "Favor the light, whimsical, gently imperfect Explore-page art direction over realism. Avoid dense foliage, full landscapes, dramatic lighting, heavy shadows, saturated colors, dark high-contrast areas, and intricate realistic detail.",
    "Blank notebooks, closed laptops, and simple human figures are allowed when the approved metaphor needs them. Keep them tactile, simplified, and free of text, interface details, keyboard detail, labels, lists, charts, or readable marks.",
    "Build one small narrative moment with asymmetry and foreground-to-background depth. Do not reduce a lesson-specific relationship to unrelated decorative objects.",
    "Translate the guidance into imagery only. Never render any word, phrase, label, title, caption, letter, number, icon glyph, currency symbol, or readable mark from the guidance.",
    "The supplied images are blurred palette-and-texture swatches only. They contain no approved subject or layout.",
    "Do not make an infographic, grid, diptych, triptych, diagram, card layout, poster, or collection of labeled icons.",
    "The image must remain correct if every readable mark is removed. No text, no words, no letters, no numbers, no labels, no captions, no logos, no watermark, no currency symbols, no compass markings, no printed marks on objects, no UI, no black outlined vector icons, no photorealism, no glossy 3D, no neon gradients, no stock-photo look.",
  ].filter(Boolean).join(" ");
}

function heroVisualReviewPrompt(content, heroDirection) {
  const direction = authoritativeHeroDirection(content, heroDirection);
  return [
    "Act as a strict visual art director for a Nuglet lesson hero.",
    "Inspect the attached candidate image against every requirement below.",
    `Required concept: ${String(direction.concept ?? "").trim()}.`,
    `Required metaphor: ${String(direction.metaphor ?? "").trim()}.`,
    `Required composition family: ${String(direction.compositionFamily ?? "").trim() || "single-scene editorial"}.`,
    "The image must be one coherent physical scene with one focal action and at most two supporting object types.",
    "It must use warm cream paper, pale watercolor or gouache, muted clay orange, moss olive, dusty blue, delicate linework, soft edges, low contrast, and generous breathing room.",
    "Fail it if it substitutes a generic bridge, path, notebook, tile sequence, before-and-after transition, diagram, icon collection, or unrelated decorative still life.",
    "Fail it if it contains text, letters, numbers, labels, logos, currency symbols, compass markings, UI, readable icon glyphs, photorealism, glossy 3D, dense foliage, visual clutter, or a copied reference composition.",
    "Fail it if the focal action would become unclear in a centered wide lesson-header crop or a centered square card crop.",
    'Return only strict JSON with this shape: {"passed":true,"issues":[]}.',
    "When failed, passed must be false and issues must contain one to five short, concrete corrections.",
  ].join(" ");
}

function parseHeroVisualReview(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const normalized = raw.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  let parsed;
  try {
    parsed = record(JSON.parse(normalized));
  } catch {
    throw new Error("hero visual review returned invalid JSON");
  }
  const issues = Array.isArray(parsed.issues)
    ? parsed.issues
      .filter((issue) => typeof issue === "string" && issue.trim())
      .slice(0, 5)
      .map((issue) => issue.trim().slice(0, 240))
    : [];
  if (typeof parsed.passed !== "boolean" || (parsed.passed === false && issues.length === 0)) {
    throw new Error("hero visual review returned an invalid decision");
  }
  return { passed: parsed.passed, issues };
}

async function reviewHeroImage(content, heroDirection, imageBytes) {
  const project = required(process.env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT");
  const location = (process.env.GOOGLE_CLOUD_LOCATION || "global").trim();
  const model = (process.env.GEMINI_VERTEX_MODEL || DEFAULT_VISUAL_REVIEW_MODEL).trim();
  delete process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const prompt = heroVisualReviewPrompt(content, heroDirection);
  const response = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { data: imageBytes.toString("base64"), mimeType: "image/png" } },
      { text: prompt },
    ],
    config: { responseMimeType: "application/json" },
  });
  const text = typeof response.text === "string"
    ? response.text
    : response.candidates?.[0]?.content?.parts?.flatMap((part) => part.text ? [part.text] : []).join("\n");
  return { ...parseHeroVisualReview(text), model, prompt };
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const input = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (typeof input.runId !== "string" || !input.runId.trim()
    || !Array.isArray(input.kinds) || typeof input.generationInputChecksum !== "string" || !record(input.content)) {
    throw new Error("media command input is invalid");
  }
  return input;
}

function checksum(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function legacyArtifactForKind(reuse, kind) {
  if (kind === "hero") return reuse.artifacts?.hero;
  if (kind === "infographic") return reuse.artifacts?.infographic;
  if (kind === "audio_brief") return reuse.artifacts?.audioBrief;
  return reuse.artifacts?.audioDiscussion;
}

function localLegacyArtifactPath(relativePath, env = process.env) {
  const root = required(env.NUGLET_LEGACY_REUSE_ROOT, "NUGLET_LEGACY_REUSE_ROOT");
  const path = resolve(root, relativePath);
  if (!path.startsWith(`${resolve(root)}/`)) throw new Error("legacy artifact path escapes NUGLET_LEGACY_REUSE_ROOT");
  return path;
}

export async function publicPreviewEndCardArtwork(input, heroAsset, env = process.env) {
  if (typeof heroAsset?.bytesBase64 === "string" && heroAsset.bytesBase64) {
    const bytes = Buffer.from(heroAsset.bytesBase64, "base64");
    return { bytes, source: "generated_hero", checksum: checksum(bytes) };
  }
  const reuse = record(input.legacyMediaReuse);
  const artifact = record(reuse.artifacts?.hero);
  const sourcePath = typeof artifact.path === "string" ? artifact.path : "";
  const expectedChecksum = typeof artifact.checksum === "string" ? artifact.checksum : "";
  const expectedByteSize = artifact.byteSize;
  const mediaType = typeof artifact.mediaType === "string" ? artifact.mediaType : "";
  if (!sourcePath) return undefined;
  if (!/^sha256:[a-f0-9]{64}$/.test(expectedChecksum)
    || !Number.isInteger(expectedByteSize)
    || expectedByteSize <= 0
    || !["image/png", "image/webp"].includes(mediaType)) {
    throw new Error("legacy public preview end-card artwork receipt is invalid");
  }
  const bytes = await readFile(localLegacyArtifactPath(sourcePath, env));
  if (checksum(bytes) !== expectedChecksum || bytes.byteLength !== expectedByteSize) {
    throw new Error("legacy public preview end-card artwork does not match the immutable receipt");
  }
  return { bytes, source: "legacy_nuglet_hero", checksum: expectedChecksum };
}

async function imageDimensions(bytes, mediaType) {
  const extension = mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "img";
  const temporaryPath = `/tmp/knowledge-bits-${createHash("sha256").update(bytes).digest("hex")}.${extension}`;
  await writeFile(temporaryPath, bytes);
  try {
    const { stdout } = await execFileAsync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", temporaryPath]);
    const width = Number(stdout.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(stdout.match(/pixelHeight:\s*(\d+)/)?.[1]);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error("could not determine legacy image dimensions");
    }
    return { width, height };
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
}

async function normalizeLegacyHero(bytes, mediaType) {
  const dimensions = await imageDimensions(bytes, mediaType);
  if (dimensions.width * 3 === dimensions.height * 4) {
    return { bytes, dimensions };
  }

  const targetWidth = Math.floor(Math.min(dimensions.width, dimensions.height * 4 / 3) / 4) * 4;
  const targetHeight = targetWidth / 4 * 3;
  if (targetWidth < 1024 || targetHeight < 768) {
    return { bytes, dimensions };
  }

  const extension = mediaType === "image/png" ? "png" : mediaType === "image/webp" ? "webp" : "img";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const inputPath = `/tmp/knowledge-bits-legacy-hero-${digest}.${extension}`;
  const outputPath = `/tmp/knowledge-bits-legacy-hero-${digest}-4x3.${extension}`;
  await writeFile(inputPath, bytes);
  try {
    if (mediaType === "image/webp") {
      const left = Math.floor((dimensions.width - targetWidth) / 2);
      const top = Math.floor((dimensions.height - targetHeight) / 2);
      await execFileAsync("cwebp", [
        "-quiet",
        "-crop", String(left), String(top), String(targetWidth), String(targetHeight),
        inputPath,
        "-o", outputPath,
      ]);
    } else {
      await execFileAsync("sips", ["--cropToHeightWidth", String(targetHeight), String(targetWidth), inputPath, "--out", outputPath]);
    }
    const croppedBytes = await readFile(outputPath);
    return {
      bytes: croppedBytes,
      dimensions: await imageDimensions(croppedBytes, mediaType),
    };
  } finally {
    await Promise.all([
      unlink(inputPath).catch(() => undefined),
      unlink(outputPath).catch(() => undefined),
    ]);
  }
}

async function generateHero(content, heroDirection, expectedReferenceChecksums) {
  const project = required(process.env.GOOGLE_CLOUD_PROJECT_IMAGE || process.env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT_IMAGE or GOOGLE_CLOUD_PROJECT");
  const location = (process.env.GOOGLE_CLOUD_LOCATION_IMAGE || process.env.GOOGLE_CLOUD_LOCATION || "us-central1").trim();
  const model = (process.env.VERTEX_IMAGE_MODEL || DEFAULT_MODEL).trim();
  const styleReferences = await heroStyleReferences();
  const referenceChecksums = styleReferences.map(({ bytes }) => checksum(bytes));
  if (expectedReferenceChecksums.length > 0
    && JSON.stringify(referenceChecksums) !== JSON.stringify(expectedReferenceChecksums)) {
    throw new Error("hero style reference does not match the recipe");
  }
  // This command authenticates through Vertex ADC. Keep API-key diagnostics out of the JSON stdout contract.
  delete process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const basePrompt = [
    heroPrompt(content, heroDirection),
    heroDirectionPrompt(content, heroDirection),
    `Final scene decision: ${visualDirection(content, heroDirection)}`,
  ].filter(Boolean).join(" ");
  let priorIssues = [];
  for (let attempt = 1; attempt <= MAX_HERO_GENERATION_ATTEMPTS; attempt += 1) {
    const renderedPrompt = [
      basePrompt,
      priorIssues.length
        ? `The previous candidate failed visual review. Correct every issue: ${priorIssues.join("; ")}.`
        : "",
    ].filter(Boolean).join(" ");
    const contents = [
      ...styleReferences.map(({ bytes, mediaType }) => ({
        inlineData: { data: bytes.toString("base64"), mimeType: mediaType },
      })),
      { text: renderedPrompt },
    ];
    const response = model.startsWith("gemini-")
      ? await ai.models.generateContent({
        model,
        contents,
        config: {
          responseModalities: ["IMAGE"],
          imageConfig: { aspectRatio: "4:3", imageSize: "1K" },
        },
      })
      : await ai.models.generateImages({
        model,
        prompt: renderedPrompt,
        config: {
          numberOfImages: 1,
          aspectRatio: "4:3",
          outputMimeType: "image/png",
          imageSize: "1K",
          negativePrompt: "text, letters, numbers, logos, watermark, UI, photorealism, neon, glossy 3D, stock photography",
        },
      });
    const imageBytesBase64 = model.startsWith("gemini-")
      ? response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data)?.inlineData?.data
      : response.generatedImages?.[0]?.image?.imageBytes;
    if (!imageBytesBase64) throw new Error("Vertex Imagen returned no image bytes");
    const imageBytes = Buffer.from(imageBytesBase64, "base64");
    const visualReview = await reviewHeroImage(content, heroDirection, imageBytes);
    if (visualReview.passed) {
      return {
        bytes: imageBytes,
        model,
        prompt: renderedPrompt,
        referenceChecksums,
        visualReview: {
          passed: true,
          attempts: attempt,
          provider: "vertex",
          model: visualReview.model,
          promptChecksum: checksum(Buffer.from(visualReview.prompt)),
          issues: [],
        },
      };
    }
    priorIssues = visualReview.issues;
  }
  throw new Error(`hero visual conformance failed: ${priorIssues.join("; ")}`);
}

async function transcribeAudio(bytes, label) {
  const project = required(process.env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT");
  const location = (process.env.GOOGLE_CLOUD_LOCATION || "global").trim();
  const model = (process.env.GEMINI_VERTEX_MODEL || "gemini-2.5-flash").trim();
  delete process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const response = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { data: bytes.toString("base64"), mimeType: "audio/mp4" } },
      { text: `Transcribe this existing Nuglet ${label} audio faithfully. Return only the spoken words, without a title, speaker labels, commentary, or markdown.` },
    ],
  });
  const transcript = typeof response.text === "string"
    ? response.text.trim()
    : response.candidates?.[0]?.content?.parts?.flatMap((part) => part.text ? [part.text] : []).join("\n").trim();
  if (!transcript) throw new Error(`Vertex returned no transcript for legacy ${label} audio`);
  return {
    transcript,
    model,
    prompt: `Transcribe this existing Nuglet ${label} audio faithfully. Return only the spoken words, without a title, speaker labels, commentary, or markdown.`,
    provider: `vertex:${model}`,
  };
}

async function reuseLegacyMedia(input) {
  const reuse = record(input.legacyMediaReuse);
  if (reuse.source !== "nuglet_published" || !record(reuse.artifacts)
    || typeof reuse.sourceRunId !== "string" || !reuse.sourceRunId.trim()) {
    throw new Error("legacy media reuse receipt is invalid");
  }
  const assets = [];
  for (const kind of [...new Set(input.kinds)]) {
    if (!["hero", "infographic", "audio_brief", "audio_discussion"].includes(kind)) {
      throw new Error(`unsupported legacy media kind: ${kind}`);
    }
    const artifact = record(legacyArtifactForKind(reuse, kind));
    const sourcePath = typeof artifact.path === "string" ? artifact.path : "";
    const expectedChecksum = typeof artifact.checksum === "string" ? artifact.checksum : "";
    const expectedByteSize = artifact.byteSize;
    const mediaType = typeof artifact.mediaType === "string" ? artifact.mediaType : "";
    if (!sourcePath || !/^sha256:[a-f0-9]{64}$/.test(expectedChecksum)
      || !Number.isInteger(expectedByteSize) || expectedByteSize <= 0 || !mediaType) {
      throw new Error(`legacy ${kind} receipt is invalid`);
    }
    const sourceBytes = await readFile(localLegacyArtifactPath(sourcePath));
    if (checksum(sourceBytes) !== expectedChecksum || sourceBytes.byteLength !== expectedByteSize) {
      throw new Error(`legacy ${kind} bytes do not match the immutable reuse receipt`);
    }
    let bytes = sourceBytes;
    const metadata = {
      byteSize: bytes.byteLength,
      mediaSource: "legacy_nuglet",
      legacySourceRunId: reuse.sourceRunId,
      legacySourcePath: sourcePath,
    };
    if (kind === "hero" || kind === "infographic") {
      const normalized = kind === "hero"
        ? await normalizeLegacyHero(bytes, mediaType)
        : { bytes, dimensions: await imageDimensions(bytes, mediaType) };
      bytes = normalized.bytes;
      metadata.byteSize = bytes.byteLength;
      const dimensions = normalized.dimensions;
      Object.assign(metadata, dimensions);
      if (kind === "hero") {
        Object.assign(metadata, {
          focalPoint: { x: 0.5, y: 0.5 },
          cropSafeArea: { x: 0, y: 0, width: 1, height: 1 },
        });
      }
    } else {
      if (typeof artifact.durationSeconds !== "number" || artifact.durationSeconds <= 0) {
        throw new Error(`legacy ${kind} duration is unavailable`);
      }
      // Keep the approved audio bytes unchanged. Transcription only supplies the
      // review and delivery metadata required by the Knowledge Bits contract.
      const transcription = await transcribeAudio(
        bytes,
        kind === "audio_brief" ? "Brief" : "Discussion",
      );
      Object.assign(metadata, {
        durationSeconds: artifact.durationSeconds,
        ...(transcription ? {
          transcript: transcription.transcript,
          transcriptAudioChecksum: checksum(bytes),
          transcriptSource: "legacy_nuglet",
          transcriptProvider: transcription.provider,
        } : {}),
      });
    }
    assets.push({
      kind,
      mediaType,
      bytesBase64: bytes.toString("base64"),
      generationInputChecksum: input.generationInputChecksum,
      metadata,
      support: {
        reuse: {
          source: "nuglet_published",
          sourceRunId: reuse.sourceRunId,
          sourcePath,
          sourceChecksum: expectedChecksum,
        },
      },
    });
  }
  return assets;
}

function recipeSnapshot(input, role) {
  const recipe = record(record(input.recipeSnapshots)[role]);
  if (typeof recipe.id !== "string" || typeof recipe.version !== "string"
    || !/^sha256:[a-f0-9]{64}$/.test(String(recipe.checksum))) {
    throw new Error(`media recipe snapshot is invalid: ${role}`);
  }
  return recipe;
}

function recipeReferenceChecksums(recipe) {
  const value = record(JSON.parse(Buffer.from(String(recipe.canonicalBase64 ?? ""), "base64").toString("utf8")));
  if (!Array.isArray(value.referenceAssets)) return [];
  return value.referenceAssets.map((reference) => required(record(reference).checksum, "referenceAssets[].checksum"));
}

function executionEvidence(recipe, prompt, options) {
  const bytes = Buffer.from(prompt);
  return {
    recipe: { id: recipe.id, version: recipe.version, checksum: recipe.checksum },
    promptBase64: bytes.toString("base64"),
    promptChecksum: checksum(bytes),
    provider: options.provider,
    model: options.model,
    referenceChecksums: options.referenceChecksums ?? [],
    ...(options.artifactId ? { artifactId: options.artifactId } : {}),
    ...(options.notebookId ? { notebookId: options.notebookId } : {}),
  };
}

function notebookLmMarker(input, kind) {
  const promptVersion = kind === "public_preview"
    ? `:${compilePublicPreview(input.content).promptTemplateVersion}`
    : "";
  return `[knowledge-bits:${input.generationInputChecksum.slice(0, 16)}:${kind}${promptVersion}]`;
}

function notebookLmPrompt(input, kind) {
  const marker = notebookLmMarker(input, kind);
  if (kind === "public_preview") {
    return renderPublicPreviewPrompt(compilePublicPreview(input.content), marker);
  }
  const { title, hook, takeaway } = contentText(input.content);
  const role = kind === "infographic" ? "infographic" : kind === "audio_brief" ? "audioBrief" : "audioDiscussion";
  const recipe = recipeSnapshot(input, role);
  const instructions = Buffer.from(String(recipe.canonicalBase64 ?? ""), "base64").toString("utf8");
  return [marker, `Create the Nuglet ${kind.replace("audio_", "audio ")} for "${title}".`, hook, takeaway, instructions]
    .filter(Boolean)
    .join(" ");
}

async function runNotebookLm(args, options = {}) {
  const command = (process.env.NOTEBOOKLM_COMMAND || "nlm").trim();
  try {
    return await execFileAsync(command, args, {
      maxBuffer: 10 * 1024 * 1024,
      timeout: options.timeout ?? 120_000,
    });
  } catch (error) {
    const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
    const detail = stderr || error.message;
    if (isNotebookLmArtifactPropagationDelay(detail)) {
      throw new MediaWaitingError("notebooklm_artifact_propagating");
    }
    throw new Error(`NotebookLM command failed: ${detail}`);
  }
}

function isNotebookLmArtifactPropagationDelay(value) {
  return /\b404\b/i.test(String(value))
    && /\b(?:propagat(?:e|ed|ing|ion)|not\s+yet\s+available)\b/i.test(String(value));
}

async function notebookLmStatus(notebookId) {
  const { stdout } = await runNotebookLm(["studio", "status", notebookId, "--json"]);
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) throw new Error("NotebookLM studio status was not a list");
  return parsed.map(record);
}

function matchingNotebookLmArtifact(artifacts, kind, marker) {
  const expectedType = kind === "infographic" ? "infographic" : kind === "public_preview" ? "video" : "audio";
  return artifacts.find((artifact) => artifact.type === expectedType
    && typeof artifact.custom_instructions === "string"
    && artifact.custom_instructions.includes(marker));
}

function notebookLmStatePath(input, notebookId) {
  const root = (process.env.KNOWLEDGE_BITS_PROVIDER_STATE_ROOT
    || join(process.env.ARTIFACT_STORAGE_FILESYSTEM_ROOT || join(homedir(), ".knowledge-bits"), ".provider-state"))
    .trim();
  const identity = createHash("sha256")
    .update(`${notebookId}:${input.generationInputChecksum}:${input.idempotencyKey}`)
    .digest("hex");
  return join(root, "notebooklm-media", `${identity}.json`);
}

async function readNotebookLmState(input, notebookId) {
  try {
    return record(JSON.parse(await readFile(notebookLmStatePath(input, notebookId), "utf8")));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

async function writeNotebookLmState(input, notebookId, state) {
  const path = notebookLmStatePath(input, notebookId);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function soleUnmarkedInfographic(artifacts, wantedKinds) {
  if (!wantedKinds.includes("infographic")) return undefined;
  const candidates = artifacts.filter((artifact) => artifact.type === "infographic" && artifact.status !== "failed");
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function reusableNotebookLmArtifact({
  artifacts,
  kind,
  marker,
  stateArtifactId,
  wantedKinds,
  regeneratedKinds = [],
}) {
  const existing = matchingNotebookLmArtifact(artifacts, kind, marker);
  const stateArtifact = stateArtifactId
    ? artifacts.find((artifact) => artifact.id === stateArtifactId && artifact.status !== "failed")
    : undefined;
  const reusableStateArtifact = kind !== "public_preview"
    || (typeof stateArtifact?.custom_instructions === "string"
      && stateArtifact.custom_instructions.includes(marker))
    ? stateArtifact
    : undefined;
  if (regeneratedKinds.includes(kind)) return reusableStateArtifact;
  const unmarkedInfographic = kind === "infographic"
    ? soleUnmarkedInfographic(artifacts, wantedKinds)
    : undefined;
  return existing ?? reusableStateArtifact ?? unmarkedInfographic;
}

async function createNotebookLmArtifact(notebookId, kind, prompt, sourceId) {
  const args = kind === "public_preview"
    ? [
        "video", "create", notebookId,
        "--format", "short",
        "--language", "en",
        "--focus", prompt,
        "--source-ids", required(sourceId, "public preview source id"),
        "--confirm",
        "--json",
      ]
    : kind === "infographic"
    ? ["infographic", "create", notebookId, "--orientation", "portrait", "--detail", "concise", "--style", "editorial", "--focus", prompt, "--confirm"]
    : ["audio", "create", notebookId, "--format", kind === "audio_brief" ? "brief" : "deep_dive", "--length", kind === "audio_brief" ? "short" : "default", "--focus", prompt, "--confirm"];
  const { stdout } = await runNotebookLm(args);
  const parsed = kind === "public_preview" ? record(JSON.parse(stdout)) : {};
  const artifactId = parsed.artifact_id
    ?? parsed.id
    ?? stdout.match(/Artifact ID:\s*([a-f0-9-]+)/i)?.[1];
  if (!artifactId) throw new Error(`NotebookLM did not return an artifact ID for ${kind}`);
  return String(artifactId);
}

async function ensurePublicPreviewSource(input, notebookId, state) {
  const brief = compilePublicPreview(input.content);
  const title = publicPreviewSourceTitle(brief);
  const { stdout } = await runNotebookLm(["source", "list", notebookId, "--json"]);
  let sources = JSON.parse(stdout);
  let source = sources.find((candidate) => candidate.title === title);
  if (!source) {
    await runNotebookLm([
      "source", "add", notebookId,
      "--text", renderPublicPreviewSource(brief),
      "--title", title,
      "--wait",
      "--wait-timeout", "600",
    ], { timeout: 660_000 });
    sources = JSON.parse((await runNotebookLm(["source", "list", notebookId, "--json"])).stdout);
    source = sources.find((candidate) => candidate.title === title);
  }
  if (!source?.id) throw new Error("Could not resolve the curated NotebookLM public preview source");
  state.public_preview_source = source.id;
  return String(source.id);
}

async function ensureNotebookLmArtifacts(input, kinds) {
  const notebookId = required(input.notebookLmNotebookId, "notebookLmNotebookId");
  const wanted = kinds.filter((kind) => kind !== "hero");
  const state = await readNotebookLmState(input, notebookId);
  let artifacts = await notebookLmStatus(notebookId);
  const tracked = new Map();
  for (const kind of wanted) {
    const prompt = notebookLmPrompt(input, kind);
    const marker = notebookLmMarker(input, kind);
    const stateArtifactId = typeof state[kind] === "string" ? state[kind] : undefined;
    // NotebookLM currently omits infographic focus text from studio status. A
    // sole infographic is safe to adopt for a new media notebook; the sidecar
    // ID then remains authoritative across later retries.
    const selected = reusableNotebookLmArtifact({
      artifacts,
      kind,
      marker,
      stateArtifactId,
      wantedKinds: wanted,
      regeneratedKinds: Array.isArray(input.regeneratedKinds) ? input.regeneratedKinds : [],
    });
    if (kind === "public_preview") {
      await ensurePublicPreviewSource(input, notebookId, state);
    }
    const artifactId = typeof selected?.id === "string" && selected.id
      ? selected.id
      : await createNotebookLmArtifact(
        notebookId,
        kind,
        prompt,
        kind === "public_preview" ? state.public_preview_source : undefined,
      );
    state[kind] = artifactId;
    await writeNotebookLmState(input, notebookId, state);
    tracked.set(kind, { artifactId, prompt });
  }

  const deadline = Date.now() + NOTEBOOKLM_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    artifacts = await notebookLmStatus(notebookId);
    let pending = false;
    for (const [kind, trackedArtifact] of tracked) {
      const current = artifacts.find((artifact) => artifact.id === trackedArtifact.artifactId);
      if (current?.status === "failed") throw new Error(`NotebookLM ${kind} generation failed`);
      if (current?.status !== "completed") pending = true;
    }
    if (!pending) return { notebookId, tracked };
    await new Promise((resolvePromise) => setTimeout(resolvePromise, NOTEBOOKLM_POLL_INTERVAL_MS));
  }
  throw new MediaWaitingError("notebooklm_media_generation_in_progress");
}

async function downloadNotebookLmArtifact(notebookId, kind, artifactId, directory) {
  const path = join(
    directory,
    kind === "infographic" ? `${kind}.png` : kind === "public_preview" ? `${kind}.mp4` : `${kind}.m4a`,
  );
  await runNotebookLm([
    "download",
    kind === "infographic" ? "infographic" : kind === "public_preview" ? "video" : "audio",
    notebookId,
    "--id",
    artifactId,
    "--output",
    path,
    "--no-progress",
  ], { timeout: 180_000 });
  return readFile(path);
}

async function transcribeVideo(bytes) {
  const project = required(process.env.GOOGLE_CLOUD_PROJECT, "GOOGLE_CLOUD_PROJECT");
  const location = (process.env.GOOGLE_CLOUD_LOCATION || "global").trim();
  const model = (process.env.GEMINI_VERTEX_MODEL || "gemini-2.5-flash").trim();
  delete process.env.GEMINI_API_KEY;
  const ai = new GoogleGenAI({ vertexai: true, project, location });
  const response = await ai.models.generateContent({
    model,
    contents: [
      { inlineData: { data: bytes.toString("base64"), mimeType: "video/mp4" } },
      { text: "Transcribe every spoken word faithfully. Return only the spoken words without headings, commentary, or markdown." },
    ],
  });
  const transcript = typeof response.text === "string"
    ? response.text.trim()
    : response.candidates?.[0]?.content?.parts?.flatMap((part) => part.text ? [part.text] : []).join("\n").trim();
  if (!transcript) throw new Error("Vertex returned no public preview transcript");
  return { transcript, provider: `vertex:${model}` };
}

async function audioDurationSeconds(bytes) {
  const path = join(tmpdir(), `knowledge-bits-audio-${createHash("sha256").update(bytes).digest("hex")}.m4a`);
  await writeFile(path, bytes);
  try {
    const { stdout } = await execFileAsync("ffprobe", [
      "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", path,
    ]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration <= 0) throw new Error("could not determine audio duration");
    return duration;
  } finally {
    await unlink(path).catch(() => undefined);
  }
}

async function generateCurrentHeroAsset(input) {
  const recipe = recipeSnapshot(input, "hero");
  const replacementPath = heroReplacementPath(input);
  const declaredReferenceChecksums = recipeReferenceChecksums(recipe);
  const referenceChecksums = declaredReferenceChecksums.length > 0
    ? declaredReferenceChecksums
    : await heroStyleReferenceChecksums();
  const generated = replacementPath
    ? {
        bytes: await readFile(replacementPath),
        model: "operator-selected",
        prompt: `Operator-selected hero replacement for run ${input.runId}.`,
        provider: "operator",
        referenceChecksums,
      }
    : {
        ...await generateHero(input.content, input.heroDirection, referenceChecksums),
        provider: "vertex",
      };
  const normalized = await normalizeLegacyHero(generated.bytes, "image/png");
  const heroBytes = normalized.bytes;
  return {
    kind: "hero",
    mediaType: "image/png",
    bytesBase64: heroBytes.toString("base64"),
    generationInputChecksum: input.generationInputChecksum,
    metadata: {
      byteSize: heroBytes.byteLength,
      ...normalized.dimensions,
      focalPoint: { x: 0.5, y: 0.5 },
      cropSafeArea: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
      styleProfileChecksum: recipe.checksum,
      referenceChecksums: generated.referenceChecksums,
      ...(generated.visualReview ? { visualReview: generated.visualReview } : {}),
    },
    support: { executions: [executionEvidence(recipe, generated.prompt, {
      provider: generated.provider,
      model: generated.model,
      referenceChecksums: generated.referenceChecksums,
    })] },
  };
}

async function prepareCurrentMediaLanes(input, kinds, dependencies = {}) {
  const makeHero = dependencies.generateHeroAsset ?? generateCurrentHeroAsset;
  const prepareNotebookLm = dependencies.ensureNotebookLm ?? ensureNotebookLmArtifacts;
  return Promise.all([
    kinds.includes("hero") ? makeHero(input) : Promise.resolve(undefined),
    kinds.some((kind) => kind !== "hero")
      ? prepareNotebookLm(input, kinds)
      : Promise.resolve(undefined),
  ]);
}

async function generateCurrentMedia(input) {
  const kinds = [...new Set(input.kinds)];
  const directory = await mkdtemp(join(tmpdir(), "knowledge-bits-media-"));
  try {
    const [heroAsset, notebookLm] = await prepareCurrentMediaLanes(input, kinds);
    const endCardArtwork = kinds.includes("public_preview")
      ? await publicPreviewEndCardArtwork(input, heroAsset)
      : undefined;
    const assetsByKind = new Map();
    if (heroAsset) assetsByKind.set("hero", heroAsset);
    for (const kind of kinds) {
      const role = kind === "hero" ? "hero" : kind === "infographic" ? "infographic" : kind === "audio_brief" ? "audioBrief" : "audioDiscussion";
      const recipe = kind === "public_preview" ? undefined : recipeSnapshot(input, role);
      if (kind === "hero") continue;

      if (!notebookLm) throw new Error(`NotebookLM preparation missing for ${kind}`);
      const tracked = notebookLm.tracked.get(kind);
      if (!tracked) throw new Error(`NotebookLM artifact tracking missing for ${kind}`);
      let bytes = await downloadNotebookLmArtifact(notebookLm.notebookId, kind, tracked.artifactId, directory);
      if (kind === "public_preview") {
        const brief = compilePublicPreview(input.content);
        const rendered = await renderPublicPreviewVideo(bytes, brief.title, {
          endCardArtworkBytes: endCardArtwork?.bytes,
        });
        bytes = rendered.bytes;
        const metadata = rendered.metadata;
        const transcription = await transcribeVideo(bytes);
        const leaks = protectedLeakage(transcription.transcript, brief);
        const technicalPassed = metadata.hasAudio
          && metadata.durationSeconds >= 40
          && metadata.durationSeconds <= 65
          && Math.abs(metadata.width / metadata.height - 9 / 16) <= 0.08;
        assetsByKind.set(kind, {
          kind,
          mediaType: "video/mp4",
          bytesBase64: bytes.toString("base64"),
          generationInputChecksum: input.generationInputChecksum,
          metadata: {
            byteSize: bytes.byteLength,
            durationSeconds: metadata.durationSeconds,
            width: metadata.width,
            height: metadata.height,
            transcript: transcription.transcript,
            transcriptSource: "vertex_gemini",
            transcriptProvider: transcription.provider,
            status: "needs_review",
            provider: "notebooklm",
            providerFormat: "short",
            providerArtifactId: tracked.artifactId,
            promptTemplateVersion: brief.promptTemplateVersion,
            providerDurationSeconds: rendered.providerDurationSeconds,
            providerTailTrimSeconds: rendered.providerTailTrimSeconds,
            narrativeDurationSeconds: rendered.narrativeDurationSeconds,
            endCardDurationSeconds: rendered.endCardDurationSeconds,
            endCardTransitionSeconds: rendered.endCardTransitionSeconds,
            endCardVoiceOverlapSeconds: rendered.endCardVoiceOverlapSeconds,
            endCardVersion: rendered.endCardVersion,
            endCardBackgroundChecksum: rendered.endCardBackgroundChecksum,
            endCardArtworkChecksum: rendered.endCardArtworkChecksum,
            endCardArtworkSource: endCardArtwork?.source ?? "focus_aperture_default",
            logoChecksum: rendered.logoChecksum,
            validation: {
              technicalPassed,
              protectedContentPassed: leaks.length === 0,
              sourceGroundingPassed: null,
              narrativePassed: null,
              issues: [
                ...(technicalPassed ? [] : ["Video must be 40-65 seconds, near 9:16, and contain audio."]),
                ...(leaks.length ? [`Possible protected-content leakage: ${leaks.join(" | ")}`] : []),
              ],
            },
            review: { decision: "pending", reviewerId: null, reviewedAt: null },
          },
          support: { executions: [] },
        });
        continue;
      }
      if (kind === "infographic") {
        assetsByKind.set(kind, {
          kind,
          mediaType: "image/png",
          bytesBase64: bytes.toString("base64"),
          generationInputChecksum: input.generationInputChecksum,
          metadata: { byteSize: bytes.byteLength, ...await imageDimensions(bytes, "image/png") },
          support: { executions: [executionEvidence(recipe, tracked.prompt, {
            provider: "notebooklm", model: "notebooklm-cli", artifactId: tracked.artifactId, notebookId: notebookLm.notebookId,
          })] },
        });
        continue;
      }

      const label = kind === "audio_brief" ? "Brief" : "Discussion";
      const transcription = await transcribeAudio(bytes, label);
      assetsByKind.set(kind, {
        kind,
        mediaType: "audio/mp4",
        bytesBase64: bytes.toString("base64"),
        generationInputChecksum: input.generationInputChecksum,
        metadata: {
          byteSize: bytes.byteLength,
          durationSeconds: await audioDurationSeconds(bytes),
          transcript: transcription.transcript,
          transcriptAudioChecksum: checksum(bytes),
          transcriptSource: "vertex_gemini",
          transcriptProvider: transcription.provider,
        },
        support: { executions: [
          executionEvidence(recipe, tracked.prompt, {
            provider: "notebooklm", model: "notebooklm-cli", artifactId: tracked.artifactId, notebookId: notebookLm.notebookId,
          }),
          executionEvidence(recipe, transcription.prompt, { provider: "vertex", model: transcription.model }),
        ] },
      });
    }
    return kinds.map((kind) => {
      const asset = assetsByKind.get(kind);
      if (!asset) throw new Error(`Media asset missing for ${kind}`);
      return asset;
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const input = await readInput();
  if (shouldReuseLegacyMedia(input)) {
    process.stdout.write(`${JSON.stringify({ assets: await reuseLegacyMedia(input) })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({ assets: await generateCurrentMedia(input) })}\n`);
}

function shouldReuseLegacyMedia(input) {
  return Boolean(input.legacyMediaReuse) && input.mediaOperation !== "generate";
}

export {
  authoritativeHeroDirection,
  checkedHeroDirection,
  heroPrompt,
  heroVisualReviewPrompt,
  parseHeroVisualReview,
  heroReplacementPath,
  isNotebookLmArtifactPropagationDelay,
  normalizeLegacyHero,
  notebookLmPrompt,
  prepareCurrentMediaLanes,
  shouldReuseLegacyMedia,
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`${error instanceof MediaWaitingError ? "MEDIA_WAITING:" : ""}${message}\n`);
    process.exitCode = error instanceof MediaWaitingError ? 75 : 1;
  });
}
