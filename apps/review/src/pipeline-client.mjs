const STAGES = [
  ['research', 'Research'],
  ['create', 'Create'],
  ['check', 'Check'],
  ['produce_assets', 'Produce assets'],
  ['human_review', 'Human review'],
  ['deliver', 'Deliver'],
];
const OPERATOR_TIME_ZONE = 'Europe/Madrid';

const CLASSIFICATIONS = [
  ['active', 'Active pipeline', 'Work still moving through research, creation, checks, assets, or human review.'],
  ['deliver', 'Delivering', 'Approved runs waiting for or executing delivery.'],
  ['completed', 'Completed', 'Runs whose delivery stage is done.'],
  ['rejected', 'Rejected', 'Runs explicitly rejected by a reviewer and removed from active work.'],
  ['duplicate', 'Duplicates', 'Older records superseded by a newer run for the same Nuglet.'],
];

export function mountPipelinePage({ document = globalThis.document, fetch = globalThis.fetch } = {}) {
  const required = (selector) => {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`Pipeline page is missing ${selector}`);
    return element;
  };
  const summary = required('#pipeline-summary');
  const dailyProgress = required('#daily-progress');
  const operations = required('#operations');
  const statusCounts = required('#status-counts');
  const stageCounts = required('#stage-counts');
  const runs = required('#pipeline-runs');
  const error = required('#pipeline-error');
  const refresh = required('#pipeline-refresh');
  const filters = [...document.querySelectorAll('[data-filter]')];
  mountNewNugletForm({ document, fetch });
  let model;
  let filter = 'all';

  const showError = (message) => {
    error.textContent = message;
    error.hidden = false;
  };
  const render = () => {
    const visibleRuns = model.runs.filter((run) => {
      if (filter === 'all') return true;
      if (filter === 'needs_human') return run.currentState === 'needs_human';
      if (filter === 'blocked') return isBlocked(run);
      if (filter === 'retrying') return Boolean(run.nextRetryAt || run.delivery?.nextAttemptAt);
      return run.classification === filter;
    });
    summary.textContent = filter === 'all'
      ? `${model.runs.length} runs · ${model.counts.active} active · ${model.counts.delivering} delivering · ${model.counts.completed} completed · ${model.counts.rejected} rejected · ${model.counts.duplicates} duplicates`
      : `${visibleRuns.length} run${visibleRuns.length === 1 ? '' : 's'} shown`;
    renderDailyProgress(document, dailyProgress, model.daily, latestRun(model.runs));
    renderOperations(document, operations, model);
    statusCounts.replaceChildren(...[
      ['active', 'Active', model.counts.active],
      ['deliver', 'Delivering', model.counts.delivering],
      ['completed', 'Completed', model.counts.completed],
      ['rejected', 'Rejected', model.counts.rejected],
      ['duplicates', 'Duplicates', model.counts.duplicates],
      ['needsHuman', 'Needs attention', model.counts.needsHuman],
    ].map(([key, label, count]) => {
      const item = document.createElement('div');
      item.dataset.statusCount = key;
      const countNode = document.createElement('strong');
      countNode.textContent = String(count);
      const labelNode = document.createElement('span');
      labelNode.textContent = label;
      item.append(countNode, labelNode);
      return item;
    }));
    stageCounts.replaceChildren(...STAGES.map(([stage, label]) => {
      const item = document.createElement('div');
      const count = document.createElement('strong');
      count.dataset.stageCount = stage;
      count.textContent = String(model.counts[stage]);
      const name = document.createElement('span');
      name.textContent = label;
      item.append(count, name);
      return item;
    }));
    runs.replaceChildren();
    for (const [classification, label, description] of CLASSIFICATIONS) {
      const classificationRuns = visibleRuns.filter((run) => run.classification === classification);
      if (!classificationRuns.length) continue;
      const group = document.createElement('section');
      group.dataset.classification = classification;
      const heading = document.createElement('h2');
      heading.textContent = label;
      const explanation = document.createElement('p');
      explanation.className = 'group-description';
      explanation.textContent = description;
      const list = document.createElement('div');
      list.className = 'run-list';
      for (const run of classificationRuns) list.append(runRow(document, run));
      group.append(heading, explanation, list);
      runs.append(group);
    }
    if (!visibleRuns.length) {
      const empty = document.createElement('p');
      empty.textContent = filter === 'all' ? 'No pipeline runs yet.' : 'No runs match this view.';
      runs.append(empty);
    }
  };

  for (const button of filters) {
    button.addEventListener('click', () => {
      filter = button.dataset.filter || 'all';
      for (const candidate of filters) candidate.setAttribute('aria-pressed', String(candidate === button));
      render();
    });
  }

  const load = async () => {
    try {
      const response = await fetch('/api/pipeline');
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not load the pipeline.');
      model = payload;
      render();
      return model;
    } catch (loadError) {
      summary.textContent = 'Pipeline data unavailable';
      showError(loadError instanceof Error ? loadError.message : 'Could not load the pipeline.');
      return undefined;
    }
  };

  refresh.addEventListener('click', () => { void load(); });
  const refreshTimer = globalThis.setInterval?.(() => { void load(); }, 30_000);
  void refreshTimer;
  return load();
}

