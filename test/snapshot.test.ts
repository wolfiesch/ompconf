import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, symlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";
import {
	cleanupTempRoots,
	createTempRoot,
	expectFileExists,
	modeBits,
	readJson,
	sha256,
	writeJson,
	writeText,
	type SnapshotManifest,
} from "./safety-helpers";

afterEach(cleanupTempRoots);

describe("snapshot contract", () => {
	test("snapshot --json creates a private manifest with checksums for config files only", async () => {
		const root = await createTempRoot("snapshot-config-only");
		const home = join(root, "home");
		const project = join(root, "project");
		const stateDir = join(root, "state");
		await writeConfigAndExcludedFiles(home, project);

		const result = await runOmpconf([
			"snapshot",
			"--json",
			"--no-redact",
			"--label",
			"safety pass",
			"--home",
			home,
			"--cwd",
			project,
			"--state-dir",
			stateDir,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const snapshot = parseStdoutJson<{ id: string }>(result);
		expect(snapshot.id).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);

		const snapshotDir = join(stateDir, "snapshots", snapshot.id);
		const manifestPath = join(snapshotDir, "manifest.json");
		expectFileExists(manifestPath);
		expect(await modeBits(stateDir)).toBe(0o700);
		expect(await modeBits(snapshotDir)).toBe(0o700);

		const manifest = await readJson<SnapshotManifest>(manifestPath);
		expect(manifest).toMatchObject({
			id: snapshot.id,
			label: "safety pass",
			tool: { name: "ompconf", version: expect.any(String) },
		});
		expect(Object.keys(manifest.roots).sort()).toEqual([
			"project",
			"user-agent",
			"user-plugins",
			"user-root",
		]);
		expect(manifest.files.map((file) => `${file.root}:${file.relativePath}`).sort()).toEqual([
			"project:.omp/.mcp.json",
			"project:.omp/mcp.json",
			"project:.omp/plugin-overrides.json",
			"project:.omp/plugins/installed_plugins.json",
			"user-agent:.mcp.json",
			"user-agent:managed-skills/generated/SKILL.md",
			"user-agent:mcp.json",
			"user-agent:skills/native/SKILL.md",
			"user-plugins:installed_plugins.json",
			"user-plugins:omp-plugins.lock.json",
			"user-plugins:package.json",
			"user-root:marketplaces.json",
		]);

		for (const file of manifest.files) {
			expect(file.kind).toBe("file");
			expect(file.mode).toBeGreaterThan(0);
			expect(file.size).toBeGreaterThan(0);
			expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
			expect(file.snapshotPath).toBe(join(snapshotDir, "files", file.root, file.relativePath));
			expectFileExists(file.snapshotPath);
			expect(await sha256(file.snapshotPath)).toBe(file.sha256);
		}

		const copiedPaths = await listRelativeFiles(join(snapshotDir, "files"));
		expect(copiedPaths).not.toEqual(expect.arrayContaining([
			"user-agent/agent.db",
			"user-agent/logs/debug.log",
			"user-agent/sessions/session.json",
			"user-plugins/node_modules/demo/package.json",
		]));
		expect(copiedPaths.some((path) => path.includes("node_modules"))).toBe(false);
		expect(copiedPaths.some((path) => path.endsWith(".db"))).toBe(false);
		expect(copiedPaths.some((path) => path.includes("/logs/"))).toBe(false);
		expect(copiedPaths.some((path) => path.includes("/sessions/"))).toBe(false);
	});

	test("snapshot preserves symlink target permissions while copying link metadata", async () => {
		const root = await createTempRoot("snapshot-symlink-perms");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const target = join(home, "real-mcp.json");
		const link = join(home, ".omp", "agent", "mcp.json");
		await writeText(target, "{\"mcpServers\":{}}\n");
		await chmod(target, 0o600);
		await mkdir(join(home, ".omp", "agent"), { recursive: true });
		await symlink(target, link);

		const result = await runOmpconf([
			"snapshot",
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
		expect(await modeBits(target)).toBe(0o600);
		const snapshot = parseStdoutJson<{ id: string }>(result);
		const manifest = await readJson<SnapshotManifest>(join(stateDir, "snapshots", snapshot.id, "manifest.json"));
		expect(manifest.files[0]).toMatchObject({ kind: "symlink", relativePath: "mcp.json" });
	});

	test("snapshot records symlinked skill directories without touching external skill targets", async () => {
		const root = await createTempRoot("snapshot-symlink-skill");
		const home = join(root, "home");
		const stateDir = join(root, "state");
		const externalSkill = join(root, "external-skill");
		const linkedSkill = join(home, ".omp", "agent", "skills", "linked");
		await writeText(join(externalSkill, "SKILL.md"), "---\nname: linked\ndescription: Linked\n---\n");
		await chmod(join(externalSkill, "SKILL.md"), 0o600);
		await mkdir(join(home, ".omp", "agent", "skills"), { recursive: true });
		await symlink(externalSkill, linkedSkill);

		const result = await runOmpconf(["snapshot", "--json", "--no-redact", "--home", home, "--cwd", home, "--state-dir", stateDir]);
		expect(result.exitCode).toBe(0);
		expect(await modeBits(join(externalSkill, "SKILL.md"))).toBe(0o600);
		const snapshot = parseStdoutJson<{ id: string }>(result);
		const manifest = await readJson<SnapshotManifest>(join(stateDir, "snapshots", snapshot.id, "manifest.json"));
		expect(manifest.files).toContainEqual(expect.objectContaining({
			root: "user-agent",
			relativePath: "skills/linked",
			kind: "symlink",
		}));
	});
});

async function writeConfigAndExcludedFiles(home: string, project: string): Promise<void> {
	await writeJson(join(home, ".omp", "agent", "mcp.json"), {
		mcpServers: { user: { command: "user-mcp" } },
	});
	await writeJson(join(home, ".omp", "agent", ".mcp.json"), {
		mcpServers: { userDot: { command: "dot-mcp" } },
	});
	await writeText(
		join(home, ".omp", "agent", "skills", "native", "SKILL.md"),
		"---\nname: native\ndescription: Native skill\n---\nNative body.\n",
	);
	await writeText(
		join(home, ".omp", "agent", "managed-skills", "generated", "SKILL.md"),
		"---\nname: generated\ndescription: Managed skill\n---\nManaged body.\n",
	);
	await writeJson(join(home, ".omp", "marketplaces.json"), {
		version: 1,
		marketplaces: [{ name: "local", url: "file:///marketplace" }],
	});
	await writeJson(join(home, ".omp", "plugins", "package.json"), {
		dependencies: { "demo-plugin": "file:../demo-plugin" },
	});
	await writeJson(join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
		plugins: { "demo-plugin": { version: "1.0.0" } },
	});
	await writeJson(join(home, ".omp", "plugins", "installed_plugins.json"), {
		version: 2,
		plugins: [{ id: "demo.plugin@local", packageName: "demo-plugin", enabled: true }],
	});
	await writeJson(join(project, ".omp", "mcp.json"), {
		mcpServers: { project: { command: "project-mcp" } },
	});
	await writeJson(join(project, ".omp", ".mcp.json"), {
		mcpServers: { projectDot: { command: "project-dot-mcp" } },
	});
	await writeJson(join(project, ".omp", "plugin-overrides.json"), {
		disabled: ["demo.plugin@local"],
	});
	await writeJson(join(project, ".omp", "plugins", "installed_plugins.json"), {
		version: 2,
		plugins: [{ id: "project.plugin@local", packageName: "project-plugin", enabled: true }],
	});

	await writeText(join(home, ".omp", "agent", "agent.db"), "sqlite bytes");
	await writeText(join(home, ".omp", "agent", "logs", "debug.log"), "debug log");
	await writeText(join(home, ".omp", "agent", "sessions", "session.json"), "{\"transcript\":true}\n");
	await writeJson(join(home, ".omp", "plugins", "node_modules", "demo", "package.json"), {
		name: "demo",
	});
}

async function listRelativeFiles(root: string): Promise<string[]> {
	const paths: string[] = [];
	await collectFiles(root, root, paths);
	return paths.sort();
}

async function collectFiles(root: string, current: string, paths: string[]): Promise<void> {
	const entries = await readdir(current, { withFileTypes: true });
	for (const entry of entries) {
		const fullPath = join(current, entry.name);
		if (entry.isDirectory()) {
			await collectFiles(root, fullPath, paths);
		} else {
			paths.push(relative(root, fullPath));
		}
	}
}
