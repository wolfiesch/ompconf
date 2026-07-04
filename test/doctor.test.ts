import { afterEach, describe, expect, test } from "bun:test";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { runOmpconf } from "./helpers";
import {
	cleanupTempRoots,
	createTempRoot,
	diagnosticCodes,
	diagnosticsByCode,
	expectNoRawHome,
	makeBrokenSymlink,
	makeProject,
	runDoctorJson,
	writeJson,
	writeText,
} from "./safety-helpers";
afterEach(cleanupTempRoots);

describe("doctor diagnostics contract", () => {
	test("doctor --json reports invalid JSON as a diagnostic instead of throwing", async () => {
		const home = await createTempRoot("invalid-json-home");
		await writeText(join(home, ".omp", "agent", "mcp.json"), "{ not valid json\n");

		const { result, doctor } = await runDoctorJson(["--home", home, "--cwd", home], 1);

		expect(doctor.ok).toBe(false);
		expect(diagnosticCodes(doctor)).toContain("JSON_INVALID");
		const [diagnostic] = diagnosticsByCode(doctor, "JSON_INVALID");
		expect(diagnostic).toMatchObject({
			severity: "error",
			scope: "user",
			path: "~/.omp/agent/mcp.json",
			fixable: false,
		});
		expect(result.stdout).not.toMatch(/\b(SyntaxError|UnhandledPromiseRejection|\s+at\s+)\b/);
	});

	test("doctor --json reports invalid YAML frontmatter and missing skill descriptions", async () => {
		const home = await createTempRoot("broken-skill-home");
		await writeText(
			join(home, ".omp", "agent", "skills", "bad-yaml", "SKILL.md"),
			"---\nname: [unterminated\n---\nBroken metadata must be surfaced.\n",
		);
		await writeText(
			join(home, ".omp", "agent", "skills", "missing-description", "SKILL.md"),
			"---\nname: missing-description\n---\nA native OMP skill without a description is invalid.\n",
		);

		const { doctor } = await runDoctorJson(["--home", home, "--cwd", home], 1);

		expect(diagnosticCodes(doctor)).toEqual(
			expect.arrayContaining(["YAML_FRONTMATTER_INVALID", "SKILL_DESCRIPTION_MISSING"]),
		);
		expect(diagnosticsByCode(doctor, "YAML_FRONTMATTER_INVALID")[0]).toMatchObject({
			severity: "error",
			scope: "user",
			path: "~/.omp/agent/skills/bad-yaml/SKILL.md",
		});
		expect(diagnosticsByCode(doctor, "SKILL_DESCRIPTION_MISSING")[0]).toMatchObject({
			severity: "error",
			scope: "user",
			path: "~/.omp/agent/skills/missing-description/SKILL.md",
		});
	});

	test("doctor --json reports duplicate MCP and skill names plus invalid MCP server fields", async () => {
		const root = await createTempRoot("mcp-skill-diagnostics");
		const home = join(root, "home");
		const project = await makeProject(root);
		await mkdir(join(home, ".omp", "agent"), { recursive: true });
		await writeJson(join(home, ".omp", "agent", "mcp.json"), {
			disabledServers: ["disabled-forced"],
			enabledServers: ["disabled-forced"],
			mcpServers: {
				shared: { command: "user-shared" },
				"bad/name": { command: "bad-name" },
				"missing-command": { type: "stdio" },
				"missing-url": { type: "http" },
				"bad-transport": { type: "websocket", url: "https://example.test/mcp" },
				"disabled-forced": { command: "disabled" },
			},
		});
		await writeJson(join(project, ".omp", "mcp.json"), {
			mcpServers: {
				shared: { type: "http", url: "https://project.example.test/mcp", enabled: true },
			},
		});
		await writeText(
			join(home, ".omp", "agent", "skills", "user-copy", "SKILL.md"),
			"---\nname: duplicate-skill\ndescription: User copy\n---\nUser body.\n",
		);
		await writeText(
			join(project, ".omp", "skills", "project-copy", "SKILL.md"),
			"---\nname: duplicate-skill\ndescription: Project copy\n---\nProject body.\n",
		);

		const { doctor } = await runDoctorJson(["--home", home, "--cwd", project], 1);

		expect(diagnosticCodes(doctor)).toEqual(
			expect.arrayContaining([
				"MCP_SERVER_DUPLICATE",
				"MCP_SERVER_INVALID_NAME",
				"MCP_SERVER_INVALID_TRANSPORT",
				"MCP_SERVER_MISSING_COMMAND",
				"MCP_SERVER_MISSING_URL",
				"MCP_SERVER_DISABLED_AND_FORCED",
				"SKILL_DUPLICATE_NAME",
			]),
		);
		for (const code of [
			"MCP_SERVER_INVALID_NAME",
			"MCP_SERVER_INVALID_TRANSPORT",
			"MCP_SERVER_MISSING_COMMAND",
			"MCP_SERVER_MISSING_URL",
		]) {
			expect(diagnosticsByCode(doctor, code)[0]?.severity).toBe("error");
		}
		expect(diagnosticsByCode(doctor, "MCP_SERVER_DUPLICATE")[0]).toMatchObject({
			severity: "warning",
			target: "shared",
		});
		expect(diagnosticsByCode(doctor, "SKILL_DUPLICATE_NAME")[0]).toMatchObject({
			severity: "warning",
			target: "duplicate-skill",
		});
	});

	test("doctor --json reports invalid plugin and marketplace registries", async () => {
		const root = await createTempRoot("invalid-registries");
		const home = join(root, "home");
		await mkdir(join(home, ".omp", "agent"), { recursive: true });
		await writeJson(join(home, ".omp", "marketplaces.json"), {
			version: 2,
			marketplaces: "not-an-array",
		});
		await writeJson(join(home, ".omp", "plugins", "installed_plugins.json"), {
			version: "two",
			plugins: "not-an-array",
		});
		await writeJson(join(home, ".omp", "plugins", "package.json"), {
			dependencies: ["not", "an", "object"],
		});
		await writeJson(join(home, ".omp", "plugins", "omp-plugins.lock.json"), {
			plugins: "not-an-object",
		});

		const { doctor } = await runDoctorJson(["--home", home, "--cwd", home], 1);

		expect(diagnosticCodes(doctor)).toEqual(
			expect.arrayContaining([
				"MARKETPLACE_REGISTRY_INVALID",
				"PLUGIN_REGISTRY_INVALID",
				"PLUGIN_PACKAGE_JSON_INVALID",
				"PLUGIN_LOCK_INVALID",
			]),
		);
		for (const code of [
			"MARKETPLACE_REGISTRY_INVALID",
			"PLUGIN_REGISTRY_INVALID",
			"PLUGIN_PACKAGE_JSON_INVALID",
			"PLUGIN_LOCK_INVALID",
		]) {
			expect(diagnosticsByCode(doctor, code)[0]?.severity).toBe("error");
		}
	});

	test("doctor --json reports broken skill and plugin symlinks without following them", async () => {
		const home = await createTempRoot("broken-symlink-home");
		await mkdir(join(home, ".omp", "agent"), { recursive: true });
		await makeBrokenSymlink(
			join(home, ".omp", "agent", "skills", "ghost-skill"),
			join(home, "missing-skill-target"),
		);
		await makeBrokenSymlink(
			join(home, ".omp", "plugins", "node_modules", "ghost-plugin"),
			join(home, "missing-plugin-target"),
		);

		const { doctor } = await runDoctorJson(["--home", home, "--cwd", home], 0);

		expect(diagnosticCodes(doctor)).toEqual(
			expect.arrayContaining(["SKILL_BROKEN_SYMLINK", "PLUGIN_BROKEN_SYMLINK"]),
		);
		expect(diagnosticsByCode(doctor, "SKILL_BROKEN_SYMLINK")[0]).toMatchObject({
			severity: "warning",
			scope: "user",
			path: "~/.omp/agent/skills/ghost-skill",
		});
		expect(diagnosticsByCode(doctor, "PLUGIN_BROKEN_SYMLINK")[0]).toMatchObject({
			severity: "warning",
			scope: "user",
			path: "~/.omp/plugins/node_modules/ghost-plugin",
		});
	});

	test("doctor exits successfully for warnings unless --strict is set", async () => {
		const root = await createTempRoot("strict-warning");
		const home = join(root, "home");
		const project = await makeProject(root);
		await mkdir(join(home, ".omp", "agent"), { recursive: true });
		await writeJson(join(home, ".omp", "plugins", "installed_plugins.json"), {
			version: 2,
			plugins: [{ id: "demo.local@local", packageName: "demo-local", enabled: true }],
		});
		await writeJson(join(project, ".omp", "plugins", "installed_plugins.json"), {
			version: 2,
			plugins: [{ id: "demo.local@local", packageName: "demo-local-project", enabled: true }],
		});

		const normal = await runDoctorJson(["--home", home, "--cwd", project], 0);
		const strict = await runDoctorJson(["--strict", "--home", home, "--cwd", project], 1);

		expect(normal.doctor.ok).toBe(true);
		expect(normal.doctor.summary.errors).toBe(0);
		expect(normal.doctor.summary.warnings).toBeGreaterThanOrEqual(1);
		expect(diagnosticsByCode(normal.doctor, "PLUGIN_SHADOWED")[0]).toMatchObject({
			severity: "warning",
			target: "demo.local@local",
		});
		expect(strict.doctor.summary.errors).toBe(0);
		expect(diagnosticCodes(strict.doctor)).toContain("PLUGIN_SHADOWED");
	});

	test("human doctor output redacts home paths and secret-looking values", async () => {
		const home = await createTempRoot("human-redaction-home");
		await writeJson(join(home, ".omp", "agent", "mcp.json"), {
			mcpServers: {
				"secret-http": {
					type: "http",
					url: "https://example.test/mcp?apiKey=raw-query-secret&safe=shown",
					headers: { Authorization: "Bearer raw-header-secret" },
					env: { API_TOKEN: "raw-env-secret" },
				},
				"missing-command": { type: "stdio" },
			},
		});

		const result = await runOmpconf(["doctor", "--home", home, "--cwd", home]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		expectNoRawHome(result.stdout, home);
		expect(result.stdout).toContain("~/.omp/agent/mcp.json");
		expect(result.stdout).toContain("[REDACTED]");
		expect(result.stdout).not.toContain("raw-query-secret");
		expect(result.stdout).not.toContain("raw-header-secret");
		expect(result.stdout).not.toContain("raw-env-secret");
	});
});
