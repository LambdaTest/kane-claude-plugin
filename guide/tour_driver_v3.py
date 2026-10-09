"""Drives a real Claude Code session (tmux socket kqvid, session kq) through kane-qe in a demo shop project while VHS
records the attached terminal. Every run in it is a real kane-cli run. Writes chapter times and the
waiting stretches (to speed up afterwards) to the JSON file named on the command line.
Clicks are SGR mouse events at the on-screen position of a label."""
import json
import os
import re
import subprocess
import sys
import time

T = ['tmux', '-L', 'kqvid']
START = time.time()
CHAPTERS: list[dict] = []
WAITS: list[list[float]] = []
DEMO = os.environ['KANE_DEMO_DIR']
URL = os.environ.get('KANE_DEMO_URL', 'http://localhost:4173')


def now() -> float:
    return round(time.time() - START, 1)


def sh(args):
    return subprocess.run(T + args, capture_output=True, text=True).stdout


def screen() -> str:
    return sh(['capture-pane', '-t', 'kq', '-p'])


def band() -> str:
    """The band's three rows: from the mascot at column 0, left of the pane if one is open."""
    lines = screen().split('\n')
    for i, line in enumerate(lines):
        if line.startswith(' ▄▀▄▄▀▄'):
            return '\n'.join(l.split('│')[0] for l in lines[i:i + 3])
    return ''


