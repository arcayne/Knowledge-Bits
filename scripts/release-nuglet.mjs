#!/usr/bin/env node

import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1_000;
const CHECKSUM_PATTERN = /^[a-f0-9]{64}$/;

export async function fetchRun({ apiUrl, token, runId, fetchImpl = fetch }) {
  return requestJson({
    apiUrl,
    token,
    path: `/runs/${encodeURIComponent(runId)}`,
    fetchImpl,
  });
}

export async function fetchReview({ apiUrl, token, runId, fetchImpl = fetch }) {
  return requestJson({
    apiUrl,
    token,
    path: `/runs/${encodeURIComponent(runId)}/review`,
    fetchImpl,
  });
}

export async function fetchPipeline({ apiUrl, token, fetchImpl = fetch }) {
  return requestJson({ apiUrl, token, path: '/pipeline', fetchImpl });
}

export function validateApprovedPackage({ run, review, expectedChecksum }) {
  const packageVersion = review?.package;
  const packageChecksum = packageVersion?.packageChecksum;
  const checksum = expectedChecksum ?? packageChecksum ?? run?.packageChecksum;
  const failures = [];

  if (!run || !review || !packageVersion) failures.push('approved package is unavailable');
  if (run?.reviewStatus !== 'approved') failures.push(`run review status is ${run?.reviewStatus ?? 'missing'}`);
  if (review?.reviewStatus !== 'approved') failures.push(`review status is ${review?.reviewStatus ?? 'missing'}`);
  if (!CHECKSUM_PATTERN.test(checksum ?? '')) failures.push('approved package checksum is missing or malformed');
  if (run?.packageChecksum !== checksum) failures.push('run package checksum does not match approved checksum');
  if (run?.approvedChecksum !== checksum) failures.push('run approved checksum does not match package checksum');
  if (review?.currentPackageChecksum !== checksum) failures.push('review current package checksum does not match');
  if (packageChecksum !== checksum) failures.push('review package checksum does not match');
  if (packageVersion?.approval && packageVersion.approval.status !== 'approved') {
    failures.push('package approval status is not approved');
  }
  if (packageVersion?.approval && packageVersion.approval.approvedChecksum !== checksum) {
    failures.push('package approval checksum does not match');
  }

  if (failures.length) {
    const error = new Error(`Approved package validation failed: ${failures.join('; ')}`);
    error.failures = failures;
    throw error;
  }

  return { checksum, packageVersion };
}

export async function approveRun({
  apiUrl,
  apiToken,
  token,
  reviewerId,
  runId,
  packageChecksum,
  fetchImpl = fetch,
}) {
  if (!reviewerId?.trim()) throw new Error('KNOWLEDGE_BITS_REVIEWER_ID is required');
  if (!CHECKSUM_PATTERN.test(packageChecksum ?? '')) {
    throw new Error('--checksum must be a 64-character lowercase SHA-256 checksum');
  }

  const [run, review] = await Promise.all([
    fetchRun({ apiUrl, token: apiToken ?? token, runId, fetchImpl }),
    fetchReview({ apiUrl, token, runId, fetchImpl }),
  ]);
  if (run.reviewStatus === 'approved' && run.approvedChecksum === packageChecksum) {
    validateApprovedPackage({ run, review, expectedChecksum: packageChecksum });
    return { run, review, alreadyApproved: true };
  }
  if (run.currentStage !== 'human_review' || run.reviewStatus !== 'pending') {
    throw new Error(`Run is not open for approval: ${run.currentStage}/${run.reviewStatus}`);
  }
  validatePendingPackage({ run, review, expectedChecksum: packageChecksum });

  await requestJson({
    apiUrl,
    token,
    path: `/runs/${encodeURIComponent(runId)}/review`,
    method: 'POST',
    headers: { 'X-Knowledge-Bits-Reviewer': reviewerId.trim() },
    body: { decision: 'approve', packageChecksum },
    fetchImpl,
  });

  const [approvedRun, approvedReview] = await Promise.all([
    fetchRun({ apiUrl, token: apiToken ?? token, runId, fetchImpl }),
    fetchReview({ apiUrl, token, runId, fetchImpl }),
  ]);
  validateApprovedPackage({ run: approvedRun, review: approvedReview, expectedChecksum: packageChecksum });
  return { run: approvedRun, review: approvedReview, alreadyApproved: false };
}

export function validatePendingPackage({ run, review, expectedChecksum }) {
  const packageChecksum = review?.package?.packageChecksum;
  const failures = [];
  if (!review?.decisionAllowed) failures.push('review package is not currently decision-allowed');
  if (!review?.package) failures.push('review package is unavailable');
  if (run?.packageChecksum !== expectedChecksum) failures.push('run package checksum does not match requested checksum');
  if (review?.currentPackageChecksum !== expectedChecksum) failures.push('review checksum does not match requested checksum');
  if (packageChecksum !== expectedChecksum) failures.push('package checksum does not match requested checksum');
  if (failures.length) throw new Error(`Pending package validation failed: ${failures.join('; ')}`);
  return review.package;
}

