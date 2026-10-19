# kane-qe v2: watch kane-cli from Claude Code

A Claude Code mod that shows what kane-cli (KaneAI) is doing, without being asked. Claude runs kane-cli; the mod reads what kane-cli leaves on disk and shows it. The mod never starts a test by itself.

## Install

```
/plugin install kane-qe --marketplace LambdaTest/kane-claude-plugin
```

It needs kane-cli installed and logged in (`npm install -g @testmuai/kane-cli`, then `kane-cli login --oauth`).

## What you see

| Surface | What it shows |
|---|---|
| **Band** (three rows above the prompt, under one blank row, the kane mascot on the left) | Row 1: `idle` with this session's passed/failed counts (each test once, by its latest result, so a failure that has since passed is gone), `running` with the test's name and time, `N runs` with one coloured cell per run, or `suite` with one cell per test and `5 of 12 tests done · 3 running · 4 left`. A suite sent to the remote grid (`testrun run --remote`) reads `12 tests on the grid · sent 2m 05s ago` until the job ends, because the grid reports its tests only then. Row 2: the step a single run is on, behind a spinner; `now` and each running test with its time, behind the same spinner; a failure the moment it happens (`✗ checkout_guest failed on Fill the shipping address`); `last run ✓ login · 2h ago` from earlier sessions; or `⚠ 2 files changed, untested [ Test this change ]`. Row 3: assurance, `47% proven · 4 use cases`, or `not set up [ Set up now ]`. The mascot's eyes move while a test runs (one step every 120 ms), and the spinner steps with them. |
| **Pane** (`/kane` or `[ Open ]`) | **Runs**: a card per run (failed first, red border), or one row per test for a suite. Press a name for its steps: done steps with a tick and time, the current or failing step expanded to *think*, *act* and each *check*, the failure's *why*, *kind* (kane's category, severity, confidence) and *where*, then *Open evidence*. For a remote suite the pane names the grid, the job and its link. **Assurance**: designed and proven bars, failing/blocked counts and when it last ran, a card per use case with what it still owes, or a card that offers to set it up with Claude. Press a use case for its detail: its title and risk, then each thing it owes under *To design* and *To run*, with kane-cli's reason and its own next command; *Close these gaps with Claude* hands that to Claude. **History**: the finished runs kept for this project, newest first, each with when it ran, how long it took, and where it failed or a suite's passed/failed counts. |
| **Card in the chat** | A kane-cli test Claude runs (`run`, `testmd run`, `testrun run`) is drawn in the conversation as a card, in place of its shell row: one line while it runs (a spinner, name, time, step), then a bordered card with the mascot, the result (`✓ passed · 41s · 12.4 credits`), a failure's step and kane's reason on one line (its *kind* is in the pane), or a suite's cells, counts and up to three failures. A suite that ended passed with every test passed says `✓ all 3 passed` in place of its counts. The card is kept short, with no blank rows, and a failed test's card is as short as a passed one (three rows with buttons): every finished card closes with a *Verified with KaneAI* badge on its last row, to the right of the buttons: a solid chip in kane's colour behind a shield (`⛨`). The border is red when the run failed, green when it passed. **View steps** / **View tests** opens the pane on that run; **View evidence** opens the run's evidence pack in kane-cli's viewer in the browser, in one click. Where the chat is printed text (the terminal outside fullscreen) the card ends with the evidence path instead of buttons. A command that never became a run (kane-cli refused or failed to start) keeps its normal row, and so does every other command. The chat folds shell calls into one count line; a group holding one run stays folded with the run's card beneath that line, so the other calls are not spread out. A group holding several runs, or a run call the host gives no id, is unfolded so each row draws its own card. |
| **After Claude changes code** | When a turn ends with edited files (by the edit tools or a shell command; not docs, hidden tool folders or git-ignored files) and no kane-cli run since, the band warns and offers *Test this change*. The card lists the changed files and saved tests that mention the same feature, with their last result and *Run it*; equal matches put the test that last failed first, then the one run most recently. Only when none does, Claude drafts an objective from the diff (also on *Draft a new objective*); *Run the objective* hands it to Claude with the app's start URL. A kane-cli run that starts after the last edit clears the warning. |

## Settings

`/config` → kane-qe:

| Setting | Default | |
|---|---|---|
| After Claude changes code | `offer` | `offer`: the band offers a test. `auto`: Claude is held once at the end of its turn to test the change. `off`: nothing |
| kane-cli command | `kane-cli` | Used only for `kane-cli cover gaps --json` (read-only, no credits) |

`/kane auto`, `/kane ask`, `/kane off` change it for this session. Colours follow Claude Code's theme (the design's palette on dark, a darker one on light), and every band row fits its width: names are cut first, then items drop from the right, `[ Open ]` stays. `/kane assurance` opens the Assurance tab and `/kane history` the History tab.

## How it reads kane-cli

