import {
  activeChecksFor,
  checkNameForFindingCode,
  type CheckName,
  type DeclaredEnvironment,
  type EnvironmentTruth,
  type SafeValue,
  type TruthFinding,
  type TruthReport,
} from '@deploytruth/core';

export interface ReportFindingCounts {
  /** Checks explicitly enabled in the manifest. */
  readonly enabled: number;
  readonly verified: number;
  readonly warnings: number;
  readonly failures: number;
  /** Total findings across all evaluated environments. */
  readonly findings: number;
}

/**
 * The single counting interpretation shared by local history, the local viewer, and CI output:
 * enabled checks minus warning/failure findings stays "verified", never fabricated.
 */
export const reportFindingCounts = (report: TruthReport): ReportFindingCounts => {
  const enabled = report.environments.reduce(
    (sum, environment) =>
      sum + Object.values(environment.declaration.checks).filter(Boolean).length,
    0,
  );
  const warnings = report.findings.filter((finding) => finding.status === 'WARN').length;
  const failures = report.findings.filter((finding) => finding.status === 'FAIL').length;
  return {
    enabled,
    verified: Math.max(0, enabled - warnings - failures),
    warnings,
    failures,
    findings: report.findings.length,
  };
};

export type CheckSummaryStatus = 'VERIFIED' | 'WARN' | 'FAIL' | 'UNVERIFIED';

export interface CheckSummaryRow {
  readonly check: CheckName;
  readonly label: string;
  readonly status: CheckSummaryStatus;
}

const KNOWN_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  git: 'Git',
  github: 'GitHub',
  vercel: 'Vercel',
  supabase: 'Supabase',
};

const providerLabel = (provider: string | undefined, fallback: string): string => {
  if (provider === undefined) {
    return fallback;
  }
  const known = KNOWN_PROVIDER_LABELS[provider.toLowerCase()];
  return known ?? provider;
};

/** Human-facing label for an evaluated check, derived only from the declaration. */
export const checkSummaryLabel = (check: CheckName, environment: DeclaredEnvironment): string => {
  const source = providerLabel(environment.source?.provider, 'Source');
  const deployment = providerLabel(environment.deployment?.provider, 'Deployment');
  const database = providerLabel(environment.database?.provider, 'Database');
  switch (check) {
    case 'local_git':
      return 'Local Git';
    case 'remote_source':
      return `${source} source`;
    case 'deployment_sha':
      return `${source} → ${deployment}`;
    case 'migrations':
      return 'Migrations';
    case 'runtime_identity':
      return `${deployment} → Runtime`;
    case 'environment_isolation':
      if (environment.runtime !== undefined && environment.database !== undefined) {
        return `Runtime → ${database}`;
      }
      if (environment.runtime !== undefined) {
        return 'Runtime environment';
      }
      return `${deployment} → ${database}`;
    case 'environment_variables':
      return 'Environment variables';
  }
};

const unavailableChecks = (findings: readonly TruthFinding[]): ReadonlySet<string> =>
  new Set(
    findings
      .filter((finding) => finding.code === 'REQUIRED_OBSERVATION_UNAVAILABLE')
      .flatMap((finding) =>
        Array.isArray(finding.evidence['unavailableChecks'])
          ? finding.evidence['unavailableChecks'].map(String)
          : [],
      ),
  );

const checkStatus = (
  truth: EnvironmentTruth,
  check: CheckName,
  unavailable: ReadonlySet<string>,
): CheckSummaryStatus => {
  const related = truth.findings.filter(
    (finding) => checkNameForFindingCode(finding.code) === check,
  );
  if (related.some((finding) => finding.status === 'FAIL')) {
    return 'FAIL';
  }
  if (related.some((finding) => finding.status === 'WARN')) {
    return 'WARN';
  }
  return unavailable.has(check) ? 'UNVERIFIED' : 'VERIFIED';
};

/**
 * One row per evaluated check. UNVERIFIED means the enabled check lacked required evidence —
 * the same coverage semantic that produces REQUIRED_OBSERVATION_UNAVAILABLE.
 */
export const checkSummaryRows = (truth: EnvironmentTruth): readonly CheckSummaryRow[] => {
  const unavailable = unavailableChecks(truth.findings);
  return activeChecksFor(truth.declaration).map((check) => ({
    check,
    label: checkSummaryLabel(check, truth.declaration),
    status: checkStatus(truth, check, unavailable),
  }));
};

/** Strips control characters so untrusted text cannot break markup or inject commands. */
const safeText = (value: string): string =>
  // eslint-disable-next-line no-control-regex -- deliberately strips control characters
  value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, ' ');

/** Escapes text placed inside Markdown emphasis/table/heading contexts. */
export const escapeMarkdown = (value: string): string =>
  safeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_[\]|])/g, '\\$1')
    .replace(/\r?\n/g, ' ');

const escapeTableCell = escapeMarkdown;

const INLINE_VALUE_LIMIT = 160;
const TEXT_LIMIT = 600;
const REMEDIATION_LIMIT = 400;
const FINDINGS_LIMIT = 20;
const SUMMARY_LIMIT_BYTES = 480 * 1024;

