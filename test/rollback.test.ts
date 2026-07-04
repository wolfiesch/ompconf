import { createHash } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";
import {
	cleanupTempRoots,
	createTempRoot,
	expectFileExists,
	modeBits,
	writeJson,
	writeText,
	type RollbackJson,
	type SnapshotManifest,
} from "./safety-helpers";

afterEach(cleanupTempRoots);

describe("rollback contract", () => {
	test("rollback --dry-run reports target checksums without writing files", async () => {
		const root = await createTempRoot("rollback-dry-run");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const targetPath = join(home, ".omp", "agent", "mcp.json");
		const snapshot = await createRollbackSnapshot({
			stateDir,
			home,
			id: "20260703-010203-abcdef",
			targetPath,
			relativePath: "mcp.json",
			contents: "snapshot mcp\n",
		});
		await writeText(targetPath, "current mcp\n");

		const result = await runOmpconf([
			"rollback",
			snapshot.id,
			"--dry-run",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
			"--state-dir",
			stateDir,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const rollback = parseStdoutJson<RollbackJson>(result);
		expect(rollback).toMatchObject({
			id: snapshot.id,
			dryRun: true,
			restored: [
				{
					root: "user-agent",
					relativePath: "mcp.json",
					targetPath,
					sha256: snapshot.sha256,
					written: false,
				},
			],
		});
		expect(await readFile(targetPath, "utf8")).toBe("current mcp\n");
	});

	test("rollback restores file contents and creates a pre-rollback snapshot first", async () => {
		const root = await createTempRoot("rollback-restore");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const targetPath = join(home, ".omp", "agent", "mcp.json");
		const snapshot = await createRollbackSnapshot({
			stateDir,
			home,
			id: "20260703-020304-fedcba",
			targetPath,
			relativePath: "mcp.json",
			contents: "restored mcp\n",
			mode: 0o600,
		});
		await writeText(targetPath, "mutated mcp\n");
		await chmod(targetPath, 0o644);

		const result = await runOmpconf([
			"rollback",
			snapshot.id,
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
			"--state-dir",
			stateDir,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const rollback = parseStdoutJson<RollbackJson>(result);
		expect(rollback.dryRun).toBe(false);
		expect(rollback.preRollbackSnapshotId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
		expect(rollback.preRollbackSnapshotId).not.toBe(snapshot.id);
		expectFileExists(join(stateDir, "snapshots", rollback.preRollbackSnapshotId!, "manifest.json"));
		expect(rollback.restored[0]).toMatchObject({
			targetPath,
			sha256: snapshot.sha256,
			written: true,
		});
		expect(await readFile(targetPath, "utf8")).toBe("restored mcp\n");
		expect(await modeBits(targetPath)).toBe(0o600);
	});

	test("rollback refuses manifest targets outside the recorded roots", async () => {
		const root = await createTempRoot("rollback-guard");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const outsidePath = join(root, "outside", "owned.txt");
		const snapshot = await createRollbackSnapshot({
			stateDir,
			home,
			id: "20260703-030405-0bad00",
			targetPath: outsidePath,
			relativePath: "../../outside/owned.txt",
			contents: "malicious overwrite\n",
		});
		await writeText(outsidePath, "keep this content\n");

		const result = await runOmpconf([
			"rollback",
			snapshot.id,
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
			"--state-dir",
			stateDir,
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		const rollback = parseStdoutJson<RollbackJson>(result);
		expect(rollback.refused).toEqual([
			expect.objectContaining({ targetPath: outsidePath, reason: expect.any(String) }),
		]);
		expect(rollback.restored).toEqual([]);
		expect(await readFile(outsidePath, "utf8")).toBe("keep this content\n");
	});

	test("rollback restores symlinks and refuses tampered snapshot source paths", async () => {
		const root = await createTempRoot("rollback-symlink-tamper");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const id = "20260703-040506-c0ffee";
		const snapshotDir = join(stateDir, "snapshots", id);
		const targetPath = join(home, ".omp", "agent", "mcp.json");
		const linkTarget = join(home, "linked-target.json");
		const snapshotPath = join(snapshotDir, "files", "user-agent", "mcp.json");
		await writeText(linkTarget, "linked target\n");
		await chmod(linkTarget, 0o600);
		await mkdir(join(snapshotDir, "files", "user-agent"), { recursive: true });
		await symlink(linkTarget, snapshotPath);
		await writeText(targetPath, "regular file\n");
		const manifest: SnapshotManifest = {
			id,
			createdAt: "2026-07-03T00:00:00.000Z",
			tool: { name: "ompconf", version: "0.1.0" },
			roots: { "user-agent": { originalPath: join(home, ".omp", "agent"), redactedPath: "~/.omp/agent" } },
			files: [{
				root: "user-agent",
				relativePath: "mcp.json",
				originalPath: targetPath,
				redactedPath: "~/.omp/agent/mcp.json",
				kind: "symlink",
				mode: 0o777,
				size: 0,
				sha256: createHash("sha256").update(await readlink(snapshotPath)).digest("hex"),
				snapshotPath: join(root, "outside-source"),
			}],
		};
		await writeText(join(root, "outside-source"), "malicious source\n");
		await writeJson(join(snapshotDir, "manifest.json"), manifest);

		const tampered = await runOmpconf(["rollback", id, "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(tampered.exitCode).toBe(1);
		expect(await readFile(targetPath, "utf8")).toBe("regular file\n");

		manifest.files[0]!.snapshotPath = snapshotPath;
		await writeJson(join(snapshotDir, "manifest.json"), manifest);
		await rm(snapshotPath);
		const evilTarget = join(home, "evil-target.json");
		await writeText(evilTarget, "evil target\n");
		await symlink(evilTarget, snapshotPath);
		const tamperedLink = await runOmpconf(["rollback", id, "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(tamperedLink.exitCode).toBe(1);
		expect(await readFile(targetPath, "utf8")).toBe("regular file\n");

		await rm(snapshotPath);
		await symlink(linkTarget, snapshotPath);
		const restored = await runOmpconf(["rollback", id, "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(restored.exitCode).toBe(0);
		expect((await lstat(targetPath)).isSymbolicLink()).toBe(true);
		expect(await modeBits(linkTarget)).toBe(0o600);
		expect(await readlink(targetPath)).toBe(linkTarget);
	});

	test("rollback restores symlinked skill directories without chmodding external skill targets", async () => {
		const root = await createTempRoot("rollback-symlink-skill");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const id = "20260703-050607-badf00";
		const snapshotDir = join(stateDir, "snapshots", id);
		const externalSkill = join(root, "external-skill");
		const linkPath = join(home, ".omp", "agent", "skills", "linked");
		const snapshotPath = join(snapshotDir, "files", "user-agent", "skills", "linked");
		await writeText(join(externalSkill, "SKILL.md"), "---\nname: linked\ndescription: Linked\n---\n");
		await chmod(join(externalSkill, "SKILL.md"), 0o600);
		await mkdir(join(snapshotPath, ".."), { recursive: true });
		await symlink(externalSkill, snapshotPath);
		const manifest: SnapshotManifest = {
			id,
			createdAt: "2026-07-03T00:00:00.000Z",
			tool: { name: "ompconf", version: "0.1.0" },
			roots: { "user-agent": { originalPath: join(home, ".omp", "agent"), redactedPath: "~/.omp/agent" } },
			files: [{
				root: "user-agent",
				relativePath: "skills/linked",
				originalPath: linkPath,
				redactedPath: "~/.omp/agent/skills/linked",
				kind: "symlink",
				mode: 0o777,
				size: 0,
				sha256: createHash("sha256").update(await readlink(snapshotPath)).digest("hex"),
				snapshotPath,
			}],
		};
		await writeJson(join(snapshotDir, "manifest.json"), manifest);

		const result = await runOmpconf(["rollback", id, "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(result.exitCode).toBe(0);
		expect((await lstat(linkPath)).isSymbolicLink()).toBe(true);
		expect(await readlink(linkPath)).toBe(externalSkill);
		expect(await modeBits(join(externalSkill, "SKILL.md"))).toBe(0o600);
	});

	test("rollback refuses manifests whose recorded roots do not match current derived roots", async () => {
		const root = await createTempRoot("rollback-root-tamper");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const targetPath = join(root, "outside-agent", "mcp.json");
		const snapshot = await createRollbackSnapshot({
			stateDir,
			home,
			id: "20260703-060708-f00bad",
			targetPath,
			relativePath: "mcp.json",
			contents: "malicious root\n",
		});
		const manifestPath = join(stateDir, "snapshots", snapshot.id, "manifest.json");
		const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as SnapshotManifest;
		manifest.roots["user-agent"]!.originalPath = join(root, "outside-agent");
		await writeJson(manifestPath, manifest);
		await writeText(targetPath, "keep\n");

		const result = await runOmpconf(["rollback", snapshot.id, "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(result.exitCode).toBe(1);
		expect(await readFile(targetPath, "utf8")).toBe("keep\n");
	});

	test("rollback refuses file targets under symlinked parents that escape derived roots", async () => {
		const root = await createTempRoot("rollback-parent-symlink");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const agentDir = join(home, ".omp", "agent");
		const outsideDir = join(root, "outside");
		const linkedParent = join(agentDir, "skills", "linked");
		const targetPath = join(linkedParent, "SKILL.md");
		await mkdir(join(agentDir, "skills"), { recursive: true });
		await writeText(join(outsideDir, "SKILL.md"), "keep outside\n");
		await symlink(outsideDir, linkedParent);
		const snapshot = await createRollbackSnapshot({
			stateDir,
			home,
			id: "20260703-070809-a11ced",
			targetPath,
			relativePath: "skills/linked/SKILL.md",
			contents: "overwrite outside\n",
		});

		const result = await runOmpconf(["rollback", snapshot.id, "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(result.exitCode).toBe(1);
		expect(await readFile(join(outsideDir, "SKILL.md"), "utf8")).toBe("keep outside\n");
	});
});

async function createRollbackSnapshot(options: {
	stateDir: string;
	home: string;
	id: string;
	targetPath: string;
	relativePath: string;
	contents: string;
	mode?: number;
}): Promise<{ id: string; sha256: string }> {
	const snapshotDir = join(options.stateDir, "snapshots", options.id);
	const snapshotPath = join(snapshotDir, "files", "user-agent", options.relativePath);
	await writeText(snapshotPath, options.contents);
	const sha = createHash("sha256").update(await readFile(snapshotPath)).digest("hex");
	const mode = options.mode ?? 0o644;
	const manifest: SnapshotManifest = {
		id: options.id,
		createdAt: "2026-07-03T00:00:00.000Z",
		tool: { name: "ompconf", version: "0.1.0" },
		roots: {
			"user-agent": {
				originalPath: join(options.home, ".omp", "agent"),
				redactedPath: "~/.omp/agent",
			},
		},
		files: [
			{
				root: "user-agent",
				relativePath: options.relativePath,
				originalPath: options.targetPath,
				redactedPath: options.targetPath.replace(options.home, "~"),
				kind: "file",
				mode,
				size: Buffer.byteLength(options.contents),
				sha256: sha,
				snapshotPath,
			},
		],
	};
	await mkdir(snapshotDir, { recursive: true });
	await writeJson(join(snapshotDir, "manifest.json"), manifest);
	return { id: options.id, sha256: sha };
}
