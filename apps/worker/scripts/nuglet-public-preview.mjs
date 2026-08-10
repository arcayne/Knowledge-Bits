import { createHash } from "node:crypto";

export const PUBLIC_PREVIEW_TEMPLATE_VERSION = "nuglet.public-preview@1.6.0";

export function compilePublicPreview(content) {
  const lesson = lessonPayload(content);
  const title = required(lesson.identity?.title ?? lesson.title, "lesson title");
  const takeaway = required(
    lesson.learning?.action?.instruction ?? lesson.takeaway,
    "lesson action",
  );
  const centralIdea = required(
    lesson.learning?.centralIdea ?? lesson.hook,
    "central idea",
  );
  const oneLineToKeep = required(
    lesson.learning?.oneLineToKeep ?? lesson.oneLineToKeep ?? lesson.reframe ?? centralIdea,
    "one line to keep",
  );
  const topicLabel = optional(
    lesson.identity?.topic?.label ?? lesson.topic?.label,
    "lesson topic",
  );
  const socialPost = record(lesson.socialPost);
  const socialPostRepresentation = {
    platform: socialPost.platform === "cross-platform" ? socialPost.platform : "cross-platform",
    text: typeof socialPost.text === "string" ? socialPost.text.trim() : "",
  };
  const protectedContent = {
    exactPractice: takeaway,
    completeReframe: oneLineToKeep,
    quizAnswers: correctQuizAnswers(lesson),
  };
  const preview = record(lesson.publicPreview ?? lesson.preview);
  const recognitionMoment = previewText(
    preview.recognitionMoment,
    protectedContent,
    recognitionMomentFromLesson(lesson, topicLabel),
  );
  const centralProblem = previewText(
    preview.centralProblem,
    protectedContent,
    centralProblemFromLesson(lesson, topicLabel),
  );
  const whyItMatters = previewText(
    preview.whyItMatters,
    protectedContent,
    whyItMattersFromLesson(lesson, topicLabel),
  );
  const learningOutcomes = stringArray(preview.learningOutcomes).length > 0
    ? stringArray(preview.learningOutcomes)
      .map((value) => previewText(value, protectedContent, ""))
      .filter(Boolean)
    : [
      `recognize the ${topicLabel} pattern in an ordinary moment`,
      "understand the mechanism in plain language",
      "see what the full Nuglet helps you try next",
    ];
  const visualAnchors = preview.visualAnchors?.length > 0
    ? stringArray(preview.visualAnchors)
      .map((value) => previewText(value, protectedContent, ""))
      .filter(Boolean)
    : visualAnchorsFromLesson(lesson, protectedContent, topicLabel);
  const editorialGuardrails = stringArray(preview.editorialGuardrails).length > 0
    ? stringArray(preview.editorialGuardrails)
    : defaultEditorialGuardrails();
  const brief = {
    schemaVersion: "nuglet.public-preview-brief.v1",
    promptTemplateVersion: PUBLIC_PREVIEW_TEMPLATE_VERSION,
    locale: "en",
    title,
    recognitionMoment,
    centralProblem,
    whyItMatters,
    learningOutcomes,
    visualAnchors,
    editorialGuardrails,
    visualDirection: "Show challenge or tension through objects and environments, not through an upset face: a difficult book, tangled threads, layered pages, a maze, a path, or an unfinished diagram. Human figures may appear only with relaxed features, open curiosity, gentle concentration, recognition, or relief.",
    emotionalShiftDirection: "Move from thoughtful surprise or puzzlement toward calm curiosity, clarity, and gentle relief.",
    finalInvitation: previewText(
      preview.finalInvitation,
      protectedContent,
      "Open the full Nuglet to learn the practical next step.",
    ),
    protectedContent,
    socialPostChecksum: prefixedChecksum(Buffer.from(JSON.stringify(socialPostRepresentation))),
  };
  return {
    ...brief,
    checksum: prefixedChecksum(Buffer.from(JSON.stringify(brief))),
  };
}

