import { afterEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";
import { cleanupTempRoots, createTempRoot, expectNoRawHome, writeJson } from "./safety-helpers";

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

afterEach(cleanupTempRoots);

describe("redaction contract", () => {
	test("mcp list --json redacts home paths and secret-looking URL parameters by default", async () => {
		const home = await createTempRoot("json-redaction-home");
		await writeJson(join(home, ".omp", "agent", "mcp.json"), {
			mcpServers: {
				remote: {
					type: "http",
					url: "https://mcp.example.test/rpc?apiKey=raw-query-secret&safe=visible",
					headers: { Authorization: "Bearer raw-header-secret" },
					env: { SERVICE_TOKEN: "raw-env-secret" },
				},
			},
		});

		const result = await runOmpconf(["mcp", "list", "--json", "--home", home, "--cwd", home]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expectNoRawHome(result.stdout, home);
		expect(result.stdout).not.toContain("raw-query-secret");
		expect(result.stdout).not.toContain("raw-header-secret");
		expect(result.stdout).not.toContain("raw-env-secret");
		const list = parseStdoutJson<McpListJson>(result);
		expect(list.servers).toHaveLength(1);
		expect(list.servers[0]).toMatchObject({
			name: "remote",
			scope: "user",
			file: "~/.omp/agent/mcp.json",
			transport: "http",
			url: "https://mcp.example.test/rpc?apiKey=[REDACTED]&safe=visible",
			hasEnv: true,
			hasHeaders: true,
		});
	});

	test("mcp list human output redacts home paths and secret-looking values", async () => {
		const home = await createTempRoot("human-redaction-home");
		await writeJson(join(home, ".omp", "agent", "mcp.json"), {
			mcpServers: {
				remote: {
					type: "sse",
					url: "https://mcp.example.test/events?token=raw-query-token&safe=visible",
				},
			},
		});

		const result = await runOmpconf(["mcp", "list", "--home", home, "--cwd", home]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		expectNoRawHome(result.stdout, home);
		expect(result.stdout).toContain("~/.omp/agent/mcp.json");
		expect(result.stdout).toContain("[REDACTED]");
		expect(result.stdout).not.toContain("raw-query-token");
	});

	test("--no-redact preserves exact local paths and non-redacted URL parameters for local debugging", async () => {
		const home = await createTempRoot("no-redact-home");
		const configFile = join(resolve(home), ".omp", "agent", "mcp.json");
		await writeJson(configFile, {
			mcpServers: {
				remote: {
					type: "http",
					url: "https://mcp.example.test/rpc?apiKey=raw-query-secret",
				},
			},
		});

		const result = await runOmpconf([
			"mcp",
			"list",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			home,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const list = parseStdoutJson<McpListJson>(result);
		expect(list.servers[0]).toMatchObject({
			file: configFile,
			url: "https://mcp.example.test/rpc?apiKey=raw-query-secret",
		});
	});

	test("list and snapshot human output redact home paths by default", async () => {
		const home = await createTempRoot("generic-human-redaction-home");
		await writeJson(join(home, ".omp", "agent", "mcp.json"), {
			mcpServers: { local: { command: "node" } },
		});

		const list = await runOmpconf(["list", "--home", home, "--cwd", home]);
		expect(list.exitCode).toBe(0);
		expectNoRawHome(list.stdout, home);
		expect(list.stdout).toContain("~/.omp/agent/mcp.json");

		const snapshot = await runOmpconf(["snapshot", "--home", home, "--cwd", home]);
		expect(snapshot.exitCode).toBe(0);
		expectNoRawHome(snapshot.stdout, home);
		expect(snapshot.stdout).toContain("~/.ompconf/snapshots/");
	});
});
