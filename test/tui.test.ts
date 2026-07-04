import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";

interface StatusJson {
	counts: StatusCounts;
}

interface StatusCounts {
	mcpServers: number;
	skills: number;
	plugins: number;
	marketplaces: number;
	diagnostics: number;
	snapshots: number;
}

type TuiScreenName = "Overview" | "Doctor" | "MCP" | "Skills" | "Plugins" | "Snapshots";

interface TuiSmokeJson {
	mode: "smoke";
	counts: StatusCounts;
	screens: Array<{
		name: TuiScreenName;
		count: number | null;
		counts?: StatusCounts;
	}>;
}

const expectedScreens: TuiScreenName[] = [
	"Overview",
	"Doctor",
	"MCP",
	"Skills",
	"Plugins",
	"Snapshots",
];

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(
		tempRoots.map((root) => rm(root, { recursive: true, force: true })),
	);
	tempRoots = [];
});

describe("TUI smoke contract", () => {
	test("tui --smoke --json exits without an interactive terminal and reports screen counts from JSON models", async () => {
		const { home, project } = await createSmokeFixture();
		const scopeArgs = ["--home", home, "--cwd", project];
		const statusResult = await runOmpconf(["status", "--json", ...scopeArgs]);
		expect(statusResult.exitCode).toBe(0);
		expect(statusResult.stderr).toBe("");
		const status = parseStdoutJson<StatusJson>(statusResult);
		expect(status.counts.snapshots).toBe(2);

		const tuiResult = await runOmpconf([
			"tui",
			"--smoke",
			"--json",
			...scopeArgs,
		]);

		expect(tuiResult.exitCode).toBe(0);
		expect(tuiResult.stderr).toBe("");
		for (const screen of expectedScreens) {
			expect(tuiResult.stdout).toContain(screen);
		}

		const smoke = parseStdoutJson<TuiSmokeJson>(tuiResult);
		expect(smoke.mode).toBe("smoke");
		expect(smoke.counts).toEqual(status.counts);
		expect(smoke.screens.map((screen) => screen.name)).toEqual(expectedScreens);

		const screensByName = Object.fromEntries(
			smoke.screens.map((screen) => [screen.name, screen]),
		) as Record<TuiScreenName, TuiSmokeJson["screens"][number]>;
		expect(screensByName.Overview.counts).toEqual(status.counts);
		expect(screensByName.Doctor.count).toBe(status.counts.diagnostics);
		expect(screensByName.MCP.count).toBe(status.counts.mcpServers);
		expect(screensByName.Skills.count).toBe(status.counts.skills);
		expect(screensByName.Plugins.count).toBe(status.counts.plugins);
		expect(screensByName.Snapshots.count).toBe(status.counts.snapshots);
	});

	test("no command opens the terminal browser instead of help", async () => {
		const { home, project } = await createSmokeFixture();
		const result = await runOmpconf(["--home", home, "--cwd", project]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("OMP Config Browser");
		expect(result.stdout).toContain("MCP (2)");
		expect(result.stdout).toContain("Skills (2)");
		expect(result.stdout).toContain("Plugins (1)");
		expect(result.stdout).toContain("/ to search");
		expect(result.stdout).toContain("j/k move");
		expect(result.stdout).not.toContain("Usage:");
	});

	test("plain tui --render advertises search and MCP toggles without a TTY", async () => {
		const { home, project } = await createSmokeFixture();
		const result = await runOmpconf([
			"tui",
			"--render",
			"--home",
			home,
			"--cwd",
			project,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toContain("OMP Config Browser");
		expect(result.stdout).toContain("Screen: Overview");
		expect(result.stdout).toContain("/ to search");
		expect(result.stdout).toContain("double-click/e/d toggles selected MCP server");
		expect(result.stdout).toContain("click select");
		expect(result.stdout).toContain("wheel scroll");
		expect(result.stdout).toContain("q quit");
		expect(result.stdout).not.toContain("Usage:");
	});

	test("tui --render browses MCP, skills, and plugins with search filters", async () => {
		const { home, project } = await createSmokeFixture();
		const scopeArgs = ["--home", home, "--cwd", project];

		const mcpResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"mcp",
			"--query",
			"user",
			...scopeArgs,
		]);
		expect(mcpResult.exitCode).toBe(0);
		expect(mcpResult.stderr).toBe("");
		expect(mcpResult.stdout).toContain("Screen: MCP");
		expect(mcpResult.stdout).toContain("userApi");
		expect(mcpResult.stdout).toContain("enabled");
		expect(mcpResult.stdout).toContain("https://example.test/mcp?token=[REDACTED]&safe=1");
		expect(mcpResult.stdout).not.toContain("secret-value");
		expect(mcpResult.stdout).toContain("double-click/e/d toggles selected MCP server");

		const rawMcpResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"mcp",
			"--query",
			"user",
			"--no-redact",
			...scopeArgs,
		]);
		expect(rawMcpResult.exitCode).toBe(0);
		expect(rawMcpResult.stderr).toBe("");
		expect(rawMcpResult.stdout).toContain("https://example.test/mcp?token=secret-value&safe=1");

		const skillResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"skills",
			"--query",
			"alpha",
			...scopeArgs,
		]);
		expect(skillResult.exitCode).toBe(0);
		expect(skillResult.stderr).toBe("");
		expect(skillResult.stdout).toContain("Screen: Skills");
		expect(skillResult.stdout).toContain("alpha");
		expect(skillResult.stdout).toContain("Alpha skill");

		const pluginResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"plugins",
			"--query",
			"example",
			...scopeArgs,
		]);
		expect(pluginResult.exitCode).toBe(0);
		expect(pluginResult.stderr).toBe("");
		expect(pluginResult.stdout).toContain("Screen: Plugins");
		expect(pluginResult.stdout).toContain("@example/omp-plugin");
	});

	test("tui --render applies navigation keys before drawing", async () => {
		const { home, project } = await createSmokeFixture();
		const scopeArgs = ["--home", home, "--cwd", project];

		const movedResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"skills",
			"--keys",
			"j",
			...scopeArgs,
		]);
		expect(movedResult.exitCode).toBe(0);
		expect(movedResult.stderr).toBe("");
		expect(movedResult.stdout).toContain("Screen: Skills");
		expect(movedResult.stdout).toMatch(/\n  ✓ alpha  valid  user\b/);
		expect(movedResult.stdout).toMatch(/\n> ✓ beta  valid  project\b/);

		const switchedResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"mcp",
			"--keys",
			"]",
			...scopeArgs,
		]);
		expect(switchedResult.exitCode).toBe(0);
		expect(switchedResult.stderr).toBe("");
		expect(switchedResult.stdout).toContain("Screen: Skills");
	});

	test("tui MCP disable uses the user deny list for project servers", async () => {
		const { home, project } = await createSmokeFixture();
		const scopeArgs = ["--home", home, "--cwd", project];

		const disabledResult = await runOmpconf([
			"tui",
			"--render",
			"--screen",
			"mcp",
			"--query",
			"project",
			"--keys",
			"d",
			...scopeArgs,
		]);
		expect(disabledResult.exitCode).toBe(0);
		expect(disabledResult.stderr).toBe("");
		expect(disabledResult.stdout).toContain("projectTool  disabled  project");

		const userConfig = JSON.parse(
			await readFile(join(home, ".omp", "agent", "mcp.json"), "utf8"),
		) as { disabledServers?: string[] };
		expect(userConfig.disabledServers).toContain("projectTool");

		const projectConfig = JSON.parse(
			await readFile(join(project, ".omp", "mcp.json"), "utf8"),
		) as { disabledServers?: string[] };
		expect(projectConfig.disabledServers ?? []).not.toContain("projectTool");
	});
});

