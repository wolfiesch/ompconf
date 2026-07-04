import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";

interface McpListJson {
	servers: Array<{
		name: string;
		scope: "user" | "project";
		file: string;
		transport: "stdio" | "http" | "sse";
		enabled: boolean;
		disabledByUser: boolean;
		forcedEnabled: boolean;
		command?: string;
		url?: string;
		hasEnv: boolean;
		hasHeaders: boolean;
		hasAuth: boolean;
	}>;
}

interface DoctorJson {
	ok: boolean;
	summary: { errors: number; warnings: number; info: number };
	diagnostics: Array<{
		code: string;
		severity: "error" | "warning" | "info";
		message: string;
		scope: "user" | "project" | "managed" | "external" | "state";
		path?: string;
		target?: string;
		fixable: boolean;
	}>;
}

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
	tempRoots = [];
});

describe("MCP read-only surface contracts", () => {
	test("mcp list merges user and project mcp files, lets project display win on duplicates, and still applies the user denylist", async () => {
		const fixture = await createMergedMcpFixture("merged-list");

		const list = await runMcpListJson([
			"--no-redact",
			"--home",
			fixture.home,
			"--cwd",
			fixture.project,
			"mcp",
			"list",
			"--scope",
			"all",
			"--include-disabled",
		]);
		const servers = Object.fromEntries(list.servers.map((server) => [server.name, server]));

		expect(Object.keys(servers).sort()).toEqual([
			"dot-disabled-field",
			"forced-by-user",
			"from-dot",
			"project-dot",
			"project-sse",
			"shared",
			"user-stdio",
		]);
		expect(list.servers.filter((server) => server.name === "shared")).toHaveLength(1);

		expect(servers["user-stdio"]).toEqual(expect.objectContaining({
			name: "user-stdio",
			scope: "user",
			file: fixture.userPrimary,
			transport: "stdio",
			enabled: true,
			disabledByUser: false,
			forcedEnabled: false,
			command: "bunx",
			hasEnv: true,
			hasHeaders: false,
			hasAuth: false,
		}));
		expect(servers.shared).toEqual(expect.objectContaining({
			name: "shared",
			scope: "project",
			file: fixture.projectPrimary,
			transport: "http",
			url: "https://project.example/mcp",
			enabled: false,
			disabledByUser: true,
			forcedEnabled: false,
		}));
		expect(servers["from-dot"]).toEqual(expect.objectContaining({
			name: "from-dot",
			scope: "user",
			file: fixture.userDot,
			transport: "http",
			url: "https://user.example/mcp",
			enabled: false,
			disabledByUser: true,
			hasHeaders: true,
		}));
		expect(servers["forced-by-user"]).toEqual(expect.objectContaining({
			name: "forced-by-user",
			scope: "user",
			file: fixture.userPrimary,
			transport: "stdio",
			enabled: true,
			disabledByUser: false,
			forcedEnabled: true,
			command: "node",
		}));
		expect(servers["dot-disabled-field"]).toEqual(expect.objectContaining({
			name: "dot-disabled-field",
			scope: "user",
			file: fixture.userDot,
			transport: "sse",
			url: "https://user.example/events",
			enabled: false,
			disabledByUser: false,
			forcedEnabled: false,
		}));
		expect(servers["project-dot"]).toEqual(expect.objectContaining({
			name: "project-dot",
			scope: "project",
			file: fixture.projectDot,
			transport: "stdio",
			command: "python",
			enabled: true,
		}));
	});

	test("mcp list omits disabled servers unless --include-disabled is present while keeping force-enabled servers visible", async () => {
		const fixture = await createMergedMcpFixture("include-disabled-filter");

		const list = await runMcpListJson([
			"--no-redact",
			"--home",
			fixture.home,
			"--cwd",
			fixture.project,
			"mcp",
			"list",
			"--scope",
			"all",
		]);
		const names = list.servers.map((server) => server.name).sort();

		expect(names).toEqual([
			"forced-by-user",
			"project-dot",
			"project-sse",
			"user-stdio",
		]);
		expect(names).not.toContain("shared");
		expect(names).not.toContain("from-dot");
		expect(names).not.toContain("dot-disabled-field");
	});

	test("doctor reports duplicate MCP names and invalid server definitions as stable diagnostics", async () => {
		const fixture = await createInvalidMcpFixture("doctor-invalid");
		const result = await runOmpconf([
			"--no-redact",
			"--home",
			fixture.home,
			"--cwd",
			fixture.project,
			"doctor",
			"--json",
		]);

		expect(result.exitCode).toBe(1);
		expect(result.stderr).toBe("");
		const doctor = parseStdoutJson<DoctorJson>(result);
		const codes = doctor.diagnostics.map((diagnostic) => diagnostic.code);

		expect(doctor.ok).toBe(false);
		expect(doctor.summary.errors).toBeGreaterThanOrEqual(5);
		expect(codes).toContain("MCP_SERVER_DUPLICATE");
		expect(codes).toContain("MCP_SERVER_INVALID_NAME");
		expect(codes).toContain("MCP_SERVER_INVALID_TRANSPORT");
		expect(codes).toContain("MCP_SERVER_MISSING_COMMAND");
		expect(codes).toContain("MCP_SERVER_MISSING_URL");
		expect(doctor.diagnostics).toContainEqual(expect.objectContaining({
			code: "MCP_SERVER_DUPLICATE",
			target: "duplicate",
			severity: "warning",
			fixable: false,
		}));
		expect(doctor.diagnostics).toContainEqual(expect.objectContaining({
			code: "MCP_SERVER_INVALID_TRANSPORT",
			target: "invalid-transport",
			severity: "error",
		}));
	});
});

