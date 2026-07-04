import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalOptions } from "../core/schema";
import { printJson, printText } from "../core/output";
import { loadModel } from "../core/model";
import { deriveRuntimePaths } from "../core/paths";
import { redactJson, redactPath } from "../core/redaction";
import { createSnapshot } from "../core/snapshots";
import { writeJsonAtomic } from "../core/write-json";
import type { McpConfigFile } from "../omp/mcp";

export function runMcp(options: GlobalOptions, args: string[]): void {
	const subcommand = args[0] ?? "list";
	if (subcommand === "list") return runMcpList(options, args.slice(1));
	if (subcommand === "add") return mutateMcp(options, args.slice(1), "add");
	if (subcommand === "remove") return mutateMcp(options, args.slice(1), "remove");
	if (subcommand === "enable") return mutateMcp(options, args.slice(1), "enable");
	if (subcommand === "disable") return mutateMcp(options, args.slice(1), "disable");
	throw new Error(`Unknown mcp subcommand: ${subcommand}`);
}

function runMcpList(options: GlobalOptions, args: string[]): void {
	const scope = readOption(args, "--scope") ?? "all";
	const includeDisabled = args.includes("--include-disabled");
	const model = loadModel(options);
	let servers = model.mcpServers;
	if (scope !== "all") servers = servers.filter((server) => server.scope === scope);
	if (!includeDisabled) servers = servers.filter((server) => server.enabled);
	const body = { servers: servers.map(({ config: _config, primary: _primary, ...server }) => server) };
	if (options.json) printJson(redactJson(body, model.paths.home, options.redact));
	else {
		printText(JSON.stringify(redactJson(body, model.paths.home, options.redact), null, 2));
	}
}

function mutateMcp(options: GlobalOptions, args: string[], action: "add" | "remove" | "enable" | "disable"): void {
	const paths = deriveRuntimePaths(options);
	const name = args[0];
	if (!name) throw new Error(`mcp ${action} requires a name`);
	const scope = (readOption(args, "--scope") ?? "user") as "user" | "project" | "all";
	createSnapshot(paths, { redact: options.redact });
	const targetScope = scope === "project" ? "project" : "user";
	const targetFile = targetScope === "project" ? projectPrimary(paths) : path.join(paths.agentDir, "mcp.json");
	const config = readConfig(targetFile);
	if (action === "add") {
		config.mcpServers ??= {};
		config.mcpServers[name] = buildAddedServer(args);
	} else if (action === "remove") {
		if (config.mcpServers) delete config.mcpServers[name];
	} else if (action === "disable") {
		config.disabledServers = unique([...(config.disabledServers ?? []), name]);
		config.enabledServers = (config.enabledServers ?? []).filter((item) => item !== name);
	} else if (action === "enable") {
		const beforeDisabled = config.disabledServers ?? [];
		config.disabledServers = beforeDisabled.filter((item) => item !== name);
		if (config.disabledServers.length === 0) delete config.disabledServers;
		const model = loadModel(options);
		const source = model.mcpServers.find((server) => server.name === name);
		if (source?.config.enabled === false && !source.primary) config.enabledServers = unique([...(config.enabledServers ?? []), name]);
	}
	writeJsonAtomic(targetFile, config);
	if (options.json) printJson(redactJson({ action, scope: targetScope, name, path: targetFile }, paths.home, options.redact));
}

function buildAddedServer(args: string[]): Record<string, unknown> {
	const url = readOption(args, "--url");
	if (url) {
		const transport = readOption(args, "--transport") ?? "http";
		return transport === "http" ? { type: "http", url } : { type: transport, url };
	}
	const dash = args.indexOf("--");
	if (dash === -1 || !args[dash + 1]) throw new Error("mcp add stdio requires -- <command> [...args]");
	return { command: args[dash + 1], args: args.slice(dash + 2) };
}

function readConfig(file: string): McpConfigFile {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) as McpConfigFile; } catch { return {}; }
}

function projectPrimary(paths: ReturnSafePaths): string {
	if (!paths.projectOmpDir) throw new Error("Project scope requires a detected project root");
	return path.join(paths.projectOmpDir, "mcp.json");
}

interface ReturnSafePaths {
	projectOmpDir: string | null;
}

function unique(values: string[]): string[] {
	return [...new Set(values)].sort();
}

function readOption(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? null : null;
}
