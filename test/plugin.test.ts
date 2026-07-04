import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf, type CliResult } from "./helpers";

interface ListJson {
	items: ListItem[];
}

interface ListItem {
	kind: "mcp" | "skill" | "plugin" | "marketplace";
	name: string;
	scope: "user" | "project" | "managed" | "external";
	enabled: boolean | null;
	source: string;
	path: string;
	summary?: string;
}

interface DoctorJson {
	ok: boolean;
	summary: { errors: number; warnings: number; info: number };
	diagnostics: DiagnosticJson[];
}

interface DiagnosticJson {
	code: string;
	severity: "error" | "warning" | "info";
	message: string;
	scope: "user" | "project" | "managed" | "external" | "state";
	path?: string;
	target?: string;
	fixable: boolean;
}

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots = [];
});

describe("plugin and marketplace read models", () => {
	test("list --json merges installed plugins, package dependencies, lock plugins, marketplaces, and project shadowing", async () => {
		const fixture = await createPluginStateFixture();

		const result = await runOmpconf([
			"list",
			"--kind",
			"all",
			"--json",
			"--no-redact",
			"--home",
			fixture.home,
			"--cwd",
			fixture.cwd,
		]);
		const list = parseSuccessfulJson<ListJson>(result);

		expect(list.items).toContainEqual(
			expect.objectContaining({
				kind: "marketplace",
				name: "local",
				scope: "user",
				enabled: null,
				path: fixture.marketplacesPath,
			}),
		);
		expect(list.items).toContainEqual(
			expect.objectContaining({
				kind: "marketplace",
				name: "team",
				scope: "user",
				enabled: null,
				path: fixture.marketplacesPath,
			}),
		);
		expect(list.items).toContainEqual(
			expect.objectContaining({
				kind: "plugin",
				name: "alpha.local@local",
				scope: "user",
				enabled: true,
				path: fixture.userInstalledPath,
			}),
		);
		expect(list.items).toContainEqual(
			expect.objectContaining({
				kind: "plugin",
				name: "dependency-plugin",
				scope: "user",
				path: fixture.packageJsonPath,
			}),
		);
		expect(list.items).toContainEqual(
			expect.objectContaining({
				kind: "plugin",
				name: "lock.plugin@local",
				scope: "user",
				path: fixture.lockfilePath,
			}),
		);
		expect(list.items.filter((item) => item.name === "shadowed.plugin@local")).toEqual([
			expect.objectContaining({
				kind: "plugin",
				scope: "project",
				enabled: false,
				path: fixture.projectInstalledPath,
			}),
		]);
	});

	test("doctor validates plugin IDs and diagnoses project shadowing plus broken node_modules symlinks", async () => {
		const fixture = await createPluginStateFixture();

		const result = await runOmpconf([
			"doctor",
			"--json",
			"--no-redact",
			"--home",
			fixture.home,
			"--cwd",
			fixture.cwd,
		]);
		const doctor = parseDoctorJson(result);

		expect(result.exitCode).toBe(1);
		expect(doctor.ok).toBe(false);
		expect(doctor.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "PLUGIN_REGISTRY_INVALID",
				scope: "user",
				path: fixture.userInstalledPath,
				target: "Bad@Id",
			}),
		);
		expect(doctor.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "PLUGIN_SHADOWED",
				scope: "project",
				path: fixture.projectInstalledPath,
				target: "shadowed.plugin@local",
			}),
		);
		expect(doctor.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "PLUGIN_BROKEN_SYMLINK",
				scope: "user",
				path: fixture.brokenSymlinkPath,
			}),
		);
	});

	test("doctor reports malformed marketplace registries without treating a valid numeric plugin-state version as invalid", async () => {
		const root = await createTempRoot("invalid-marketplace");
		const home = join(root, "home");
		const project = join(root, "project");
		await mkdir(project, { recursive: true });
		const configRoot = join(home, ".omp");
		const pluginsDir = join(configRoot, "plugins");
		const marketplacesPath = join(configRoot, "marketplaces.json");
		const installedPath = join(pluginsDir, "installed_plugins.json");
		await writeJson(marketplacesPath, { version: 1, marketplaces: { local: {} } });
		await writeJson(installedPath, {
			version: 99,
			plugins: [{ id: "numeric.version@local", packageName: "numeric-plugin" }],
		});

		const result = await runOmpconf([
			"doctor",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			project,
		]);
		const doctor = parseDoctorJson(result);

		expect(result.exitCode).toBe(1);
		expect(doctor.diagnostics).toContainEqual(
			expect.objectContaining({
				code: "MARKETPLACE_REGISTRY_INVALID",
				scope: "user",
				path: marketplacesPath,
			}),
		);
		expect(doctor.diagnostics).not.toContainEqual(
			expect.objectContaining({
				code: "PLUGIN_REGISTRY_INVALID",
				path: installedPath,
				target: "version",
			}),
		);
	});
});

