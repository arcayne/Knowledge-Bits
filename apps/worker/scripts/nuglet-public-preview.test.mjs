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
    identity: { title: "Protect Your Attention" },
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
  assert.match(publicPreviewSourceTitle(brief), /^Nuglet public preview [a-f0-9]{12}$/);
});

test("prompt binds NotebookLM Short format and the protected boundary", () => {
  const prompt = renderPublicPreviewPrompt(compilePublicPreview(content), "[marker]");
  assert.match(prompt, /NotebookLM Short/);
  assert.match(prompt, /45-60 seconds/);
  assert.match(prompt, /only allowed source/);
  assert.doesNotMatch(prompt, /Put the phone away/);
});

test("flags obvious practice and quiz-answer leakage", () => {
  const brief = compilePublicPreview(content);
  assert.ok(protectedLeakage(
    "Put the phone away and close extra tabs for one focus block.",
    brief,
  ).length > 0);
  assert.deepEqual(protectedLeakage("See why attention can feel scattered.", brief), []);
});
