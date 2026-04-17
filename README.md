# pi-smart-commit

A [pi](https://github.com/mariozechner/pi-coding-agent) extension that replaces the built-in `commit` tool with a version that requires user review before committing.

## Install

```bash
# Global (user-level)
pi install ssh://git@github.com/SunflowerFuchs/pi-smart-commit.git

# Project-level (shared with team via .pi/settings.json)
pi install -l ssh://git@github.com/SunflowerFuchs/pi-smart-commit.git

# Try without installing
pi -e ssh://git@github.com/SunflowerFuchs/pi-smart-commit.git
```

## What's Included

| Type | Name | Description |
|------|------|-------------|
| Tool | `commit` | User-reviewed commits with diff summary and editor prompt |

## Usage

When the agent wants to commit changes, this tool opens an editor with the proposed commit message and a diff summary. The user can:

- **Save** to commit with the (possibly edited) message
- **Escape / close** to skip the commit entirely

Key behaviors:

- **Requires explicit paths** — the agent must specify which files to commit. Staging everything is rejected.
- **Diff summary** — shows a `git diff --stat` alongside the message for context.
- **Co-author trailer** — automatically appends a `Co-authored-by:` line with the model name.
- **Smart staging** — skips re-staging files that are already staged (avoids errors on pre-staged deletions).
- **Non-interactive fallback** — in headless mode (no TUI), commits directly without the editor prompt.

## How It Works

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
npm test
```

## License

MIT
