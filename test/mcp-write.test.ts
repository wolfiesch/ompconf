import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";

interface SnapshotManifest {
	id: string;
	files: Array<{
		root: string;
		relativePath: string;
		originalPath: string;
		redactedPath: string;
		kind: "file" | "symlink";
		mode: number;
		size: number;
		sha256: string;
		snapshotPath: string;
	}>;
}

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
	tempRoots = [];
});

describe("MCP write-path contracts", () => {
	test("mcp add writes a stdio server only to user mcp.json after taking a prewrite snapshot", async () => {
		const fixture = await createWriteFixture("add-user-stdio");
		const userDot = join(fixture.home, ".omp", "agent", ".mcp.json");
		await writeJson(userDot, {
			mcpServers: {
				"read-only-dot": { command: "node", args: ["dot.js"] },
			},
		});
		const dotBefore = await readFile(userDot, "utf8");

		const result = await runOmpconf([
			...globalArgs(fixture),
			"mcp",
			"add",
			"stdio-added",
			"--scope",
			"user",
			"--",
			"bunx",
			"@acme/mcp-server",
			"--flag",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const userPrimary = join(fixture.home, ".omp", "agent", "mcp.json");
		const primary = await readJsonFile<{ mcpServers: Record<string, { command: string; args?: string[] }> }>(userPrimary);
		expect(primary.mcpServers["stdio-added"]).toEqual({
			command: "bunx",
			args: ["@acme/mcp-server", "--flag"],
		});
		expect(await readFile(userDot, "utf8")).toBe(dotBefore);

		const { manifest } = await readSingleSnapshot(fixture.stateDir);
		const relativePaths = manifest.files.map((file) => `${file.root}/${file.relativePath}`).sort();
		expect(relativePaths).toContain("user-agent/.mcp.json");
		expect(relativePaths).not.toContain("user-agent/mcp.json");
	});

	test("mcp add --url writes a remote project server only to project .omp/mcp.json after taking a prewrite snapshot", async () => {
		const fixture = await createWriteFixture("add-project-url");
		const projectDot = join(fixture.project, ".omp", ".mcp.json");
		await writeJson(projectDot, {
			mcpServers: {
				"project-dot": { type: "http", url: "https://dot.example/mcp" },
			},
		});
		const dotBefore = await readFile(projectDot, "utf8");

		const result = await runOmpconf([
			...globalArgs(fixture),
			"mcp",
			"add",
			"project-remote",
			"--scope",
			"project",
			"--url",
			"https://project.example/events",
			"--transport",
			"sse",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const projectPrimary = join(fixture.project, ".omp", "mcp.json");
		const primary = await readJsonFile<{ mcpServers: Record<string, { type: string; url: string }> }>(projectPrimary);
		expect(primary.mcpServers["project-remote"]).toEqual({
			type: "sse",
			url: "https://project.example/events",
		});
		expect(await readFile(projectDot, "utf8")).toBe(dotBefore);

		const { manifest } = await readSingleSnapshot(fixture.stateDir);
		const relativePaths = manifest.files.map((file) => `${file.root}/${file.relativePath}`).sort();
		expect(relativePaths).toContain("project/.omp/.mcp.json");
		expect(relativePaths).not.toContain("project/.omp/mcp.json");
	});

	test("mcp remove deletes a user server from primary mcp.json without touching a same-named .mcp.json server", async () => {
		const fixture = await createWriteFixture("remove-user-primary");
		const userPrimary = join(fixture.home, ".omp", "agent", "mcp.json");
		const userDot = join(fixture.home, ".omp", "agent", ".mcp.json");
		await writeJson(userPrimary, {
			mcpServers: {
				"remove-me": { command: "node", args: ["old.js"] },
				"keep-me": { type: "http", url: "https://keep.example/mcp" },
			},
		});
		await writeJson(userDot, {
			mcpServers: {
				"remove-me": { command: "node", args: ["dot.js"] },
			},
		});
		const dotBefore = await readFile(userDot, "utf8");

		const result = await runOmpconf([
			...globalArgs(fixture),
			"mcp",
			"remove",
			"remove-me",
			"--scope",
			"user",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const primary = await readJsonFile<{ mcpServers: Record<string, unknown> }>(userPrimary);
		expect(Object.keys(primary.mcpServers).sort()).toEqual(["keep-me"]);
		expect(await readFile(userDot, "utf8")).toBe(dotBefore);

		const snapshotPrimary = await readSnapshotFile(fixture.stateDir, "user-agent/mcp.json");
		expect(snapshotPrimary).toContain("remove-me");
		expect(snapshotPrimary).toContain("keep-me");
	});

	test("mcp disable records a denylist entry in primary user mcp.json without mutating a read-only .mcp.json source", async () => {
		const fixture = await createWriteFixture("disable-readonly");
		const userDot = join(fixture.home, ".omp", "agent", ".mcp.json");
		await writeJson(userDot, {
			mcpServers: {
				"readonly-off": { command: "node", args: ["readonly.js"] },
			},
		});
		const dotBefore = await readFile(userDot, "utf8");

		const result = await runOmpconf([
			...globalArgs(fixture),
			"mcp",
			"disable",
			"readonly-off",
			"--scope",
			"all",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const userPrimary = join(fixture.home, ".omp", "agent", "mcp.json");
		const primary = await readJsonFile<{ disabledServers: string[] }>(userPrimary);
		expect(primary.disabledServers).toEqual(["readonly-off"]);
		expect(await readFile(userDot, "utf8")).toBe(dotBefore);

		const { manifest } = await readSingleSnapshot(fixture.stateDir);
		const relativePaths = manifest.files.map((file) => `${file.root}/${file.relativePath}`).sort();
		expect(relativePaths).toContain("user-agent/.mcp.json");
		expect(relativePaths).not.toContain("user-agent/mcp.json");
	});

	test("mcp enable removes a user denylist entry after snapshotting the old primary mcp.json", async () => {
		const fixture = await createWriteFixture("enable-denylist-entry");
		const userPrimary = join(fixture.home, ".omp", "agent", "mcp.json");
		await writeJson(userPrimary, {
			disabledServers: ["blocked", "keep-blocked"],
			mcpServers: {
				blocked: { command: "node", args: ["blocked.js"] },
				"keep-blocked": { command: "node", args: ["keep.js"] },
			},
		});

		const result = await runOmpconf([
			...globalArgs(fixture),
			"mcp",
			"enable",
			"blocked",
			"--scope",
			"user",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const primary = await readJsonFile<{ disabledServers: string[] }>(userPrimary);
		expect(primary.disabledServers).toEqual(["keep-blocked"]);

		const snapshotPrimary = await readSnapshotFile(fixture.stateDir, "user-agent/mcp.json");
		expect(snapshotPrimary).toContain("blocked");
		expect(snapshotPrimary).toContain("keep-blocked");
	});

	test("mcp enable force-enables a read-only disabled source by writing enabledServers to primary mcp.json only", async () => {
		const fixture = await createWriteFixture("enable-readonly-source");
		const userDot = join(fixture.home, ".omp", "agent", ".mcp.json");
		await writeJson(userDot, {
			mcpServers: {
				"readonly-disabled": {
					command: "bunx",
					args: ["readonly.js"],
					enabled: false,
				},
			},
		});
		const dotBefore = await readFile(userDot, "utf8");

		const result = await runOmpconf([
			...globalArgs(fixture),
			"mcp",
			"enable",
			"readonly-disabled",
			"--scope",
			"all",
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const userPrimary = join(fixture.home, ".omp", "agent", "mcp.json");
		const primary = await readJsonFile<{ enabledServers: string[] }>(userPrimary);
		expect(primary.enabledServers).toEqual(["readonly-disabled"]);
		expect(await readFile(userDot, "utf8")).toBe(dotBefore);

		const { manifest } = await readSingleSnapshot(fixture.stateDir);
		const relativePaths = manifest.files.map((file) => `${file.root}/${file.relativePath}`).sort();
		expect(relativePaths).toContain("user-agent/.mcp.json");
		expect(relativePaths).not.toContain("user-agent/mcp.json");
	});
});

interface WriteFixture {
	home: string;
	project: string;
	stateDir: string;
}

async function createWriteFixture(name: string): Promise<WriteFixture> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-mcp-write-${name}-`));
	tempRoots.push(root);
	const home = resolve(join(root, "home"));
	const project = resolve(join(root, "project"));
	const stateDir = resolve(join(root, "state"));
	await mkdir(join(project, ".git"), { recursive: true });
	await mkdir(home, { recursive: true });
	return { home, project, stateDir };
}

function globalArgs(fixture: WriteFixture): string[] {
	return [
		"--no-redact",
		"--home",
		fixture.home,
		"--cwd",
		fixture.project,
		"--state-dir",
		fixture.stateDir,
	];
}

async function readSingleSnapshot(stateDir: string): Promise<{ snapshotDir: string; manifest: SnapshotManifest }> {
	const snapshotsRoot = join(stateDir, "snapshots");
	const entries = await readdir(snapshotsRoot, { withFileTypes: true });
	const snapshotDirs = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
	expect(snapshotDirs).toHaveLength(1);
	const snapshotDirName = snapshotDirs[0];
	if (!snapshotDirName) throw new Error("Expected exactly one snapshot directory");
	const snapshotDir = join(snapshotsRoot, snapshotDirName);
	const manifestPath = join(snapshotDir, "manifest.json");
	expect(existsSync(manifestPath)).toBe(true);
	const manifest = await readJsonFile<SnapshotManifest>(manifestPath);
	return { snapshotDir, manifest };
}

async function readSnapshotFile(stateDir: string, relativePath: string): Promise<string> {
	const { snapshotDir, manifest } = await readSingleSnapshot(stateDir);
	const manifestEntry = manifest.files.find((file) => `${file.root}/${file.relativePath}` === relativePath);
	expect(manifestEntry).toBeDefined();
	if (!manifestEntry) throw new Error(`Snapshot did not record ${relativePath}`);
	const snapshotPath = isAbsolute(manifestEntry.snapshotPath)
		? manifestEntry.snapshotPath
		: join(snapshotDir, manifestEntry.snapshotPath);
	return readFile(snapshotPath, "utf8");
}

async function readJsonFile<T>(file: string): Promise<T> {
	return parseStdoutJson<T>({
		exitCode: 0,
		stdout: await readFile(file, "utf8"),
		stderr: "",
	});
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