const truncate = (value: string, limit: number): string =>
  value.length <= limit ? value : `${value.slice(0, limit - 1)}…`;

/** Renders a normalized SafeValue without ever emitting raw provider payloads. */
const safeValueMarkdown = (value: SafeValue | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    const text = truncate(safeText(String(value)), INLINE_VALUE_LIMIT);
    return `\`${text.replace(/`/g, "'")}\``;
  }
  const json = truncate(JSON.stringify(value, null, 2), TEXT_LIMIT);
  return `\n\n~~~json\n${json.replace(/`/g, "'")}\n~~~`;
};

const scopeLabel = (finding: TruthFinding, truth: EnvironmentTruth): string => {
  const check = checkNameForFindingCode(finding.code);
  if (check !== undefined) {
    return checkSummaryLabel(check, truth.declaration);
  }
  const components = finding.affectedComponents
    .map((component) => component.type)
    .filter((type, index, all) => all.indexOf(type) === index)
    .sort();
  return components.length > 0 ? components.join(' · ') : 'environment';
};

const findingMarkdown = (finding: TruthFinding, truth: EnvironmentTruth): string => {
  const lines: string[] = [
    `### \`${safeText(finding.code).replace(/`/g, "'")}\` — ${escapeMarkdown(truncate(finding.title, TEXT_LIMIT))}`,
    '',
    `${escapeMarkdown(finding.severity)} · ${finding.status} · ${escapeMarkdown(scopeLabel(finding, truth))}`,
    '',
    escapeMarkdown(truncate(finding.description, TEXT_LIMIT)),
  ];
  const expected = safeValueMarkdown(finding.expected);
  const observed = safeValueMarkdown(finding.observed);
  if (expected !== undefined || observed !== undefined) {
    lines.push('');
    if (expected !== undefined) {
      lines.push(`Expected: ${expected}`);
    }
    if (observed !== undefined) {
      lines.push(`Observed: ${observed}`);
    }
  }
  if (finding.remediation.length > 0) {
    lines.push(
      '',
      `Remediation: ${escapeMarkdown(truncate(finding.remediation, REMEDIATION_LIMIT))}`,
    );
  }
  return lines.join('\n');
};

const environmentSection = (
  truth: EnvironmentTruth,
  counts: ReportFindingCounts,
  showEnvironmentHeading: boolean,
): string => {
  const lines: string[] = [];
  if (showEnvironmentHeading) {
    lines.push(`## ${escapeMarkdown(truth.environment)}`, '', `**${truth.verdict}**`, '');
  }
  const rows = checkSummaryRows(truth);
  if (rows.length > 0) {
    lines.push('| Check | Status |', '| --- | --- |');
    for (const row of rows) {
      lines.push(`| ${escapeTableCell(row.label)} | ${row.status} |`);
    }
    lines.push('');
  }
  if (truth.findings.length === 0) {
    lines.push('No findings.', '');
    return lines.join('\n');
  }
  lines.push('### Findings', '');
  const shown = truth.findings.slice(0, FINDINGS_LIMIT);
  for (const finding of shown) {
    lines.push(findingMarkdown(finding, truth), '');
  }
  const remaining = truth.findings.length - shown.length;
  if (remaining > 0) {
    lines.push(
      `_…and ${remaining} more finding${remaining === 1 ? '' : 's'} in the report artifact._`,
      '',
    );
  }
  return lines.join('\n');
};

export interface TruthSummaryOptions {
  /** Additional safe context lines appended after the run identity (for example a CI run URL). */
  readonly context?: readonly string[];
}

/**
 * The single human-readable DeployTruth summary. It feeds both the GitHub Job Summary and the
 * `summary.md` CI artifact so the two can never drift apart. Bounded, escaped, and built only
 * from the normalized TruthReport — never from provider payloads.
 */
export const buildTruthSummaryMarkdown = (
  report: TruthReport,
  options: TruthSummaryOptions = {},
): string => {
  const counts = reportFindingCounts(report);
  const environments = report.environments.map((truth) => truth.environment);
  const lines: string[] = [
    `# DeployTruth — ${escapeMarkdown(environments.join(', ') || report.project)}`,
    '',
    `**${report.verdict}**`,
    '',
    `${counts.verified} verified · ${counts.warnings} warning${counts.warnings === 1 ? '' : 's'} · ${counts.failures} failure${counts.failures === 1 ? '' : 's'}`,
    '',
  ];

  const multiple = report.environments.length > 1;
  for (const truth of report.environments) {
    lines.push(environmentSection(truth, counts, multiple));
  }

  lines.push(`Run ID: \`${report.runId}\``, '');
  for (const context of options.context ?? []) {
    lines.push(escapeMarkdown(context), '');
  }

  let markdown = `${lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()}\n`;
  if (Buffer.byteLength(markdown, 'utf8') > SUMMARY_LIMIT_BYTES) {
    markdown = `${markdown.slice(0, SUMMARY_LIMIT_BYTES)}\n\n_Summary truncated; the report artifact contains the complete normalized truth._\n`;
  }
  return markdown;
};
