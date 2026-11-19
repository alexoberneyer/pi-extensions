# All sessions -> Needs you across projects -> each agent's question.
# Synthetic metadata and idle Pi sessions only. No real history or tmux server.
Output "/tmp/agents-demo.gif"

Set FontSize 18
Set Width 1200
Set Height 640
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 60ms

Hide
Type `eval "$(node docs/demo/agents-world.mjs)"` Enter
Sleep 8s
Type `"$PI_DEMO_LAUNCHER" -ne -ns -nc -np --no-themes --no-mcp --offline --no-session -e "$PI_DEMO_EXTENSION"` Enter
Sleep 6s
Type "/agents" Enter
Sleep 3s
Down
Sleep 1s
Show

Sleep 5s
Tab
Sleep 6s
Down
Sleep 5s
Up
Sleep 5s
