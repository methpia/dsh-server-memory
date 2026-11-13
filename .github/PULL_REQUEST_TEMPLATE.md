## What changed

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The reason, not a restatement of the diff. Link an issue if there is one. -->

## Checks

- [ ] `python3 -m unittest discover -s server/tests` passes
- [ ] `cd plugin && node --test --experimental-test-isolation=none "tests/*.test.js"` passes
- [ ] `node scripts/smoke.mjs --url <running service> --token-file <token>` passes (if the API changed)
- [ ] No new Python dependency was added
- [ ] No code path writes a full session transcript into the database
- [ ] `git status` shows no `.runtime/`, `*.db` or token file

## Notes for reviewers

<!-- Trade-offs, follow-ups, anything you intentionally left out. -->
