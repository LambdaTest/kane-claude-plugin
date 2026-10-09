#!/bin/zsh
# Records the v3 walkthrough: a real Claude Code session in a demo shop project, every kane-cli run real.
# Needs vhs, tmux, ffmpeg, a kane-cli login, and KANE_DEMO_DIR: a git project served at KANE_DEMO_URL with
#   - src/checkout/validate.js refusing a postcode that has a space, and src/search/search.js not trimming its query;
#   - saved tests tagged smoke in .testmuai/tests: checkout_guest (fails on that postcode), search, cart_add;
#   - a requirement store (.context) with designed tests, some of them run.
set -u
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8
cd "$(dirname "$0")"
DEMO_DIR="${KANE_DEMO_DIR:?set KANE_DEMO_DIR to the demo project}"
export KANE_DEMO_DIR
export KANE_DEMO_URL="${KANE_DEMO_URL:-http://localhost:4173}"
PLUGIN="$(cd ../kane-qe && pwd)"
tmux -L kqvid kill-server 2>/dev/null
# A session of its own: the plugin under test, no personal settings, hooks or MCP servers.
tmux -L kqvid -f /dev/null new-session -d -s kq -x 176 -y 49 -c "$DEMO_DIR" "LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 KANE_CLI_USER_AGENT=claude-code CLAUDE_CODE_NO_FLICKER=1 claude --plugin-dir $PLUGIN --setting-sources project,local --strict-mcp-config --model sonnet --append-system-prompt 'This session is a recorded product demo. Answer in one or two short plain sentences. Do exactly what is asked and nothing more. Run each kane-cli command exactly once and never rerun it, whatever its exit code. The only shell commands you may run are kane-cli commands: never ls, grep, cat, git or anything else, and never read the saved output of a command. When you are told to test a change, run the saved test that covers it straight away: kane-cli testmd run .testmuai/tests/<name>_test.md --agent --headless. Never ask follow-up questions, and never mention unit tests, READMEs or documentation.' --allowedTools 'Bash(kane-cli:*)' Edit Read"
tmux -L kqvid set -g status off
tmux -L kqvid set -g focus-events on
tmux -L kqvid set -as terminal-features ',xterm*:RGB'; tmux -L kqvid set -g window-size latest
sleep 10
# A folder Claude Code has not seen asks whether to trust it: the demo project is ours.
if tmux -L kqvid capture-pane -t kq -p | grep -q 'trust this folder'; then tmux -L kqvid send-keys -t kq Down; sleep 0.3; tmux -L kqvid send-keys -t kq Enter; sleep 6; fi
until tmux -L kqvid capture-pane -t kq -p | grep -q ' idle '; do sleep 1; done
vhs tour_v3.tape > vhs-v3.log 2>&1 &
VHS=$!
until tmux -L kqvid list-clients | grep -q .; do sleep 0.2; done
sleep 1.1
python3 tour_driver_v3.py tour-v3.json 2> driver-v3.log
echo "driver exit $?" >> driver-v3.log
# The tape waits for the session to be detached: that ends the recording.
sleep 2
tmux -L kqvid detach-client -s kq 2>/dev/null
wait $VHS 2>/dev/null
echo "vhs exit $?" >> driver-v3.log
python3 cut_tour_v3.py
