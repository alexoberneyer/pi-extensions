# Changelog

## Unreleased

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
