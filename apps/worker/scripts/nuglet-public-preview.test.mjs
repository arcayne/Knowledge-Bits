import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePublicPreview,
  protectedLeakage,
  publicPreviewSourceTitle,
  renderPublicPreviewPrompt,
  renderPublicPreviewSource,
} from "./nuglet-public-preview.mjs";

const content = {
  kind: "nuglet.lesson.v1",
  schemaVersion: "1.1.0",
  payload: {
    identity: {
      title: "Protect Your Attention",
      topic: { label: "attention" },
    },
    learning: {
      centralIdea: "Visible cues make attention easier to pull away.",
      oneLineToKeep: "Design the setup before relying on effort.",
      action: { instruction: "Put the phone away and close extra tabs for one focus block." },
    },
    quiz: {
      questions: [{
        correctOptionId: "remove",
        options: [
          { id: "remove", text: "Remove easy distractions" },
          { id: "try", text: "Try harder" },
        ],
      }],
    },
  },
};

test("compiles a limited English source without protected lesson answers", () => {
  const brief = compilePublicPreview(content);
  const source = renderPublicPreviewSource(brief);
  assert.equal(brief.locale, "en");
  assert.match(source, /deliberately limited promotional preview source/);
  assert.doesNotMatch(source, /Put the phone away/);
  assert.doesNotMatch(source, /Remove easy distractions/);
  assert.doesNotMatch(source, /Visible cues make attention easier to pull away/);
  assert.doesNotMatch(source, /Design the setup before relying on effort/);
  assert.match(source, /attention pattern/);
  assert.equal(brief.promptTemplateVersion, "nuglet.public-preview@1.4.0");
  assert.match(publicPreviewSourceTitle(brief), /^Nuglet public preview [a-f0-9]{12}$/);
});

test("prompt binds NotebookLM Short format and the protected boundary", () => {
  const prompt = renderPublicPreviewPrompt(compilePublicPreview(content), "[marker]");
  assert.match(prompt, /NotebookLM Short/);
  assert.match(prompt, /45-60 seconds/);
  assert.match(prompt, /only allowed source/);
  assert.doesNotMatch(prompt, /Put the phone away/);
});

test("prompt biases casting toward the core audience without making it exclusive", () => {
  const prompt = renderPublicPreviewPrompt(compilePublicPreview(content), "[marker]");
  assert.match(prompt, /working adults aged roughly 25-40/);
  assert.match(prompt, /women represented most often/);
  assert.match(prompt, /Younger men and people from varied backgrounds/);
  assert.match(prompt, /flexible direction, not an exclusive rule or rigid quota/);
  assert.match(prompt, /Avoid repeatedly defaulting to middle-aged or older men/);
  assert.match(prompt, /avoid stereotypes or tokenistic casting/);
});

test("prompt keeps visual tension curious and brand-safe instead of angry", () => {
  const brief = compilePublicPreview(content);
  const source = renderPublicPreviewSource(brief);
  const prompt = renderPublicPreviewPrompt(brief, "[marker]");

  assert.match(source, /thoughtful surprise or puzzlement/);
  assert.match(source, /challenge or tension through objects and environments/);
  assert.doesNotMatch(source, /personally frustrating|self-blame/);
  assert.match(prompt, /gentle intellectual intrigue/);
  assert.match(prompt, /every challenge, tension, or problem beat object-first/);
  assert.match(prompt, /Do not use a human face to communicate friction, struggle, confusion, difficulty, failure, or conflict/);
  assert.match(prompt, /relaxed forehead, relaxed eyes and mouth/);
  assert.match(prompt, /Never show furrowed or knitted brows, narrowed eyes, downturned mouths, clenched jaws/);
  assert.match(prompt, /Avoid close-up, front-facing portraits during tension or problem beats/);
  assert.match(prompt, /thoughtful surprise, curiosity, calm recognition, clarity, and gentle relief/);
  assert.match(prompt, /never emotionally threatening/);
  assert.doesNotMatch(prompt, /Build tension/);
});

test("flags obvious practice and quiz-answer leakage", () => {
  const brief = compilePublicPreview(content);
  assert.ok(protectedLeakage(
    "Put the phone away and close extra tabs for one focus block.",
    brief,
  ).length > 0);
  assert.deepEqual(protectedLeakage("See why attention can feel scattered.", brief), []);
});

test("allows the public title when it is also the protected one-line reframe", () => {
  const brief = compilePublicPreview({
    ...content,
    payload: {
      ...content.payload,
      identity: { title: "Your mind is your only permanent roommate" },
      learning: {
        ...content.payload.learning,
        oneLineToKeep: "Your mind is your only permanent roommate.",
      },
    },
  });

  assert.deepEqual(
    protectedLeakage("Your mind is your only permanent roommate.", brief),
    [],
  );
});

test("never places the complete reframe or central idea in the provider source", () => {
  const cases = [
    {
      title: "The hard book was teaching me how to think slowly",
      centralIdea: "A difficult book is not always a problem; sometimes the friction is useful because it slows you down.",
      oneLineToKeep: "The friction of a hard text is not a barrier; it is the workout that builds cognitive patience.",
    },
    {
      title: "The One-Sentence Test for True Understanding",
      centralIdea: "You can test whether you understand one idea by explaining it plainly, from memory.",
      oneLineToKeep: "Familiarity is not understanding; true comprehension requires explanation from memory.",
    },
    {
      title: "Not Every Thought is Work",
      centralIdea: "Overthinking gets quieter when you stop treating every thought as a responsibility.",
      oneLineToKeep: "A thought can ask for your attention without becoming a task.",
    },
  ];

  for (const candidate of cases) {
    const source = renderPublicPreviewSource(compilePublicPreview({
      ...content,
      payload: {
        ...content.payload,
        identity: { title: candidate.title },
        learning: {
          ...content.payload.learning,
          centralIdea: candidate.centralIdea,
          oneLineToKeep: candidate.oneLineToKeep,
        },
      },
    }));
    assert.doesNotMatch(source, new RegExp(candidate.centralIdea.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.doesNotMatch(source, new RegExp(candidate.oneLineToKeep.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});