async function createMergedMcpFixture(name: string): Promise<{
	home: string;
	project: string;
	userPrimary: string;
	userDot: string;
	projectPrimary: string;
	projectDot: string;
}> {
	const root = await createTempRoot(name);
	const home = join(root, "home");
	const project = join(root, "project");
	const userPrimary = join(home, ".omp", "agent", "mcp.json");
	const userDot = join(home, ".omp", "agent", ".mcp.json");
	const projectPrimary = join(project, ".omp", "mcp.json");
	const projectDot = join(project, ".omp", ".mcp.json");

	await mkdir(join(project, ".git"), { recursive: true });
	await writeJson(userPrimary, {
		disabledServers: ["shared", "from-dot"],
		enabledServers: ["forced-by-user"],
		mcpServers: {
			"user-stdio": {
				command: "bunx",
				args: ["-y", "@acme/mcp"],
				env: { API_TOKEN: "secret-token" },
			},
			"forced-by-user": {
				command: "node",
				args: ["disabled.js"],
				enabled: false,
			},
			shared: { command: "user-shared" },
		},
	});
	await writeJson(userDot, {
		mcpServers: {
			"from-dot": {
				type: "http",
				url: "https://user.example/mcp",
				headers: { authorization: "Bearer secret" },
			},
			"dot-disabled-field": {
				type: "sse",
				url: "https://user.example/events",
				enabled: false,
			},
		},
	});
	await writeJson(projectPrimary, {
		mcpServers: {
			shared: {
				type: "http",
				url: "https://project.example/mcp",
				enabled: true,
			},
			"project-sse": {
				type: "sse",
				url: "https://project.example/events",
			},
		},
	});
	await writeJson(projectDot, {
		mcpServers: {
			"project-dot": {
				command: "python",
				args: ["server.py"],
			},
		},
	});

	return {
		home: resolve(home),
		project: resolve(project),
		userPrimary: resolve(userPrimary),
		userDot: resolve(userDot),
		projectPrimary: resolve(projectPrimary),
		projectDot: resolve(projectDot),
	};
}

async function createInvalidMcpFixture(name: string): Promise<{ home: string; project: string }> {
	const root = await createTempRoot(name);
	const home = join(root, "home");
	const project = join(root, "project");
	await mkdir(join(project, ".git"), { recursive: true });

	await writeJson(join(home, ".omp", "agent", "mcp.json"), {
		mcpServers: {
			"bad/name": { command: "ok" },
			"missing-command": { type: "stdio" },
			"invalid-transport": { type: "websocket", url: "https://example.invalid" },
			duplicate: { command: "user-duplicate" },
		},
	});
	await writeJson(join(home, ".omp", "agent", ".mcp.json"), {
		mcpServers: {
			"empty-command": { command: "   " },
		},
	});
	await writeJson(join(project, ".omp", "mcp.json"), {
		mcpServers: {
			duplicate: { type: "http", url: "https://project.example/mcp" },
			"missing-http-url": { type: "http" },
		},
	});
	await writeJson(join(project, ".omp", ".mcp.json"), {
		mcpServers: {
			"missing-sse-url": { type: "sse", url: "" },
		},
	});

	return { home: resolve(home), project: resolve(project) };
}

async function runMcpListJson(args: string[]): Promise<McpListJson> {
	const result = await runOmpconf(["--json", ...args]);

	expect(result.exitCode).toBe(0);
	expect(result.stderr).toBe("");
	return parseStdoutJson<McpListJson>(result);
}


async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-mcp-${name}-`));
	tempRoots.push(root);
	return root;
}

async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}