function mountNewNugletForm({ document, fetch }) {
  const form = document.querySelector('#new-nuglet-form');
  if (!form) return;
  const submit = document.querySelector('#new-nuglet-submit');
  const status = document.querySelector('#new-nuglet-status');
  const check = document.querySelector('#nuglet-similarity-check');
  const similarityStatus = document.querySelector('#nuglet-similarity-status');
  const results = document.querySelector('#nuglet-similarity-results');
  const resultsHeading = document.querySelector('#nuglet-similarity-heading');
  const matches = document.querySelector('#nuglet-similarity-matches');
  const distinctConfirmation = document.querySelector('#nuglet-distinct-confirmation');
  const distinctCheckbox = form.querySelector('[name="confirmDistinct"]');
  const csrfToken = document.querySelector('meta[name="review-csrf-token"]')?.content ?? '';
  const value = (name) => form.querySelector(`[name="${name}"]`)?.value.trim() ?? '';
  const draftFingerprint = () => JSON.stringify({
    title: value('title'),
    objective: value('objective'),
    audience: value('audience'),
    locale: value('locale'),
  });
  let checkedDraft;
  let similarity;
  let checking = false;
  let submitting = false;

  const updateSubmit = () => {
    const checkIsCurrent = checkedDraft === draftFingerprint();
    const distinctConfirmed = similarity?.risk === 'none' || distinctCheckbox.checked;
    submit.disabled = checking
      || submitting
      || !checkIsCurrent
      || !similarity
      || !distinctConfirmed
      || !value('notebookLmNotebookId');
  };

  const invalidateSimilarity = () => {
    checkedDraft = undefined;
    similarity = undefined;
    results.hidden = true;
    results.dataset.risk = '';
    matches.replaceChildren();
    distinctConfirmation.hidden = true;
    distinctCheckbox.checked = false;
    similarityStatus.textContent = 'Run this check before creating the notebook.';
    updateSubmit();
  };

  const renderSimilarity = (payload) => {
    similarity = payload;
    checkedDraft = draftFingerprint();
    results.hidden = false;
    results.dataset.risk = payload.risk;
    matches.replaceChildren();
    distinctCheckbox.checked = false;
    if (payload.risk === 'none') {
      resultsHeading.textContent = 'No close matches found';
      const item = document.createElement('li');
      item.textContent = 'No existing Knowledge Bits run crossed the related-content threshold.';
      matches.append(item);
      distinctConfirmation.hidden = true;
      similarityStatus.textContent = 'Similarity check is current. Create a fresh NotebookLM notebook for this Nuglet.';
    } else {
      resultsHeading.textContent = payload.risk === 'likely_duplicate'
        ? 'Likely duplicate found'
        : 'Related Nuglets found';
      for (const match of payload.matches) {
        const item = document.createElement('li');
        const link = document.createElement('a');
        link.href = match.reviewPath;
        link.textContent = match.title;
        const detail = document.createElement('span');
        detail.textContent = ` · ${Math.round(match.score * 100)}% · ${match.reasons.join('; ')}`;
        item.append(link, detail);
        matches.append(item);
      }
      distinctConfirmation.hidden = false;
      similarityStatus.textContent = 'Review the matches before deciding whether this is a distinct Nuglet.';
    }
    updateSubmit();
  };

  for (const name of ['title', 'objective', 'audience', 'locale']) {
    form.querySelector(`[name="${name}"]`)?.addEventListener('input', invalidateSimilarity);
  }
  form.querySelector('[name="notebookLmNotebookId"]')?.addEventListener('input', updateSubmit);
  distinctCheckbox.addEventListener('change', updateSubmit);
  check.addEventListener('click', async () => {
    if (checking || submitting) return;
    const input = {
      title: value('title'),
      objective: value('objective'),
      audience: value('audience'),
      locale: value('locale'),
    };
    if (Object.values(input).some((field) => !field)) {
      similarityStatus.textContent = 'Add the title, objective, audience, and locale before checking.';
      return;
    }
    checking = true;
    check.disabled = true;
    similarityStatus.textContent = 'Checking every existing run...';
    updateSubmit();
    try {
      const response = await fetch('/api/similarity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify(input),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || 'Could not check for similar Nuglets.');
      renderSimilarity(payload);
    } catch (error) {
      invalidateSimilarity();
      similarityStatus.textContent = error instanceof Error ? error.message : 'Could not check for similar Nuglets.';
    } finally {
      checking = false;
      check.disabled = false;
      updateSubmit();
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (submitting) return;
    if (!similarity || checkedDraft !== draftFingerprint()) {
      status.dataset.tone = 'error';
      status.textContent = 'Run the similarity check again before starting research.';
      return;
    }
    if (similarity.risk !== 'none' && !distinctCheckbox.checked) {
      status.dataset.tone = 'error';
      status.textContent = 'Confirm the distinct learner objective or angle before continuing.';
      return;
    }
    submitting = true;
    updateSubmit();
    status.dataset.tone = '';
    status.textContent = 'Creating the research run...';
    const sourceUrls = value('sourceUrls').split(/\r?\n/).map((url) => url.trim()).filter(Boolean);
    const brief = {
      topic: value('title'),
      title: value('title'),
      objective: value('objective'),
      audience: value('audience'),
      locale: value('locale'),
      notebookLmNotebookId: value('notebookLmNotebookId'),
      ...(sourceUrls.length ? { sourceUrls } : {}),
      intake: {
        requestedBy: 'review_operator',
        requestedFormat: 'story_playbook',
        similarityReview: {
          fingerprint: similarity.fingerprint,
          decision: similarity.risk === 'none' ? 'clear' : 'proceed_distinct',
        },
      },
    };
    try {
      const response = await fetch('/api/runs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken },
        body: JSON.stringify({ title: value('title'), locale: value('locale'), notebookLmNotebookId: value('notebookLmNotebookId'), brief }),
      });
      const payload = await response.json();
      if (!response.ok) {
        if (payload.similarity) renderSimilarity(payload.similarity);
        throw new Error(payload.error || 'Could not start the Nuglet.');
      }
      status.innerHTML = '';
      status.append(document.createTextNode('Research started. '));
      const link = document.createElement('a');
      link.href = `/runs/${encodeURIComponent(payload.id)}`;
      link.textContent = 'Open review';
      status.append(link);
      form.reset();
      form.querySelector('[name="audience"]').value = 'general adult learners';
      form.querySelector('[name="locale"]').value = 'en';
      invalidateSimilarity();
    } catch (error) {
      status.dataset.tone = 'error';
      status.textContent = error instanceof Error ? error.message : 'Could not start the Nuglet.';
    } finally {
      submitting = false;
      updateSubmit();
    }
  });
  invalidateSimilarity();
}

function runRow(document, run) {
  const row = document.createElement('article');
  row.dataset.runRow = '';
  const title = document.createElement('h3');
  title.textContent = run.title;
  const details = document.createElement('p');
  details.textContent = `${labelForClassification(run.classification)} · Revision ${run.currentRevision} · ${run.currentState.replaceAll('_', ' ')} · ${formatUpdatedAt(run.updatedAt)}`;
  row.append(title, details);
  const badges = document.createElement('div');
  badges.className = 'run-badges';
  badges.append(badge(document, `Stage attempt ${run.currentAttempt}`));
  if (run.nextRetryAt) badges.append(badge(document, `Retry ${formatUpdatedAt(run.nextRetryAt)}`, 'warning'));
  if (run.delivery) {
    badges.append(badge(document, `Delivery ${run.delivery.state.replaceAll('_', ' ')}`, isBlocked(run) ? 'warning' : undefined));
    badges.append(badge(document, `Delivery attempts ${run.delivery.attempts}`));
    if (run.delivery.nextAttemptAt) badges.append(badge(document, `Delivery retry ${formatUpdatedAt(run.delivery.nextAttemptAt)}`, 'warning'));
  }
  row.append(badges);
  if (run.reason) {
    const reason = document.createElement('p');
    reason.className = 'run-reason';
    reason.textContent = run.reason;
    row.append(reason);
  }
  if (run.duplicateOf) {
    const duplicate = document.createElement('p');
    duplicate.className = 'run-duplicate';
    duplicate.textContent = `Superseded by ${run.duplicateOf}`;
    row.append(duplicate);
  }
  const preview = document.createElement('a');
  preview.href = `/runs/${encodeURIComponent(run.id)}`;
  preview.textContent = 'Preview';
  row.append(preview);
  return row;
}

function renderDailyProgress(document, container, daily, newestRun) {
  const heading = document.createElement('div');
  heading.className = 'daily-heading';
  const title = document.createElement('h2');
  title.textContent = `${daily.delivered} of ${daily.target} delivered today`;
  const context = document.createElement('p');
  context.textContent = `${daily.day} · ${timeZoneLabel(daily.day, daily.timezone)} · ${daily.remaining} remaining`;
  heading.append(title, context);

  const progress = document.createElement('div');
  progress.className = 'target-progress';
  progress.setAttribute('role', 'progressbar');
  progress.setAttribute('aria-label', 'Daily delivery progress');
  progress.setAttribute('aria-valuemin', '0');
  progress.setAttribute('aria-valuemax', String(daily.target));
  progress.setAttribute('aria-valuenow', String(Math.min(daily.delivered, daily.target)));
  const fill = document.createElement('span');
  fill.style.width = `${Math.min((daily.delivered / daily.target) * 100, 100)}%`;
  progress.append(fill);

  const metrics = document.createElement('div');
  metrics.className = 'daily-metrics';
  for (const [label, value] of [
    ['Target', daily.target],
    ['Started today', daily.started],
    ['Ready for review', daily.readyForReview],
    ['Approved, delivering', daily.approvedInFlight],
    ['Delivered today', daily.delivered],
  ]) {
    const item = document.createElement('div');
    const count = document.createElement('strong');
    count.textContent = String(value);
    const name = document.createElement('span');
    name.textContent = label;
    item.append(count, name);
    metrics.append(item);
  }
  const children = [heading, progress, metrics];
  if (newestRun) {
    const latest = document.createElement('div');
    latest.className = 'latest-run';
    const label = document.createElement('strong');
    label.textContent = 'Latest run';
    const link = document.createElement('a');
    link.href = `/runs/${encodeURIComponent(newestRun.id)}`;
    link.textContent = newestRun.title;
    const detail = document.createElement('p');
    detail.textContent = `${newestRun.currentStage.replaceAll('_', ' ')} · ${newestRun.currentState.replaceAll('_', ' ')} · started ${formatUpdatedAt(newestRun.createdAt)}`;
    latest.append(label, link, detail);
    children.push(latest);
  }
  container.replaceChildren(...children);
}

function renderOperations(document, container, model) {
  const cards = [
    ['blockers', 'Blockers', model.counts.blocked, 'Waiting, failed, or needing a person.'],
    ['retries', 'Retries scheduled', model.counts.retrying, 'Runs or deliveries with a next attempt time.'],
  ];
  container.replaceChildren(...cards.map(([key, label, value, description]) => {
    const card = document.createElement('article');
    card.dataset.operation = key;
    const heading = document.createElement('h2');
    heading.textContent = `${value} ${label.toLowerCase()}`;
    const copy = document.createElement('p');
    copy.textContent = description;
    card.append(heading, copy);
    return card;
  }));
}

function badge(document, text, tone) {
  const element = document.createElement('span');
  element.className = 'run-badge';
  if (tone) element.dataset.tone = tone;
  element.textContent = text;
  return element;
}

function isBlocked(run) {
  return run.currentState === 'waiting'
    || run.currentState === 'needs_human'
    || ['waiting', 'failed', 'needs_human', 'superseded'].includes(run.delivery?.state);
}

function labelForClassification(classification) {
  return {
    active: 'Active',
    deliver: 'Delivering',
    completed: 'Completed',
    rejected: 'Rejected',
    duplicate: 'Duplicate',
  }[classification] || classification;
}

function latestRun(runs) {
  return runs.reduce((latest, run) => {
    if (!latest) return run;
    const createdDelta = Date.parse(run.createdAt) - Date.parse(latest.createdAt);
    return createdDelta > 0 || (createdDelta === 0 && run.id < latest.id) ? run : latest;
  }, null);
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('en-GB', {
    timeZone: OPERATOR_TIME_ZONE,
    timeZoneName: 'short',
  });
}

function timeZoneLabel(day, timeZone) {
  const date = new Date(`${day}T12:00:00.000Z`);
  if (Number.isNaN(date.getTime())) return timeZone;
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    timeZoneName: 'short',
  }).formatToParts(date).find((part) => part.type === 'timeZoneName')?.value ?? timeZone;
}
