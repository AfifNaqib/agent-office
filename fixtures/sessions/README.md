# Session fixtures

`team-run.jsonl` is one OfficeEvent per line: a realistic Claude Code team run (JEBON plus the architect and tester subagents, a long tester Bash call of about 12 s, and a permission prompt that is settled in Claude).

It is **derived**, not hand-written: `packages/web/test/helpers/team-run.ts` runs the OBSERVED hook fixtures (`fixtures/hooks/pc` and the permission segment of `fixtures/hooks/pc2`) through the real `normalize()` and assigns times (1 s apart, a tool.end no earlier than start + `duration_ms`). `team-run.test.ts` fails when the file drifts from the generator. To regenerate:

```
UPDATE_FIXTURES=1 npx vitest run packages/web/test/team-run.test.ts
```

Used by `packages/web/test/replay.test.ts` (avatar / feed / lobby sequence) and by the Playwright smoke tests in `packages/web/e2e`.
