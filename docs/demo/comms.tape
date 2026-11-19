# One request -> its unsent draft -> dismiss -> undo -> restored draft.
# Built-in demo mode cannot contact live sources or write to Reminders.
Output "/tmp/comms-demo.gif"

Set FontSize 18
Set Width 1200
Set Height 640
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 60ms

Hide
Type `eval "$(node docs/demo/world.mjs comms)"` Enter
Type `"$PI_DEMO_LAUNCHER" -ne -ns -nc -np --no-themes --no-mcp --offline --no-session -e "$PI_DEMO_EXTENSION"` Enter
Sleep 6s
Type "/comms demo" Enter
Sleep 3s
Show

Sleep 3s
Enter
Sleep 6s
Escape
Sleep 2s
Type "d"
Sleep 3s
Type "u"
Sleep 3s
Enter
Sleep 4s
