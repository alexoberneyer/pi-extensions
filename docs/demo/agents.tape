# Renders the README Agents GIF. Run from the repository root: vhs docs/demo/agents.tape
# agents-world.mjs builds a throwaway HOME with a fake `claude` and two Pi
# sessions on a private tmux server, so no real sessions or history appear.
Output "/tmp/agents-demo.gif"

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 90ms

Hide
Type `eval "$(node docs/demo/agents-world.mjs)"` Enter
Sleep 8s
Type `pi -ne -ns -nc -np --no-themes --no-mcp --offline --no-session -e "$AGENTS_DEMO_EXTENSION"` Enter
Sleep 6s
Type "/agents" Enter
Sleep 4s
Show

Sleep 3s
Down
Sleep 2s
Down
Sleep 2s
Down
Sleep 2s
Up
Sleep 0.6s
Up
Sleep 0.6s
Up
Sleep 1s
Type "tests"
Sleep 2.5s
Escape
Sleep 1.5s
Tab
Sleep 2s
Tab
Sleep 2s
Tab
Sleep 1.5s
Shift+Tab
Sleep 0.6s
Shift+Tab
Sleep 0.6s
Shift+Tab
Sleep 1.5s
Ctrl+O
Sleep 2s
Ctrl+O
Sleep 2s
Ctrl+O
Sleep 0.4s
Ctrl+O
Sleep 0.4s
Ctrl+O
Sleep 1.5s
Ctrl+P
Sleep 2.5s
Ctrl+P
Sleep 2s
