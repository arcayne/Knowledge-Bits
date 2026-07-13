export type EditorialSeverity = 'critical' | 'major' | 'minor';

export interface EditorialFinding {
  code: string;
  severity: EditorialSeverity;
  blocking: boolean;
  message: string;
}

export interface EditorialCheckReport {
  findings: readonly EditorialFinding[];
  summary: string;
}

export function parseEditorialCheck(value: unknown): EditorialCheckReport {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Editorial response must be an object');
  }
  const response = value as Record<string, unknown>;
  if (typeof response.summary !== 'string' || !Array.isArray(response.findings)) {
    throw new TypeError('Editorial response requires summary and findings');
  }
  const findings = response.findings.map((finding) => parseFinding(finding));
  return { summary: response.summary, findings };
}

export function requiresEditorialFailure(report: EditorialCheckReport): boolean {
  return report.findings.some(({ blocking }) => blocking);
}

function parseFinding(value: unknown): EditorialFinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Editorial finding must be an object');
  }
  const finding = value as Record<string, unknown>;
  if (typeof finding.code !== 'string' || !finding.code.trim() || typeof finding.message !== 'string' || !finding.message.trim()) {
    throw new TypeError('Editorial finding requires code and message');
  }
  if (finding.severity !== 'critical' && finding.severity !== 'major' && finding.severity !== 'minor') {
    throw new TypeError('Editorial finding severity must be critical, major, or minor');
  }
  return {
    code: finding.code,
    severity: finding.severity,
    blocking: finding.severity === 'critical' || finding.code === 'unsupported-claim',
    message: finding.message,
  };
}
