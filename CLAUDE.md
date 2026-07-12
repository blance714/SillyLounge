# CLAUDE.md — working principles for this project

## Fix at the root, never take shortcuts

When solving a bug, **find and fix the root cause — do NOT take the fast/cheap
band-aid route.** This is a side project; speed is explicitly NOT a goal. Quality,
correctness, and learning are.

- Don't suppress, mask, or paper over a symptom (e.g. hiding a flashing row,
  debouncing around a race) when the real cause is a structural/design issue.
  Diagnose the actual mechanism first, then fix *that*.
- A patch that "works most of the time" or relies on timing luck is not a fix.
- Prefer the principled architectural solution over the expedient one, even when
  it's more work. Introducing a better architecture or a proven library is
  welcome when it removes a whole class of bugs (and is a chance to learn).
- If you catch yourself reaching for a quick mitigation, stop and name the root
  cause out loud first; only patch if the root fix is genuinely out of scope, and
  say so explicitly.

## Project terminology

- In Chinese project prose, use **亲节点** and **亲提交**. Do not use
  “父节点” or “父提交”.
- Preserve upstream identifiers and literal quotations such as `parent`, API
  field names, command output, and external error messages when exact spelling
  matters; explain them using the project terminology around the quotation.
