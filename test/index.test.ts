import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import smartCommit from "../src/index.ts";

const execFileAsync = promisify(execFile);

async function git(repo: string, ...args: string[]) {
	return execFileAsync("git", args, { cwd: repo, encoding: "utf8" });
}

async function createEmptyRepository() {
	const repo = await mkdtemp(join(tmpdir(), "pi-smart-commit-"));
	await git(repo, "init", "--quiet");
	await git(repo, "config", "user.name", "Test User");
	await git(repo, "config", "user.email", "test@example.com");
	return repo;
}

async function createRepository() {
	const repo = await createEmptyRepository();
	await writeFile(join(repo, "selected.txt"), "base\n");
	await writeFile(join(repo, "unrelated.txt"), "base\n");
	await git(repo, "add", ".");
	await git(repo, "commit", "--quiet", "-m", "Initial commit");
	return repo;
}

function registerCommitTool() {
	let tool: any;
	const pi = {
		registerTool(registeredTool: any) {
			tool = registeredTool;
		},
		exec: async (command: string, args: string[], options: { cwd?: string }) => {
			try {
				const result = await execFileAsync(command, args, {
					cwd: options.cwd,
					encoding: "utf8",
				});
				return { code: 0, stdout: result.stdout, stderr: result.stderr };
			} catch (error: any) {
				return {
					code: error.code ?? 1,
					stdout: error.stdout ?? "",
					stderr: error.stderr ?? error.message,
				};
			}
		},
		events: { emit() {} },
	};

	smartCommit(pi as any);
	return tool;
}

test("commits only selected paths while preserving unrelated staged changes", async () => {
	const repo = await createRepository();

	try {
		await writeFile(join(repo, "selected.txt"), "selected change\n");
		await writeFile(join(repo, "unrelated.txt"), "staged unrelated change\n");
		await git(repo, "add", "unrelated.txt");
		await writeFile(join(repo, "unrelated.txt"), "unstaged unrelated change\n");

		const tool = registerCommitTool();
		await tool.execute(
			"test-call",
			{ message: "Commit selected file", paths: ["selected.txt"], repo },
			undefined,
			undefined,
			{ hasUI: false, model: { name: "test-model" } },
		);

		const committedPaths = (await git(repo, "show", "--format=", "--name-only", "HEAD")).stdout
			.trim()
			.split("\n");
		assert.deepEqual(committedPaths, ["selected.txt"]);
		assert.equal((await git(repo, "show", ":unrelated.txt")).stdout, "staged unrelated change\n");
		assert.equal(await readFile(join(repo, "unrelated.txt"), "utf8"), "unstaged unrelated change\n");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("commits the staged snapshot of a partially staged selected file", async () => {
	const repo = await createRepository();

	try {
		await writeFile(join(repo, "selected.txt"), "staged selected change\n");
		await git(repo, "add", "selected.txt");
		await writeFile(join(repo, "selected.txt"), "unstaged selected change\n");

		const tool = registerCommitTool();
		await tool.execute(
			"test-call",
			{ message: "Commit selected file", paths: ["selected.txt"], repo },
			undefined,
			undefined,
			{ hasUI: false, model: { name: "test-model" } },
		);

		assert.equal((await git(repo, "show", "HEAD:selected.txt")).stdout, "staged selected change\n");
		assert.equal(await readFile(join(repo, "selected.txt"), "utf8"), "unstaged selected change\n");
		assert.equal((await git(repo, "status", "--short")).stdout.trim(), "M selected.txt");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("isolates selected paths when Git diff formatting is customized", async () => {
	const repo = await createRepository();

	try {
		await git(repo, "config", "diff.noprefix", "true");
		await git(repo, "config", "color.ui", "always");
		await writeFile(join(repo, "selected.txt"), "selected change\n");
		await writeFile(join(repo, "unrelated.txt"), "unrelated change\n");
		await git(repo, "add", "unrelated.txt");

		const tool = registerCommitTool();
		await tool.execute(
			"test-call",
			{ message: "Commit selected file", paths: ["selected.txt"], repo },
			undefined,
			undefined,
			{ hasUI: false, model: { name: "test-model" } },
		);

		assert.deepEqual(
			(await git(repo, "show", "--format=", "--name-only", "HEAD")).stdout.trim().split("\n"),
			["selected.txt"],
		);
		assert.equal((await git(repo, "-c", "color.ui=false", "status", "--short")).stdout.trim(), "M  unrelated.txt");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("reconciles selected index entries changed by a commit hook", async () => {
	const repo = await createRepository();

	try {
		await writeFile(join(repo, "selected.txt"), "selected change\n");
		await git(repo, "add", "selected.txt");
		await writeFile(join(repo, "unrelated.txt"), "unrelated change\n");
		await git(repo, "add", "unrelated.txt");

		const hook = join(repo, ".git", "hooks", "pre-commit");
		await writeFile(hook, "#!/bin/sh\nprintf 'hook-formatted\\n' > selected.txt\ngit add selected.txt\n");
		await chmod(hook, 0o755);

		const tool = registerCommitTool();
		await tool.execute(
			"test-call",
			{ message: "Commit selected file", paths: ["selected.txt"], repo },
			undefined,
			undefined,
			{ hasUI: false, model: { name: "test-model" } },
		);

		assert.equal((await git(repo, "show", "HEAD:selected.txt")).stdout, "hook-formatted\n");
		assert.equal((await git(repo, "show", ":selected.txt")).stdout, "hook-formatted\n");
		assert.equal((await git(repo, "status", "--short")).stdout.trim(), "M  unrelated.txt");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("creates an initial commit containing only selected paths", async () => {
	const repo = await createEmptyRepository();

	try {
		await writeFile(join(repo, "selected.txt"), "selected content\n");
		await writeFile(join(repo, "unrelated.txt"), "unrelated content\n");
		await git(repo, "add", "unrelated.txt");

		const tool = registerCommitTool();
		await tool.execute(
			"test-call",
			{ message: "Initial selected commit", paths: ["selected.txt"], repo },
			undefined,
			undefined,
			{ hasUI: false, model: { name: "test-model" } },
		);

		assert.equal((await git(repo, "show", "HEAD:selected.txt")).stdout, "selected content\n");
		await assert.rejects(git(repo, "show", "HEAD:unrelated.txt"));
		assert.equal((await git(repo, "status", "--short")).stdout.trim(), "A  unrelated.txt");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});

test("commits a selected pre-staged deletion without committing unrelated staged changes", async () => {
	const repo = await createRepository();

	try {
		await git(repo, "rm", "--quiet", "selected.txt");
		await writeFile(join(repo, "unrelated.txt"), "unrelated change\n");
		await git(repo, "add", "unrelated.txt");

		const tool = registerCommitTool();
		await tool.execute(
			"test-call",
			{ message: "Delete selected file", paths: ["selected.txt"], repo },
			undefined,
			undefined,
			{ hasUI: false, model: { name: "test-model" } },
		);

		assert.equal((await git(repo, "show", "--format=", "--name-status", "HEAD")).stdout.trim(), "D\tselected.txt");
		assert.equal((await git(repo, "status", "--short")).stdout.trim(), "M  unrelated.txt");
	} finally {
		await rm(repo, { recursive: true, force: true });
	}
});
