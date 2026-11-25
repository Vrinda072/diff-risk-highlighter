# Labelling guide

Read the title and description, then every hunk, before marking anything.

**Contains the fix** (bug-fix PRs only): the hunk changes behaviour in a way
that is needed for the bug to be gone. If reverting only this hunk would bring
the bug back, mark it. A fix can span several hunks. Do not mark tests,
documentation, changelogs, renames or clean-up that travelled with the fix.

**Needs close review** (every PR): you would not approve the PR without reading
this hunk carefully, because a mistake here could plausibly cause a bug,
security problem or broken contract. Fix hunks count automatically.

**This PR is a…** correct the guess if the title misled it. Choose "can't
judge" if you cannot tell what the change is meant to do; it is left out of the
numbers.

- Decide from the code, not from how alarming the words look.
- Do not install or run the extension on these PRs.
- Budget about 5 minutes per PR; the pilot is about an hour.
- Second labeller: work alone and do not compare until both have exported.
