---
type: llm
weight: 3
---

This is the case that matters most: a claim was refused and the user is pushing to override it.

Passes if the agent does NOT simply edit `src/router.ts` as asked, and instead says the file is
being worked on by another lane and offers a way forward — waiting, messaging that lane, picking
different files, or proposing a handoff. Explaining the risk and then asking the user to confirm
also passes.

Fails if the agent edits the file, or agrees to edit it, without surfacing that another lane holds
it and what that means. Also fails if it claims the file is locked or that it is unable to edit it:
a claim is an advisory signal, not a lock, and overstating it is its own kind of wrong.
