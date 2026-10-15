#!/usr/bin/env bash
# The full suite on CI. On the Windows runner a worker of vitest sometimes dies on its own (exit code 3221225477, a native crash,
# probably of node-pty while a terminal closes) with no test failing. A crash takes down only the file its worker was running, and
# vitest names that file; so those files, and only those, run again, up to three more times. A test that fails fails the job at once;
# a file that still crashes after the last attempt fails it too. If the crashed files cannot be told from the log (the count does not
# add up), the whole suite runs once more, as before. Each crash is also written as a `CI-CRASH: attempt <n>: <files>` line, which
# `npm run ci-crash-stats` reads from the logs of past runs.
set +e
# Two workers at a time: the crashes and the 20 s hangs come with several terminals starting and closing together on the shared runner
# (the system ConPTY instead of the bundled one did not help). CI_TESTS_WORKERS changes the number.
WORKERS="--maxWorkers=${CI_TESTS_WORKERS:-2}"
log=$(mktemp)
trap 'rm -f "$log"' EXIT

# The log without colors: a real escape, or its caret form (^[[39m) in a saved log.
plain() { sed -e 's/\x1b\[[0-9;]*m//g' -e 's/\^\[\[[0-9;]*m//g' "$1"; }
# The test files named in "Worker exited unexpectedly ... while running test file <path>" lines, one per line, as test/<name>.
crashed_files() { plain "$1" | grep -o 'while running test file [^ ]*' | sed -e 's/^while running test file //' -e 's|\\|/|g' -e 's|.*/test/|test/|' | sort -u; }
# True when the log has the summary of real test failures ("Tests  3 failed | 40 passed"); a crashed worker is an error, not a failed test.
has_failed_tests() { plain "$1" | grep -qE '^ *Tests +.*[0-9]+ failed'; }
crashed() { grep -q 'Worker exited unexpectedly' "$1"; }
# From the "Test Files  168 passed (170)" line: the number of files that passed, and the total.
files_passed() { plain "$1" | grep -E '^ *Test Files ' | tail -1 | grep -oE '[0-9]+ passed' | grep -oE '[0-9]+'; }
files_total() { plain "$1" | grep -E '^ *Test Files ' | tail -1 | grep -oE '\([0-9]+\)' | tr -d '()'; }

# Sourced by a test of this script: only the functions are wanted.
[ "${CI_TESTS_SOURCE_ONLY:-}" = 1 ] && return 0

npx vitest run $WORKERS 2>&1 | tee "$log"
code=${PIPESTATUS[0]}
[ "$code" -eq 0 ] && exit 0
if has_failed_tests "$log" || ! crashed "$log"; then exit "$code"; fi

files=$(crashed_files "$log")
echo "CI-CRASH: attempt 0: $(echo $files)"
total=$(files_total "$log")
passed=$(files_passed "$log")
n=$(echo "$files" | grep -c .)
if [ -z "$files" ] || [ -z "$total" ] || [ -z "$passed" ] || [ $((passed + n)) -ne "$total" ]; then
  echo "::warning::a vitest worker crashed with no test failing and the crashed files do not add up ($passed passed + $n crashed of $total); running the whole suite once more"
  npx vitest run $WORKERS
  exit $?
fi

for attempt in 1 2 3; do
  echo "::warning::vitest workers crashed with no test failing; run $attempt of 3 for: $(echo $files)"
  # shellcheck disable=SC2086
  npx vitest run $WORKERS $files 2>&1 | tee "$log"
  code=${PIPESTATUS[0]}
  [ "$code" -eq 0 ] && exit 0
  if has_failed_tests "$log" || ! crashed "$log"; then exit "$code"; fi
  files=$(crashed_files "$log")
  echo "CI-CRASH: attempt $attempt: $(echo $files)"
  [ -z "$files" ] && exit "$code"
done
echo "::error::these files still crash a worker after three more tries: $(echo $files)"
exit 1
