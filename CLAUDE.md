# CLAUDE.md

Operating guide for working in this repo. These reflect how the maintainer wants
work done — follow them by default.

## Working agreement: commits and review

- **Do the work, but do not commit.** Leave all changes in the working tree.
- **Staging is the maintainer's approval.** They run `git add` on files once they've
  reviewed and accepted them. Treat staged files as locked: do not re-edit, unstage,
  revert, stash, or commit them, and never run `git add`/`commit`/`reset`/`checkout --`
  on their behalf unless explicitly asked.
- **No automatic version bumps** and no per-task commit churn.
- **Work in small units and stop for review** between them, rather than running a
  long batch end to end.

## Comments and code style

- **Terse. Business rationale only.** A comment should explain a non-obvious domain
  reason ("users are deactivated, never deleted"), not restate what the code does.
- **No process references in code** — no phase numbers, decision/ADR IDs, or ticket
  numbers. Those live in planning docs, not the codebase.
- **Let the code self-document.** Prefer clear names and structure over commentary;
  delete a comment the code already makes obvious.

## Database and migrations

- **Prefer a clean schema baseline over create-then-drop churn.** Don't create
  something a later step immediately drops; build the schema you actually want.
- **Order tables by dependency.** Create a referenced (parent) table before the
  tables that reference it, so foreign keys are declared inline rather than patched
  in afterward with `ALTER TABLE`.
- **Least-privilege roles.** A schema-owner role owns the database and objects and is
  what migrations run as; the application role receives only explicit, per-table
  grants. Enforce immutable / append-only tables by withholding `UPDATE`/`DELETE`
  rather than relying on application code alone.
- **Share connection config across roles.** Owner and app connections target the same
  host/port/database; only the credentials differ — don't introduce parallel,
  divergeable copies of the same value.

## General approach

- **Optimize for correctness, not simplicity-by-omission.** If a simpler option
  sacrifices correctness, say so and recommend the correct one.
- **Surface downstream consequences.** When a change creates work or a constraint for
  a later step, call it out explicitly instead of letting it surface later.
- **Confirm before consequential or destructive actions**, and **verify** (type-check,
  tests) before claiming something is done.
