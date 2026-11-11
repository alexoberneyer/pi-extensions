# Changelog

## Unreleased

- Stop Comms duplicates. Collectors refer to saved items by short refs and see recently closed items. A second mail or Teams ID with the same sender and timestamp folds into the saved item. Collectors can mark cross-source duplicates. Coverage reports merges and ignored refs.
- Rank Comms by time. Items get an optional `dueAt`, anything due within 48 hours ranks as priority 1, and priority 1 now means it costs something if ignored until tomorrow. Bundled triage prepares the next working day's meetings.
- Name what others closed in the Comms finish notice and source coverage.
- Add `bin/comms-refresh.mjs` for an unattended refresh and a weekday launchd schedule.
- Split Comms collector notes into a one-line blocker and a one-line uncertainty. Only a blocker withholds a proposed reply. Refreshes report proposals received and seeded. Add optional `comms.voiceInstructions` and record each draft's origin.
- Decide Comms items from the list: `n` adds a Next reminder and closes the unchanged item, `d` drops it, `u` undoes the latest decision, `/` searches. Items record first-seen, reopen and decision times.
- Reduce Comms to two tabs. Top shows the oldest five items within a priority, and Needs you lists them all. Waiting returns an item after three days. Remove the Drafts, Next, Waiting and All views and `/comms next`. The search box shows only while typing.
- Remove the Comms reply wrapper. Copy the draft and open the original to send it.
- Stop collecting meeting follow-ups and reMarkable captures in Comms. Saved items still load. Their configuration keys are still accepted.
- Make Agents' Needs you view a global attention queue with project context and explicit reasons.
- Keep queue selection stable during refresh and require reselection when the selected session leaves.

## [0.1.0] · 2026-11-06

- Extract all ten extensions and their required helpers into one Pi package.
- Add private configuration, neutral workflows and safe public defaults.
- Make standalone planning, supervision and communication handoffs load bundled approval guards.
- Verify worker guard registration before dispatching work.
- Preserve existing queue/state paths and session-entry identifiers.
- Add isolated, model-free package and configuration tests.