export function renderPublicPreviewSource(brief) {
  return [
    `# Nuglet public preview source: ${brief.title}`,
    "",
    "This is a deliberately limited promotional preview source, not the full lesson.",
    "",
    "## Recognition moment",
    brief.recognitionMoment,
    "",
    "## Central problem",
    brief.centralProblem,
    "",
    "## Why it matters",
    brief.whyItMatters,
    "",
    "## What the full Nuglet helps the viewer understand",
    ...brief.learningOutcomes.map((item) => `- ${item}`),
    "",
    "## Visual story anchors",
    ...brief.visualAnchors.map((item) => `- ${item}`),
    "",
    "## Visual direction",
    brief.visualDirection,
    "",
    "## Emotional direction",
    brief.emotionalShiftDirection,
    "",
    "## Invitation",
    brief.finalInvitation,
    "",
    "## Protected boundary",
    "Do not disclose the exact practice, its steps, quiz answers, complete reframe, or conclusion.",
    "Create recognition and curiosity without resolving the lesson.",
    "",
    "## Editorial guardrails",
    ...brief.editorialGuardrails.map((item) => `- ${item}`),
    "",
  ].join("\n");
}

export function renderPublicPreviewPrompt(brief, marker) {
  const openingSceneDirection = openingSceneDirectionFor(brief);
  return [
    marker,
    `Create an English-language NotebookLM Short for the locked Nuglet "${brief.title}".`,
    "Treat the selected curated preview source as the only allowed source.",
    "This is a preview, not a summary: do not reveal the exact practice, its steps, quiz answers, complete reframe, or conclusion.",
    "Use NotebookLM Short format: approximately 45-60 seconds, vertical, and mobile-first.",
    "Use a three-beat structure: open inside the recognition moment; explain one grounded mechanism; end with an unresolved invitation to learn the practical next step in the full Nuglet.",
    `Recognition moment: ${brief.recognitionMoment}`,
    `Central tension: ${brief.centralProblem}`,
    `Why it matters: ${brief.whyItMatters}`,
    `Visual anchors: ${brief.visualAnchors.join(" ")}`,
    "Keep one consistent person or situation across the opening and return; show one concrete cue or object at a time rather than diagrams, dashboards, formulas, or montage overload.",
    openingSceneDirection,
    "Narrate in complete, natural sentences. Use cautious qualitative language and explain only the mechanism supported by the curated source.",
    `Editorial guardrails: ${brief.editorialGuardrails.join(" ")}`,
    "Visual casting should generally reflect working adults aged roughly 25-40, with women represented most often. Younger men and people from varied backgrounds should appear naturally too. This is a flexible direction, not an exclusive rule or rigid quota. Avoid repeatedly defaulting to middle-aged or older men, and avoid stereotypes or tokenistic casting.",
    `Visual direction: ${brief.visualDirection}`,
    "Make every challenge, tension, or problem beat object-first. Do not use a human face to communicate friction, struggle, confusion, difficulty, failure, or conflict.",
    "Do not default to coffee, cups, mugs, breakfast beverages, desks, or laptops as the opening motif. Choose the concrete cue from this Nuglet's recognition moment, and vary the opening object across lessons. Use only objects that are necessary to the scene and render each one cleanly and recognizably.",
    "Human figures may appear only during recognition, curiosity, insight, or relief. Keep every visible person relaxed, curious, gently concentrated, or softly smiling.",
    "Never show furrowed brows, narrowed eyes, downturned mouths, clenched jaws or fists, tense shoulders, glaring, scowling, hostile, distressed, panicked, defeated, or confrontational expressions or posture.",
    "The emotional arc is thoughtful surprise, curiosity, calm recognition, clarity, and gentle relief. The challenge should feel intellectually intriguing, never emotionally threatening.",
    "Tone: warm, hopeful, intelligent, emotionally observant, concise, evidence-grounded, and human. No hype, shame, fear, diagnosis, invented statistics, or transformation promises. Do not resolve the lesson or repeat its exact practice, reframe, quiz answer, or conclusion.",
  ].join(" ");
}

