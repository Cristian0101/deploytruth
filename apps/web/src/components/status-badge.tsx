import { CheckCircle, Question, Warning, XCircle } from '@phosphor-icons/react';

export type DisplayStatus =
  'PASS' | 'WARN' | 'FAIL' | 'VERIFIED' | 'READY' | 'CONNECTED' | 'UNKNOWN';

const toneFor = (status: DisplayStatus): string => {
  if (status === 'FAIL') return 'failed';
  if (status === 'WARN') return 'warning';
  if (status === 'UNKNOWN') return 'unknown';
  return 'verified';
};

export const StatusIcon = ({ status }: { readonly status: DisplayStatus }) => {
  const tone = toneFor(status);
  if (tone === 'failed') return <XCircle weight="fill" aria-hidden="true" />;
  if (tone === 'warning') return <Warning weight="fill" aria-hidden="true" />;
  if (tone === 'unknown') return <Question weight="fill" aria-hidden="true" />;
  return <CheckCircle weight="fill" aria-hidden="true" />;
};

export const StatusBadge = ({ status }: { readonly status: DisplayStatus }) => (
  <span className={`status-badge status-badge--${toneFor(status)}`}>
    <StatusIcon status={status} />
    {status}
  </span>
);