async function createSmokeFixture(): Promise<{ home: string; project: string }> {
	const root = await mkdtemp(join(tmpdir(), "ompconf-tui-smoke-"));
	tempRoots.push(root);
	const home = join(root, "home");
	const project = join(root, "project");

	await mkdir(join(project, ".git"), { recursive: true });
	await mkdir(join(home, ".omp", "agent", "skills", "alpha"), { recursive: true });
	await mkdir(join(project, ".omp", "skills", "beta"), { recursive: true });
	await mkdir(join(home, ".omp", "plugins"), { recursive: true });
	await mkdir(join(home, ".ompconf", "snapshots", "20260101-010101-aaaaaa"), {
		recursive: true,
	});
	await mkdir(join(home, ".ompconf", "snapshots", "20260102-020202-bbbbbb"), {
		recursive: true,
	});

	await writeFile(
		join(home, ".omp", "agent", "mcp.json"),
		`${JSON.stringify({ mcpServers: { userApi: { type: "http", url: "https://example.test/mcp?token=secret-value&safe=1" } } }, null, 2)}\n`,
	);
	await writeFile(
		join(project, ".omp", "mcp.json"),
		`${JSON.stringify({ mcpServers: { projectTool: { command: "project-tool" } } }, null, 2)}\n`,
	);
	await writeFile(
		join(home, ".omp", "agent", "skills", "alpha", "SKILL.md"),
		"---\nname: alpha\ndescription: Alpha skill\n---\n\nAlpha body\n",
	);
	await writeFile(
		join(project, ".omp", "skills", "beta", "SKILL.md"),
		"---\nname: beta\ndescription: Beta skill\n---\n\nBeta body\n",
	);
	await writeFile(
		join(home, ".omp", "plugins", "package.json"),
		`${JSON.stringify({ dependencies: { "@example/omp-plugin": "file:../plugin" } }, null, 2)}\n`,
	);
	await writeFile(
		join(home, ".omp", "marketplaces.json"),
		`${JSON.stringify({ version: 1, marketplaces: [{ id: "local", url: "https://example.test" }] }, null, 2)}\n`,
	);

	return { home, project };
}

