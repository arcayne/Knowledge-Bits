import { ProviderNeedsHumanError, ProviderWaitingError } from './types.js';

interface NotebookRecord {
  id?: string;
  notebook_id?: string;
  title: string;
  url?: string;
}

export interface NotebookProvisioningProcess {
  run(input: {
    command: string;
    args: readonly string[];
    timeoutMs: number;
    signal: AbortSignal;
  }): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }>;
}

export interface NotebookProvisioningInput {
  title: string;
  idempotencyKey: string;
  signal: AbortSignal;
}

export interface NotebookProvisioningResult {
  notebookId: string;
  title: string;
  url?: string;
  reused: boolean;
}

export interface NotebookProvisioner {
  provision(input: NotebookProvisioningInput): Promise<NotebookProvisioningResult>;
}

/**
 * Creates or reuses a dedicated NotebookLM notebook through the local nlm CLI.
 * The deterministic title makes a retry safe after a create succeeds before the
 * engine binding request completes.
 */
export class NotebookLmNotebookProvisioner implements NotebookProvisioner {
  constructor(private readonly options: {
    process: NotebookProvisioningProcess;
    command?: string;
    timeoutMs?: number;
  }) {}

  async provision(input: NotebookProvisioningInput): Promise<NotebookProvisioningResult> {
    const title = normalizeTitle(input.title);
    const existing = await this.list(title, input.signal);
    if (existing) return { ...existing, reused: true };

    const response = await this.options.process.run({
      command: this.options.command ?? 'nlm',
      args: ['notebook', 'create', title, '--json'],
      timeoutMs: this.options.timeoutMs ?? 180_000,
      signal: input.signal,
    });
    this.assertProcessSuccess(response);
    const record = parseNotebookRecord(response.stdout, 'create');
    return {
      notebookId: notebookId(record),
      title: record.title,
      ...(record.url ? { url: record.url } : {}),
      reused: false,
    };
  }

  private async list(title: string, signal: AbortSignal): Promise<Omit<NotebookProvisioningResult, 'reused'> | undefined> {
    const response = await this.options.process.run({
      command: this.options.command ?? 'nlm',
      args: ['notebook', 'list', '--json'],
      timeoutMs: this.options.timeoutMs ?? 180_000,
      signal,
    });
    this.assertProcessSuccess(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.stdout);
    } catch {
      throw new ProviderNeedsHumanError('notebooklm_provisioning_list_invalid');
    }
    if (!Array.isArray(parsed)) throw new ProviderNeedsHumanError('notebooklm_provisioning_list_invalid');
    const notebooks = parsed.map((candidate) => decodeNotebookRecord(candidate, true))
      .filter((candidate): candidate is NotebookRecord => candidate !== undefined);
    if (notebooks.length !== parsed.length) throw new ProviderNeedsHumanError('notebooklm_provisioning_list_invalid');
    const match = notebooks.find((candidate) => candidate.title === title);
    if (!match) return undefined;
    return {
      notebookId: notebookId(match),
      title: match.title,
      ...(match.url ? { url: match.url } : {}),
    };
  }

  private assertProcessSuccess(response: { stdout: string; stderr: string; exitCode: number | null; timedOut?: boolean }): void {
    if (response.timedOut) {
      throw new ProviderWaitingError('notebooklm_provisioning_timeout', new Date(Date.now() + 60_000).toISOString());
    }
    if (response.exitCode === 0) return;
    const combined = `${response.stdout}\n${response.stderr}`;
    if (/rate limit|cooldown|too many requests/i.test(combined)) {
      throw new ProviderWaitingError('notebooklm_provisioning_cooldown', new Date(Date.now() + 60_000).toISOString());
    }
    if (/auth|credential|login|forbidden|unauthori[sz]ed|command not found|missing/i.test(combined)) {
      throw new ProviderNeedsHumanError('notebooklm_provisioning_configuration');
    }
    throw new ProviderNeedsHumanError('notebooklm_provisioning_failed');
  }
}

function parseNotebookRecord(raw: string, operation: string): NotebookRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ProviderNeedsHumanError(`notebooklm_provisioning_${operation}_invalid`);
  }
  const result = decodeNotebookRecord(parsed);
  if (!result) throw new ProviderNeedsHumanError(`notebooklm_provisioning_${operation}_invalid`);
  return result;
}

function notebookId(record: NotebookRecord): string {
  const value = record.id ?? record.notebook_id;
  if (!value) throw new ProviderNeedsHumanError('notebooklm_provisioning_id_missing');
  return value;
}

function decodeNotebookRecord(value: unknown, allowEmptyTitle = false): NotebookRecord | undefined {
  if (!isRecord(value)) return undefined;
  const title = typeof value.title === 'string' ? value.title.trim() : '';
  const id = optionalBoundedString(value.id, 256);
  const notebookIdValue = optionalBoundedString(value.notebook_id, 256);
  const url = optionalUrl(value.url);
  if ((!title && !allowEmptyTitle) || title.length > 512
    || (value.id !== undefined && !id)
    || (value.notebook_id !== undefined && !notebookIdValue)
    || (!id && !notebookIdValue)
    || (value.url !== undefined && !url)) return undefined;
  return {
    ...(id ? { id } : {}),
    ...(notebookIdValue ? { notebook_id: notebookIdValue } : {}),
    title,
    ...(url ? { url } : {}),
  };
}

function optionalBoundedString(value: unknown, maxLength: number): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength ? normalized : undefined;
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? value : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeTitle(value: string): string {
  const title = value.trim().replace(/\s+/g, ' ');
  if (!title) throw new ProviderNeedsHumanError('notebooklm_provisioning_title_missing');
  if (title.length > 512) throw new ProviderNeedsHumanError('notebooklm_provisioning_title_too_long');
  return title;
}
