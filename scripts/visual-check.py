#!/usr/bin/env python3
"""
Runs the real interactive Pi with pi-subagents and a scripted model in a pseudo-terminal, and
prints what the screen shows while agents work and after they finish. No account is used.

    python3 -m venv /tmp/pyte-venv && /tmp/pyte-venv/bin/pip install pyte
    /tmp/pyte-venv/bin/python scripts/visual-check.py
"""
import json, os, pty, select, shutil, sys, tempfile, time

import pyte

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PI = shutil.which("pi") or sys.exit("pi not found on PATH")
COLS, ROWS = int(os.environ.get("COLS", 130)), int(os.environ.get("ROWS", 40))

home = tempfile.mkdtemp(prefix="psa-visual-")
project = os.path.join(home, "project")
os.makedirs(os.path.join(project, "src"))
for name in ("README.md", "package.json", "src/auth.ts"):
    open(os.path.join(project, name), "w").write("")
json.dump({"faux": {"type": "api_key", "key": "x"}}, open(os.path.join(home, "auth.json"), "w"))
json.dump(
    {"extensions": [os.path.join(ROOT, "test", "fixtures", "visual-model.ts"), os.path.join(ROOT, "src", "index.ts")],
     "defaultProvider": "faux", "defaultModel": "faux-1", "quietStartup": True},
    open(os.path.join(home, "settings.json"), "w"),
)

screen = pyte.Screen(COLS, ROWS)
stream = pyte.ByteStream(screen)
env = {**os.environ, "PI_CODING_AGENT_DIR": home, "TERM": "xterm-256color", "COLUMNS": str(COLS), "LINES": str(ROWS)}
pid, fd = pty.fork()
if pid == 0:
    os.chdir(project)
    os.execvpe(PI, [PI, "--no-session"], env)

import fcntl, struct, termios
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", ROWS, COLS, 0, 0))

def pump(seconds):
    end = time.time() + seconds
    while time.time() < end:
        ready, _, _ = select.select([fd], [], [], 0.05)
        if ready:
            try:
                stream.feed(os.read(fd, 65536))
            except OSError:
                return

def show(title):
    print(f"\n===== {title} =====")
    lines = [line.rstrip() for line in screen.display]
    while lines and not lines[-1]:
        lines.pop()
    print("\n".join(lines))

def type_text(text):
    for char in text:
        os.write(fd, char.encode())
        time.sleep(0.01)

pump(4)
type_text("Check the project with three agents")
os.write(fd, b"\r")
for moment in os.environ.get("MOMENTS", "2,6,14").split(","):
    pump(float(moment) - (0 if moment == "0" else 0))
    show(f"after {moment}s more")
os.write(fd, b"\x03")
pump(0.5)
os.write(fd, b"\x03")
pump(1)
shutil.rmtree(home, ignore_errors=True)
