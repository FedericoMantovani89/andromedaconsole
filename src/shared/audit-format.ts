/**
 * A measure of the audit as it is shown to a person (the readable report, the report dialog, the queue, the line to the main): the share
 * of comments is a fraction inside (0.1666...) and a percentage outside (16.7%); every other measure is a plain number.
 */
export function formatMetric(id: string, value: number): string {
  if (id !== 'comment_ratio') return String(value);
  return `${Math.round(value * 1000) / 10}%`;
}
