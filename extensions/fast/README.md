# Speed tiers

Requests `service_tier: "priority"` or, after explicit selection, `"ultrafast"` for supported OpenAI models. It never changes the model, reasoning setting or transport.

On `openai-codex` and `openai` Responses routes, the extension covers GPT-6.2 Sol and Astra, newer numbered releases in those two families, and their dated snapshots. It also keeps GPT-6.1 Sol on both routes and GPT-6 Astra on Codex.

Pi does not expose model speed tier capabilities. The family rule decides when to request a tier, not whether a future model or your account will accept it. Other models and providers are untouched.

## Use

**New sessions default to off.** Set `fast.defaultTier` to `"priority"` in private configuration to restore a deliberate priority-on default. Ultrafast cannot be a configuration default.

| Command        | Action                                                  |
| -------------- | ------------------------------------------------------- |
| `/fast`        | Toggle normal Fast on/off                               |
| `/fast on`     | Request priority, including when leaving Ultra          |
| `/fast off`    | Stop overriding the request tier                        |
| `/fast ultra`  | Explicitly request Ultrafast and show a cost warning    |
| `/fast status` | Show the configured tier and whether Pi will request it |

Choices affect subsequent requests. They persist on the current session branch and follow reload, resume and tree navigation. Existing saved Ultra choices still restore. Off leaves another extension's tier setting untouched.

The footer and `/fast status` show what Pi will request, not proof that the backend honored it. Provider errors are surfaced without silently switching credentials, tiers or billing routes.

## Cost

Priority and Ultrafast can increase usage and charges. Subscription allowances, purchased credits and API billing differ. Verify current provider pricing and account eligibility before enabling them. Pi's displayed cost may underestimate the actual charge.

Sources: [Codex speed](https://developers.openai.com/codex/speed), [Ultrafast API](https://developers.openai.com/api/docs/guides/ultrafast-mode), [API pricing](https://developers.openai.com/api/docs/pricing).

## Verify

```sh
node scripts/test.mjs tests/fast.test.mjs
npm run lint:check
```

Tests intercept HTTP requests and use fake credentials. No model calls occur. They cover both direct reasoning fields and the API-key `configuration_update` representation.