function openingSceneDirectionFor(brief) {
  const title = normalize(brief.title);
  if (title.includes("build defaults")) {
    return "For this preview, make the opening visual about choosing between two breakfast foods or looking at a small pantry choice. Do not show a coffee cup or mug, and do not use a generic morning-routine montage.";
  }
  if (title.includes("weekly reset")) {
    return "For this preview, make the opening visual about a wall calendar, a weekly page, or a phone reminder being reviewed on Monday. Do not show a coffee cup or mug, and do not use a generic morning-routine montage.";
  }
  return "For this preview, make the opening visual specific to the recognition moment above. Do not use coffee, cups, or mugs as a default prop, and do not reuse the same opening object across unrelated Nuglets.";
}

export function publicPreviewSourceTitle(brief) {
  return `Nuglet public preview ${brief.checksum.slice(7, 19)}`;
}

export function protectedLeakage(transcript, brief) {
  const haystack = normalize(transcript);
  const publicTitle = normalize(brief.title);
  return [
    brief.protectedContent.exactPractice,
    brief.protectedContent.completeReframe,
    ...brief.protectedContent.quizAnswers,
  ].filter((phrase) => {
    const normalized = normalize(phrase);
    // The title is deliberately spoken/displayed in a public preview. A
    // lesson whose one-line reframe is also its title must not fail merely
    // because the narrator names the Nuglet.
    if (normalized === publicTitle) return false;
    const meaningful = normalized.split(" ").filter((word) => word.length > 3);
    if (meaningful.length < 3) return false;
    const matches = meaningful.filter((word) => haystack.includes(word)).length;
    return haystack.includes(normalized)
      || (meaningful.length >= 4 && matches / meaningful.length >= 0.8);
  });
}

function lessonPayload(content) {
  if (content?.kind === "nuglet.lesson.v1" && content?.schemaVersion === "1.1.0") {
    return content.payload ?? {};
  }
  return content ?? {};
}

function recognitionMomentFromLesson(lesson, topicLabel) {
  const storyOpening = firstStoryText(lesson);
  if (storyOpening) return `Open on this ordinary moment: ${firstSentence(storyOpening)}`;
  const example = firstReadSection(lesson, "example");
  if (example) return `Open on the concrete situation: ${firstSentence(example)}`;
  return `Introduce the everyday tension in the ${topicLabel} lesson without explaining how to resolve it.`;
}

function centralProblemFromLesson(lesson, topicLabel) {
  const details = lessonDetails(lesson);
  const commonMistake = lesson.commonMistake;
  if (typeof commonMistake === "string" && commonMistake.trim()) {
    return `The tempting but incomplete response is: ${commonMistake.trim()}`;
  }
  const watchOut = details.read?.playbook?.watchOuts?.[0];
  if (typeof watchOut === "string" && watchOut.trim()) {
    return `Show the everyday trap around ${topicLabel}: ${watchOut.trim()}`;
  }
  return `Show why this ${topicLabel} pattern can feel puzzling or mentally tangled without turning the moment into conflict or distress.`;
}

function whyItMattersFromLesson(lesson, topicLabel) {
  const details = lessonDetails(lesson);
  const lessonWhy = lesson.learning?.whyItMatters ?? details.learning?.whyItMatters;
  if (typeof lessonWhy === "string" && lessonWhy.trim()) return lessonWhy.trim();
  const idea = firstReadSection(lesson, "idea");
  if (idea) return firstSentence(idea);
  return `Build curiosity about why the ${topicLabel} pattern matters without stating the lesson's reframe or action.`;
}

