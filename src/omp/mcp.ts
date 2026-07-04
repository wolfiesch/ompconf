import * as path from "node:path";
import type { Diagnostic } from "../core/diagnostics";
import type { RuntimePaths } from "../core/schema";
import { readJsonFile } from "../core/read-json";

export interface McpConfigFile {
	mcpServers?: Record<string, McpServerConfig>;
	disabledServers?: string[];
	enabledServers?: string[];
}

export interface McpServerConfig {
	type?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	url?: string;
	headers?: Record<string, string>;
	enabled?: boolean;
	timeout?: number;
	auth?: unknown;
	oauth?: unknown;
}

export interface McpServerSummary {
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
	config: McpServerConfig;
	primary: boolean;
}

interface Source {
	scope: "user" | "project";
	file: string;
	primary: boolean;
	config: McpConfigFile | null;
}

export function loadMcp(paths: RuntimePaths): { servers: McpServerSummary[]; diagnostics: Diagnostic[]; userPrimary: string; projectPrimary: string | null } {
	const diagnostics: Diagnostic[] = [];
	const userPrimary = path.join(paths.agentDir, "mcp.json");
	const projectPrimary = paths.projectOmpDir ? path.join(paths.projectOmpDir, "mcp.json") : null;
	const sources: Source[] = [readSource("user", userPrimary, true, diagnostics), readSource("user", path.join(paths.agentDir, ".mcp.json"), false, diagnostics)];
	if (paths.projectOmpDir) sources.push(readSource("project", projectPrimary!, true, diagnostics), readSource("project", path.join(paths.projectOmpDir, ".mcp.json"), false, diagnostics));
	const userDisabled = new Set<string>();
	const userEnabled = new Set<string>();
	for (const source of sources.filter((item) => item.scope === "user" && item.config)) {
		for (const name of source.config?.disabledServers ?? []) userDisabled.add(name);
		for (const name of source.config?.enabledServers ?? []) userEnabled.add(name);
	}
	for (const name of userDisabled) if (userEnabled.has(name)) diagnostics.push({ code: "MCP_SERVER_DISABLED_AND_FORCED", severity: "error", message: `${name} is disabled and force-enabled`, scope: "user", target: name, fixable: false });
	const byName = new Map<string, McpServerSummary>();
	const seen = new Map<string, McpServerSummary>();
	for (const source of sources) {
		for (const [name, config] of Object.entries(source.config?.mcpServers ?? {})) {
			const summary = summarizeServer(name, config, source, userDisabled, userEnabled, diagnostics);
			if (seen.has(name)) diagnostics.push({ code: "MCP_SERVER_DUPLICATE", severity: "warning", message: `Duplicate MCP server ${name}`, scope: source.scope, path: source.file, target: name, fixable: false });
			seen.set(name, summary);
			const existing = byName.get(name);
			if (!existing || source.scope === "project") byName.set(name, summary);
		}
	}
	return { servers: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics, userPrimary, projectPrimary };
}

function readSource(scope: "user" | "project", file: string, primary: boolean, diagnostics: Diagnostic[]): Source {
	const result = readJsonFile<McpConfigFile>(file, scope);
	diagnostics.push(...result.diagnostics);
	return { scope, file, primary, config: result.value };
}

function summarizeServer(name: string, config: McpServerConfig, source: Source, userDisabled: Set<string>, userEnabled: Set<string>, diagnostics: Diagnostic[]): McpServerSummary {
	validateServer(name, config, source, diagnostics);
	const rawTransport = config.type ?? "stdio";
	const transport = rawTransport === "http" || rawTransport === "sse" ? rawTransport : "stdio";
	const disabledByUser = userDisabled.has(name);
	const forcedEnabled = !disabledByUser && userEnabled.has(name) && config.enabled === false;
	const enabled = disabledByUser ? false : forcedEnabled ? true : config.enabled !== false;
	const summary: McpServerSummary = { name, scope: source.scope, file: source.file, transport, enabled, disabledByUser, forcedEnabled, hasEnv: Boolean(config.env && Object.keys(config.env).length > 0), hasHeaders: Boolean(config.headers && Object.keys(config.headers).length > 0), hasAuth: Boolean(config.auth || config.oauth), config, primary: source.primary };
	if (config.command !== undefined) summary.command = config.command;
	if (config.url !== undefined) summary.url = config.url;
	return summary;
}

function validateServer(name: string, config: McpServerConfig, source: Source, diagnostics: Diagnostic[]): void {
	if (!name.trim() || /[\\/\0]/.test(name)) diagnostics.push({ code: "MCP_SERVER_INVALID_NAME", severity: "error", message: `Invalid MCP server name ${name}`, scope: source.scope, path: source.file, target: name, fixable: false });
	const transport = config.type ?? "stdio";
	if (transport !== "stdio" && transport !== "http" && transport !== "sse") {
		diagnostics.push({ code: "MCP_SERVER_INVALID_TRANSPORT", severity: "error", message: `Invalid MCP transport for ${name}`, scope: source.scope, path: source.file, target: name, fixable: false });
		return;
	}
	if (transport === "stdio" && !config.command) diagnostics.push({ code: "MCP_SERVER_MISSING_COMMAND", severity: "error", message: `${name} is missing command`, scope: source.scope, path: source.file, target: name, fixable: false });
	if ((transport === "http" || transport === "sse") && !config.url) diagnostics.push({ code: "MCP_SERVER_MISSING_URL", severity: "error", message: `${name} is missing url`, scope: source.scope, path: source.file, target: name, fixable: false });
}
