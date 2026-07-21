const STAGES = [
  ['research', 'Research'],
  ['create', 'Create'],
  ['check', 'Check'],
  ['produce_assets', 'Produce assets'],
  ['human_review', 'Human review'],
  ['deliver', 'Deliver'],
];

const CLASSIFICATIONS = [
  ['active', 'Active pipeline', 'Work still moving through research, creation, checks, assets, or human review.'],
  ['deliver', 'Delivering', 'Approved runs waiting for or executing delivery.'],
  ['completed', 'Completed', 'Runs whose delivery stage is done.'],
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
  const filters = [...document.querySelectorAll('[data-filter]')];
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
      ? `${model.runs.length} runs · ${model.counts.active} active · ${model.counts.delivering} delivering · ${model.counts.completed} completed · ${model.counts.duplicates} duplicates`
      : `${visibleRuns.length} run${visibleRuns.length === 1 ? '' : 's'} shown`;
    renderDailyProgress(document, dailyProgress, model.daily);
    renderOperations(document, operations, model);
    statusCounts.replaceChildren(...[
      ['active', 'Active', model.counts.active],
      ['deliver', 'Delivering', model.counts.delivering],
      ['completed', 'Completed', model.counts.completed],
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

  return (async () => {
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
  })();
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

function renderDailyProgress(document, container, daily) {
  const heading = document.createElement('div');
  heading.className = 'daily-heading';
  const title = document.createElement('h2');
  title.textContent = `${daily.delivered} of ${daily.target} delivered today`;
  const context = document.createElement('p');
  context.textContent = `${daily.day} · ${daily.timezone} · ${daily.remaining} remaining`;
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
  container.replaceChildren(heading, progress, metrics);
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
    duplicate: 'Duplicate',
  }[classification] || classification;
}

function formatUpdatedAt(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