function visualAnchorsFromLesson(lesson, protectedContent, topicLabel) {
  const details = lessonDetails(lesson);
  const anchors = [];
  const storyOpening = firstStoryText(lesson);
  if (storyOpening) {
    const sentence = previewText(firstSentence(storyOpening), protectedContent, "");
    if (sentence) anchors.push(`Use the ordinary situation in this opening as the recurring scene: ${sentence}`);
  }
  const example = firstReadSection(lesson, "example");
  if (example) {
    const sentence = previewText(firstSentence(example), protectedContent, "");
    if (sentence) anchors.push(`Show one or two concrete cues from the example, one at a time: ${sentence}`);
  }
  const frames = Array.isArray(details.visual?.frames) ? details.visual.frames : [];
  for (const frame of frames.filter((candidate) => candidate?.icon !== "action").slice(0, 2)) {
    const title = typeof frame?.title === "string" ? frame.title.trim() : "";
    const body = typeof frame?.body === "string" ? previewText(firstSentence(frame.body), protectedContent, "") : "";
    if (title && body) anchors.push(`Make the mechanism visible through one simple image, not a chart: ${title} — ${body}`);
  }
  if (anchors.length > 0) return anchors;
  return [`Use one ordinary ${topicLabel} situation, one concrete cue, and one visible moment of hesitation or recognition.`];
}

function firstStoryText(lesson) {
  const blocks = lessonDetails(lesson).read?.story?.blocks;
  if (!Array.isArray(blocks)) return "";
  const opening = blocks.find((block) => block?.type === "opening" && typeof block.text === "string")
    ?? blocks.find((block) => typeof block?.text === "string");
  return typeof opening?.text === "string" ? opening.text.trim() : "";
}

function firstReadSection(lesson, id) {
  const section = lessonDetails(lesson).read?.sections?.find((candidate) => candidate?.id === id);
  return typeof section?.body === "string" ? section.body.trim() : "";
}

function lessonDetails(lesson) {
  return record(lesson.lessonV2 ?? lesson);
}

function firstSentence(value) {
  const text = String(value ?? "").trim().replace(/\s+/g, " ");
  const match = text.match(/^(.+?[.!?])(?:\s|$)/);
  return (match?.[1] ?? text).trim();
}

function previewText(value, protectedContent, fallback) {
  if (typeof value === "string" && value.trim() && !containsProtectedContent(value, protectedContent)) {
    return value.trim().replace(/\s+/g, " ");
  }
  if (typeof fallback === "string" && fallback.trim() && !containsProtectedContent(fallback, protectedContent)) {
    return fallback.trim().replace(/\s+/g, " ");
  }
  return "";
}

function containsProtectedContent(value, protectedContent) {
  const normalizedValue = normalize(value);
  return [
    protectedContent.exactPractice,
    protectedContent.completeReframe,
    ...protectedContent.quizAnswers,
  ].some((phrase) => {
    const normalizedPhrase = normalize(phrase);
    return normalizedPhrase.length >= 12 && normalizedValue.includes(normalizedPhrase);
  });
}

function defaultEditorialGuardrails() {
  return [
    "Describe the mechanism qualitatively; do not invent equations, formulas, meters, scales, or mathematical consequences.",
    "Do not intensify the source into complete exhaustion, deep fatigue, inevitability, total depletion, or absolute claims.",
    "Use complete natural sentences; avoid sentence fragments, stacked labels, and unexplained jargon.",
    "Keep on-screen labels short, spatially separate, and limited to one label per shot.",
  ];
}

function stringArray(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim()).map((item) => item.trim())
    : [];
}

function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : {};
}

function correctQuizAnswers(lesson) {
  const questions = lesson.quiz?.questions ?? lesson.challenge?.questions ?? [];
  return questions.flatMap((question) => {
    if (Array.isArray(question.options) && question.correctOptionId) {
      return question.options
        .filter((option) => option.id === question.correctOptionId)
        .map((option) => option.text);
    }
    return (question.options ?? [])
      .filter((option) => option.isCorrect)
      .map((option) => option.label);
  }).filter((value) => typeof value === "string" && value.trim());
}

function required(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} is required`);
  return value.trim();
}

function optional(value, fallback) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function normalize(value) {
  return String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function prefixedChecksum(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
