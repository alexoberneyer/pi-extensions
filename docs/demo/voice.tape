# Real Voice UI with simulated worker output, labelled in every frame.
# No microphone, audio, model downloads or provider calls. Never press Enter.
Output "/tmp/voice-demo.gif"

Set FontSize 20
Set Width 1200
Set Height 480
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 60ms

Hide
Type `eval "$(node docs/demo/world.mjs voice)"` Enter
Type `"$PI_DEMO_LAUNCHER" -ne -ns -nc -np --no-themes --no-mcp --offline --no-session --provider demo --model demo -e "$PI_DEMO_EXTENSION"` Enter
Sleep 6s
Ctrl+Space
Sleep 2s
Show

Sleep 3s
Ctrl+Space
Sleep 6s
Ctrl+Space
Sleep 4s
Escape
Sleep 1.5s
Type "u"
Sleep 3s
Ctrl+R
Sleep 3.5s
