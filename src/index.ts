/**
 * Smart Commit Extension
 *
 * Registers a `commit` tool the LLM can use to commit staged/unstaged changes.
 * Before committing:
 *   1. Shows the proposed commit message in an editor for the user to adjust
 *   2. Save to commit, Escape to skip
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "commit",
		label: "Commit",
		description:
			"Stage and commit specific files to git. You must provide explicit paths — staging all files is not allowed. The user will be able to review, edit, or skip the commit before it happens.",
		promptSnippet: "Stage and commit specific git changes with user-reviewed commit message",
		promptGuidelines: [
			"Use this tool to commit changes instead of running git commit via bash.",
			"Write clear, conventional commit messages. The user can adjust them before committing.",
			"Always specify the exact paths to commit — never omit paths to stage everything. Only include files relevant to your changes.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Proposed commit message" }),
			paths: Type.Array(Type.String(), {
				description: "Specific paths to stage and commit. Must be provided — staging all files is not allowed.",
			}),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Require explicit paths — never stage everything
			if (!params.paths || params.paths.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: "Commit rejected: you must specify explicit paths. Use `git status` or `git diff` to identify the files you changed, then pass only those.",
						},
					],
					details: { skipped: true, reason: "no_paths" },
				};
			}

			// Check if there's anything to commit
			const statusResult = await pi.exec("git", ["status", "--porcelain"], { signal });
			if (statusResult.code !== 0) {
				throw new Error(`Not a git repository or git error: ${statusResult.stderr}`);
			}
			if (!statusResult.stdout.trim()) {
				return {
					content: [{ type: "text", text: "Nothing to commit — working tree clean." }],
					details: { skipped: true, reason: "clean" },
				};
			}

			// Show diff summary for context
			const diffResult = await pi.exec("git", ["diff", "--stat"], { signal });
			const stagedDiff = await pi.exec("git", ["diff", "--cached", "--stat"], { signal });
			const diffSummary = [stagedDiff.stdout.trim(), diffResult.stdout.trim()].filter(Boolean).join("\n");

			if (!ctx.hasUI) {
				// Non-interactive: commit with co-author trailer
				const modelName = ctx.model?.name ?? "unknown model";
				const fullMessage = `${params.message}\n\nCo-authored-by: ${modelName}`;
				await stageAndCommit(fullMessage, params.paths, signal);
				return {
					content: [{ type: "text", text: `Committed: ${params.message}` }],
					details: { committed: true, message: fullMessage },
				};
			}

			// Interactive: let user review and edit the message
			pi.events.emit("smart-commit:review-started", { toolCallId, message: params.message, paths: params.paths });
			const modelName = ctx.model?.name ?? "unknown model";
			const template = `${params.message}\n\nCo-authored-by: ${modelName}`;
			const editedMessage = await ctx.ui.editor(
				`Review commit message (save to commit, Escape to skip):\n${diffSummary ? `\n${diffSummary}` : ""}`,
				template
			);

			if (!editedMessage || !editedMessage.trim()) {
				pi.events.emit("smart-commit:skipped", { toolCallId, reason: "user" });
				return {
					content: [{ type: "text", text: "Commit skipped by user." }],
					details: { skipped: true, reason: "user" },
				};
			}

			const finalMessage = editedMessage.trim();
			await stageAndCommit(finalMessage, params.paths, signal);

			// Get the short hash for the result
			const hashResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { signal });
			const hash = hashResult.stdout.trim();

			pi.events.emit("smart-commit:committed", { toolCallId, hash, message: finalMessage });
			return {
				content: [{ type: "text", text: `Committed ${hash}` }],
				details: { committed: true, hash },
			};
		},
	});

	async function stageAndCommit(
		message: string,
		paths: string[],
		signal: AbortSignal | undefined
	) {
		// Get already-staged paths so we can skip re-staging them.
		// This avoids `git add` failing on pre-staged deletions (e.g. from `git rm`)
		// where the file no longer exists on disk.
		const cachedResult = await pi.exec("git", ["diff", "--cached", "--name-only"], { signal });
		const stagedPaths = new Set(
			cachedResult.code === 0 ? cachedResult.stdout.trim().split("\n").filter(Boolean) : []
		);

		const toStage = paths.filter((p) => !stagedPaths.has(p));

		if (toStage.length > 0) {
			// Use -A to handle both additions and deletions (e.g. files removed from disk)
			const addResult = await pi.exec("git", ["add", "-A", "--", ...toStage], { signal });
			if (addResult.code !== 0) {
				throw new Error(`Failed to stage files: ${addResult.stderr}`);
			}
		}

		// Commit
		const commitResult = await pi.exec("git", ["commit", "-m", message], { signal });
		if (commitResult.code !== 0) {
			throw new Error(`Commit failed: ${commitResult.stderr}`);
		}
	}
}