export async function waitForDelivery({
  apiUrl,
  token,
  runId,
  timeoutMs = DEFAULT_POLL_TIMEOUT_MS,
  intervalMs = DEFAULT_POLL_INTERVAL_MS,
  fetchImpl = fetch,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
}) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const pipeline = await fetchPipeline({ apiUrl, token, fetchImpl });
    const run = pipeline.runs?.find((candidate) => candidate.id === runId);
    if (!run) throw new Error(`Run ${runId} is not present in the pipeline dashboard`);

    const deliveryState = run.delivery?.state ?? null;
    if (deliveryState === 'succeeded' || run.classification === 'completed') {
      return { run, deliveryState: 'succeeded' };
    }
    if (deliveryState === 'needs_human') {
      throw new Error(`Delivery needs human attention: ${run.reason ?? 'no reason provided'}`);
    }
    if (Date.now() >= deadline) {
      throw new Error(`Delivery did not complete before timeout; current state is ${deliveryState ?? run.classification}`);
    }
    await sleep(intervalMs);
  }
}

export async function verifySeo({ url, fetchImpl = fetch }) {
  const target = new URL(url);
  const expectedUrl = normalizeUrl(target);
  const origin = target.origin;
  const result = {
    url: expectedUrl,
    checks: [],
    warnings: [],
    passed: false,
  };

  const page = await fetchText(expectedUrl, fetchImpl);
  check(result, 'public route returns HTTP 2xx', page.response.ok, `HTTP ${page.response.status}`);
  const title = firstMatch(page.text, /<title\b[^>]*>([\s\S]*?)<\/title>/i);
  check(result, 'title is present', Boolean(title?.[1]?.trim()), 'missing <title>');
  const description = metaContent(page.text, 'name', 'description');
  check(result, 'meta description is present', Boolean(description), 'missing description metadata');
  const robots = metaContent(page.text, 'name', 'robots') ?? '';
  check(result, 'page is indexable', !/noindex|nofollow/i.test(robots), robots || 'missing robots metadata');
  const canonical = linkHref(page.text, 'canonical');
  check(result, 'canonical URL matches public route', normalizeUrl(canonical) === expectedUrl, canonical || 'missing canonical link');
  check(result, 'Open Graph metadata is present', Boolean(metaContent(page.text, 'property', 'og:title')), 'missing og:title');
  check(result, 'JSON-LD is present', /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>/i.test(page.text), 'missing JSON-LD');

  const [robotsFile, dedicatedSitemap, generalSitemap, llms] = await Promise.all([
    fetchText(`${origin}/robots.txt`, fetchImpl),
    fetchText(`${origin}/knowledge-bits-sitemap.xml`, fetchImpl),
    fetchText(`${origin}/sitemap.xml`, fetchImpl),
    fetchText(`${origin}/llms.txt`, fetchImpl),
  ]);
  const dedicatedSitemapUrl = `${origin}/knowledge-bits-sitemap.xml`;
  const generalSitemapUrl = `${origin}/sitemap.xml`;
  check(result, 'robots.txt returns HTTP 2xx', robotsFile.response.ok, `HTTP ${robotsFile.response.status}`);
  check(result, 'robots.txt advertises Knowledge Bits sitemap', robotsFile.text.includes(dedicatedSitemapUrl), 'dedicated sitemap missing from robots.txt');
  check(result, 'robots.txt advertises general sitemap', robotsFile.text.includes(generalSitemapUrl), 'general sitemap missing from robots.txt');
  check(result, 'Knowledge Bits sitemap returns HTTP 2xx', dedicatedSitemap.response.ok, `HTTP ${dedicatedSitemap.response.status}`);
  const escapedExpectedUrl = expectedUrl.replaceAll('&', '&amp;');
  check(result, 'Knowledge Bits sitemap contains the public URL', dedicatedSitemap.text.includes(expectedUrl) || dedicatedSitemap.text.includes(escapedExpectedUrl), 'public URL missing from dedicated sitemap');
  check(result, 'Knowledge Bits sitemap contains lastmod', /<lastmod>\d{4}-\d{2}-\d{2}<\/lastmod>/i.test(dedicatedSitemap.text), 'lastmod missing from dedicated sitemap');
  check(result, 'general sitemap is available', generalSitemap.response.ok, `HTTP ${generalSitemap.response.status}`);
  if (!llms.response.ok || !llms.text.includes(expectedUrl)) {
    result.warnings.push(`llms.txt does not list ${expectedUrl}`);
  }
  result.passed = result.checks.every((entry) => entry.passed);
  return result;
}

async function fetchText(url, fetchImpl) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS) });
  return { response, text: await response.text() };
}