async function createPluginStateFixture(): Promise<{
	home: string;
	cwd: string;
	marketplacesPath: string;
	userInstalledPath: string;
	projectInstalledPath: string;
	packageJsonPath: string;
	lockfilePath: string;
	brokenSymlinkPath: string;
}> {
	const root = await createTempRoot("state");
	const home = join(root, "home");
	const project = join(root, "project");
	const cwd = join(project, "packages", "app");
	await mkdir(join(project, ".git"), { recursive: true });
	await mkdir(cwd, { recursive: true });

	const configRoot = join(home, ".omp");
	const pluginsDir = join(configRoot, "plugins");
	const projectPluginsDir = join(project, ".omp", "plugins");
	const marketplacesPath = join(configRoot, "marketplaces.json");
	const userInstalledPath = join(pluginsDir, "installed_plugins.json");
	const projectInstalledPath = join(projectPluginsDir, "installed_plugins.json");
	const packageJsonPath = join(pluginsDir, "package.json");
	const lockfilePath = join(pluginsDir, "omp-plugins.lock.json");
	const brokenSymlinkPath = join(pluginsDir, "node_modules", "broken-plugin");

	await writeJson(marketplacesPath, {
		version: 1,
		marketplaces: [
			{ id: "local", name: "Local Registry", url: "https://plugins.example.test/index.json" },
			{ id: "team", name: "Team Registry", url: "https://team.example.test/index.json" },
		],
	});
	await writeJson(userInstalledPath, {
		version: 7,
		plugins: [
			{ id: "alpha.local@local", packageName: "alpha-plugin", enabled: true },
			{ id: "shadowed.plugin@local", packageName: "shadowed-user", enabled: true },
			{ id: "Bad@Id", packageName: "bad-plugin", enabled: true },
		],
	});
	await writeJson(projectInstalledPath, {
		version: 2,
		plugins: [
			{ id: "shadowed.plugin@local", packageName: "shadowed-project", enabled: false },
			{ id: "project.only@team", packageName: "project-plugin", enabled: true },
		],
	});
	await writeJson(packageJsonPath, {
		private: true,
		dependencies: {
			"dependency-plugin": "1.2.3",
		},
	});
	await writeJson(lockfilePath, {
		version: 2,
		plugins: {
			"lock.plugin@local": {
				packageName: "lock-plugin",
				version: "0.0.1",
				source: "local",
			},
		},
	});
	await mkdir(dirname(brokenSymlinkPath), { recursive: true });
	await symlink(join(root, "missing-plugin-target"), brokenSymlinkPath);

	return {
		home,
		cwd,
		marketplacesPath,
		userInstalledPath,
		projectInstalledPath,
		packageJsonPath,
		lockfilePath,
		brokenSymlinkPath,
	};
}

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-plugin-${name}-`));
	tempRoots.push(root);
	return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}

function parseSuccessfulJson<T>(result: CliResult): T {
	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	return parseStdoutJson<T>(result);
}

function parseDoctorJson(result: CliResult): DoctorJson {
	expect(result.stdout).not.toBe("");
	expect(result.stderr).toBe("");
	return parseStdoutJson<DoctorJson>(result);
}
