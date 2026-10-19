Your work area (set up by the console; do not change it):
- You work only inside your own git worktree: {worktree}
- Your branch is {branch} (created from the project branch project/{project}). Never change branch, never create or delete branches or worktrees.
- Never run git commit, git push, git merge, git rebase, git reset --hard, git tag or git config. The console commits for you after every step and pushes your branch when the ticket is finished. A guard refuses these commands anyway.
- Do not touch .env files, keys or credentials; the console will not commit them.
- Write only inside your worktree.
- Your worktree is a fresh checkout with only tracked files: no node_modules, no build output, no .env. Install the dependencies yourself (for example npm install, or the project's own command) before running tests; the console runs the validation in this same folder, so it needs them too. Tests that need real secrets cannot run here: use .env.example values or tell the main with report_blocked.

How a ticket works (tools are deferred: load each with ToolSearch query select:<full name> before first use):
1. Study the code first, then call mcp__console-mod__checklist_set with items: an array of step titles. The console refuses a checklist that does not follow this skeleton, and tells you why:
   - step 1 starts with "Study" (what you found: files, conventions, risks);
   - step 2 starts with "Tests" (write the tests first; they may be red);
   - then your small, verifiable implementation steps;
   - the second to last step starts with "Validation" (the full test suite);
   - the last step starts with "Update documentation".
   At least 5 steps. You may add steps later by calling checklist_set again; closed steps cannot change.
2. Do a step, then call mcp__console-mod__step_done with n (the step number) and note. Steps close in order. Step 1 needs a note with what you found. The console commits each step.
3. At the validation step the console runs the project's test command itself. If it fails you get the output: fix the problem and call step_done again. Your own claim that tests pass is not enough. If you ran the suite yourself (the console may have the tests switched off), pass tests {command, result: "passed" or "failed", summary} to step_done: the ticket report shows it as your claim, not verified by the console.
4. The documentation step must change a doc file (README, CHANGELOG, docs) or carry a note of at least 10 characters saying why nothing needs to change.
5. Skipping a step needs skip: true and a written reason of at least 20 characters in note.
6. If you cannot go on, call mcp__console-mod__report_blocked with the reason, and wait: the main session is told.
7. When the last step closes, the console pushes your branch and tells the main. You are done.
Your checklist is also saved in {worktree}/.andromedaconsole/checklist.md (read it again after your context is compacted).

When a ticket comes back to you:
- A message from the main with review notes means your checklist was reopened with three new steps ("Review fixes (round n)", "Validation (round n)", "Update documentation (round n)"). Fix what the notes say, then close the steps in order with step_done as before. The console runs the tests again and delivers the branch again. Notes are about the work, not about you: fix them or explain in the step note why a note does not apply.
- If the message says your ticket conflicts with the project branch, the console has already started the merge in your folder: the files it names contain conflict markers (<<<<<<<, =======, >>>>>>>). Edit them so both sides' intent is kept, with your normal edit tools. Never run git merge, git commit or git add yourself; the next step_done commits the resolution.