async function requestJson({ apiUrl, token, path, method = 'GET', headers = {}, body, fetchImpl }) {
  const baseUrl = requiredUrl(apiUrl, 'ENGINE_API_BASE_URL');
  const response = await fetchImpl(new URL(path.replace(/^\/+/, ''), baseUrl), {
    method,
    headers: {
      Authorization: `Bearer ${requiredValue(token, 'API token')}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch { /* handled below */ }
  if (!response.ok) {
    throw new Error(`${method} ${path} failed with HTTP ${response.status}${text ? `: ${text}` : ''}`);
  }
  if (!payload || typeof payload !== 'object') throw new Error(`${method} ${path} returned invalid JSON`);
  return payload;
}

function check(result, name, passed, detail) {
  result.checks.push({ name, passed, ...(passed ? {} : { detail }) });
}

function metaContent(html, attribute, value) {
  const tag = html.match(new RegExp(`<meta\\b[^>]*${attribute}=["']${escapeRegExp(value)}["'][^>]*>`, 'i'))
    ?? html.match(new RegExp(`<meta\\b[^>]*content=["'][^"']*["'][^>]*${attribute}=["']${escapeRegExp(value)}["'][^>]*>`, 'i'));
  if (!tag) return null;
  return firstMatch(tag[0], /content=["']([^"']*)["']/i)?.[1]?.trim() || null;
}

function linkHref(html, relation) {
  const tag = html.match(new RegExp(`<link\\b[^>]*rel=["']${escapeRegExp(relation)}["'][^>]*>`, 'i'))
    ?? html.match(new RegExp(`<link\\b[^>]*href=["'][^"']*["'][^>]*rel=["']${escapeRegExp(relation)}["'][^>]*>`, 'i'));
  return firstMatch(tag?.[0] ?? '', /href=["']([^"']*)["']/i)?.[1] ?? null;
}

function firstMatch(value, pattern) { return value.match(pattern); }
function normalizeUrl(value) {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    if (parsed.pathname !== '/') parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.toString();
  } catch { return ''; }
}
function requiredValue(value, name) { if (!value?.trim()) throw new Error(`${name} is required`); return value.trim(); }
function requiredUrl(value, name) { return new URL(requiredValue(value, name).replace(/\/$/, '') + '/'); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function printJson(value) { console.log(JSON.stringify(value, null, 2)); }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  if (!command || !['inspect', 'approve', 'watch', 'verify-seo'].includes(command)) {
    throw new Error('Usage: release-nuglet <inspect|approve|watch|verify-seo> --run <id> [options]');
  }

  if (command === 'verify-seo') {
    const result = await verifySeo({ url: requiredArg(args, 'url') });
    printJson(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }

  const apiUrl = requiredValue(process.env.ENGINE_API_BASE_URL, 'ENGINE_API_BASE_URL');
  const apiToken = requiredValue(process.env.ENGINE_API_TOKEN, 'ENGINE_API_TOKEN');
  const reviewToken = requiredValue(process.env.ENGINE_REVIEW_TOKEN, 'ENGINE_REVIEW_TOKEN');
  const runId = requiredArg(args, 'run');
  const [run, review] = await Promise.all([
    fetchRun({ apiUrl, token: apiToken, runId }),
    fetchReview({ apiUrl, token: reviewToken, runId }),
  ]);

  if (command === 'inspect') {
    printJson(summarize({ run, review }));
    return;
  }
  if (command === 'approve') {
    const packageChecksum = requiredArg(args, 'checksum');
    const reviewerId = requiredValue(process.env.KNOWLEDGE_BITS_REVIEWER_ID, 'KNOWLEDGE_BITS_REVIEWER_ID');
    const result = await approveRun({ apiUrl, apiToken, token: reviewToken, reviewerId, runId, packageChecksum });
    printJson(summarize(result));
    return;
  }

  const result = await waitForDelivery({
    apiUrl,
    token: reviewToken,
    runId,
    ...(args.timeout ? { timeoutMs: Number(args.timeout) * 1_000 } : {}),
    ...(args.interval ? { intervalMs: Number(args.interval) * 1_000 } : {}),
  });
  printJson(result);
}

function summarize({ run, review }) {
  return {
    runId: run.id,
    title: run.title,
    currentStage: run.currentStage,
    currentRevision: run.currentRevision,
    reviewStatus: run.reviewStatus,
    packageChecksum: run.packageChecksum,
    approvedChecksum: run.approvedChecksum,
    currentPackageChecksum: review.currentPackageChecksum,
    decisionAllowed: review.decisionAllowed,
    packageId: review.package?.packageId ?? null,
    packageVersionId: review.package?.id ?? null,
  };
}

function requiredArg(args, name) {
  const value = args[name];
  if (typeof value !== 'string' || !value.trim()) throw new Error(`--${name} is required`);
  return value.trim();
}

function parseArgs(values) {
  const result = { _: [] };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index];
    if (!value.startsWith('--')) { result._.push(value); continue; }
    const name = value.slice(2);
    const next = values[index + 1];
    if (!next || next.startsWith('--')) throw new Error(`--${name} requires a value`);
    result[name] = next;
    index += 1;
  }
  return result;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
