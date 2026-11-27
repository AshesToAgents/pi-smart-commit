/**
 * Smart Commit Extension
 *
 * Registers a `commit` tool the LLM can use to commit staged/unstaged changes.
 * Before committing:
 *   1. Shows the proposed commit message in an editor for the user to adjust
 *   2. Save to commit, Escape to skip
 *
 * The user can disable the review step for the current session with `/commit-approval allow`.
 * The mode is in-memory only, so it resets whenever extensions reload (new/resumed session).
 */

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export default function (pi: ExtensionAPI) {
	type ApprovalMode = "ask" | "allow";

	// Session-scoped, in-memory only. Intentionally not a tool parameter so the model cannot bypass review.
	let approvalMode: ApprovalMode = "ask";

	const STATUS_KEY = "smart-commit";
	const APPROVAL_ARGS = ["allow", "ask", "status"];
	const describeApprovalMode = (mode: ApprovalMode) =>
		mode === "allow"
			? "allow — commits are made without review this session."
			: "ask — every commit is reviewed before it happens.";

	async function shortHash(repoDir: string, signal: AbortSignal | undefined) {
		const hashResult = await pi.exec("git", ["rev-parse", "--short", "HEAD"], { cwd: repoDir, signal });
		return hashResult.stdout.trim();
	}

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
			"Pass `repo` when committing in a git repository other than the session directory, for example a nested checkout. Paths are then relative to that repository.",
		],
		parameters: Type.Object({
			message: Type.String({ description: "Proposed commit message" }),
			repo: Type.Optional(
				Type.String({
					description:
					"Path to the git repository to commit in, absolute or relative to the session directory. Defaults to the session directory.",
				})
			),
			paths: Type.Array(Type.String(), {
				description:
					"Specific paths to stage and commit, relative to the session directory (or to `repo` when given). Must be provided — staging all files is not allowed.",
			}),
		}),

		async execute(toolCallId, params, signal, onUpdate, ctx) {
			// Resolve the repository directory once; all git commands run there.
			// Paths are resolved against the session directory, which is also the default.
			const sessionCwd = process.cwd();
			const repoDir = resolve(sessionCwd, params.repo?.trim() || ".");
			const isDefaultRepo = repoDir === sessionCwd;

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
			const statusResult = await pi.exec("git", ["status", "--porcelain"], { cwd: repoDir, signal });
			if (statusResult.code !== 0) {
				throw new Error(`Not a git repository (or git error) at ${repoDir}: ${statusResult.stderr}`);
			}
			if (!statusResult.stdout.trim()) {
				return {
					content: [{ type: "text", text: "Nothing to commit — working tree clean." }],
					details: { skipped: true, reason: "clean" },
				};
			}

			// Show diff summary for context
			const diffResult = await pi.exec("git", ["diff", "--stat"], { cwd: repoDir, signal });
			const stagedDiff = await pi.exec("git", ["diff", "--cached", "--stat"], { cwd: repoDir, signal });
			const diffSummary = [stagedDiff.stdout.trim(), diffResult.stdout.trim()].filter(Boolean).join("\n");

			// Review is required only in interactive sessions where the user has not opted out.
			const autoApproved = ctx.hasUI && approvalMode === "allow";
			const needsReview = ctx.hasUI && !autoApproved;

			if (!needsReview) {
				// Non-interactive or user-approved: commit with co-author trailer, no editor
				const modelName = ctx.model?.name ?? "unknown model";
				const fullMessage = `${params.message}\n\nCo-authored-by: ${modelName}`;
				await stageAndCommit(fullMessage, params.paths, repoDir, signal);
				const hash = await shortHash(repoDir, signal);
				const location = isDefaultRepo ? "" : ` in ${repoDir}`;

				pi.events.emit("smart-commit:committed", { toolCallId, hash, message: fullMessage, repo: repoDir, autoApproved });
				return {
					content: [
						{
							type: "text",
							text: `Committed ${hash}${location}${autoApproved ? " (auto-approved, no review)" : ""}: ${params.message}`,
						},
					],
					details: { committed: true, hash, message: fullMessage, repo: repoDir, autoApproved },
				};
			}

			// Interactive: let user review and edit the message
			pi.events.emit("smart-commit:review-started", { toolCallId, message: params.message, paths: params.paths, repo: repoDir });
			const modelName = ctx.model?.name ?? "unknown model";
			const template = `${params.message}\n\nCo-authored-by: ${modelName}`;
			const editedMessage = await ctx.ui.editor(
				`${isDefaultRepo ? "Review commit message" : `Review commit message for ${repoDir}`} (save to commit, Escape to skip):\n${diffSummary ? `\n${diffSummary}` : ""}`,
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
			await stageAndCommit(finalMessage, params.paths, repoDir, signal);

			// Get the short hash for the result
			const hash = await shortHash(repoDir, signal);

			pi.events.emit("smart-commit:committed", { toolCallId, hash, message: finalMessage, repo: repoDir, autoApproved: false });
			return {
				content: [{ type: "text", text: `Committed ${hash}${isDefaultRepo ? "" : ` in ${repoDir}`}` }],
				details: { committed: true, hash, repo: repoDir },
			};
		},
	});

	pi.registerCommand("commit-approval", {
		description: "Toggle commit review for this session: ask (default), allow (commit without review), or status",
		getArgumentCompletions(prefix) {
			const matches = APPROVAL_ARGS.filter((value) => value.startsWith(prefix)).map((value) => ({ value, label: value }));
			return matches.length > 0 ? matches : null;
		},
		async handler(args, ctx) {
			const arg = args.trim();
			if (arg === "status") {
				ctx.ui.notify(`Commit approval: ${describeApprovalMode(approvalMode)}`, "info");
				return;
			}

			const next: ApprovalMode = arg === "" ? (approvalMode === "ask" ? "allow" : "ask") : (arg as ApprovalMode);
			if (next !== "ask" && next !== "allow") {
				ctx.ui.notify(`Unknown commit approval mode '${arg}'. Use ask, allow, or status.`, "error");
				return;
			}

			const previous = approvalMode;
			approvalMode = next;

			// Keep the bypass visible in the footer for as long as it is active.
			ctx.ui.setStatus(
				STATUS_KEY,
				approvalMode === "allow" ? "commits: auto-approved (/commit-approval ask to restore review)" : undefined
			);
			ctx.ui.notify(`Commit approval: ${describeApprovalMode(approvalMode)}`, "info");
			if (previous !== approvalMode) {
				pi.events.emit("smart-commit:approval-changed", { mode: approvalMode, previous });
			}
		},
	});

	async function stageAndCommit(
		message: string,
		paths: string[],
		repoDir: string,
		signal: AbortSignal | undefined
	) {
		// Get already-staged paths so we can skip re-staging them.
		// This avoids `git add` failing on pre-staged deletions (e.g. from `git rm`)
		// where the file no longer exists on disk.
		const cachedResult = await pi.exec("git", ["diff", "--cached", "--name-only"], { cwd: repoDir, signal });
		const stagedPaths = new Set(
			cachedResult.code === 0 ? cachedResult.stdout.trim().split("\n").filter(Boolean) : []
		);

		const toStage = paths.filter((p) => !stagedPaths.has(p));

		if (toStage.length > 0) {
			// Use -A to handle both additions and deletions (e.g. files removed from disk)
			const addResult = await pi.exec("git", ["add", "-A", "--", ...toStage], { cwd: repoDir, signal });
			if (addResult.code !== 0) {
				throw new Error(`Failed to stage files: ${addResult.stderr}`);
			}
		}

		// Build the commit in a temporary index so unrelated staged changes remain in the real index.
		// Copy selected entries from the real index rather than using `git commit --only`, which
		// would commit unstaged working-tree content from partially staged selected files.
		const headResult = await pi.exec("git", ["rev-parse", "--verify", "--quiet", "HEAD"], {
			cwd: repoDir,
			signal,
		});
		const selectedDiff = await pi.exec(
			"git",
			[
				"diff",
				"--cached",
				"--binary",
				"--full-index",
				"--no-ext-diff",
				"--no-textconv",
				"--no-color",
				"--src-prefix=a/",
				"--dst-prefix=b/",
				...(headResult.code === 0 ? ["HEAD"] : []),
				"--",
				...paths,
			],
			{ cwd: repoDir, signal }
		);
		if (selectedDiff.code !== 0) {
			throw new Error(`Failed to prepare selected files: ${selectedDiff.stderr}`);
		}

		const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-smart-commit-"));
		const temporaryIndex = join(temporaryDirectory, "index");
		const selectedPatch = join(temporaryDirectory, "selected.patch");

		try {
			const readTreeResult = await execGitWithIndex(
				headResult.code === 0 ? ["read-tree", "HEAD"] : ["read-tree", "--empty"],
				repoDir,
				temporaryIndex,
				signal
			);
			if (readTreeResult.code !== 0) {
				throw new Error(`Failed to prepare temporary index: ${readTreeResult.stderr}`);
			}

			if (selectedDiff.stdout) {
				await writeFile(selectedPatch, selectedDiff.stdout);
				const applyResult = await execGitWithIndex(
					["apply", "--cached", "--binary", selectedPatch],
					repoDir,
					temporaryIndex,
					signal
				);
				if (applyResult.code !== 0) {
					throw new Error(`Failed to prepare selected files: ${applyResult.stderr}`);
				}
			}

			const commitResult = await execGitWithIndex(["commit", "-m", message], repoDir, temporaryIndex, signal);
			if (commitResult.code !== 0) {
				throw new Error(`Commit failed: ${commitResult.stderr}`);
			}

			// Hooks may update selected entries in the temporary index. Match those entries in the
			// real index to the new commit while leaving unrelated staged entries untouched.
			const resetResult = await pi.exec("git", ["reset", "--quiet", "HEAD", "--", ...paths], {
				cwd: repoDir,
			});
			if (resetResult.code !== 0) {
				throw new Error(`Commit succeeded but failed to refresh the index: ${resetResult.stderr}`);
			}
		} finally {
			await rm(temporaryDirectory, { recursive: true, force: true });
		}
	}
}

function execGitWithIndex(
	args: string[],
	cwd: string,
	indexPath: string,
	signal: AbortSignal | undefined
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolveResult) => {
		execFile(
			"git",
			args,
			{
				cwd,
				encoding: "utf8",
				env: { ...process.env, GIT_INDEX_FILE: indexPath },
				signal,
			},
			(error, stdout, stderr) => {
				resolveResult({
					code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
					stdout,
					stderr: stderr || error?.message || "",
				});
			}
		);
	});
}