- Live runs: `~/.testmuai/kaneai/sessions/active/<pid>.json`, once a second; only runs whose `cwd` is inside this project, and only while the pid is alive.
- Each run's `events.ndjson` (and each suite member's own stream, read once more when it ends), from where it last stopped. Structured lines only, never kane-cli's human output. Unknown events and fields are skipped; lines that are not JSON are skipped and counted; a stream with a newer wire version shows its name and time and says so.
- Names come from the command Claude ran (`kane-cli testmd run login_test.md` → `login_test.md`); for a run nobody started in this chat, from its own process's command line (`ps -o args= -p <pid>`); then kane-cli's own `recording_state`, then the objective.
- Failure facts come from `run_end.verdict` (root cause, category, severity, confidence), never guessed.
- A run's card is its shell call's row: the mod notes the call's id when Claude runs a kane-cli test and keeps it on the run that starts.
- Evidence: kane-cli seals a run's pack as it exits, at `<session dir>/evidence/<id>.evidence`; a suite's is `<project>/.testmuai/evidence/<execution id>.evidence`. The mod looks for it for half a minute after the run ends. *View evidence* starts `kane-cli evidence serve <pack>`, reads the viewer link it prints and opens it (`open`, else `xdg-open`); the viewer serves until the session ends, and a second press reuses it. With no pack or no viewer, Claude is asked to open it instead.
- A remote suite: `remote_start` (the grid) and `remote_dispatched` (the job and its link) while the job runs; its tests arrive after the fact, stamped with the grid's own time. A job that fails before any test reports (`remote_error`) gives every test that reason.
- Assurance: `kane-cli cover gaps --json` at session start and after each run, when the project has a `.context` folder. Each use case keeps up to 20 of its `pending` rows (title, why, risk, stage, `ready_command`) for its detail view; its counts cover them all.
- The last 30 results per project are kept in the mod's store (`recentByProject`, apart from v1's `history`) for `last run …` and the History tab. Entries kept by earlier versions (label, status and time only) still read.

## What this mod runs and sends

The mod makes no network requests of its own. It reads files on this machine, starts the local programs below, and hands text to Claude in this conversation.

**Programs it starts** (each with a fixed argument list; `<pid>`, `<path>` and `<url>` are filled in from kane-cli's own files):

| Command | When | Why |
|---|---|---|
| `kill -0 <pid>` | once a second while a run is live | to tell whether a kane-cli run is still going |
| `ps -o args= -p <pid>` | once per run nobody started in this chat | to name the run from its command line |
| `tail -c +<offset> <events file>` | while a run is live | to read only the new lines of kane-cli's event stream |
| `git check-ignore -q <path>` | after Claude edits a file | to skip git-ignored files when deciding what changed |
| `git diff -- <changed files>` | only when you ask for a drafted objective | to show Claude the change it should test |
| `kane-cli cover gaps --json` | at session start and after each run, when the project has a `.context` folder | to read assurance coverage (read-only, no credits) |
| `kane-cli evidence serve <pack>` | only when you press *View evidence* | kane-cli's own evidence viewer, served on this machine |
| `open <url>`, else `xdg-open <url>` | right after that | to open the viewer's local link in your browser |

`kane-cli` here is the *kane-cli command* setting (default `kane-cli`), split on spaces. What kane-cli itself does is kane-cli's, as its own documentation describes.

**What it reads**: kane-cli's live-run pointers and event streams under `~/.testmuai/kaneai/sessions/`, the project's `.testmuai/` folder (saved tests, variables, evidence packs), Claude Code's theme setting, `HOME`, and its own pictures in `assets/mascot/`. It keeps the last 30 results per project in its own store, on this machine.

**What it hands to Claude**, and so to the model this Claude Code session uses:

- **A drafted objective**: when you press *Draft a new objective*, the list of changed files and their `git diff` (up to 8,000 characters) go to Claude in a side request, which replies with one test objective.
- **Prompts it submits on a button press**, each shown in the conversation as your message:
  - *Run it*: `Test my last change with the saved kane-cli test: kane-cli testmd run .testmuai/tests/<test> … --agent --headless. Then report the result.`
  - *Run the objective*: `Test my last change with kane-cli: kane-cli run "<objective>" … --agent --headless. Then report the result.`
  - *Close these gaps with Claude*: `Close the assurance gaps of kane-cli use case <id> …`
  - *Set it up with Claude*: `Set up kane-cli assurance for this project …`
  - *View evidence*, when no viewer could be started: `Open the evidence for the kane-cli run in <path>.`
- **In auto mode only**: when Claude's turn ends with untested changes, the mod asks Claude once to test them, naming the changed files and the saved tests that match.

**What it never does**: start a test by itself, change Claude Code's settings or permissions, or answer a permission prompt. It hooks no setting: it reads Claude Code's theme every two seconds to match its colours.

## Develop

```
claude plugin validate kane-qe
claude plugin test kane-qe          # adapter table, band states at 60/80/120 columns, recorded streams, pane and band on terminal and desktop, change tracking, stale pointers, assurance and use-case detail, remote suites, history, the card in the chat
node kane-qe/tests/fixtures/build.mjs   # after adding a recorded stream to tests/fixtures/*.ndjson
```

Layout: `hooks/adapter.ts` (wire line → internal event, the only place raw field names appear), `hooks/model.ts` (pure: events → runs, runs → band rows and pane text), `hooks/sources.ts` (pointer and byte-offset helpers), `hooks/register.tsx` (polling, hooks and drawing), `hooks/mascot.ts` (the mascot, as designed but for its speed), `assets/mascot/*.png` (the mascot's picture frames, read at session start for surfaces that show images).

v1 (the cockpit that starts runs, with Insights, Tests, History and Setup tabs and model tools) is on the `main` branch.
