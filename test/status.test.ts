import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";

interface StatusJson {
	version: string;
	profile: string | null;
	paths: {
		home: string;
		cwd: string;
		configRoot: string;
		agentDir: string;
		pluginsDir: string;
		projectRoot: string | null;
		projectOmpDir: string | null;
		stateDir: string;
	};
	counts: {
		mcpServers: number;
		skills: number;
		plugins: number;
		marketplaces: number;
		diagnostics: number;
		snapshots: number;
	};
	warnings: Array<{ code: string; message: string }>;
}

const requiredHelpCommands = [
	"status",
	"doctor",
	"list",
	"snapshot",
	"mcp",
	"skill",
	"install",
	"link",
	"remove",
	"enable",
	"disable",
	"rollback",
	"tui",
];

const zeroCounts: StatusJson["counts"] = {
	mcpServers: 0,
	skills: 0,
	plugins: 0,
	marketplaces: 0,
	diagnostics: 0,
	snapshots: 0,
};

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots = [];
});

describe("Phase 1 CLI status contract", () => {
	test("help lists every Phase 1 command family", async () => {
		const result = await runOmpconf(["--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		for (const command of requiredHelpCommands) {
			expect(result.stdout).toMatch(new RegExp(`\\b${command}\\b`));
		}
	});

	test("status --json on an empty home redacts derived roots by default", async () => {
		const home = await createTempRoot("empty-home");
		const status = await runStatusJson(["--home", home, "--cwd", home]);

		expect(status).toEqual({
			version: expect.any(String),
			profile: null,
			paths: {
				home: "~",
				cwd: "~",
				configRoot: "~/.omp",
				agentDir: "~/.omp/agent",
				pluginsDir: "~/.omp/plugins",
				projectRoot: null,
				projectOmpDir: null,
				stateDir: "~/.ompconf",
			},
			counts: zeroCounts,
			warnings: [],
		});
	});

	test("status --json --no-redact detects a .git project root without creating .omp", async () => {
		const home = await createTempRoot("git-home");
		const project = await createTempRoot("git-project");
		const nestedCwd = join(project, "packages", "app");
		await mkdir(join(project, ".git"), { recursive: true });
		await mkdir(nestedCwd, { recursive: true });

		const status = await runStatusJson([
			"--no-redact",
			"--home",
			home,
			"--cwd",
			nestedCwd,
		]);
		const projectOmpDir = join(resolve(project), ".omp");

		expect(status.paths.cwd).toBe(resolve(nestedCwd));
		expect(status.paths.projectRoot).toBe(resolve(project));
		expect(status.paths.projectOmpDir).toBe(projectOmpDir);
		expect(existsSync(projectOmpDir)).toBe(false);
	});

	test("status --json --no-redact honors PI_CONFIG_DIR for config, agent, and plugin roots", async () => {
		const home = await createTempRoot("custom-config-home");
		const status = await runStatusJson(["--no-redact", "--home", home, "--cwd", home], {
			PI_CONFIG_DIR: ".custom-omp",
		});
		const configRoot = join(resolve(home), ".custom-omp");

		expect(status.paths.configRoot).toBe(configRoot);
		expect(status.paths.agentDir).toBe(join(configRoot, "agent"));
		expect(status.paths.pluginsDir).toBe(join(configRoot, "plugins"));
		expect(status.paths.stateDir).toBe(join(resolve(home), ".ompconf"));
	});

	test("status --json --no-redact uses pre-existing XDG_DATA_HOME/omp for plugins only", async () => {
		const root = await createTempRoot("xdg-data-root");
		const home = join(root, "home");
		const xdgDataHome = join(root, "xdg-data");
		await mkdir(home, { recursive: true });
		await mkdir(join(xdgDataHome, "omp"), { recursive: true });

		const status = await runStatusJson(["--no-redact", "--home", home, "--cwd", home], {
			XDG_DATA_HOME: xdgDataHome,
		});
		const configRoot = join(resolve(home), ".omp");

		expect(status.paths.configRoot).toBe(configRoot);
		expect(status.paths.agentDir).toBe(join(configRoot, "agent"));
		expect(status.paths.pluginsDir).toBe(
			join(resolve(xdgDataHome), "omp", "plugins"),
		);
		expect(status.paths.stateDir).toBe(join(resolve(home), ".ompconf"));
	});

	test("status --json --no-redact derives named profile roots under profiles/<name>", async () => {
		const home = await createTempRoot("profile-home");
		const status = await runStatusJson([
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
			"--profile",
			"work",
		]);
		const configRoot = join(resolve(home), ".omp", "profiles", "work");

		expect(status.profile).toBe("work");
		expect(status.paths.configRoot).toBe(configRoot);
		expect(status.paths.agentDir).toBe(join(configRoot, "agent"));
		expect(status.paths.pluginsDir).toBe(join(configRoot, "plugins"));
	});

	test("status --json --no-redact ignores PI_CODING_AGENT_DIR for named profiles", async () => {
		const home = await createTempRoot("profile-env-agent-dir-home");
		const envAgentDir = join(home, "env-agent");
		const status = await runStatusJson([
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
			"--profile",
			"work",
		], {
			PI_CODING_AGENT_DIR: envAgentDir,
		});
		const configRoot = join(resolve(home), ".omp", "profiles", "work");

		expect(status.paths.agentDir).toBe(join(configRoot, "agent"));
	});

	test("status rejects combining a named profile with --agent-dir", async () => {
		const home = await createTempRoot("profile-agent-dir-home");
		const agentDir = join(home, "override-agent");
		const result = await runOmpconf([
			"status",
			"--json",
			"--home",
			home,
			"--cwd",
			home,
			"--profile",
			"work",
			"--agent-dir",
			agentDir,
		]);
		const combinedOutput = `${result.stdout}\n${result.stderr}`;

		expect(result.exitCode).toBe(1);
		expect(combinedOutput).toContain("--profile");
		expect(combinedOutput).toContain("--agent-dir");
	});
});

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-status-${name}-`));
	tempRoots.push(root);
	return root;
}

async function runStatusJson(
	args: string[],
	env: Record<string, string> = {},
): Promise<StatusJson> {
	const result = await runOmpconf(["status", "--json", ...args], { env });

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");

	const status = parseStdoutJson<StatusJson>(result);
	expectStatusJsonShape(status);
	return status;
}

function expectStatusJsonShape(status: StatusJson): void {
	expect(Object.keys(status).sort()).toEqual([
		"counts",
		"paths",
		"profile",
		"version",
		"warnings",
	]);
	expect(Object.keys(status.paths).sort()).toEqual([
		"agentDir",
		"configRoot",
		"cwd",
		"home",
		"pluginsDir",
		"projectOmpDir",
		"projectRoot",
		"stateDir",
	]);
	expect(Object.keys(status.counts).sort()).toEqual([
		"diagnostics",
		"marketplaces",
		"mcpServers",
		"plugins",
		"skills",
		"snapshots",
	]);
}
