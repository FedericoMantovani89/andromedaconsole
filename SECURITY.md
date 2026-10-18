# Security

AndromedaConsole runs several Claude Code sessions on your machine, each one a normal `claude` process with your Windows user's rights. This page says what the console does to limit the damage, what it does not do, and what changes when you turn bypass on. Read it before you run agents on a project you cannot afford to damage.

**The console is meant to be used with someone watching.** The guard and the other layers catch mistakes; they are not a security boundary (see "What the guard does not guarantee"), and nothing here replaces your own supervision. Do not leave agents running unattended with bypass on a project you cannot afford to damage.

## The layers

1. **Separate worktree and branch per agent.** Each agent works in `<project>/.andromedaconsole/worktrees/<name>` on `agent/<project>/<name>`.
2. **A pre-push hook in each worktree** refuses every ref except the agent's own branch.
3. **The guard** checks each file and shell tool call against explicit rules before it runs (see below).
4. **Roles.** Only the console and the main merge and push. Reviewer and recovery sessions are read-only.
5. **One confirmation for `main`.** Reaching your real `main` always asks you; the console then merges and pushes with a one-time token that the pre-push hook checks.
6. **A local server only.** It listens on `127.0.0.1`, with a per-start token and Host/Origin checks. Each launched session has its own token and can only call `/v1`; the UI token does not work there. The address the console prints, the app window and a notification click carry a single-use code, not the token: the page swaps it for the token once (only from the console's own origin) and removes it from the address, so an address left in a history or a log opens nothing. The page keeps the token in the tab's `sessionStorage`, which is isolated per address, and the terminal sockets pass it in their query string (never in the visible address). The console sets `NoDefaultCurrentDirectoryInExePath` so a `git.exe` or `claude.cmd` inside a repository is not run in place of the real program.

## What the guard guarantees

For the tools the console routes to it (file tools and shell commands), the guard denies, with a stated reason:

- force pushes, deleting remote or local branches, pushing tags, pushing to protected refs (`main`, `master`, `develop`, `trunk`, `release/*`);
- `--no-verify` on `commit` and `push`, `core.hooksPath` and aliases (also through `git -c`), writing git config, changing remotes (`git remote add`, `set-url`, `remove`...), moving refs (`update-ref`, `symbolic-ref`), `git merge`, `rebase`, `pull`, `reset --hard`, and changing branch;
- git configuration set through the environment (`GIT_CONFIG*`, `GIT_DIR`, `GIT_EXEC_PATH`, `GIT_SSH*` and similar, set before a git command or in the session), git aliases (a subcommand that is not a git command), and the abbreviated forms of the guarded git options (`--no-verif`, `--har`, `-bnew`);
- writing outside the agent's worktree (for shell commands: redirects, `cp`, `mv`, `Set-Content`, `Out-File`, `tee` and similar; the null devices and the system temp folder are the only places outside the worktree an agent may write to), and anything inside `.git/hooks` or the console's own hooks folder;
- writing the project's `.claude/settings.local.json` and anything inside the console's mod folder (rule `path.console-config`): a session that could change them could answer the release approval in the user's place. Only that one settings file is guarded: other settings files, the user's own `~/.claude` and projects that do not use the console are never touched, and a hook placed in `settings.json`, or a `mv`/`rm` of the `.claude` folder, is not caught;
- reading or writing files that look like secrets (`.env`, keys, credentials; the patterns are configurable);
- wide `rm` and download-and-execute;
- for the main, Claude Code's built-in subagents other than read-only lookups.

A release to `origin/main` is approved only by the user, in the console queue or, from the Claude app, by answering the dialog the main shows with its own `AskUserQuestion`. The dialog answer reaches the console through the mod, not through a tool the model can call, and only with a key the console hands to the main's mod once at the start of its session; a "yes" written in chat approves nothing. This relies on the engine recording the user's answer; a model that can change the engine's input (a hook in `settings.json` or in a skill) is outside what the guard stops.

The console never writes the user's global Claude configuration (`~/.claude`, `~/.claude.json`): it only reads the transcripts under `~/.claude/projects` for the budget, and a test (`test/no-global-claude-writes.test.ts`) fails if the sources start writing there.

The rules are written as explicit ids. The guard never denies a command only because it looks odd.

## What the guard does not guarantee

- **It reads command text.** A command that is obfuscated or generated by a script it cannot read (`bash -c "$(...)"`, a script the agent wrote and then runs) can get around it. It protects against mistakes, not against an adversary. This is stated in the code and in the specification on purpose.
- **Shell rules read text.** A script the agent wrote and then runs can write anywhere; hard links and Windows short names (8.3) are not resolved; `sed -i` and `perl -i` are read as writes to the file they name, but other in-place editors are not followed; a command that writes to a folder named by an option the guard does not know (`rsync`, `install`, `tar -C`) is not followed either. A word with wildcards is read as a secret's name when it can expand to one (`.env*`, `.e*`), but one with fewer than two literal characters (`*`, `.*`, `*.*`) or one that opens with a wildcard (`*.json`, `*.pe?`) is let through, so `grep -r foo *` and `cat *.json` work (`*.pem` and the like are still refused: they match their own pattern).
- **Read-only sessions can run project scripts.** `npm run` and `npx` stay allowed so a reviewer can run the tests; a script can write files.
- **Reading tools are fail-open.** When the console cannot be reached the mod refuses the tools that change things and lets Read, Grep and Glob through.
- **Only routed tools are checked.** MCP tools other than the console's own are not sent to the guard, so a budget, loop or quota restriction does not stop them either.
- **Prompt injection is not detected.** Text in a repository file, an issue or a web page can steer an agent. The guard sees the resulting tool calls, not the reason for them.
- **There is no operating-system sandbox.** Agents run as your Windows user. A permitted command can still read anything that user can read (outside the secret patterns) and use the network.
- **The branch protection that matters is on the remote.** A deliberate attack on `origin/main` is only really stopped by branch protection on the remote, which the console cannot set for you.

## Bypass (`agents.bypassPermissions`)

Off by default. When you turn it on in *Options*, agents run Claude Code without permission prompts, so **the guard is the only brake** and nothing reaches the queue for approval. It applies to sessions launched after the change. While it is on, a red chip in the status bar says so at all times. With it off, an agent's tool permission prompts go to the queue drawer.

Use bypass only on a project where the worktree, the pre-push hook and a protected remote are enough for the worst case you can imagine.

## Data that leaves the machine

- Telemetry is off.
- What Claude Code itself sends to Anthropic.
- If you use voice dictation: the audio you record is sent to Groq for transcription. The Groq key is stored on this computer and never shown again.

## Reporting a problem

Please do not open a public issue for a vulnerability. Use GitHub's "Report a vulnerability" on the repository's Security tab if it is offered, or tell the maintainer directly (Federico Mantovani). Include the version (shown in the title bar), the guard rule or tool call involved and, if you can, the output of `npm run console -- doctor --json`.
