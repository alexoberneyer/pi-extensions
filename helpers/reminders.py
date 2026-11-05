"""Apple Reminders backend, driven through JXA (`osascript -l JavaScript`).

Uses the local macOS app without cloud credentials. The terminal needs
Automation permission for Reminders (see PERMISSION_HELP below).

Values are injected into the script as JSON literals rather than passed as argv,
so a list name or reminder id can never break out of the script text.

Reminders' AppleScript interface is slow per-property, so every read uses the
bulk accessors (`reminders.id()`, `reminders.name()`, ...) which return whole
arrays in one round trip instead of one call per reminder.
"""

import json
import subprocess

PERMISSION_HELP = """Reminders access is not granted to this terminal.

Grant it once:
  System Settings -> Privacy & Security -> Automation
  -> [your terminal app] -> enable Reminders

If the terminal is not listed yet, run any Reminders command once and macOS
will prompt. Then re-run this."""


class RemindersError(RuntimeError):
    pass


def _jxa(body: str, **values) -> object:
    """Run a JXA snippet whose last expression is JSON, and parse the result.

    `values` become JSON-literal consts at the top of the script -- injection
    safe, and far less error-prone than shell/AppleScript string quoting.
    """
    header = "".join(f"const {k} = {json.dumps(v)};\n" for k, v in values.items())
    script = header + body

    try:
        proc = subprocess.run(
            ["osascript", "-l", "JavaScript", "-e", script],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except subprocess.SubprocessError as exc:
        raise RemindersError(f"osascript failed: {exc}") from exc

    if proc.returncode != 0:
        err = proc.stderr.strip()
        if "-1743" in err or "Not authorized" in err:
            raise SystemExit(PERMISSION_HELP)
        if "NOLIST" in err:
            raise SystemExit(
                f"No Reminders list named {values.get('LIST')!r}.\n"
                "Create it in the Reminders app, or pass --list."
            )
        raise RemindersError(err or "osascript returned no output")

    out = proc.stdout.strip()
    return json.loads(out) if out else None


# JXA fragment shared by every call: resolve the list or fail loudly.
_LIST = """
const app = Application('Reminders');
const matches = app.lists.whose({name: LIST})();
if (matches.length === 0) { throw new Error('NOLIST'); }
const list = matches[0];
"""

# Bulk-read every reminder. `whose` is applied by the caller.
_READ = """
// Local calendar date, NOT toISOString(). A reminder due 01:00 on the 2nd is
// 23:00Z on the 1st, and ISO would file it a day early -- the date you see in
// the Reminders app is the local one, so that is the one to keep.
function pad(n) { return (n < 10 ? '0' : '') + n; }

function localDate(d) {
  if (!d) { return null; }
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

function localStamp(d) {
  if (!d) { return null; }
  return localDate(d) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

let ids = [], names = [], bodies = [], dues = [], alarms = [], done = [];
try {
  ids = target.id();
  names = target.name();
  bodies = target.body();
  dues = target.dueDate();
  // remindMeDate is the field that means "this will notify me". It is the only
  // reliable timed/untimed discriminator: alldayDueDate is set to midnight even
  // on a reminder that has an explicit time, so it cannot tell them apart.
  alarms = target.remindMeDate();
  done = target.completed();
} catch (e) {
  // An empty list makes the bulk accessors throw rather than return [].
}
const out = ids.map(function (id, i) {
  return {
    id: id,
    title: names[i] || '',
    notes: bodies[i] || '',
    due: localDate(dues[i]),
    remind_at: localStamp(alarms[i]),
    status: done[i] ? 'completed' : 'needsAction',
  };
});
JSON.stringify(out);
"""


class RemindersBackend:
    """Local list reads and explicitly requested reminder mutations."""

    def open_tasks(self, list_name: str) -> list[dict]:
        """Reminders that are not completed, in list order."""
        return _jxa(
            _LIST + "const target = list.reminders.whose({completed: false});" + _READ,
            LIST=list_name,
        )

    def index(self, list_name: str) -> dict[str, dict]:
        """Every reminder, completed or not, keyed by id."""
        items = _jxa(_LIST + "const target = list.reminders;" + _READ, LIST=list_name)
        return {t["id"]: t for t in items}

    def _set_completed(self, list_name: str, task_id: str, value: bool) -> None:
        _jxa(
            _LIST
            + """
const ids = list.reminders.id();
const i = ids.indexOf(ID);
if (i < 0) { throw new Error('NOTFOUND'); }
list.reminders[i].completed = VALUE;
JSON.stringify(true);
""",
            LIST=list_name,
            ID=task_id,
            VALUE=value,
        )

    def complete(self, list_name: str, task_id: str) -> None:
        self._set_completed(list_name, task_id, True)

    def restore(self, list_name: str, task_id: str) -> None:
        """Un-complete, so it shows up on the phone again."""
        self._set_completed(list_name, task_id, False)

    def add(self, list_name: str, title: str, notes: str = "") -> str:
        """Create an untimed reminder at the end of the list. Returns its id."""
        return _jxa(
            _LIST
            + """
const r = app.Reminder({name: TITLE, body: NOTES});
list.reminders.push(r);
JSON.stringify(r.id());
""",
            LIST=list_name,
            TITLE=title,
            NOTES=notes,
        )

    def delete(self, list_name: str, task_id: str) -> None:
        _jxa(
            _LIST
            + """
const ids = list.reminders.id();
const i = ids.indexOf(ID);
if (i < 0) { throw new Error('NOTFOUND'); }
app.delete(list.reminders[i]);
JSON.stringify(true);
""",
            LIST=list_name,
            ID=task_id,
        )


def build_backend() -> RemindersBackend:
    return RemindersBackend()
