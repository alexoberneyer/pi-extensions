# Changelog

## Unreleased

- Split Comms collector notes into a one-line blocker and a one-line uncertainty. Only a blocker withholds a proposed reply. Refreshes report proposals received and seeded. Add optional `comms.voiceInstructions` and record each draft's origin.
- Decide Comms items from the list: `n` adds a Next reminder and closes the unchanged item, `d` drops it, `/` searches. Needs you shows five eligible items, oldest first within a priority, with backlog counts. Items record first-seen, reopen and decision times.
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
