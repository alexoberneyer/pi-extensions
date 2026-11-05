"""Read-only probe, sent to dev01 over SSH stdin. Nothing is installed remotely."""
from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import time


def run(args):
    return subprocess.run(args, capture_output=True, text=True, timeout=4, check=True).stdout


def claude_sessions():
    sessions = json.loads(run(["claude", "agents", "--json"]))
    if not isinstance(sessions, list) or any(not isinstance(item, dict) for item in sessions):
        raise ValueError("Unsupported Claude discovery response")
    return sessions


def tmux_panes():
    try:
        output = run(["tmux", "list-panes", "-a", "-F",
                      "#{socket_path}\t#{session_id}\t#{pane_id}\t#{pane_pid}\t#{pane_current_path}\t#{pane_current_command}\t#{session_name}"])
    except subprocess.CalledProcessError as error:
        if "no server running" in error.stderr or "No such file or directory" in error.stderr:
            return []
        raise
    panes = []
    for line in output.splitlines():
        socket, session_id, pane_id, pid, cwd, command, name = line.split("\t", 6)
        panes.append(dict(socket=socket, sessionId=session_id, id=pane_id, pid=int(pid), cwd=cwd,
                          command=command, name=name))
    return panes


def process_parents():
    return dict(tuple(map(int, line.split())) for line in run(["ps", "-eo", "pid=,ppid="]).splitlines())


def pi_records():
    registry = Path(os.environ.get("PI_CODING_AGENT_DIR", str(Path.home() / ".pi/agent"))) / "agents-status"
    records = []
    try:
        paths = list(registry.iterdir())
    except FileNotFoundError:
        return records
    for path in paths:
        if not re.fullmatch(r"[a-f0-9-]+\.json", path.name):
            continue
        try:
            info = path.lstat()
            if not stat.S_ISREG(info.st_mode) or info.st_size > 16384:
                continue
            record = json.loads(path.read_text())
            if not isinstance(record, dict):
                continue
            pid = record.get("pid")
            if not isinstance(pid, int) or isinstance(pid, bool) or pid <= 0:
                continue
            os.kill(pid, 0)  # Check on the owning host, never on the Mac.
            records.append(record)
        except (OSError, ValueError):
            continue
    return records


def collect():
    # Independent probes run concurrently so several four-second timeouts do
    # not exhaust the SSH deadline and hide healthy sources.
    errors = []
    values = {}
    probes = {"claude": claude_sessions, "tmux": tmux_panes,
              "processes": process_parents, "pi": pi_records}
    with ThreadPoolExecutor(max_workers=4) as pool:
        futures = {name: pool.submit(probe) for name, probe in probes.items()}
        for name, future in futures.items():
            try:
                values[name] = future.result()
            except Exception:
                errors.append(name)  # No metadata or subprocess output in errors.
                values[name] = {} if name == "processes" else []
    panes = values["tmux"]
    parents = values["processes"]
    pane_pids = {pane["pid"]: pane["id"] for pane in panes}

    def pane_for(pid):
        visited = set()
        while isinstance(pid, int) and pid > 0 and pid not in visited:
            if pid in pane_pids:
                return pane_pids[pid]
            visited.add(pid)
            pid = parents.get(pid)
        return None

    return dict(version=1, now=int(time.time() * 1000), panes=panes,
                pi=[dict(record=record, pane=pane_for(record.get("pid"))) for record in values["pi"]],
                claude=[dict(record=session, pane=pane_for(session.get("pid"))) for session in values["claude"]],
                errors=errors, claudeConfigDir=os.environ.get("CLAUDE_CONFIG_DIR"))


if __name__ == "__main__":
    try:
        print(json.dumps(collect()))
    except Exception:
        raise SystemExit("dev01 discovery failed. Check tmux, ps and Python on the server.")
