import { afterEach, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
} from "node:fs";
import { lstat, mkdir, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { runOmpconf } from "./helpers";

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots = [];
});

describe("local plugin link", () => {
	test("user scope creates a node_modules symlink and lockfile entry under the user plugin root", async () => {
		const root = await createTempRoot("user-link");
		const home = join(root, "home");
		await mkdir(home, { recursive: true });
		const pluginDir = await createLocalPluginBundle(root, "local-plugin");

		const result = await runOmpconf([
			"link",
			pluginDir,
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const linkPath = join(home, ".omp", "plugins", "node_modules", "local-plugin");
		await expectSymlinkTarget(linkPath, pluginDir);
		const lockfilePath = join(home, ".omp", "plugins", "omp-plugins.lock.json");
		expectLockfileTracksLinkedPlugin(lockfilePath, "local-plugin", pluginDir);
	});

	test("project scope writes only to the detected project .omp plugin root", async () => {
		const root = await createTempRoot("project-link");
		const home = join(root, "home");
		const project = join(root, "project");
		const cwd = join(project, "packages", "app");
		await mkdir(home, { recursive: true });
		await mkdir(join(project, ".git"), { recursive: true });
		await mkdir(cwd, { recursive: true });
		const pluginDir = await createLocalPluginBundle(root, "project-plugin");

		const result = await runOmpconf([
			"link",
			pluginDir,
			"--scope",
			"project",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			cwd,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const projectLinkPath = join(
			project,
			".omp",
			"plugins",
			"node_modules",
			"project-plugin",
		);
		await expectSymlinkTarget(projectLinkPath, pluginDir);
		expectLockfileTracksLinkedPlugin(
			join(project, ".omp", "plugins", "omp-plugins.lock.json"),
			"project-plugin",
			pluginDir,
		);
		expect(
			existsSync(join(home, ".omp", "plugins", "node_modules", "project-plugin")),
		).toBe(false);
	});


	test("link rejects path-traversal package names before touching node_modules", async () => {
		const root = await createTempRoot("malicious-plugin-name");
		const home = join(root, "home");
		const pluginDir = join(root, "malicious");
		await mkdir(pluginDir, { recursive: true });
		await writeJson(join(pluginDir, "package.json"), {
			name: "../../outside",
			version: "1.0.0",
			omp: { id: "outside@local" },
		});
		const outsidePath = join(home, ".omp", "outside");

		const result = await runOmpconf([
			"link",
			pluginDir,
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);

		expect(result.exitCode).toBe(1);
		expect(existsSync(outsidePath)).toBe(false);
		expect(existsSync(join(home, ".omp", "plugins", "node_modules"))).toBe(false);
	});

	test("install --dry-run reports the plugin target without writing symlink or lockfile", async () => {
		const root = await createTempRoot("install-dry-run");
		const home = join(root, "home");
		await mkdir(home, { recursive: true });
		const pluginDir = await createLocalPluginBundle(root, "dry-plugin");

		const result = await runOmpconf([
			"install",
			pluginDir,
			"--scope",
			"user",
			"--dry-run",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(join(home, ".omp", "plugins", "node_modules", "dry-plugin"));
		expect(existsSync(join(home, ".omp", "plugins", "node_modules", "dry-plugin"))).toBe(false);
		expect(existsSync(join(home, ".omp", "plugins", "omp-plugins.lock.json"))).toBe(false);
	});
	test("remove, enable, and disable mutate the scoped plugin registry", async () => {
		const root = await createTempRoot("registry-mutations");
		const home = join(root, "home");
		await mkdir(home, { recursive: true });
		const registryPath = join(home, ".omp", "plugins", "installed_plugins.json");
		await writeJson(registryPath, {
			version: 2,
			plugins: [{ id: "toggle.plugin@local", packageName: "toggle-plugin", enabled: true }],
		});

		const disable = await runOmpconf([
			"disable",
			"toggle.plugin@local",
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);
		expect(disable.exitCode).toBe(0);
		expect(readRegistry(registryPath).plugins[0]?.enabled).toBe(false);

		const enable = await runOmpconf([
			"enable",
			"toggle.plugin@local",
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);
		expect(enable.exitCode).toBe(0);
		expect(readRegistry(registryPath).plugins[0]?.enabled).toBe(true);

		const remove = await runOmpconf([
			"remove",
			"toggle.plugin@local",
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);
		expect(remove.exitCode).toBe(0);
		expect(readRegistry(registryPath).plugins).toEqual([]);
	});
});

async function createLocalPluginBundle(
	root: string,
	packageName: string,
): Promise<string> {
	const pluginDir = join(root, packageName);
	mkdirSync(pluginDir, { recursive: true });
	await writeJson(join(pluginDir, "package.json"), {
		name: packageName,
		version: "1.0.0",
		omp: {
			id: `${packageName}@local`,
			name: packageName,
			description: `Local test plugin ${packageName}`,
		},
	});
	await writeFile(join(pluginDir, "index.js"), "export default {};\n");
	return pluginDir;
}

async function expectSymlinkTarget(
	linkPath: string,
	expectedTarget: string,
): Promise<void> {
	const stats = await lstat(linkPath);
	expect(stats.isSymbolicLink()).toBe(true);
	const rawTarget = await readlink(linkPath);
	const absoluteTarget = resolve(dirname(linkPath), rawTarget);
	expect(realpathSync(absoluteTarget)).toBe(realpathSync(expectedTarget));
}


function readRegistry(path: string): { plugins: Array<{ id: string; enabled?: boolean }> } {
	return JSON.parse(readFileSync(path, "utf8")) as { plugins: Array<{ id: string; enabled?: boolean }> };
}
function expectLockfileTracksLinkedPlugin(
	lockfilePath: string,
	packageName: string,
	pluginDir: string,
): void {
	const lockfile = JSON.parse(readFileSync(lockfilePath, "utf8")) as Record<
		string,
		unknown
	>;
	expect(lockfile.version).toBe(2);
	expect(jsonContainsString(lockfile, packageName)).toBe(true);
	expect(jsonContainsString(lockfile, resolve(pluginDir))).toBe(true);
}

function jsonContainsString(value: unknown, expected: string): boolean {
	if (value === expected) {
		return true;
	}
	if (Array.isArray(value)) {
		return value.some((entry) => jsonContainsString(entry, expected));
	}
	if (typeof value === "object" && value !== null) {
		return Object.entries(value).some(
			([key, entry]) => key === expected || jsonContainsString(entry, expected),
		);
	}
	return false;
}

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-plugin-link-${name}-`));
	tempRoots.push(root);
	return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, `${JSON.stringify(value, null, "\t")}\n`);
}
