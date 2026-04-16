# pi-smart-commit

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that replaces the built-in `commit` tool with a smarter version that ensures user review before committing.

## What it does

When the LLM wants to commit changes, this extension opens an editor with the proposed commit message and a diff summary. The user can:

- **Save** to commit with the (possibly edited) message
- **Escape / close** to skip the commit entirely

This prevents the LLM from committing without oversight while still letting it drive the workflow.

### Key behaviors

- **Requires explicit paths** — the LLM must specify which files to commit. Staging everything is rejected.
- **Diff summary** — shows a `git diff --stat` alongside the message for context.
- **Co-author trailer** — automatically appends a `Co-authored-by:` line with the model name.
- **Smart staging** — skips re-staging files that are already staged (avoids errors on pre-staged deletions).
- **Non-interactive fallback** — in headless mode (no TUI), commits directly without the editor prompt.

## Install

```bash
pi install git:github.com/SunflowerFuchs/pi-smart-commit
```

Or add it to `.pi/settings.json` for project-level use:

```json
{
  "packages": ["git:github.com/SunflowerFuchs/pi-smart-commit"]
}
```

## Try without installing

```bash
pi -e git:github.com/SunflowerFuchs/pi-smart-commit
```

## How it works

The extension registers a `commit` tool that shadows pi's built-in one. When invoked:

1. Validates that explicit paths were provided.
2. Runs `git status` to confirm there's something to commit.
3. Collects staged and unstaged diff stats for display.
4. Opens a text editor with the proposed message and diff summary.
5. On save, stages the specified files and commits. On cancel, returns a skip message.

In non-interactive contexts (no UI available), it stages and commits directly without the editor step.

## Development

```bash
npm install
npm run typecheck
```
