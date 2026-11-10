<!--
  Pull request template.

  Title: imperative mood, sentence case, at most 72 characters, no trailing
  period. Say what the change does, not which files it touched, e.g.
  "Make paper trading block real orders on every route".

  Description: keep the summary to one paragraph of three sentences or fewer,
  then add only the sections a reviewer needs to judge the risk. Delete the
  rest and answer Testing with commands actually run.
-->

## Summary

<!-- One paragraph, three sentences at most: what changed and why. -->

## Why

<!-- The problem or user impact this addresses. Link issues, e.g. Closes #123. -->

## What changed

<!--
  Group changes by area and name the entry points a reviewer should start
  from. Note behaviour that is intentionally different now, or write "no
  change when <feature> is off".
-->

## Testing

<!-- Commands run and their real results, not just "tests pass". -->

- [ ] `npm run typecheck`
- [ ] `npm test` — result: <!-- e.g. 434 tests, 431 pass, 0 fail, 3 skipped -->
- [ ] `npm run build`
- [ ] Manually verified: <!-- what, and on which platform/venue -->

## Risk and rollback

<!-- Blast radius, failure modes (fail open or closed?), and how to revert. -->
