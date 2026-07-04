import type { GlobalOptions } from "../core/schema";
import { printJson, printText } from "../core/output";
import { loadModel } from "../core/model";
import { redactJson, redactPath } from "../core/redaction";

interface ListItem {
	kind: "mcp" | "skill" | "plugin" | "marketplace";
	name: string;
	scope: "user" | "project" | "managed" | "external";
	enabled: boolean | null;
	source: string;
	path: string;
	summary?: string;
}

export function runList(options: GlobalOptions, args: string[]): void {
	const kind = readOption(args, "--kind") ?? "all";
	const model = loadModel(options);
	const items: ListItem[] = [];
	if (kind === "all" || kind === "mcp") {
		for (const server of model.mcpServers) {
			items.push(withSummary({ kind: "mcp", name: server.name, scope: server.scope, enabled: server.enabled, source: server.transport, path: server.file }, server.url ?? server.command));
		}
	}
	if (kind === "all" || kind === "skill") {
		items.push(...model.skills.map((skill) => ({ kind: "skill" as const, name: skill.name, scope: skill.scope, enabled: null, source: skill.provider, path: skill.path, summary: skill.description })));
	}
	if (kind === "all" || kind === "plugin") {
		items.push(...model.plugins.map((plugin) => ({ kind: "plugin" as const, name: plugin.id, scope: plugin.scope, enabled: plugin.enabled, source: plugin.source, path: plugin.path, summary: plugin.packageName })));
	}
	if (kind === "all" || kind === "marketplace") {
		for (const marketplace of model.marketplaces) {
			items.push(withSummary({ kind: "marketplace", name: marketplace.id, scope: marketplace.scope, enabled: null, source: "marketplace", path: marketplace.path }, marketplace.summary));
		}
	}
	const body = { items };
	if (options.json) printJson(redactJson(body, model.paths.home, options.redact));
	else printText(items.map((item) => `${item.kind}\t${item.name}\t${redactPath(item.path, model.paths.home, options.redact)}${item.summary ? `\t${redactJson(item.summary, model.paths.home, options.redact)}` : ""}`).join("\n"));
}

function withSummary(item: Omit<ListItem, "summary">, summary: string | undefined): ListItem {
	return summary === undefined ? item : { ...item, summary };
}

function readOption(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? null : null;
}
