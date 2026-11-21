# Polish

Polish a draft and put the result in Pi's prompt, unsent. Review it, edit it or press Enter. One request goes to the model on the side. The draft and the result never enter the conversation.

## Use

| Input             | Effect                                                   |
| ----------------- | -------------------------------------------------------- |
| `Ctrl+Alt+P`      | Polish the current draft in place.                       |
| `/polish <text>`  | Polish the text and put the result in the empty prompt.  |
| Escape while busy | Cancel. The draft stays as it was.                       |
| Undo              | One undo restores the original draft. `u` in Vim NORMAL. |

It pairs with [Voice](../voice/README.md): dictate with `Ctrl+Space`, press `Ctrl+Alt+P`, review, send. A bare `/polish` has nothing to polish, because typing the command replaces the draft. Use the shortcut for text already in the prompt.

Failures leave the draft unchanged and say why: unreadable rules, no model, a provider error, an empty or cut-off reply. A second press while a request runs is refused.

## Rules

The rules are a Markdown file used as the system prompt. Polish appends one sentence asking for the polished text alone. The default file is `~/.agents/skills/polish-text/rules.md`, the shared rules of the `polish-text` skill as its installer links them. Any Markdown file works.

Polish reads the file on every request, so edits apply without `/reload`.

## Configuration

```json
{
  "polish": {
    "rulesFile": null,
    "shortcut": "ctrl+alt+p",
    "model": null
  }
}
```

| Setting     | Default                     | Meaning                                                                                            |
| ----------- | --------------------------- | -------------------------------------------------------------------------------------------------- |
| `rulesFile` | `null`, the skill's rules   | Path to the rules. `~` and paths relative to the configuration file work.                          |
| `shortcut`  | `ctrl+alt+p`                | A `ctrl+alt+letter` shortcut, different from `voice.shortcut`.                                     |
| `model`     | `null`, the session's model | `provider/model-id` to always polish with one model, for example a small fast one you have set up. |

Reasoning models are asked for low reasoning, whatever the session's thinking level. Apply configuration changes with `/reload`.

## Privacy and cost

The draft goes to the selected model's provider like any prompt, and the request is billed to the same account. Polish writes no logs or files. Nothing is sent until you press the shortcut or submit `/polish`.
