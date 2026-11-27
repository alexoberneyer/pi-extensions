# One request -> pick an agent -> focused split -> manual paste, unsent.
# Synthetic queue, private tmux, fixture clipboard and mock agent.
Output "/tmp/comms-handoff-demo.gif"

Set FontSize 20
Set Width 1440
Set Height 760
Set Padding 24
Set WindowBar Colorful
Set TypingSpeed 60ms

Hide
Type `node docs/demo/comms-world.mjs` Enter
Sleep 7s
Type "/comms" Enter
Sleep 2s
Enter
Sleep 2s
Show

Sleep 3s
Enter
Sleep 3s
Enter
Sleep 4s
Enter
Sleep 5s
Ctrl+V
Sleep 7s
