# Changelog

All notable changes to this project are recorded here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/)
(a release is a `v<version>` tag, which is also what the desktop app shows). Before the first release the work was grouped by the phases
of `docs/SPEC.md` section 24: those entries are kept below the releases. Write entries in English (P11) and add them in the same
change that introduces the behaviour.

## [Unreleased]

- Fixed: the console's request message and every agent prompt give one rule for a request the agent cannot answer yet ("Answer <id>" as the first open step after Tests; later steps cannot close until it is answered), the main answers a late escalation as any other and forwards a draft to a consumer already started, and the `dba` keeps dumps in the system temp folder or the clone's container, passes the clone's connection without editing configuration files or writing credentials, and reads the shared database only with the credentials in its goal.
- Changed: the main is told how to write the goals of agents that depend on each other (spawn the provider of a contract first, name the colleague and the contract in both goals, the provider publishes the contract first, the consumer works against the draft or a mock with TODO requests, a consumer not yet running gets the draft in its goal, a late escalated question is answered at once), and every author agent's request rules say to answer a colleague's question before its own steps (or as its next open step, never before Study or Tests) and to publish a contract it provides after Study and before Tests, one message per consumer.
- Fixed: the instruction to pass `tests` to `step_done` reaches only the agent that writes the work (in its validation step), no longer the reviewer and recovery sessions, which have no `step_done`.
- Added: shipped profiles `backend`, `frontend` and `dba` next to `developer` (offered to the main and in the new-agent menu); every working profile tells the agent to publish the contract it provides first (after its Study step; to the main when the consumer is not running yet; a summary and a file path when it exceeds the 8000-character message cap), to work against a draft or a mock while waiting for one, to answer a colleague's request before going on (at once, or as its next open step), and never to rewrite a colleague's files; the `dba` proves each migration on a throw-away clone restored from a local copy or backup with every run aimed explicitly at the clone, never writes to the shared database first, keeps dumps out of its commits, removes what it created, and says so in its report when a remote database without a local copy could only be proven on synthetic data.
- Fixed: a repository command for a folder the project does not hold is refused with the names of the repositories that can be used (or, in a folder that is itself the repository, a text saying to set the project's command), and a repository folder named like an object property (`constructor`, `toString`, `__proto__`) no longer breaks the test command lookup or shows an inherited value in Options.
- Added: `step_done` takes an optional `tests` ({ command, result: passed or failed, summary }) for the tests an agent ran by hand, kept on the ticket (last one wins; a reopen for a new round or a restart by a new agent forgets it, and a damaged value on disk reads as none) and shown in `ticket_report` as its own line, labelled as reported by the agent and not verified by the console (n/a when the agent reported none), next to the console's own tests line, so a project with the tests switched off no longer reads as if nothing was tested.
- Fixed: switching "inhibit the tests" on now changes the very next `step_done` at the validation step: a refusal that no call was waiting for (such as `no_test_command`) is no longer kept and handed back to a later call, only a closed step is; a validation waiting in the machine's test queue leaves it within one poll (about 2 s) once the tests are inhibited, one already running is stopped and its verdict ignored, and the step closes without any test result; the full run on the merged branch no longer locks and reads every repository while the tests are inhibited.
- Added: in a project folder that holds several repositories, Options, Project has one test command per repository (`project.json` `repoTestCommands`, keyed by the repository folder name), used for every moment before `testCommands` and `testCommand` (a ticket run of it takes the machine's one heavy test slot: only the project's own `testCommands.ticket` runs light); each row shows the command detected in that repository as its placeholder (n/a when none), the project-wide field no longer says that nothing was detected, `PUT /api/project` refuses a repository the folder does not hold (`project.repoUnknown`), and a `no_test_command` refusal (validation step and `ticket_report`) names the repository and where to set its command.
- Fixed: in a project folder that holds several repositories, the test command is detected in the repository a run happens in (the agent's worktree for the validation step, review re-run and recovery; the repository's project worktree for the merge, the central run and the release proposal; its checkout after the release merge) instead of in the project folder, which has no build file, so `step_done` no longer refuses `no_test_command` for every agent; that refusal now names the repository. A project folder that is the repository behaves as before.
- Fixed: the mod acknowledges an inbox message only after `$.prompt.submit` took it (a throw or a `drop` leaves it with the console, offered again in order, with a back-off of 2 s doubling up to 60 s while the engine keeps refusing it; a re-offered message whose ack was lost is acknowledged without a second submit within the same mod process, while after a restart it can arrive twice), and the `unanswered_requests` / `request_unanswered` refusals tell an agent that a request text it has not seen arrives when it ends its turn, instead of answering `unknown`.
- Fixed: `merge_ticket` no longer ends in "The console did not answer." while the merge goes on: the merge runs as a job of its own, each request waits at most 15 s and answers `running`, the mod asks again, a repeated call for a merged ticket answers `merged` with the same sha without touching git, and a partial cleanup answers `cleanup.incomplete` (session, worktree, branch) and the notice to the main names what was left.
- Fixed: a `bad_request` from a console tool (`send_message`, `merge_ticket`, `spawn_agent` and the others) now carries a `detail` sentence that names the missing or wrong field (for example `in_reply_to is required for type "answer"`); `code` is unchanged.
- Added: `list_agents` shows the main the release request that waits for the user (`release: { id, status: 'pending' }`), so it neither asks again nor forgets it.
- Tests: a pending release confirmation is pinned to raise one desktop notice titled "Release to approve" (the queue badge and notice already existed).
- Fixed: a release request that is no longer in the queue is asked again instead of answering "already asked".
- Added: a release can be approved or rejected from the Claude app: the main shows the request in its own AskUserQuestion dialog and the mod posts the user's choice with a per-session release key the model never sees.
- Added: guard rule `path.console-config`: no session (main or agent) may write a project's `.claude/settings.local.json` (judged as Windows resolves the path: cd, junctions, 8.3 names) or the console mod's folder; `settings.json` and the `.claude` folder stay free.
- Changed: the main's `AskUserQuestion` carrying `answers` or `annotations` in its input is refused, and a release dialog counts only with exactly the options Reject then Approve.
- Added: the main is told when an answer in its release dialog did not count (question reworded, or the request already settled), gets the question back when it proposes a release that is still waiting, and, when its mod has no release key, is told to send the user to the console queue.
- Fixed: `sed -i` / `--in-place` and `perl -i` count as writes to the files they edit for the guard (the mod folder, and `path.outside-worktree` for agents).
- Tests: a static check fails if any source file writes to the user's Claude home (`~/.claude`, `CLAUDE_CONFIG_DIR`, `~/.claude.json`).

## [0.0.10] - 2026-10-15

### Changed
- `SECURITY.md` says the console is meant to be used with someone watching: the guard catches mistakes and is not a security boundary.
- Tests: `PtyManager` takes the function that starts a session's process (`StartOptions.ptySpawn`, the pseudo terminal by default), and the 14 test files that never read the terminal run their agents on plain pipes (`test/pipe-pty.ts`, `usePipePty()`), so they no longer depend on the ConPTY, where the native worker crashes on the CI runner happen.
- Claude Code 2.1.300 is now the last tested version (`test/e2e/claude-contract.ts` holds, and `real-claude-smoke.ts` passes: the main answers a prompt, a second agent starts, a reopened tab restores both).

### Fixed
- The guard refuses an agent's download saved outside its worktree (`curl -o`, `-OutFile`, `--output=`), `cp -t`/`mv -t` into a folder outside it, and `git clone` into one.
- The guard refuses a word with wildcards that can expand to a secret's name (`cat .env*`, `type .e*`); `*`, `.*`, `*.*` and globs that open with a wildcard (`*.json`) stay allowed.
- The guard reads `-t` as a target folder only for `cp`, `mv`, `ln` and `install`, and `bitsadmin` only with `/transfer`, so `ls -t`, `docker build -t` and `bitsadmin /list` are not taken for writes.
- A failing `setGoal`/`setRepo` while an agent is being created now undoes the spawn (name, token, registry entry) instead of leaving a registered agent behind.
- A ticket file that is damaged and could not be set aside is no longer overwritten by a new empty ticket: writing to it fails with `ticket.unreadable`.
- A replacement agent that fails to start gives the ticket back its stop cause, blocked reason and blocked flag along with its name and budget.
- Temp files of an interrupted state write (`*.tmp-<pid>-<n>`, older than an hour) are removed from the tickets folder.

## [0.0.9] - 2026-10-13

### Fixed
- The main may call `ticket_report`, `request_review`, `send_back_ticket`, `merge_ticket` and `propose_release` without a permission prompt (they were missing from its allowed tools, so without bypass the review flow stopped at a prompt).

## [0.0.8] - 2026-10-13

### Changed
- Internal: the assembly of a project is now a typed container with one file per area (state, tests, agents, tickets, budget, http), instead of one 900-line function; behavior is unchanged.
- Fixes from the review of the hardening work: the guard no longer counts `-Path` of a reading command as a write nor `node server.js -p 3000` as `node -p`; `git stage` and the other missing built-ins are not taken for aliases; a discarded session releases its questions, restrictions and inbox; a damaged `projects.json` is set aside; the unhandled-rejection logger is removed on close; the budget tick no longer waits on one busy ticket.
- The page is served with a Content-Security-Policy (own scripts only, connections to this server only, no framing), `nosniff` and no referrer.
- Internal: the project folder is canonicalised (8.3 short names expanded) when a project opens and before git worktree paths are compared; the POSIX-only branches of the ticket test runner are gone.
- `npm run test:ticket` finds the `project/<name>` branch by itself (`TICKET_BASE` overrides it); `start-console.bat` is now in the repository and uses `--project-root`; `node-notifier` is 11 (no `uuid` advisory); the mod manifest author is `andromedaconsole`.
- Internal: everything that depends on undocumented Claude Code details (launch flags, transcript files, tested version) now lives in `src/server/claude-code/`; `test/e2e/claude-contract.ts` checks it against the real `claude` (version, flags, mod validation). The mod is type-checked in `npm run check` when Claude Code has written its types beside it.
- The product is now called AndromedaConsole (it was AndromedaCli, a name already taken): window and page title, splash picture, installer (`AndromedaConsole-Setup-*.exe`), app id, package name, and the `--name` that Remote Control shows. The project folder `.andromedacli/` is now `.andromedaconsole/`, the settings folder `%APPDATA%\andromedacli` is now `%APPDATA%\andromedaconsole`, and `ANDROMEDACLI_TEST_CONCURRENCY` is now `ANDROMEDACONSOLE_TEST_CONCURRENCY`. The first start moves the old folders by itself (state paths and git worktrees are repaired); an installed 0.0.7 does not auto-update across the new app id and needs the new installer once.

- The guard now also refuses shell writes outside the agent's worktree (redirects, copies, moves, `Set-Content`...; the system temp folder and the null devices stay allowed), git configuration set through `GIT_*` environment variables, git aliases, abbreviated git options (`--no-verif`, `--har`, `-bnew`), the main's writes to global git config, secret files named with an alternate data stream or a trailing dot or space, `findstr` and `git show REV:file` on secrets, `node -e`, `python -c` and `mklink` in read-only sessions, and more download-and-run forms (`--output=`, `certutil`, `bitsadmin`, `Start-BitsTransfer`). The console no longer lets Windows run a `git.exe` or `claude.cmd` found in the working folder.
- State files are safer: a state file the console cannot read (a ticket, `agents.json`, `requests.json`, `inbox.json`, the full-run record) is set aside as `<name>.corrupt-<date>` instead of being overwritten by the next save, and the status bar says which one and where it went; writes retry a busy file (antivirus, indexer) and flush to disk; all ticket work goes through one per-ticket queue; renaming a ticket is atomic; the project's own secret patterns apply when a worktree is cleaned up; stopping a session waits for its processes to exit; a failed replacement restores the ticket's budget; and an unhandled promise rejection is logged to `errors.log` instead of stopping the console.

### Added
- `npm run test:changed`: the checks, then the tests related to the diff against `origin/main`. `test:ticket` (diff against `project/<name>`, what the console runs for a ticket) selects every file in a plain checkout where that branch is far behind.
- CI: when a vitest worker crashes natively, its minidump is kept (Windows Error Reporting) and uploaded as the `crash-dumps` artifact.

### Changed
- CI: the full suite runs with two vitest workers (`--maxWorkers=2`; `CI_TESTS_WORKERS` changes it), to see whether fewer terminals starting and closing together stop the native worker crashes and the 20 s hangs. The system ConPTY instead of the bundled one for the tests did not help and was taken out again.
- `npm run shot` with `--agents`, `--states` or `--many` makes the project folder a git repository by default (a plain folder answered `422 git.notRepo`).

## [0.0.7] - 2026-10-12

### Added
- Agent panels have a Compact button, the counterpart of the bar's Expand: the panel folds into a bar and the next agent takes its slot.
- Archived agents can be deleted from the list, one by one or all at once (after a question): the record, the session and the terminal history go; worktree, branch, ticket, report and ledger stay (`DELETE /api/agents/<slug>`, `POST /api/agents/delete-archived`).
- Status bar: a red "Bypass on" chip is shown at all times while agents run without permission prompts.
- `SECURITY.md`: the layers, what the guard guarantees and what it does not, what bypass changes, and what leaves the machine. The README now mentions the desktop app, the delete of archived agents and Compact, and says that dictation audio goes to Groq.
- The address that opens the page (printed by `serve`, the app window, a notification click) carries a single-use code (`?code=`) instead of the token. The page swaps it once for the token (`POST /api/session`, only with the console's own `Origin`) and removes it from the address; a used or expired (12 h) code opens nothing. The token is still accepted as `Authorization: Bearer` and `?token=` for tools that hold it.
- `npm run shot:readme` makes the README pictures (`assets/screenshots/`) from a staged demo project (`scripts/demo-agent.cjs`); the README shows them.
- `doctor` warns (not fails) when the installed Claude Code is newer than the last version a real contract run used (`TESTED_CLAUDE_MAX`, now 2.1.294).
- `CONTRIBUTING.md`, issue templates (bug report with Claude Code and Node versions and the `doctor` output), and Dependabot for npm and GitHub Actions (weekly, grouped).
- CI: a `smoke` job (the checks and the seven smoke files) runs next to the full suite, so a break in the basics shows early.

### Changed
- The README and `CONTRIBUTING.md` now say that AndromedaConsole is Windows-only by design: no macOS or Linux support, and none planned.
- CI: when vitest workers crash with no test failing (a native crash on the Windows runner), only the crashed files run again, up to three more times, instead of the whole suite once; a failing test still fails the job at once, and so does a file that keeps crashing.
- The README is a short front page (tagline, why, quick start, safety, links); the rest moved to `guide/` (using, architecture, configuration, desktop app, development). The repository was renamed to `andromedaconsole` (old links and the desktop app's update check follow the redirect). The changelog follows Keep a Changelog with the released versions.
- Shipped model catalog: added Fable 5.1 and Haiku 5.5.
- Status bar: the project budget reads "∞" (no limit is set) instead of "n/a", and "Resume now" is shown only while the console sleeps for a usage limit.

### Fixed
- Guard: an agent can no longer change the git remotes (`git remote add`, `set-url`, `remove`, `rename`, `set-head`, `set-branches`); listing them still works.
- App: voice dictation failed with "the browser has no permission to use the microphone" because the window refused every permission but clipboard and notifications; it now grants audio-only `media` to the console's own address.

## [0.0.6] - 2026-10-11

### Added
- Options > Notifications: "The main notifies me in the Claude app (Remote Control)" (`notifications.mainPush`, off by default, one switch). When on, the main's prompt gets `prompts/main-push.md` and `PushNotification` is allowed: with `/rc` connected the main notifies when it starts an agent, when an agent finishes, when it has a question and when it finishes a whole task. Read when the sessions start, so Save asks for the restart.

### Changed
- CI: when a vitest worker crashes on the GitHub runner with no test failing, the whole suite runs once more (`scripts/ci-tests.sh`); a failing test or a second crash still fails the job.

## [0.0.5] - 2026-10-11

### Changed
- CI: when a vitest worker crashes on the GitHub runner with no test failing, the files whose worker died run once more (`scripts/ci-tests.sh`); a failing test or a second crash still fails the job.
- Options > Secrets: the saved Groq key shows in the field itself, as grey text, its first five characters and five stars (`gsk_a*****`; the console sends only that, never the key); typing replaces it, and below the field there is only "Remove key". The field has an eye that shows or hides what is being typed, like a password field (it never reveals the saved key).
- The dictation dialog closes with the X in its corner (like Options) instead of a Close button, records with a red dot and stops with a red square, and has no Clear button (the text is erased by hand). While it records, it shows the time since the start (m:ss) and bars that follow the voice, like an equalizer (Web Audio; where that is missing the clock still runs). `npm run shot` has `--groq`, `--fill`, `--fake-mic` and `--wait` for this.
- Expanding a dormant agent no longer opens an empty terminal: the panel prints the agent's last words in full (the entries of the read panel, n/a when there are none) and keeps the Wake up button in its header, so the text can be read before waking it.
- The update chip (version found, downloading, ready to restart) is the last thing in the status bar, at its far right edge.
- The divider between main and the agents keeps the main column between 30% and 75% of the width (it was 20% to 80%).
- The "+ new agent" control is always the first item of the agents column, and stays on top while the column scrolls.
- With many agents the agents column scrolls instead of crushing the panels: a panel keeps a minimum height of 140 px, a bar its own height.
- `npm run shot` has new options to look at the interface in a given situation: `--update`, `--agents`, `--many`, `--states`, `--split`, `--scroll`; it also prints the page errors.
- The app has an icon: the galaxy from the splash picture (`build/icon.ico`, 16 to 256 px) on `AndromedaConsole.exe`, on the installer and uninstaller and in the installer header. `signAndEditExecutable: false` became `signExecutable: false` so the icon is written into the exe; there is still no code signing.
- The page has a favicon (the galaxy, `favicon.png`, served without a token like the splash).
- The splash picture is twice as large (2798x1434, resampled with Lanczos, lightly cleaned and sharpened); it is the same picture, so it is smoother but has no new detail.
- Tests: `git-clone` and `project-fields` close their server before they remove their folders (afterEach hooks run last-declared first); on the GitHub runner the folder was locked by the still running agent and the hook timed out.
- Tests: the hook timeout is 60 s (was 10 s), so the cleanup of a temporary folder that Windows still holds for a moment no longer fails a test.
- The full test suite now runs on GitHub (`.github/workflows/ci.yml`: check and `vitest run` on every push to main and every pull request), and the local commit gate is gone (the Claude Code hook, `scripts/commit-gate.ts`, `scripts/stamp-tests.ts`); `npm test` is plain `vitest run`. Locally only the tests of what changed are run; the pre-commit hook still runs `npm run check` and wants a CHANGELOG line.
- A release that is a fast-forward no longer runs the test command again on the target branch: the tree is the one the proposal already tested on that tip. A real merge still does.
- Test helper `makeRepo` copies a repository built once per process instead of repeating about twelve git calls for every test (the copy is about 0.2 s against about 1 s idle).
- Questions for the user now go through the main's own AskUserQuestion dialog, so they can be answered from Remote Control: an agent that writes the work is refused AskUserQuestion and asks the main with `send_message` (the main relays the question and options as written and returns the answer word for word), and the main's `ask_user` tool is gone from its tool list. Reviewer and recovery sessions, permissions and the console's own requests (tickets, releases) still use the queue.

## [0.0.4] - 2026-10-10

### Fixed
- The release workflow's "Smoke test of the unpacked app" (`npm run smoke:app`) failed on tag v0.0.3 with `401 unauthorized` and a 503 on the terminal socket. The app was fine: the script read the page's token as soon as the static `#topbar` existed, before the page's script had stored it in `sessionStorage`. It now waits for the token first; no check was removed or weakened.

## [0.0.3] - 2026-10-10

### Added
- "Archive all finished": a button in the archived list (the status-bar chip now also shows as "Archived (0)" while some agent can be archived) archives, after a confirmation that shows how many, every agent that is finished, or idle with a delivered, merged or released ticket, in one request (`POST /api/agents/archive-finished`, answers `{count, slugs}`). Agents waiting on a decision or stopped (budget, limit, blocked, recovering) are never archived; nothing is deleted and Unarchive still works. After a restart, reviewers and merged developers are not brought back, and stopped finishes stay visible, as before.
- Voice dictation for the main: a microphone icon button in the main panel's header (beside its state; not on agent panels) opens a dialog that records from the browser microphone, has the console transcribe it with Groq Whisper (`whisper-large-v3-turbo`, in the UI language), puts the text in an editable box, appends each further clip, and *Send to main* types the text into the main's input without pressing Enter. Closing the dialog keeps the text until the page reloads, Clear, or a send. The text typed is plain single-line text: escape sequences, Enter and other control characters are removed. It is typed as plain text, so a transcript that starts with `/` or `!` is seen by the main as typed (a command or mode switch of its terminal program).
- Options, Secrets tab (global): the Groq API key, with a warning that the audio goes to Groq. The key is kept only in `<config dir>/secrets.json` (owner-only where the system supports it), never in `config.json`, never sent back to the browser (the tab shows only n/a or set, with replace and remove), never logged, and not copied by templates or copy-settings. New routes: `GET/PUT /api/secrets`, `POST /api/dictation/transcribe` (25 MB limit checked before any network call, refused without a key), `POST /api/main/input`; new error codes `dictation.*`. New `mic` icon.
- One queue for the long test runs of the whole machine: heavy runs (the `merge` and `release` commands, and `ticket` runs when the project has no `testCommands.ticket` of its own) go one at a time, first come first served, so two full suites never slow each other down (the machine has 2 physical cores; the `recovery-http` test failed when they overlapped). A `ticket` command set in `testCommands.ticket` counts as the fast one and is not queued. The limit is 1; `ANDROMEDACONSOLE_TEST_CONCURRENCY` raises it. A waiting run shows as "Waiting for the test queue (n)" on the agent's ticket chip and `step_done` answers `running` with `queue: n`; the state also carries a `testQueue` snapshot. The timeout counts from the start of the run, and the slot is freed when a run ends, times out or fails; a validation whose agent is gone is dropped or stopped.
- Central full run: after the merges into `project/<name>` have settled (120 s with no merge on its way) the console runs the `release` command once on the tip through the queue, covering all tickets merged since the last run, and records the tip, the command and the tickets in `.andromedaconsole/state/central-tests.json`. `propose_release` does not run the full command again on a tip that already passed it.
- When the central run is red the console finds the ticket that broke it: the failing test files against the files each merged ticket changed, then a bisect over the merges (re-running only the failing files, vitest or jest, on a temporary checkout that is removed afterwards). The author gets the failing tests and the output tail (or, when its session is gone, one decision goes to the user's queue); when nobody can be blamed the decision carries the facts. The console never changes code. The full run happens on a temporary detached checkout of the tip, so merges are never blocked by it; when the merge and release commands are the same and the last merge already tested the tip, it is not run twice; a console start covers merges nobody has checked; a ticket handed over after a red run is not blamed again. Because an author is normally gone after a merge, the decision offers "Ask the main for a follow-up agent" (the main gets the goal, the failing tests and the output).
- Archive of finished agents: an agent whose session ended for good (a merged ticket, a finished review or recovery) leaves the agents column by itself and is listed under "Archived (N)" in the status bar, with Unarchive and Unarchive all; nothing is deleted. A stopped agent (budget, loop, usage limit) stays, new work un-archives an agent, the flag survives a restart, and a small Archive button archives an idle agent with a delivered or merged ticket by hand (`POST /api/agents/<slug>/archive` and `/unarchive`). The agents counters and Alt+n ignore archived agents.
- A project can set a different test command for each moment (`testCommands` in `project.json`, three fields in Options, This project): `ticket` (validation step, review re-run, recovery), `merge` (after a merge) and `release`; each falls back to the single test command, so nothing changes unless they are set. New npm scripts `test:ticket` (check + tests changed against the project branch) and `test:smoke` (check + 7 core files); neither writes the commit-gate stamp.
- The header Queue and Options buttons and the agent bar's Read button are icon buttons (bell with a count badge, gear, clipboard); the tooltip and accessible name keep the translated text.

### Fixed
- A recovery session is no longer ended while its report is still being handled: the 3 s grace before the session is closed now starts after the new agent has been started, so a slow restart on a loaded machine cannot revoke the session before the report is answered (a second report was answered "unauthorized" instead of "not_recovery").
- A long validation no longer ends in "The console did not answer.": `step_done` runs the tests as a job of its own, each request waits at most 15 s and answers `running`, the mod asks again until the real result, and the step is recorded when the run ends.

## [0.0.2] - 2026-10-09

### Added
- Requests between agents: `send_message` (question, answer, info, unknown, escalate) routed by the console; a question returns an id `TODO-xxxxxx` at once and the asker keeps working.
- A checklist step can wait for an answer (`Step.waitingOn`): `step_done` goes past it, the validation and documentation steps refuse (`pending_requests`) while one waits, and a step cannot close while its `TODO-<id>` comment is still in the code (`todo_left`); the ticket is not delivered with any such comment left.
- An agent cannot close its validation or documentation step while a request addressed to it is open (`unanswered_requests`), nor close the step named after an open request ("Answer TODO-x") before answering it (`request_unanswered`).
- A stopped agent (budget, loop, usage limit, replacement) keeps the requests it made and their waiting steps; they are cancelled only when it ends for good, and the waiting steps are then released and the holder told. A late answer from the original recipient of an escalated request is accepted; `list_agents` shows the main the requests it still has to answer; a console start restarts the request clocks; the two request settings apply without a restart.
- An unanswered question goes to the main after `agents.requestTimeoutMinutes` (15 by default, counted from the moment the colleague received it); chains of requests are limited by `agents.requestMaxHops` (3); a recipient that is not running sends the question to the main at once.
- The agent bar shows "waiting for <colleague> (TODO-x)" and "to answer for <colleague> (TODO-x)"; a Requests drawer lists the requests between agents.
- Desktop app: it looks for a newer version on the GitHub releases (after 30 s, then every 4 hours); the status bar offers Download, then Restart to update, and nothing happens without the user (a repository that is private, or a release without `latest.yml`, shows nothing). The version of a release is the tag that was pushed.

### Fixed
- Desktop app: a second click on close (or a quit) while the clean stop runs no longer ends the app before the stop finishes, and "Restart to update" stops the server cleanly before the installer starts; the install request is answered at once.
- Budget: an agent resumed after a console restart no longer has its whole earlier transcript counted a second time.
- Queue: what the user is asked to allow is built by the console from the call that will be remembered; the "always" buttons are offered only for a call that can be remembered; a dropped question frees its handler.
- Console: made-up file names no longer grow the page cache; an ended session keeps 256 KB of scrollback instead of 4 MB.
- Release: the build job holds no credentials (a second job publishes), actions are pinned to a commit; the app refuses browser permissions other than clipboard copy and notifications and the exe can no longer run as a plain Node interpreter.

## [0.0.1] - 2026-10-09

### Added
- Desktop app: the console ships as a Windows x64 Electron app (one window, the server runs inside it, no separate Node process, NSIS installer); `npm run build:app`, `dist:dir`, `dist` and `smoke:app`. Closing the window asks first when agents are running.
- Options, Project: while the test command is empty the console uses the one the project suggests (npm test from a package.json with a test script, mvn test or gradle test); the field shows it as a placeholder and says where it comes from. Switches with a longer explanation (squash, worktrees) have it in an (i) tooltip instead of a line below, and the template menu is called Template.
- Shipped profiles are now `developer` (general), `reviewer` and `recovery`; `backend`, `dba` and `frontend` are gone, and so are the profiles of the Java and web templates (the project's CLAUDE.md says how it is built). The new-agent menu lists only profiles to pick by hand (not `reviewer`/`recovery`); a template's profile list is checked for its shape only. The build and lint command fields are gone from Options, Project (the console never used them).
- Options: the Names tab is gone (it only listed fixed rules; the new-agent form already says why a name is refused).
- Options: the panel has a visible scrollbar and a shadow at the edge that still has content behind it, so a long tab shows there is more below.
- Options, Budget and limits: the token budget, the alert/restriction/stop levels and the usage-limit levels are horizontal sliders with the value in a read-only box at the right. Levels that must stay in order stop at their neighbour and are sent as one request; the footnote now says which settings apply to new agents.
- Options, Profiles: profiles can be created, edited and deleted from the dialog (files in the config folder, all fields: name, description, model, token budget, read only, instructions). A shipped profile is edited as a copy and restored one by one or all at once; a profile only the project has stays read only here. New routes `GET /api/profiles`, `PUT|DELETE /api/profiles/<name>`, `POST /api/profiles/restore`; the new-agent menu lists every profile.
- After Save in Options, a Yes/No question offers to restart the sessions when a setting Claude reads only at launch changed (bypass, guard mode, agent model) or a program installed since is not on the PATH of the running console. Yes (`POST /api/restart`) ends and starts again every project's sessions (the main resumes its conversation, the agents that were running are resumed), refreshes the PATH from the system on Windows, and loads the page again from the splash; the console, its port and token stay.
- The divider between main and the agents can be dragged (20-80%) to widen or narrow either side; double-click resets to half; the position is remembered in the browser.
- A project folder that is not a git repository but holds several (for example `abc-website` with `abc-fe` and `abc-be`) now works: `spawn_agent` and the new-agent form take a `repo`, each agent gets its worktree and branches in that repo, and review, merge and a single release confirmation run per repo (`git.repoRequired`, `git.unknownRepo`); the main's prompt lists the repos.
- With no project open (nothing remembered and no `--project-root`) the console shows a welcome screen that asks for a project; creating it starts the console as usual. The new-project dialog has a Browse button that opens the native Windows folder window (`POST /api/pick-folder`, one window at a time, title in the interface language).
- `GET /api/host` tells the page what the console knows without a project (projects, language, languages); project routes with no project answer `404 project.notFound`.

### Changed
- Lighter console: the UI is minified and split (the reader's markdown libraries and the Options dialog load when first used) and served with ETag and Brotli instead of `no-store`; state pushes are merged and built once per project instead of once per socket and per change; one slug regex and one JSON reader; terminals keep 10 000 lines in the page instead of 20 000.
- Review fixes for the above: the silence chip is pushed when it appears or goes (no longer waits for another event) and never shows for an agent that has just woken up; reviewers and recoveries get it too; "Always" is exact on the whole tool input (not the shortened line shown) and also answers identical requests already waiting; the silence threshold in Options has a tooltip.
- Agents: the "not started" chip says why (Claude Code never reported in, or it has not taken its goal); a working agent with no sign of life for longer than the silence threshold (Options, Budget and limits) shows a chip too (report only, nothing is stopped).
- Queue: a permission can be answered "Always allow" or "Always deny": it is remembered for that agent and the exact same tool call until its session ends (the guard still applies); each agent's panel shows how many of its items wait for the user.
- Options: the (i) hint is drawn by the page, half as wide and taller; in Models the refresh button is square and the catalog address box is as wide as the model menu; in Profiles the two notes sit at the bottom of the panel, full width; the new-profile name hint is one line with a typed-characters counter (0/40) under the box; the profile token budget is a slider like in Budget and limits, starting at the default.
- Agents and main: the agent prompt now says that the goal message, the main's review notes and the console's answers are its instructions (Claude Code labels a plugin message as coming from a plugin, and the old wording made small models refuse the goal); the goal is also saved as `.andromedaconsole/goal-<name>.md` in the agent's checkout; the main is told the profiles that really exist (the old fixed list backend/dba/frontend was stale).
- Repository tooling: `npm run shot` (a screenshot of the real UI), `npm run hooks` (pre-commit: `npm run check` and a CHANGELOG line for a change to the product), and a Claude Code hook that refuses a git commit until `npm test` has run green since the last code change (`wip:` skips it).
- The console never reads the PATH (or the registry) from the system: it only uses the PATH it was started with. The restart of the sessions no longer merges the Windows PATH in, the Prerequisites tab has no Recheck or Restart button (they could not show a program installed later) but a line saying to start the console again from a new terminal, and the restart question after Save is asked only for settings the sessions read at launch.
- Options, Git: the non-repository case is two bold titles ("Initialize git" with its button, "Or clone an existing repository" with its box), each with its explanation in an (i) tooltip instead of lines of text.
- Options, Git: a folder that only holds repositories (not a repository itself) offers git init and clone like any other non-repository folder, with a one-line note and no list of the repositories; the project then becomes that repository, the ones inside belong in its .gitignore.
- Options: the note "settings apply to agents launched from now on" is shown once, next to Save, on every tab, instead of inside some tabs; the Budget and Profiles notes keep only what is specific to them.
- Options, Git: a project folder that is not a repository can also be made a clone of an existing repository (address in https, ssh or git@host:path form; the folder must hold only the console's own files; no password goes through the console, and ext:: and local transports are refused). The console now also warns when a repository has no .gitignore: the main asks the user once per repository, an agent keeps its work clean (the console commits with git add -A).
- Options, Git: the box for "files the console never commits" is gone (the .gitignore is the programmers' to fill); the console's own safety net for secret-looking files stays, with its default patterns and the `git.secretPatterns` entry in the configuration file.
- Options, Git: the git program section (status, version, install, recheck) is gone; when git is missing one red line sends the user to Prerequisites, when it is there nothing is shown.
- The Italian name of the Generic template is now "Generic" (it was "Generico").
- Options, Project: "Inhibit the tests for this project" for a project with no tests (or where they cannot be run): no test command runs anywhere (validation step, review, merge, release, recovery), the validation step closes without a run, and the reports and the reviewer are told "not run", never "passed". The explanation of the test command field is now in its (i) tooltip, and the project model menu says what the default is.
- Options, Plugins: each plugin shows whether it is installed (for every project, for this one, disabled, only elsewhere, or not installed), asked of Claude Code with `claude plugin list --json`; an installed one has no command to copy; the "context used" line shows only when the value is known (it was always n/a).
- Options: the Server tab is gone (two read-only lines: the port is in the address bar, the configuration folder is in the documentation).
- Plugin catalog: Superpowers (`superpowers@claude-plugins-official`) is listed under "useful on request", official, for the main only (its worktree, commit and branch skills overlap with what the console does for the agents).
- Prerequisites: the main and every agent are told which optional helpers (ripgrep, fd, jq, ctags, Python, uv, ShellCheck) are installed, with what each is for and which to prefer (`rg` over `grep`...); nothing is said about a missing one. The Prerequisites tab shows how many shell commands used each helper (console-wide counters, never the commands).
- The restart question: No at the left, Yes at the right.
- Prerequisites: Python, ripgrep, Universal Ctags, jq, fd, ShellCheck and uv are optional checks, each judged only by running `<tool> --version` (no PATH or folder scan); winget install and update from Options like the GitHub CLI. The Options table has a Required and an Optional section; the first-start wizard lists only the required tools.
- Options: after a language change every tab is translated, also the ones not on screen at that moment (Models stayed in the old language).
- Options, Notifications: the quiet hours are picked on a clock face (hour on two rings, then minute; also by keyboard) instead of a typed time. The two clocks are disabled while the quiet hours box is off.
- Options, Notifications: a grouping time out of range is no longer put back silently; Save refuses it with a message that names the field and its limits (1 to 60).
- Options: the Mod tab is gone (it only showed a read-only line); `mod.enabled` stays in the configuration file as a debug switch.
- Options: Save is all or nothing. Every staged change is first only checked (`?dryRun=1`, nothing written) and all the refusals are listed; only when everything is accepted is anything saved, so a refused Save leaves the settings as they were.
- Projects: a new project can start with the settings of an open one (new-project dialog), and Options, Project can copy them onto the open project (profiles, rules, commands, limits; never agents or tickets). Options, Project also has the tokens-per-agent slider; the global model, agent limit and token budget are labelled as defaults.
- Options: the left column is split into Global and Project groups, each with a heading and a separator.
- Options, Budget and limits: the three sliders of a group (alert, restriction, stop; and the quota ones) move together: reaching a neighbour pushes it along instead of stopping.
- Options: a number outside its range is refused with a message that names the field and its limits ("must be a whole number between 1 and 64"); Save tries every staged change and lists all the refusals together (config entries and the project limit).
- Options: changes in every tab are staged and applied by one Save button (which closes the dialog); a top-right X closes without saving. A refused change shows its error and the dialog stays open. Tabs keep their edits while another tab is shown.
- Options, Models: aliases are no longer listed; the catalog date sits next to the label; Refresh is a green round-arrow button beside the menu; the catalog address has an (i) tooltip; the cache time field is gone (fixed 6 hours, Refresh forces); the "applies to new agents" note is a footnote.
- Choosing a folder in the new-project dialog (Browse or typing it) fills the project name from the folder name; a name the user typed is kept. A rule makes the `hidden` attribute win even over a class that sets `display` (the name field of the dialog had been showing when it should not).
- First-start wizard: one heading (the step name, with a quiet "First start · step n of m" line above it), no Skip button, Back on the left, the recheck button in the middle and Next on the right; the last step is an optional Git step (offering `git init`) shown only when the chosen folder is not a repository, replacing the "First project" step. The prerequisites recheck button is centred in Options too.
- The language list no longer has a "browser language" entry (only languages that have a message file); a saved "auto" shows English. The first-start wizard has a Back button, on the left, from the second step on.
- The prerequisite check tells "installed, restart the console" (status `restart`) for a tool that is not on this process's PATH but answers `--version` at the fixed place the installer puts it (Windows gives a program the PATH it started with, so the GitHub CLI installed from the dialog was shown as missing). Nothing reads the registry or other programs' environment.
- The default language is English (it was "auto", the browser's); "auto" is still a choice in the language list.
- The console never starts git on its own: a new folder is only created (no `git init`). Options, Git tab: shows whether git is installed (with the install command and the consent dialog when it is missing) and a "Start a git repository here" button (`POST /api/projects/git-init`: `git init -b main` and an empty first commit) for a project folder that is not a repository.
- Options, Project tab: a template picker with "Apply template" (`POST /api/projects/apply-template`): the profiles, main.md and rules.md of the template replace the files of the same name, the commands already set stay; the build, lint, model and agent-limit fields are always shown.
- The first-start wizard's project step shows only the folder (no name) and points to Options, Git when it is not a repository; its last button opens the one-field new-project dialog.
- The new-project dialog asks only for the folder: the template (Java, web front end or generic) and the build/test/lint commands are picked from what the folder holds (`POST /api/projects` with `auto: true`), a folder that does not exist is created with a git repository (the dialog says so), and a name field appears only when the folder's name is taken or unusable. Commands, model and limits are changed in Options, Project tab.
- "Plan" is now "project" everywhere (UI texts in English and Italian, prompts, API `/api/projects`, `project.json`, `projects.json`, `--project-root`, branches `project/<project>` and `agent/<project>/<name>`, the `.project` merge worktree). No migration: projects created before this change must be recreated.
- New agents' worktrees (and the console's `.project` merge checkout) live under the project's `.andromedaconsole/worktrees/` (`<repo>/` one level down when the project folder holds several repos) instead of `<repo>.worktrees`; worktrees already made keep working where they are. Claude Code's folder trust now reaches them from the project folder.
- The last open project can be closed: the console goes back to the welcome screen.
- The close-project dialog has a box "also delete the project's data": it removes the project's worktrees, its `agent/<project>/*` and `project/<project>` branches and its `.andromedaconsole`, so the project opens again as new (`DELETE /api/projects/<name>?purge=1`).
- Agents are launched with `--name "<agent> <project> AndromedaConsole"` (same reason).
- The main session is launched with `--name "<project> AndromedaConsole"` (also on restart/resume), so Remote Control shows it instead of the default name.
- The guard refuses the main any Claude Code built-in subagent other than the read-only Explore, Plan and claude-code-guide types (rule `agent.builtin-subagent`), pointing it to `spawn_agent`; the mod now sends the subagent type and also guards the older `Task` tool name.
- The main's prompt tells it to do every file-changing job through console agents (`spawn_agent`), not Claude Code's built-in subagents, which are invisible to the console (no worktree, ticket or budget).
- Visual redesign of the whole UI: dark graphite surface with hairline seams instead of dimmed panels, one accent for focus, state dots with colour only for state, tab-style project and options navigation, themed terminals, a brand mark in the top bar and a narrow-window layout.
- Options dialog navigation is a vertical menu on the left (a row on narrow windows); Escape closes the Options, new-project and close-project dialogs.
- `serve` without `--project-root` no longer opens the current folder: it opens the projects remembered in `projects.json`, or shows the welcome screen. `startServer` takes `projectRoot` and `projectName` as optional.
- The request handler takes the console-wide part (`HostContext`) apart from a project's `Context`.

### Fixed
- On Windows the terminals use the ConPTY bundled with node-pty (falling back to the system's if it cannot start): the system one on Windows 10 dropped the mouse and alternate-screen requests of Claude Code's fullscreen mode, so the mouse wheel did nothing in the terminals while PageUp/PageDown worked.
- git is retried when Windows kills it at start-up on a starved machine (exit 0xC0000142, before git runs anything); this made a step commit fail now and then under a heavy test run.
- Opening a project whose saved main session had no transcript (it never received a prompt) failed with "No conversation found with session ID"; the main now resumes only a session that has a transcript and otherwise starts a new one.
- The native folder window opened by Browse could appear behind the browser; its owner window is now shown (invisible, off-screen, topmost, brought to the foreground) so the dialog comes to the front.
- The new-project dialog on the welcome screen listed no templates and detected no commands (those routes needed an open project); they now answer with no project open.
- The start-up picture now covers the whole window (cropped instead of letterboxed), and dialog forms (new project, save as template) have stacked labels, styled fields, a three-column commands row and a primary action button.
- The guard no longer asks the network whether a UNC path (`\servershare...`) exists: it is never inside a local folder, so it is decided at once (the lookup of an unknown server name took about 20 s per call).

## Before the first release

The phases below were built before the first tag, in the order they are listed (newest first).

## Phase 6: multiple projects, full resume, notifications, templates, options (2026-10-05)

### 6C: Multiple projects and tabs
- One console now hosts several projects (one per project folder), each with its own main session, agents, tickets, queue and `.andromedaconsole/` folder, shown as tabs with a dot while its queue waits; `+ project` opens a project, a small close button closes one (nothing is deleted on disk), `Alt+Left` / `Alt+Right` switch, and the page title counts waiting questions.
- `POST /api/projects`, `DELETE /api/projects/<name>`, `?project=<name>` on every `/api/*` request and on `/ws/ui` and `/ws/term/<slug>` (absent: the first project); `StateMessage.projects`; the open projects are remembered in `<configDir>/projects.json`.
- The active-agent global limit counts agents of all projects; a freed slot in one project starts the queue of the others; the quota state, the sleep timer (state now in `<configDir>/state/sleep.json`) and the ledger are shared by all projects.

### 6A: Full resume
- After a restart the main resumes its own session and the other agents come back dormant (no process, no quota spent); an agent whose turn was lost in a crash, or whose worktree is gone, is interrupted. The main gets one message with the lists.
- Dormant agents wake when the user clicks them (Wake up), when work arrives for them, or when the main calls resume_agent (which now also accepts dormant and interrupted agents).
- The console keeps agent sessions, undelivered inbox messages, the main session and a clean-stop flag across restarts; a saved usage-limit sleep is re-armed.
- Stale worktrees (git.staleWorktreeDays, git.staleCheck) are flagged and reported once to the main; new main tool worktree_cleanup saves, pushes and removes a worktree, never a branch.

### 6B: Notifications
- The server raises a native Windows toast (node-notifier) for questions, permissions, the release confirmation, tickets that need a decision, budget decisions, the weekly limit, other decisions and interrupted agents, also with the browser tab closed.
- Nothing is announced while the console is in front (focused, queue open or the asking panel active, from a UI heartbeat); events within a few seconds become one toast; quiet hours (local time, may cross midnight), per-type switches and sound are settings.
- A click on a toast opens the console on that queue item (#queue=<id>); the tab title shows the number of waiting items.
- When no toast can be shown the state says so and an optional browser notification takes over; the Notifications section of Settings has a test toast button; the doctor checks that the toast module loads.

### 6D: Templates and the new-project flow
- Project templates: a folder with `template.json`, `main.md`, `rules.md` and `profiles/*.md`; shipped ones live in `templates/` (`backend-java`, `frontend-web`, `generic`), the user's in `<config dir>/templates/` (the user's wins on the same id); an invalid template is listed as unavailable with the reason. `GET /api/templates` lists them.
- New project from a template (`applyTemplate`): creates the folder and a git repository with an empty first commit when asked (a commit identity is supplied only when the user has none), copies the profiles to `.andromedaconsole/profiles/`, writes `.andromedaconsole/main.md` and `.andromedaconsole/rules.md` and the project fields; what the user typed beats the detected commands, which beat the template's.
- `GET /api/projects/detect?root=` proposes build, test and lint commands from `pom.xml`, Gradle or `package.json` (bounded reads, no process is run).
- `POST /api/projects/save-template` saves the current project as a user template (a copy: later project changes never touch it; an existing id is refused unless `overwrite`).
- New optional project fields (`project.json`, `PUT /api/project`): `buildCommand`, `lintCommand`, `profiles`, `model`, `agentTokens`, `maxActive`, `docs`, `secretPatterns`; the project's profiles limit the new-agent picker and `spawn_agent`, its model, token budget, active-agent limit and secret patterns sit behind the request's and the profile's own values.
- The main's prompt gets `.andromedaconsole/main.md` and every session's prompt gets `.andromedaconsole/rules.md`; an agent is told which documents to update at the last step (`docs`).
- New-project dialog (template, folder, name; commands prefilled from the folder) and a "save as template" dialog; the first-start wizard offers to create a project from a template.
- SPEC delta (21.2 step 3): the console does not install a project `CLAUDE.md`: an uncommitted file would dirty the user's checkout (the release check refuses on tracked changes) and would not reach the worktrees; the rules travel in `.andromedaconsole/rules.md`, appended to every session's system prompt.

### 6E: Options, remote model list, plugin catalog
- The gear opens a tabbed Options dialog (models, profiles, budget and limits, names, project, git, guard, mod, notifications, language, prerequisites, plugins, server); each editable field saves on change and goes back when the server refuses it.
- `PUT /api/config` accepts any subset of the configuration: it is deep-merged into the user's file (unknown entries kept), validated, refused with `config.invalid {path}` when a touched entry is invalid, and applied at once to the limits, budget thresholds, git options and catalogs; `GET /api/options` returns the effective configuration and the read-only facts.
- New config entries `models` (`agent`, `catalogUrl`, `cacheHours`) and `plugins` (`catalogUrl`, `cacheHours`); the saved agent model is used for launches after the ticket, profile and project levels.
- Model list from a remote `models.json` with a cache (6 hours by default), a shipped fallback in `catalog/models.json`, a refresh button and a warning when the saved model left the list.
- Plugin catalog as a read-only list (`catalog/plugins-catalog.json`, `GET /api/plugins`): tiers, trust, requirements, conflicts, "not tested with this version", and the exact install command to copy; nothing is installed or enabled.
- SPEC delta: the model and plugin catalog URLs are empty by default (repository address still open), so the shipped lists are the source until one is set.

### 6F: Assisted install of prerequisites
- The prerequisites table (Options and the first-start wizard) has an Install/Update button for a missing, outdated or unreadable tool: a dialog shows the exact command and where it comes from, the console runs it itself in a read-only terminal after the click, then checks again.
- Installs come from a shipped table of fixed commands (winget for Node.js, Git and the GitHub CLI; the scoped npm package for Claude Code); the console never elevates, runs one install at a time, and records each in `install.log` in the config folder.
- A failed install that looks like a permission problem says it needs administrator rights; the dialog says the commands are not verified on this machine yet.
- New optional prerequisite: the GitHub CLI (`gh`); missing never blocks anything.

### Fixed (found when the six parts were put together)
- `/api/projects/detect` and `/api/projects/save-template` are no longer taken for project routes (they answered 404).
- The generic configuration patch accepts the `notifications` section.
- A leftover agent record with no ticket, no session and no worktree is history, not a dormant agent.
- The first-start wizard has a third button on its last step (create a project from a template); the acceptance spec clicks Skip explicitly.

## Phase 5: budget, blocks, limits (2026-10-05)

### Added
- Per-agent token budget: alert at 80% (WIP commit by the console, message to the agent and the main), restriction at 100%, orderly stop after the grace with the ticket in `suspended_budget`; tokens come from the Claude Code transcript (input + cache_creation + output) and are recorded in a monthly ledger.
- The budget alert tells the agent to write its handover note to `.andromedaconsole/handover.md`; the console reads it (bounded, no symlinks) at the stop and gives it to the new agent.
- Recovery: after a budget stop or a block the main can start a read-only recovery agent (`start_recovery`) that verifies the work, diagnoses the cause from the ledger and reports a remedy (`recovery_report`); the restart is a new agent on the same branch, at most 2 attempts, and a spend is always the user's decision (a `change_model` remedy asks as well).
- Loop and block detection from the transcript: repeated identical calls, repeated identical errors and repeated compactions are corrected, then limited, then stopped (ticket `blocked`, recovery by the main) and keep escalating while the loop goes on; silence (any sign of life counts, the notice says whether the process is alive) and a long time without `step_done` only warn the main.
- Subscription quota: the mod reports the limits (`session.measure`, `quota` event); at 70% the active-agent limit halves, at 85% nothing new starts and agents are told to close the step, at 95% they are restricted, committed and ended in priority order, the main last; a spend limit never drives the steps.
- Sleep until the reset: from the 95% stop (when the reset time is known) or at 100% the console waits with no attempt in between and, at the reset, wakes only the main (one check, then a backoff of 5, 10 and 20 minutes); a later low reading ends any sleep; the weekly limit does not restart by itself and puts an item in the queue listing the choices.
- `resume_agent` (main): resumes suspended agents with `--resume`, staggered across calls, refused while the quota is high; with `git.worktrees` off they resume in the project folder.
- The status bar shows the quota, the reset date or waiting time, "paused / almost used up" and an always visible "Resume now" button (disabled while awake), and the agents against the current limit; the agent bar shows the budget used, the new ticket states and loop level, and a queue item with raise, close or recover after a budget stop.
- The guard can restrict a session (budget, loop, quota); the mod now routes WebFetch, WebSearch and Agent through the guard.
- Budget, loop and quota thresholds are configuration entries (`budget` in config.json) with the SPEC defaults.

### Changed
- Queued agents start oldest first when several slots free at once.
- The agent counter and the start limit use the stricter of the global and the per-project limit.
- `checklist_set` is refused (`restricted`) while an agent is restricted; "close" on a budget decision is refused while a recovery runs on the ticket.

### Fixed (found by the final review)
- The quota step comes down to what a lower reading says (after a stop, a five-hour reset with the weekly window at 76% gives `halve`); the wake-up probe counts as running below the freeze threshold; a reset time more than 7 days away is treated as unknown.
- The 95% stop restricts first, then commits, then ends; only tickets being written get a WIP commit (a delivered branch never moves); a reviewer or recovery stopped by the usage limit gives its ticket back and a recovery ended by the console never leaves the ticket in `recovering`.
- The loop detector sees a new run of identical calls or errors after a different call (also within one turn) and an error repeated with successes in between; the same-error signal keys on the originating call plus the last 200 characters of the error, so failing tests that differ are not taken for a loop; a skipped or empty step no longer resets a loop.
- A main restarted at a wake-up keeps its session id; a resumed agent that dies before its session starts is suspended again.
- A queued replacement whose start fails hands its ticket to the user; a replacement never starts on a new branch; a ticket whose agent is not a live session is never stopped by the budget.

## Phase 4: review and merge (2026-10-05)

### Added
- Ticket pipeline (`tickets/flow.ts`): `in_progress` â†’ `delivered` â†’ `in_review` â†’ `approved` â†’ `merged` â†’ `released`, with
  `changes_requested`, `conflict` and `needs_user` on the side; an impossible change is refused with a code. The panel header
  shows it as a chip (`In review`, `Approved`, `Merged`, `Rework 1/2`â€¦), kept after the worktree is gone.
- `report.md` per ticket (`.andromedaconsole/tickets/<name>/`), written by the console without a model: objective, checklist, files
  (from git), tests (the console's own run), documentation, the agents' notes verbatim, the review. Headings follow the
  interface language (`report.*` keys); the squash commit message is English.
- Main tools: `ticket_report` (facts from git and from the tests the console reruns on exactly the delivered commit),
  `send_back_ticket` (the main's own check), `request_review`, `merge_ticket`, `propose_release`.
- Reviewer: a read-only agent (`CONSOLE_ROLE=reviewer`, profile `reviewer`) in a detached checkout of the delivered commit;
  the guard refuses anything that writes (tools, redirects, `rm`, `git add`â€¦). One `review_verdict {pass, notes}` per review.
  A reviewer is started only by `request_review`; its session ends after the verdict.
- Rounds: a failed review (or red tests on the delivered commit) goes back to the author as a message from the main, with
  three new steps appended to its checklist; after two rework rounds the next failure puts a decision in the user's queue
  (send back / approve as it is / leave).
- Merge in series into the project branch through a console-owned worktree (`<repo>.worktrees/.project`): squash by default
  (`project.json` `squash:false` keeps the step commits behind a merge commit; Settings switch). A conflict is never forced: the
  project branch stays put and the console starts the merge in the author's folder so it only edits the files; red tests after the
  merge undo it. After a merge the author session ends (`Finished`), its worktree and local branch go, the remote branch stays.
- Release to `origin/main`: `propose_release` puts one confirmation in the queue (tickets, reports, files, verdicts, tests); only
  after Approve does the console merge into the local `main` (the checkout must be on `main` and clean), rerun the tests and push
  with a one-time token. A pre-push hook in the main repository refuses `main`/`master`/`develop`/`trunk`/`release/*` and tags
  for everyone else (installed only where it cannot replace a project hook or `core.hooksPath`).
- Queue items from the console (`confirm`, `decision`) with their data; new state `finished` for a session ended on purpose.
- Every review, merge and release tool call pushes the new state to the browsers.

### Changed
- `step_done` and `checklist_set` are refused unless the ticket is `in_progress`.
- A reviewer counts against the active-agent limit like any agent.

### Fixed (found by the final review)
- The main can no longer push `origin/main` around the release hook (`--no-verify`, wildcard refspecs, `send-pack`, `core.hooksPath`/alias changes, editing the hooks folder); the read-only guard for reviewers closes more write paths and has fewer false positives.
- A crash during the post-merge tests no longer adopts the merge without tests; a merge and a release proposal no longer race on the `.project` worktree; a deleted `.project` folder no longer blocks merges.
- A failed release keeps edits the user made meanwhile (`reset --keep`), merges the approved commit, and releases every merged ticket; large release payloads shrink the reports instead of being cut, and list commits already on local main.
- Only failed reviews count toward the two rework rounds (conflicts and red merge tests do not); the panel chip reads "Rework N".
- A queued reviewer that fails to start gives the ticket back; a project or agent named `console` can no longer erase console queue items; goal and review notes cannot alter the report structure; reviewer hook folders are removed.

## Phase 3: git worktrees, checklists and guard (2026-10-04)

### Added
- Git worktrees: every agent gets its own worktree (`<repo>.worktrees/<name>`) on its own branch `agent/<project>/<name>`,
  created from the project branch `project/<project>` (made from HEAD the first time); the session starts inside it. A queued agent
  gets its worktree only when its slot arrives. Refused up front with `git.notRepo`, `git.noCommits`, `git.worktreeExists`;
  a failed start leaves no worktree, branch, hook folder, token or process. `git.worktrees: false` keeps the old behaviour.
- Per-worktree `pre-push` hook (through `extensions.worktreeConfig`, script kept in the repository's git dir): only the
  agent's own branch can be pushed; other refs, force, deletes and tags are refused.
- Checklists and tickets: tools `checklist_set`, `step_done`, `report_blocked` (agents only). The console validates the
  mandatory skeleton (study, tests first, steps, validation, documentation), commits each closed step itself
  (`step n/N: title`, trailers `Agent:`, `Ticket:`, `Progetto:`), refuses secrets (`.env`, keys, credentials, configurable
  patterns), runs the project's test command at the validation step with a timeout, and pushes the branch when the last step
  closes, telling the main. Steps close in order, one at a time; the checklist is also saved in `.andromedaconsole/checklist.md`.
- Guard: `POST /v1/guard` judges every `Bash`, `PowerShell`, `Write`, `Edit`, `NotebookEdit`, `Read`, `Grep` and `Glob` call
  with the caller's own role and worktree (git commit/push/force/tag/checkout/merge/reset, config tampering, paths outside the
  worktree and `.git`, secrets, wide deletes, download-and-run). The main has a shorter list. Fails closed for shell and
  writing tools when the console is unreachable. `guard.mode` `enforce` or `shadow` (allow and log); refusals are logged to
  `.andromedaconsole/state/guard.jsonl`.
- Settings dialog: a switch for `agents.bypassPermissions` (with a warning), the guard mode, and the project's test command;
  `PUT /api/config` takes them (and still the language), `PUT /api/project` the test command. Bypass and guard mode apply to
  sessions launched afterwards; running sessions keep what they started with.
- Launch check: 90 s after an agent is launched the console verifies it reported in and took its goal; if not, the main gets a "Launch check:" message (also for agents started from the UI) and the panel shows "Not started yet" until the agent works. Asked for by the architect.
- Build version: the latest tag reachable from `main` of the console's own repository (without the `v`; `package.json` version, now 0.0.1, until a tag exists) is shown over the splash picture and in the tab title (`AndromedaConsole v0.0.1`).
- Start-up splash (the AndromedaConsole picture, `src/ui/splash.jpg`): shown about 2 s, then faded out; it never takes clicks or keys. The page title is the commercial name, AndromedaConsole (the repository and package keep the internal name multiconsole).
- Panel headers show the checklist progress (`3/7`) and two new states, `Studying` (no checklist yet) and `Blocked`.

### Fixed (found by the final review)
- Guard: commands inside if/then/fi, subshells, brace groups, PowerShell blocks and `iex "..."` are judged like any other; `timeout`, `xargs`, `watch` are looked through; a `cd` earlier in the command moves later relative paths; `rmdir/rd/del -Recurse` and piped `Remove-Item` count as recursive deletes.
- Guard: the main's `git push` / `git push origin HEAD` / `--all` are refused while the repository is on a protected branch, and pushing an existing tag by name is a tag push.
- Secrets: `.env.example` and other template files are no longer refused; `credentials.*` narrowed to real credential file types.
- Several agents started at once no longer race on the project branch and the repository config (one lock per repository).
- The agent prompt tells it its worktree has only tracked files (install dependencies first).

### Changed
- The scheduler can start an agent asynchronously (the worktree is made first); the slot is taken at once.
- `git` retries a spawn that fails because the machine is busy (EAGAIN, EPERM, EBUSY) a few times.

## Phase 2: mod and channel (2026-10-04)

### Added
- The console mod (`mod/`, a Claude Code plugin): reports `session.start/end` and `turn.start/complete`, delivers the
  console's messages through the inbox (`$.prompt.submit`), and exposes tools by role: the main gets `spawn_agent`,
  `list_agents` and `ask_user`; agents get `list_agents`, and their native `AskUserQuestion` is intercepted.
- Channel `/v1/*` (events, inbox, ack, tools, question long-polls) with a **per-session token**; the UI token is not valid
  there and session tokens are not valid on `/api` or the WebSockets.
- Agent state derived from mod events (`starting`, `idle`, `working`, `waiting_user`, `queued`, `interrupted`), shown
  in the panel headers; the terminal text never changes it.
- Limit on active agents (default 4 global, 3 per project): beyond it `spawn_agent` answers `queued` with the position and
  the agent starts by itself when a slot frees; lowering the limit stops nobody. One flow serves the UI button and the tool.
- Question queue (drawer, `Alt+Q`, dot on the project tab): answers reach the waiting tool call without moving the focus.
- "Read" panel (`Alt+L` or the Read button): the last 50 answers of each session as sanitised Markdown with normal
  scrolling, filter and copy; kept on disk under `.andromedaconsole/state/reading/`.
- Profiles (`prompts/profiles/*.md`, project > user > shipped), the main's instructions (`prompts/main.md`) and the agent's
  (`prompts/agent.md`) naming the deferred tools by full name.
- Tests: scheduler, registry, questions, reading, markdown sanitiser, `/v1` security, launch, profiles; browser e2e with a
  simulated mod (`test/e2e/phase2.spec.ts`) and a manual contract test with the real Claude Code and the real mod
  (`test/e2e/mod-real-claude.ts`).

### Added (after the review)
- Permission routing: an agent's permission prompt goes to the console queue (tool, command, reason; Allow/Deny) instead of
  waiting unseen in its terminal, and the answer becomes the verdict (mod hook on `tool.check`). The main keeps the native dialog.

### Fixed
- Command injection through `--model` (and any cmd.exe-bound argument) on Windows: models must be plain ids and unsafe characters are refused.
- Shutting the console down no longer starts queued agents; a `turn.complete` with a large answer (up to 2 MiB) is accepted;
  an aborted turn withdraws its question; a queued agent created from the form is no longer shown as an error.
- The mod sets up its poller and tools once per process, does not inject a message whose acknowledgement failed, and a tool-registration
  failure no longer silences its events.

### Changed
- Sessions get `--allowedTools` for the console's own tools, otherwise they stop at a permission prompt without bypass.
- `POST /api/agents` answers `202 { status: "queued", position }` when the agent has to wait.
- Oversized request bodies are drained and refused with 400 instead of resetting the connection.

## Phase 1: console base (2026-10-04)

### Added
- Local console server on `127.0.0.1` (default port 7391) with a per-start token and Host/Origin checks; it owns every
  `claude` process through node-pty (ConPTY) and keeps a per-session scrollback that survives closing the browser tab.
- Browser UI (xterm.js): fixed main on the left, agents stacked on the right (full panels up to four, then bars),
  manual agent launch, status bar, `Alt+1..9` shortcuts. The keyboard focus never moves on its own.
- Activity-name (slug) rules: format, length, generic names, Windows reserved names, uniqueness, accents transliterated.
- Project state under `<repo>/.andromedaconsole/` (`project.json`, `state/agents.json`); the project keeps its original name.
- Internationalisation through `.properties` bundles (`en`, `it`); languages are discovered from the files and can be
  switched at runtime without reloading.
- Build gate `npm run check`: key/placeholder parity between languages, unused and undefined keys, user-facing error
  codes have a text, no literal visible strings or stray `.focus()` in the UI, `tsc`.
- Read-only prerequisite checks (Node >= 22, Git, Claude Code >= 2.1.287, honouring the configured Claude command), a
  skippable first-start wizard, a settings dialog and `console doctor [--json]` with a live security self-test.
- Tests: unit and integration (Vitest), browser acceptance in Edge (`test/e2e/phase1.spec.ts`) and a manual smoke test
  with the real Claude Code (`test/e2e/real-claude-smoke.ts`).

### Changed
- Sessions start without `--dangerously-skip-permissions` until the guard of Phase 3 exists
  (`agents.bypassPermissions`, default `false`).
- `GET /i18n/<lang>` is served without the token (Host check still applies) so a refused token can be explained.

### Fixed
- Closing a ConPTY that runs the real Claude Code blocked Node for about a minute; the process tree is now ended with
  `taskkill /T /F` first.
- Scrollback buffer copied 4 MiB per output chunk and lost terminal modes (bracketed paste, cursor) after wrapping.
- A state update could move the node the user was typing in and drop its focus; panels and bars are now reconciled and
  cached instead of rebuilt.
- Agents saved by an earlier run no longer occupy panel slots; a failed agent creation leaves no orphan process.
- Saving the language never overwrites a hand-edited or unreadable `config.json`.
- Agent creation waits for the startup prerequisite checks instead of proceeding while they are unknown.
- A corrupt `agents.json` or a malformed WebSocket request no longer crashes the server.
- Keys typed behind the first-start wizard no longer reach a hidden terminal; a refused token shows a message instead of
  a blank page; the queue shows n/a and the agent count excludes the main session.

## Phase 0: verification of the Claude Code mods (2026-10-04)

Documentation only, kept under `docs/` (not versioned): `REPORT-VERIFICHE.md` with the outcome of checks V1-V19, the study
of context compaction (S0), notes on the reference projects, and a probe mod. No project B was needed for V1-V8. See
`docs/SPEC.md` section 3.5 for the places where reality differed from the specification.

[Unreleased]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.10...HEAD
[0.0.10]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.9...v0.0.10
[0.0.9]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.8...v0.0.9
[0.0.8]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.7...v0.0.8
[0.0.7]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.6...v0.0.7
[0.0.6]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.5...v0.0.6
[0.0.5]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.4...v0.0.5
[0.0.4]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.3...v0.0.4
[0.0.3]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.2...v0.0.3
[0.0.2]: https://github.com/FedericoMantovani89/andromedaconsole/compare/v0.0.1...v0.0.2
[0.0.1]: https://github.com/FedericoMantovani89/andromedaconsole/releases/tag/v0.0.1
