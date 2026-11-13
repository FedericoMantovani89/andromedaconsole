import { describe, expect, it } from 'vitest';
import { formatMetric } from '../src/shared/audit-format';

describe('formatMetric', () => {
  it('shows the share of comments as a percentage with at most one decimal', () => {
    expect(formatMetric('comment_ratio', 1 / 6)).toBe('16.7%');
    expect(formatMetric('comment_ratio', 0.15)).toBe('15%');
    expect(formatMetric('comment_ratio', 0)).toBe('0%');
    expect(formatMetric('comment_ratio', 1)).toBe('100%');
    expect(formatMetric('comment_ratio', 0.3333333)).toBe('33.3%');
  });

  it('shows every other measure as the plain number', () => {
    expect(formatMetric('diff_lines', 412)).toBe('412');
    expect(formatMetric('file_lines', 0)).toBe('0');
    expect(formatMetric('comment_run_lines', 6)).toBe('6');
  });
});
