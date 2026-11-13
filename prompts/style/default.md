---
name: default
description: Small, reviewable diffs and few comments
limits:
  diff_lines: 250
  files_touched: 8
  file_lines: 600
  comment_run_lines: 4
  comment_ratio: 0.15
---
Prefer small functions with descriptive names over comments that explain how the code works.
A comment says why, in a line or two; it never narrates the change, lists what was done, or keeps a changelog.
Reuse a helper that already exists in the repository before writing a new one.
Keep one concern per change: unrelated edits belong in their own ticket.