def find(label: str, last: bool = False):
    lines = screen().split('\n')
    hits = [(y, line.index(label)) for y, line in enumerate(lines) if label in line]
    if not hits:
        return None
    y, x = hits[-1] if last else hits[0]
    return x + 1 + min(2, len(label) // 2), y + 1


def click(label: str, last: bool = False, wait: float = 1.5) -> bool:
    pos = find(label, last)
    if not pos:
        print(f'  ! not on screen: {label}', file=sys.stderr)
        return False
    x, y = pos
    for seq in (f'\x1b[<0;{x};{y}M', f'\x1b[<0;{x};{y}m'):
        sh(['send-keys', '-t', 'kq', '-H', *[f'{b:02x}' for b in seq.encode()]])
        time.sleep(0.08)
    time.sleep(wait)
    return True


def click_on_line(anchor: str, label: str, wait: float = 1.5) -> bool:
    """Clicks `label` on the first screen line that also holds `anchor`: one button out of several alike."""
    for y, line in enumerate(screen().split('\n')):
        if anchor in line and label in line:
            x = line.rindex(label) + 1 + min(2, len(label) // 2)
            for seq in (f'\x1b[<0;{x};{y + 1}M', f'\x1b[<0;{x};{y + 1}m'):
                sh(['send-keys', '-t', 'kq', '-H', *[f'{b:02x}' for b in seq.encode()]])
                time.sleep(0.08)
            time.sleep(wait)
            return True
    print(f'  ! not on one line: {anchor} / {label}', file=sys.stderr)
    return False


def keys(*k: str, wait: float = 1.0):
    sh(['send-keys', '-t', 'kq', *k])
    time.sleep(wait)


def type_text(text: str, per_char: float = 0.03, wait: float = 0.6):
    for ch in text:
        sh(['send-keys', '-t', 'kq', '-l', ch])
        time.sleep(per_char)
    time.sleep(wait)


def prompt(text: str, wait: float = 2.0):
    type_text(text)
    keys('Enter', wait=wait)


def wait_for(pattern: str, timeout: float = 300, every: float = 1.0, fast: bool = True, on=None) -> bool:
    """Waits until the band (or `on`) matches; the stretch is marked to be sped up in the cut."""
    on = on or band
    t0 = now()
    end = time.time() + timeout
    ok = False
    while time.time() < end:
        if re.search(pattern, on()):
            ok = True
            break
        time.sleep(every)
    if fast and now() - t0 > 6:
        WAITS.append([t0 + 3, now() - 2])
    if not ok:
        print(f'  ! timed out waiting for {pattern}', file=sys.stderr)
    return ok


def wait_gone(pattern: str, timeout: float = 400, on=None):
    on = on or band
    t0 = now()
    end = time.time() + timeout
    while time.time() < end and re.search(pattern, on()):
        time.sleep(1.5)
    if now() - t0 > 6:
        WAITS.append([t0 + 3, now() - 2])


def chapter(title: str, detail: str):
    CHAPTERS.append({'t': now(), 'title': title, 'detail': detail})
    print(f'[{now():6.1f}s] {title}', file=sys.stderr)


def kane(*args: str):
    """A kane-cli run started outside Claude, in the project: as from another terminal.
    `testrun run` takes no --agent (it streams NDJSON when not on a terminal)."""
    flags = ['--headless'] if args[0] == 'testrun' else ['--agent', '--headless']
    env = {**os.environ, 'LANG': 'en_US.UTF-8', 'LC_ALL': 'en_US.UTF-8', 'KANE_CLI_USER_AGENT': 'claude-code'}
    subprocess.Popen(['kane-cli', *args, *flags], cwd=DEMO, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def turn_done(timeout: float = 240):
    """Waits for Claude's turn to end: its spinner line gone."""
    time.sleep(2)
    wait_gone(r'\(\d+m? ?\d*s? · |esc to interrupt', timeout=timeout, on=screen)
    time.sleep(1.5)


# ── the tour ─────────────────────────────────────────────────────────────

wait_for(r' idle ', timeout=60, fast=False)
chapter('The band', 'Always above the prompt: kane-cli is idle, the last run in this project, and requirement coverage on row 3.')
time.sleep(6)

chapter('Claude runs a test: a card in the chat', 'One line while it runs, with the band following the same step. Then the result, as a card in place of the shell output.')
prompt('Run the guest checkout test and tell me the result in one line: kane-cli testmd run .testmuai/tests/checkout_guest_test.md --agent --headless', wait=3)
wait_for(r' running ', timeout=90, fast=False)
time.sleep(8)
wait_for(r' idle ', timeout=400)
turn_done()
time.sleep(6)

chapter('Why it failed', 'View steps opens the pane on that run: kane’s own verdict, the steps, the failing check. View evidence opens the evidence in the browser.')
click('[ View steps ]', wait=4)
time.sleep(6)
click('[ View evidence ]', wait=5)
time.sleep(2)

chapter('Claude fixes it; the change is untested', 'An edit and no test since: the band warns, and offers the saved test that covers the change.')
prompt('Postcodes with a space, like "SW1A 1AA", must be accepted at checkout. Fix validatePostcode in src/checkout/validate.js with one Edit and change nothing else.', wait=3)
wait_for(r'changed, untested', timeout=240)
turn_done()
time.sleep(4)
click('[ Test this change ]', wait=4)
time.sleep(5)

chapter('Test the change', 'Run it hands the saved test to Claude. This time the card is green, and the warning clears.')
click_on_line('checkout_guest', '[ Run it ]', wait=3)
wait_for(r' running ', timeout=120, fast=False)
time.sleep(8)
wait_for(r' idle ', timeout=500)
turn_done()
time.sleep(6)

chapter('Auto: Claude tests before it finishes', '/kane auto: after an edit Claude is held once at the end of its turn, tests the change itself, and reports.')
prompt('/kane auto', wait=3)
prompt('Search must ignore spaces around the query, so " mug " finds the Stoneware Mug. Fix searchProducts in src/search/search.js with one Edit and change nothing else.', wait=3)
wait_for(r'Claude will test', timeout=240, fast=False)
wait_for(r' running ', timeout=240)
time.sleep(8)
wait_for(r' idle ', timeout=500)
turn_done(timeout=300)
time.sleep(6)
prompt('/kane ask', wait=2)

chapter('A suite', 'kane-cli testrun: one cell per test and done · running · left on the band; one card for the whole suite.')
prompt('Run the smoke suite and give me one line: kane-cli testrun run --tags smoke --parallel 3 --headless', wait=3)
wait_for(r' suite ', timeout=120, fast=False)
time.sleep(8)
wait_for(r' idle ', timeout=600)
turn_done(timeout=300)
time.sleep(6)

chapter('Runs started anywhere', 'Two runs from another terminal in this project: one cell per run, and what is running now. They have no card: nobody ran them in this chat.')
click('[ Runs ]', wait=1)
kane('testmd', 'run', '.testmuai/tests/cart_add_test.md')
kane('testmd', 'run', '.testmuai/tests/search_test.md')
wait_for(r'2 runs', timeout=60, fast=False)
time.sleep(8)
wait_for(r' idle ', timeout=400)
time.sleep(4)

chapter('Assurance', 'Designed and proven coverage from kane-cli cover gaps. A use case opens to what it still owes, with kane-cli’s next command.')
prompt('/kane assurance', wait=4)
time.sleep(5)
click('uc-1', wait=3)
time.sleep(7)
click('‹ Assurance', wait=2)

chapter('History', 'Every finished run in this project, with when, how long, and where it failed.')
click('[ History ]', wait=3)
time.sleep(7)

chapter('End', 'kane-qe: a band that watches kane-cli, a card for every test Claude runs, a pane for runs, assurance and history, and a nudge to test what Claude changed.')
time.sleep(4)
json.dump({'chapters': CHAPTERS, 'waits': WAITS}, open(sys.argv[1] if len(sys.argv) > 1 else 'tour-v3.json', 'w'), indent=2)
print('DONE', now(), file=sys.stderr)
