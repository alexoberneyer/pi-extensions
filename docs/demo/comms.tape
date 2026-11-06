# Renders the README demo GIF. Run from the repository root: vhs docs/demo/comms.tape
# Pi starts in a throwaway agent and config directory, so no real settings,
# sessions, queue or credentials are loaded. Only demo fixtures are shown.
Output "/tmp/comms-demo.gif"

Set FontSize 16
Set Width 1200
Set Height 640
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 80ms

Hide
Type `export PI_CODING_AGENT_DIR=$(mktemp -d) XDG_CONFIG_HOME=$(mktemp -d) && echo '{"quietStartup":true}' > $PI_CODING_AGENT_DIR/settings.json` Enter
Type "pi -ne -ns -nc -np --no-themes --no-mcp --offline --no-session -e ./extensions/comms/index.ts" Enter
Sleep 6s
Type "/comms demo" Enter
Sleep 2s
Show

Sleep 2.5s
Down
Sleep 1.2s
Down
Sleep 1.2s
Up
Sleep 1s
Up
Sleep 1s
Enter
Sleep 3.5s
Enter
Sleep 3s
Escape
Sleep 1s
Escape
Sleep 1.2s
Tab
Sleep 1.5s
Tab
Sleep 1.5s
Tab
Sleep 1.2s
Tab
Sleep 1.5s
Ctrl+G
Sleep 3s
Escape
Sleep 1.5s
Type "rollout"
Sleep 2.5s
