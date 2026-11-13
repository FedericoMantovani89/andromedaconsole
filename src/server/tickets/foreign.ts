/** Files a change may carry that nobody wrote for the goal: lock files, build output, logs. The review facts and the audit measures both leave them out. */
export const FOREIGN: readonly RegExp[] = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock)$/,
  /^(dist|build|out|coverage|node_modules|target|\.venv)\//,
  /\.(log|tmp|class|pyc|swp)$/,
];
export const isForeignPath = (path: string): boolean => FOREIGN.some((re) => re.test(path));
