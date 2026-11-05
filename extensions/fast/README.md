# Speed tiers

Requests `service_tier: "priority"` or, after explicit selection, `"ultrafast"` for supported OpenAI models. It never changes the model, reasoning setting or transport.

Supported model/API combinations currently match the existing implementation:

- `openai-codex/gpt-6-astra`
- `openai/gpt-6.1-sol` with the Responses API
- `openai-codex/gpt-6.1-sol`

Other models and providers are untouched. Availability depends on the provider and account.

## Use

**New sessions default to off.** Set `fast.defaultTier` to `"priority"` in private configuration to restore a deliberate priority-on default. Ultrafast cannot be a configuration default.

| Command        | Action                                               |
| -------------- | ---------------------------------------------------- |
| `/fast`        | Toggle normal Fast on/off                            |
| `/fast on`     | Request priority, including when leaving Ultra       |
| `/fast off`    | Stop overriding the request tier                     |
| `/fast ultra`  | Explicitly request Ultrafast and show a cost warning |
| `/fast status` | Inspect without changing anything                    |

Choices affect subsequent requests. They persist on the current session branch and follow reload, resume and tree navigation. Existing saved Ultra choices still restore. Off leaves another extension's tier setting untouched.

The footer reports a requested tier, not proof that the backend honored it. Provider errors are surfaced without silently switching credentials, tiers or billing routes.

## Cost

Priority and Ultrafast can increase usage and charges. Subscription allowances, purchased credits and API billing differ. Verify current provider pricing and account eligibility before enabling them. Pi's displayed cost may underestimate the actual charge.

Sources: [Codex speed](https://developers.openai.com/codex/speed), [Ultrafast API](https://developers.openai.com/api/docs/guides/ultrafast-mode), [API pricing](https://developers.openai.com/api/docs/pricing).

## Verify

```sh
node scripts/test.mjs tests/fast.test.mjs
npm run lint:check
```

Tests intercept HTTP requests and use fake credentials. No model calls occur. They cover both direct reasoning fields and Pi 1.5's API-key configuration-update representation.
