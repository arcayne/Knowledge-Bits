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

  const renderContent = (reviewPackage) => {
    const payload = reviewPackage.content.target.payload;
    const values = {
      title: payload.title,
      takeaway: payload.takeaway,
      action: payload.action,
      'depths.quick': payload.depths.quick,
      'depths.core': payload.depths.core,
      'depths.deep': payload.depths.deep,
    };
    for (const [path, value] of Object.entries(values)) required(`[data-content-path="${path}"]`).textContent = value;
    fillList('#claim-coverage', payload.claimCoverage.map((entry) => `${entry.path}: ${entry.claimIds.join(', ')}`), 'No claim coverage.');
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

  const renderAsset = (kind, asset) => {
    const container = required(`#${kind}`);
    container.replaceChildren();
    if (asset.state === 'missing' || !asset.artifactId || !asset.mediaType || !runId) {
      container.textContent = `Missing ${kind} preview.`;
      return;
    }
    const source = `/api/artifact?runId=${encodeURIComponent(runId)}&artifactId=${encodeURIComponent(asset.artifactId)}`;
    const media = document.createElement(asset.mediaType.startsWith('audio/') ? 'audio' : 'img');
    media.src = source;
    if (media.tagName === 'AUDIO') media.controls = true;
    else media.alt = `${kind} preview`;
    container.append(media);
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
        renderContent(payload.package);
        renderEvidence(payload.package);
        renderQa(payload.package);
      }
      renderAsset('hero', payload.assets.hero);
      renderAsset('infographic', payload.assets.infographic);
      renderAsset('audio', payload.assets.audio);
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
