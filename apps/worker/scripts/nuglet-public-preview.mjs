import { createHash } from "node:crypto";

export const PUBLIC_PREVIEW_TEMPLATE_VERSION = "nuglet.public-preview@1.4.0";

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
    lesson.learning?.oneLineToKeep ?? lesson.commonMistake ?? centralIdea,
    "one line to keep",
  );
  const topicLabel = optional(
    lesson.identity?.topic?.label ?? lesson.topic?.label,
    "the lesson topic",
  );
  const brief = {
    schemaVersion: "nuglet.public-preview-brief.v1",
    promptTemplateVersion: PUBLIC_PREVIEW_TEMPLATE_VERSION,
    locale: "en",
    title,
    recognitionMoment: `Introduce the familiar puzzle suggested by "${title}" without explaining how to resolve it.`,
    centralProblem: `Show why this ${topicLabel} pattern can feel puzzling or mentally tangled without turning the moment into conflict or distress.`,
    whyItMatters: "Build curiosity about why the pattern matters without stating the lesson's reframe or action.",
    learningOutcomes: [
      `recognize the situation behind "${title}"`,
      "understand why the pattern matters",
      "see that the full Nuglet contains a practical next step",
    ],
    emotionalShiftDirection: "Move from thoughtful surprise or puzzlement toward calm curiosity, clarity, and gentle relief.",
    visualDirection: "Show challenge or tension through objects and environments, not through an upset face: a difficult book, tangled threads, layered pages, a maze, a path, or an unfinished diagram. Human figures may appear only with relaxed features, open curiosity, gentle concentration, recognition, or relief.",
    finalInvitation: "Learn the practical next step in the full Nuglet.",
    protectedContent: {
      exactPractice: takeaway,
      completeReframe: oneLineToKeep,
      quizAnswers: correctQuizAnswers(lesson),
    },
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
    "## Emotional direction",
    brief.emotionalShiftDirection,
    "",
    "## Visual direction",
    brief.visualDirection,
    "",
    "## Invitation",
    brief.finalInvitation,
    "",
    "## Protected boundary",
    "Do not disclose the exact practice, its steps, quiz answers, complete reframe, or conclusion.",
    "Create recognition and curiosity without resolving the lesson.",
    "",
  ].join("\n");
}

export function renderPublicPreviewPrompt(brief, marker) {
  return [
    marker,
    `Create an English-language NotebookLM Short for the locked Nuglet "${brief.title}".`,
    "Treat the selected curated preview source as the only allowed source.",
    "This is a preview, not a summary: do not reveal the exact practice, its steps, quiz answers, complete reframe, or conclusion.",
    "Use NotebookLM Short format: approximately 45-60 seconds, vertical, and mobile-first.",
    "Open immediately inside the recognition moment. Build gentle intellectual intrigue, explain why it matters, then promise what the full Nuglet helps the viewer understand without giving the answer.",
    "Use one calm narrative arc.",
    "Visual casting should generally reflect working adults aged roughly 25-40, with women represented most often. Younger men and people from varied backgrounds should appear naturally too. This is a flexible direction, not an exclusive rule or rigid quota. Avoid repeatedly defaulting to middle-aged or older men, and avoid stereotypes or tokenistic casting.",
    "Make every challenge, tension, or problem beat object-first: show a difficult book, tangled threads, layered pages, a maze, a path, an unfinished diagram, or another calm visual metaphor. Do not use a human face to communicate friction, struggle, confusion, difficulty, failure, or conflict.",
    "Human figures may appear only during recognition, curiosity, insight, or relief. Every visible person must have a relaxed forehead, relaxed eyes and mouth, open curiosity, gentle concentration, or a soft smile.",
    "Never show furrowed or knitted brows, narrowed eyes, downturned mouths, clenched jaws, clenched fists, tense shoulders, glaring, scowling, hostile, accusatory, distressed, panicked, defeated, or confrontational expressions or posture.",
    "Do not turn words such as friction, struggle, fight, failure, challenge, hard, difficult, or tangled into anger or emotional distress. Avoid close-up, front-facing portraits during tension or problem beats.",
    "The emotional arc is thoughtful surprise, curiosity, calm recognition, clarity, and gentle relief. The challenge should feel intellectually intriguing, never emotionally threatening.",
    "Tone: warm, hopeful, intelligent, emotionally observant, concise, evidence-grounded, and human. No hype, shame, fear, diagnosis, invented statistics, or transformation promises.",
  ].join(" ");
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
