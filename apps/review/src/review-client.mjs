export function mountReviewPage({ document = globalThis.document, fetch = globalThis.fetch } = {}) {
  const required = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Review page is missing ${selector}`);
    return element;
  };
  const root = required('main[data-run-id]');
  const runId = root.dataset.runId;
  const error = required('#error');
  const changeForm = required('#change-form');
  const commentField = required('#comment');
  const decisionStatus = required('#decision-status');
  const decisionButtons = [...document.querySelectorAll('[data-decision], #change-form button')];
  const csrfToken = required('meta[name="review-csrf-token"]').content;
  let model;

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  const setDecisionAllowed = (allowed) => decisionButtons.forEach((button) => { button.disabled = !allowed; });
  const fillList = (selector, values, emptyLabel) => {
    const list = required(selector);
    list.replaceChildren();
    for (const value of values.length ? values : [emptyLabel]) {
      const item = document.createElement('li');
      item.textContent = value;
      list.append(item);
    }
  };
  const assetSource = (asset) => (
    asset?.state === 'available' && asset.artifactId && runId
      ? `/api/artifact?runId=${encodeURIComponent(runId)}&artifactId=${encodeURIComponent(asset.artifactId)}`
      : null
  );

  const renderStory = (payload) => {
    const story = payload.read.story;
    required('#story-title').textContent = story.title;
    required('#story-meta').textContent = `${story.estimatedMinutes} minute read`;
    const container = required('#story-blocks');
    container.replaceChildren();
    for (const block of story.blocks) {
      const section = document.createElement('section');
      section.className = 'story-block';
      const label = document.createElement('h4');
      label.textContent = block.type.replaceAll('_', ' ');
      const text = document.createElement('p');
      text.textContent = block.text;
      section.append(label, text);
      container.append(section);
    }
  };

  const renderPlaybook = (payload) => {
    const playbook = payload.read.playbook;
    required('#playbook-title').textContent = playbook.title;
    required('#playbook-principle').textContent = playbook.principle;
    required('#playbook-why').textContent = playbook.whyItMatters;
    const steps = required('#playbook-steps');
    steps.replaceChildren();
    for (const step of playbook.steps) {
      const section = document.createElement('section');
      section.className = 'playbook-step';
      const title = document.createElement('h4');
      title.textContent = step.title;
      const body = document.createElement('p');
      body.textContent = step.body;
      section.append(title, body);
      steps.append(section);
    }
    required('#playbook-example').textContent = `${playbook.example.title}: ${playbook.example.body}`;
    fillList('#playbook-watch-outs', playbook.watchOuts, 'No watch-outs.');
    required('#playbook-action').textContent = `Action: ${playbook.action}`;
  };

  const renderLegacyContent = (payload) => {
    required('#story-title').textContent = payload.title;
    required('#story-meta').textContent = payload.takeaway;
    const blocks = required('#story-blocks');
    blocks.replaceChildren();
    for (const [labelText, textValue] of Object.entries(payload.depths)) {
      const section = document.createElement('section');
      section.className = 'story-block';
      const label = document.createElement('h4');
      label.textContent = labelText;
      const text = document.createElement('p');
      text.textContent = textValue;
      section.append(label, text);
      blocks.append(section);
    }
    required('#playbook-title').textContent = payload.action;
    required('#playbook-principle').textContent = payload.takeaway;
  };

  const renderAsset = (kind, asset, altText) => {
    const container = required(`#${kind}`);
    container.replaceChildren();
    const source = assetSource(asset);
    if (!source || !asset.mediaType?.startsWith('image/')) {
      container.textContent = `Missing ${kind} preview.`;
      return null;
    }
    const image = document.createElement('img');
    image.src = source;
    image.alt = altText;
    container.append(image);
    return source;
  };

  const renderHeroCrops = (hero, source) => {
    required('#hero-alt').textContent = `Alt text: ${hero.altText}`;
    required('#hero-metadata').textContent = `${hero.width} x ${hero.height}; focal point ${hero.focalPoint.x}, ${hero.focalPoint.y}; crop safe area ${hero.cropSafeArea.x}, ${hero.cropSafeArea.y}, ${hero.cropSafeArea.width}, ${hero.cropSafeArea.height}`;
    for (const id of ['hero-lesson-header', 'hero-card', 'hero-thumbnail']) {
      const container = required(`#${id}`);
      container.replaceChildren();
      if (!source) continue;
      const image = document.createElement('img');
      image.src = source;
      image.alt = `${hero.altText} (${id.replace('hero-', '')} crop preview)`;
      image.style.objectPosition = `${hero.focalPoint.x * 100}% ${hero.focalPoint.y * 100}%`;
      container.append(image);
    }
  };

  const renderAudio = (id, asset, audio) => {
    const container = required(`#${id}`);
    container.replaceChildren();
    const source = assetSource(asset);
    if (!source || !asset.mediaType?.startsWith('audio/')) {
      container.textContent = `Missing ${id.replaceAll('-', ' ')}.`;
    } else {
      const control = document.createElement('audio');
      control.src = source;
      control.controls = true;
      control.preload = 'metadata';
      container.append(control);
    }
    required(`#${id}-transcript`).textContent = audio?.transcript?.text ?? 'Transcript unavailable.';
  };

  const load = async () => {
    try {
      if (!runId) throw new Error('A run id is required.');
      const response = await fetch(`/api/review?runId=${encodeURIComponent(runId)}`);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load the review.');
      model = payload;
      required('#title').textContent = payload.title;
      required('#status').textContent = `${payload.currentStage.replace('_', ' ')}: ${payload.reviewStatus}`;
      const checksumMatches = payload.package && payload.package.packageChecksum === payload.currentPackageChecksum;
      required('#checksum').textContent = checksumMatches ? payload.package.packageChecksum : 'Package checksum mismatch';
      if (payload.package) {
        const learner = payload.package.content.target.payload;
        if (payload.package.content.target.schemaVersion === '1.1.0' && learner.materialization === 'materialized') {
          renderStory(learner);
          renderPlaybook(learner);
          const heroSource = renderAsset('hero', payload.assets.hero, learner.hero.altText);
          renderHeroCrops(learner.hero, heroSource);
          renderAsset('infographic', payload.assets.infographic, learner.visual.altText);
          required('#infographic-alt').textContent = `Alt text: ${learner.visual.altText}`;
          fillList('#infographic-text-equivalent', learner.visual.textEquivalent, 'No text equivalent.');
          renderAudio('audio-brief', payload.assets.audioBrief, learner.listen.brief);
          renderAudio('audio-discussion', payload.assets.audioDiscussion, learner.listen.discussion);
          renderQuiz(learner);
        } else {
          renderLegacyContent(learner);
          renderAsset('hero', payload.assets.hero, 'Hero preview');
          renderAsset('infographic', payload.assets.infographic, 'Infographic preview');
          renderAudio('audio-brief', payload.assets.audioBrief, null);
          renderAudio('audio-discussion', payload.assets.audioDiscussion, null);
        }
        renderEvidence(payload.package);
        renderQa(payload.package);
        renderGenerationExecutions(payload.generationExecutions);
        fillList('#claim-coverage', learner.claimCoverage.map((entry) => `${entry.path}: ${entry.claimIds.join(', ')}`), 'No claim coverage.');
      }
      renderEditorialWarnings(payload.warnings);
      const allowed = Boolean(payload.decisionAllowed && checksumMatches);
      setDecisionAllowed(allowed);
      decisionStatus.textContent = allowed ? 'One overall package decision' : (payload.issues[0] || 'This package is not open for review.');
      required('#review').hidden = false;
    } catch (loadError) {
      required('#status').textContent = 'Review data unavailable';
      setDecisionAllowed(false);
      showError(loadError instanceof Error ? loadError.message : 'Could not load the review.');
    }
  };

  const renderQuiz = (payload) => {
    const container = required('#quiz');
    container.replaceChildren();
    for (const [index, question] of payload.quiz.questions.entries()) {
      const section = document.createElement('section');
      section.className = 'quiz-question';
      const prompt = document.createElement('h3');
      prompt.textContent = `${index + 1}. ${question.prompt}`;
      const options = document.createElement('ol');
      for (const option of question.options) {
        const item = document.createElement('li');
        item.textContent = `${option.text}${option.id === question.correctOptionId ? ' (correct)' : ''}`;
        options.append(item);
      }
      const rationale = document.createElement('p');
      rationale.textContent = question.rationale;
      section.append(prompt, options, rationale);
      container.append(section);
    }
  };

  const renderEvidence = (reviewPackage) => {
    const evidence = reviewPackage.evidence;
    fillList('#accepted-sources', evidence.acceptedSources.map((source) => (
      `${source.title} (${source.url}) snapshot ${source.snapshot.artifactId}`
    )), 'No accepted sources.');
    fillList('#rejected-sources', evidence.rejectedSources.map((source) => (
      `${source.title}: ${source.readability.reason || source.credibility.reason || 'rejected'}`
    )), 'No rejected sources.');
    fillList('#coverage-gaps', evidence.coverageGaps.map((gap) => `${gap.topic}: ${gap.reason}`), 'No coverage gaps.');
    fillList('#claims', evidence.claims.map((claim) => {
      const citations = claim.citations.map((citation) => (
        `${citation.sourceId}/${citation.snapshotArtifactId}: ${citation.excerpt}`
      )).join(' | ');
      return `${claim.statement} (${citations})`;
    }), 'No claims.');
  };

  const renderQa = (reviewPackage) => {
    required('#qa').textContent = `${reviewPackage.qa.deterministic.passed ? 'Passed' : 'Failed'}: ${reviewPackage.qa.editorial.summary}`;
    const all = [...reviewPackage.qa.deterministic.findings, ...reviewPackage.qa.editorial.findings];
    fillList('#qa-findings', all.map((finding) => `${finding.code}: ${finding.message}`), 'No QA findings.');
  };

  const renderEditorialWarnings = (warnings = []) => {
    const container = required('#editorial-warnings');
    container.replaceChildren();
    container.hidden = warnings.length === 0;
    if (warnings.length === 0) return;
    const label = document.createElement('strong');
    label.textContent = 'Editorial warnings';
    const list = document.createElement('ul');
    for (const warning of warnings) {
      const item = document.createElement('li');
      item.textContent = warning;
      list.append(item);
    }
    container.append(label, list);
  };

  const renderGenerationExecutions = (generationExecutions = {}) => {
    const container = required('#generation-executions');
    container.replaceChildren();
    for (const [role, executions] of Object.entries(generationExecutions)) {
      const heading = document.createElement('h4');
      heading.textContent = role.replace(/([A-Z])/g, ' $1').trim();
      const list = document.createElement('ul');
      list.className = 'provenance-list';
      for (const execution of executions) {
        const item = document.createElement('li');
        const summary = document.createElement('p');
        summary.textContent = `${execution.recipe.id}@${execution.recipe.version}; ${execution.model}; execution ${execution.executionId}; output ${execution.outputKind} ${execution.outputChecksum}; prompt ${execution.promptChecksum}; references ${execution.referenceChecksums.join(', ') || 'none'}`;
        item.append(summary);
        for (const [label, artifact] of [
          ['Recipe snapshot', execution.recipeSnapshot],
          ['Rendered prompt', execution.renderedPrompt],
          ['Execution report', execution.executionReport],
        ]) {
          const link = document.createElement('a');
          link.href = assetSource({ state: 'available', artifactId: artifact.artifactId }) ?? '#';
          link.textContent = label;
          item.append(link, document.createTextNode(' '));
        }
        list.append(item);
      }
      if (executions.length === 0) {
        const item = document.createElement('li');
        item.textContent = 'No generation provenance required for this historical package.';
        list.append(item);
      }
      container.append(heading, list);
    }
  };

  const submit = async (decision, comment) => {
    const packageChecksum = model?.package?.packageChecksum;
    if (!model?.decisionAllowed || !packageChecksum || packageChecksum !== model.currentPackageChecksum) {
      return showError('A complete current package is required.');
    }
    const response = await fetch('/api/review', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
      body: JSON.stringify({ runId, decision, packageChecksum, ...(comment ? { comment } : {}) }),
    });
    const payload = await response.json();
    if (!response.ok) return showError(payload.error || 'Could not record the review decision.');
    decisionStatus.textContent = `Recorded: ${payload.reviewStatus}`;
    changeForm.dataset.open = 'false';
    return load();
  };

  required('[data-decision="approve"]').addEventListener('click', () => void submit('approve'));
  required('[data-decision="request_changes"]').addEventListener('click', () => {
    changeForm.dataset.open = 'true';
    commentField.focus();
  });
  changeForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const comment = new FormData(changeForm).get('comment');
    if (typeof comment !== 'string' || !comment.trim()) return showError('A comment is required to request changes.');
    void submit('request_changes', comment.trim());
  });
  return load();
}
