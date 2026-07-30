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
  const regenerateInfographic = required('#regenerate-infographic');
  const regenerateInfographicStatus = required('#regenerate-infographic-status');
  const decisionButtons = [...document.querySelectorAll('[data-decision], #change-form button')];
  const csrfToken = required('meta[name="review-csrf-token"]').content;
  let model;
  let submissionInFlight = false;
  let regenerationInFlight = false;

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  const clearError = () => {
    error.textContent = '';
    error.hidden = true;
  };
  const setDecisionAllowed = (allowed) => decisionButtons.forEach((button) => { button.disabled = !allowed; });
  const setRegenerationAllowed = (allowed) => {
    regenerateInfographic.disabled = !allowed || regenerationInFlight;
  };
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

  const renderRunSummary = (run) => {
    const container = required('#run-summary');
    container.replaceChildren();
    for (const [label, value] of [
      ['Stage', run.currentStage.replaceAll('_', ' ')],
      ['State', run.currentState.replaceAll('_', ' ')],
      ['Revision', String(run.currentRevision)],
      ['Review', run.reviewStatus.replaceAll('_', ' ')],
    ]) {
      const chip = document.createElement('span');
      chip.className = 'run-chip';
      chip.dataset.tone = run.currentState === 'queued' || run.currentState === 'running' ? 'active' : 'neutral';
      chip.textContent = `${label}: ${value}`;
      container.append(chip);
    }
    container.hidden = false;
  };

  const renderPendingDocument = (section, message) => {
    const container = required(section);
    container.replaceChildren();
    const note = document.createElement('p');
    note.className = 'pending-note';
    note.textContent = message;
    container.append(note);
  };

  const setNarrativeLayout = (isNarrative) => {
    required('#written-format-label').textContent = isNarrative ? 'Lesson' : 'Story';
    required('#playbook-section').hidden = isNarrative;
    required('#audio-brief-section').hidden = isNarrative;
    required('#audio-discussion-section').hidden = isNarrative;
    required('#audio-conversation-section').hidden = !isNarrative;
  };

  const renderProgressiveMedia = (media = [], candidate = null) => {
    const byKind = new Map(media.filter((item) => item.state !== 'missing').map((item) => [item.kind, item]));
    const hero = byKind.get('hero');
    const heroSource = renderAsset('hero', hero, 'Verified legacy hero');
    for (const id of ['hero-lesson-header', 'hero-card', 'hero-thumbnail']) {
      const container = required(`#${id}`);
      container.replaceChildren();
      if (!heroSource) continue;
      const image = document.createElement('img');
      image.src = heroSource;
      image.alt = 'Verified legacy hero crop preview';
      container.append(image);
    }
    required('#hero-alt').textContent = candidate?.hero?.altText
      ? `Draft brief: ${candidate.hero.altText}`
      : hero
        ? 'Verified production hero, pending package attachment.'
        : '';
    renderAsset('infographic', byKind.get('infographic'), 'Verified legacy infographic');
    required('#infographic-alt').textContent = candidate?.visual?.altText
      ? `Draft brief: ${candidate.visual.altText}`
      : byKind.has('infographic')
        ? 'Verified production infographic, pending package attachment.'
        : '';
    fillList(
      '#infographic-text-equivalent',
      Array.isArray(candidate?.visual?.textEquivalent) ? candidate.visual.textEquivalent : [],
      'Infographic text will appear after the visual brief is generated.',
    );

    const isNarrative = candidate?.contentModel === 'single-narrative.v2';
    setNarrativeLayout(isNarrative);
    if (isNarrative) {
      renderProgressiveAudio('audio-conversation', byKind.get('audio_conversation'));
    } else {
      renderProgressiveAudio('audio-brief', byKind.get('audio_brief'));
      renderProgressiveAudio('audio-discussion', byKind.get('audio_discussion'));
    }
  };

  const renderProgressiveAudio = (id, asset) => {
    const container = required(`#${id}`);
    container.replaceChildren();
    const source = assetSource(asset);
    if (!source || !asset.mediaType?.startsWith('audio/')) {
      container.dataset.state = 'pending';
      const label = id === 'audio-brief'
        ? 'Brief'
        : id === 'audio-discussion'
          ? 'Discussion'
          : 'Conversation';
      container.textContent = asset?.state === 'planned'
        ? `${label} audio is ready and will attach at Produce assets.`
        : `${label} audio is pending attachment.`;
      return;
    }
    const control = document.createElement('audio');
    control.src = source;
    control.controls = true;
    control.preload = 'metadata';
    container.append(control);
  };

  const renderProgressiveEvidence = (documentModel, candidate = null) => {
    const evidence = documentModel?.state === 'available' ? documentModel.data : null;
    const accepted = Array.isArray(evidence?.acceptedSources) ? evidence.acceptedSources : [];
    const rejected = Array.isArray(evidence?.rejectedSources) ? evidence.rejectedSources : [];
    const gaps = Array.isArray(evidence?.coverageGaps) ? evidence.coverageGaps : [];
    const claims = Array.isArray(candidate?.claims) ? candidate.claims : [];
    const coverage = Array.isArray(candidate?.claimCoverage) ? candidate.claimCoverage : [];
    fillList('#accepted-sources', accepted.map((source) => `${source.title} - ${source.url}`), 'Research has not produced accepted sources yet.');
    fillList('#rejected-sources', rejected.map((source) => `${source.title}: ${source.readability?.reason || source.credibility?.reason || 'rejected'}`), 'No rejected sources.');
    fillList('#coverage-gaps', gaps.map((gap) => `${gap.topic}: ${gap.reason}`), 'No recorded coverage gaps.');
    fillList('#claims', claims.map((claim) => claim.statement), 'Claims will appear after Story and Playbook generation.');
    fillList(
      '#claim-coverage',
      coverage.map((entry) => `${entry.path}: ${entry.claimIds.length} claim${entry.claimIds.length === 1 ? '' : 's'}`),
      'Claim coverage will appear after content generation.',
    );
  };

  const renderProgressive = (payload) => {
    renderRunSummary(payload.run);
    const candidate = payload.documents.content.state === 'available'
      ? payload.documents.content.data?.payload
      : null;
    if (candidate?.read?.lesson) {
      renderNarrative(candidate);
    } else if (candidate?.read?.story) {
      renderStory(candidate);
    } else {
      renderPendingDocument('#story-blocks', payload.documents.content.state === 'unavailable'
        ? `Story generation exists but cannot be read: ${payload.documents.content.issue}`
        : 'Story has not been generated yet. It is scheduled in the Create stage.');
    }
    if (candidate?.read?.lesson) {
      required('#playbook-section').hidden = true;
    } else if (candidate?.read?.playbook) {
      renderPlaybook(candidate);
    } else {
      renderPendingDocument('#playbook-steps', payload.documents.content.state === 'unavailable'
        ? `Playbook generation exists but cannot be read: ${payload.documents.content.issue}`
        : 'Playbook has not been generated yet. It is scheduled as a separate Create request.');
    }
    if (candidate?.quiz?.questions) renderQuiz(candidate);
    renderProgressiveMedia(payload.media, candidate);
    renderProgressiveEvidence(payload.documents.evidence, candidate);
    required('#qa').textContent = payload.documents.qa.state === 'available'
      ? 'QA evidence is available and will be shown with the completed package.'
      : 'QA is pending until Story and Playbook are generated.';
    fillList('#qa-findings', [], 'No QA findings yet.');
    required('#checksum').textContent = 'Package pending';
    decisionStatus.textContent = payload.run.currentState === 'needs_human' && payload.run.currentStage !== 'human_review'
      ? `Automated ${payload.run.currentStage.replaceAll('_', ' ')} is blocked: ${payload.run.reason || 'operator attention required'}. Human review comes after generation and QA.`
      : payload.run.currentStage !== 'human_review'
        ? `Not ready for approval. ${payload.run.currentStage.replaceAll('_', ' ')} is ${payload.run.currentState.replaceAll('_', ' ')}. Human review comes after generation and QA.`
        : `Not ready for approval. ${payload.run.currentStage.replaceAll('_', ' ')} is ${payload.run.currentState.replaceAll('_', ' ')}.`;
    setDecisionAllowed(false);
    setRegenerationAllowed(false);
    required('#review').hidden = false;
  };

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

  const renderNarrative = (payload) => {
    const lesson = payload.read.lesson;
    setNarrativeLayout(true);
    required('#story-title').textContent = lesson.title;
    required('#story-meta').textContent = `${lesson.estimatedMinutes} minute read`;
    const container = required('#story-blocks');
    container.replaceChildren();
    for (const part of lesson.sections) {
      const section = document.createElement('section');
      section.className = 'story-block';
      const text = document.createElement('p');
      text.textContent = part.text;
      section.append(text);
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
      container.dataset.state = 'pending';
      container.textContent = asset?.state === 'planned'
        ? `Verified legacy ${kind} is ready in the migration bundle and will attach at Produce assets.`
        : `Missing ${kind} preview.`;
      return null;
    }
    const image = document.createElement('img');
    image.src = source;
    image.alt = altText;
    const link = document.createElement('a');
    link.href = source;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.className = 'full-size-link';
    link.dataset.fullSize = kind;
    link.title = `Open full-size ${kind}`;
    link.append(image);
    container.append(link);
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

  const renderVideo = (id, asset) => {
    const container = document.querySelector(`#${id}`);
    if (!container) return;
    container.replaceChildren();
    const source = assetSource(asset);
    if (!source || !asset?.mediaType?.startsWith('video/')) {
      container.dataset.state = 'pending';
      container.textContent = 'No public preview Short is queued for this package.';
      return;
    }
    const control = document.createElement('video');
    control.src = source;
    control.controls = true;
    control.preload = 'metadata';
    control.playsInline = true;
    container.append(control);
  };

  const load = async () => {
    try {
      clearError();
      if (!runId) throw new Error('A run id is required.');
      const reviewResponse = await fetch(`/api/review?runId=${encodeURIComponent(runId)}`);
      const payload = await reviewResponse.json();
      if (!reviewResponse.ok) throw new Error(payload.error || 'Could not load the review.');
      model = payload;
      const checksumMatches = payload.package && payload.package.packageChecksum === payload.currentPackageChecksum;
      required('#checksum').textContent = checksumMatches ? payload.package.packageChecksum : 'Package checksum mismatch';
      if (payload.package) {
        required('#title').textContent = payload.title;
        required('#status').textContent = `${payload.currentStage.replaceAll('_', ' ')}: ${payload.reviewStatus.replaceAll('_', ' ')}`;
        const learner = payload.package.content.target.payload;
        if (payload.package.content.target.schemaVersion === '2.0.0' && learner.materialization === 'materialized') {
          renderNarrative(learner);
          const heroSource = renderAsset('hero', payload.assets.hero, learner.hero.altText);
          renderHeroCrops(learner.hero, heroSource);
          renderAsset('infographic', payload.assets.infographic, learner.visual.altText);
          required('#infographic-alt').textContent = `Alt text: ${learner.visual.altText}`;
          fillList('#infographic-text-equivalent', learner.visual.textEquivalent, 'No text equivalent.');
          renderAudio(
            'audio-conversation',
            payload.assets.audioConversation,
            learner.listen.conversation,
          );
          renderVideo('public-preview', payload.assets.publicPreview);
          renderQuiz(learner);
        } else if (payload.package.content.target.schemaVersion === '1.1.0' && learner.materialization === 'materialized') {
          setNarrativeLayout(false);
          renderStory(learner);
          renderPlaybook(learner);
          const heroSource = renderAsset('hero', payload.assets.hero, learner.hero.altText);
          renderHeroCrops(learner.hero, heroSource);
          renderAsset('infographic', payload.assets.infographic, learner.visual.altText);
          required('#infographic-alt').textContent = `Alt text: ${learner.visual.altText}`;
          fillList('#infographic-text-equivalent', learner.visual.textEquivalent, 'No text equivalent.');
          renderAudio('audio-brief', payload.assets.audioBrief, learner.listen.brief);
          renderAudio('audio-discussion', payload.assets.audioDiscussion, learner.listen.discussion);
          renderVideo('public-preview', payload.assets.publicPreview);
          renderQuiz(learner);
        } else {
          setNarrativeLayout(false);
          renderLegacyContent(learner);
          renderAsset('hero', payload.assets.hero, 'Hero preview');
          renderAsset('infographic', payload.assets.infographic, 'Infographic preview');
          renderAudio('audio-brief', payload.assets.audioBrief, null);
          renderAudio('audio-discussion', payload.assets.audioDiscussion, null);
          renderVideo('public-preview', payload.assets.publicPreview);
        }
        renderEvidence(payload.package);
        renderQa(payload.package);
        renderGenerationExecutions(payload.generationExecutions);
        fillList('#claim-coverage', learner.claimCoverage.map((entry) => `${entry.path}: ${entry.claimIds.join(', ')}`), 'No claim coverage.');
        setRegenerationAllowed(payload.reviewStatus !== 'rejected');
        regenerateInfographicStatus.textContent = payload.reviewStatus === 'approved'
          ? 'Replacing this asset clears approval and returns the package to human review.'
          : 'Queues one Vertex-planned Nuglet infographic and returns the package to human review.';
      } else {
        const previewResponse = await fetch(`/api/preview?runId=${encodeURIComponent(runId)}`);
        const preview = await previewResponse.json();
        if (!previewResponse.ok) throw new Error(preview.error || 'Could not load the progressive preview.');
        required('#title').textContent = preview.run.title;
        required('#status').textContent = `${preview.run.currentStage.replaceAll('_', ' ')}: ${preview.run.currentState.replaceAll('_', ' ')}`;
        renderProgressive(preview);
        setRegenerationAllowed(false);
      }
      renderEditorialWarnings(payload.warnings);
      const approved = payload.reviewStatus === 'approved';
      const rejected = payload.reviewStatus === 'rejected';
      const terminal = approved || rejected;
      const allowed = Boolean(payload.decisionAllowed && checksumMatches && !terminal);
      setDecisionAllowed(allowed);
      required('[data-decision="approve"]').hidden = terminal;
      required('[data-decision="request_changes"]').hidden = terminal;
      changeForm.hidden = terminal;
      if (terminal) changeForm.dataset.open = 'false';
      if (payload.package) {
        decisionStatus.textContent = terminal
          ? (approved ? 'Approved, awaiting delivery.' : 'Rejected and removed from the active pipeline.')
          : allowed
            ? 'One overall package decision'
            : (payload.issues[0] || 'This package is not open for review.');
      }
      required('#review').hidden = false;
    } catch (loadError) {
      required('#status').textContent = 'Review data unavailable';
      setDecisionAllowed(false);
      setRegenerationAllowed(false);
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
    if (submissionInFlight) return;
    const packageChecksum = model?.package?.packageChecksum;
    if (!model?.decisionAllowed || !packageChecksum || packageChecksum !== model.currentPackageChecksum) {
      return showError('A complete current package is required.');
    }
    submissionInFlight = true;
    clearError();
    setDecisionAllowed(false);
    decisionStatus.textContent = decision === 'approve' ? 'Recording approval...' : 'Sending changes...';
    let submitted = false;
    try {
      const response = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ runId, decision, packageChecksum, ...(comment ? { comment } : {}) }),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // Preserve a visible failure state when an upstream proxy returns an empty or non-JSON response.
      }
      if (!response.ok) throw new Error(payload.error || 'Could not record the review decision.');
      submitted = true;
      decisionStatus.textContent = `Recorded: ${payload.reviewStatus || decision}`;
      changeForm.dataset.open = 'false';
      await load();
    } catch (submitError) {
      decisionStatus.textContent = 'Decision not recorded';
      showError(submitError instanceof Error ? submitError.message : 'Could not record the review decision.');
    } finally {
      submissionInFlight = false;
      if (!submitted) {
        const currentChecksum = model?.package?.packageChecksum;
        const allowed = Boolean(
          model?.decisionAllowed
          && currentChecksum
          && currentChecksum === model.currentPackageChecksum
          && model.reviewStatus !== 'approved'
          && model.reviewStatus !== 'rejected'
        );
        setDecisionAllowed(allowed);
      }
    }
  };

  const replaceInfographic = async () => {
    if (regenerationInFlight || !model?.package || model.reviewStatus === 'rejected') return;
    regenerationInFlight = true;
    clearError();
    setRegenerationAllowed(false);
    regenerateInfographicStatus.textContent = 'Queueing one Nuglet infographic...';
    try {
      const response = await fetch('/api/regenerate-infographic', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ runId }),
      });
      let payload = {};
      try {
        payload = await response.json();
      } catch {
        // Preserve a visible failure state when an upstream proxy returns an empty or non-JSON response.
      }
      if (!response.ok) throw new Error(payload.error || 'Could not queue the Nuglet infographic.');
      regenerateInfographicStatus.textContent = 'Queued. The package is returning to human review.';
      await load();
    } catch (regenerationError) {
      regenerateInfographicStatus.textContent = 'Infographic replacement was not queued.';
      showError(regenerationError instanceof Error
        ? regenerationError.message
        : 'Could not queue the Nuglet infographic.');
    } finally {
      regenerationInFlight = false;
      setRegenerationAllowed(Boolean(model?.package && model.reviewStatus !== 'rejected'));
    }
  };

  regenerateInfographic.addEventListener('click', () => void replaceInfographic());
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
