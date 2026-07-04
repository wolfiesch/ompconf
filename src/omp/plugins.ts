import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "../core/diagnostics";
import type { RuntimePaths } from "../core/schema";
import { readJsonFile } from "../core/read-json";

export interface PluginItem { id: string; packageName: string; scope: "user" | "project"; enabled: boolean | null; path: string; source: string }
export interface MarketplaceItem { id: string; name: string; path: string; scope: "user"; summary?: string }

const pluginIdPattern = /^[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?@[a-z0-9](?:[a-z0-9.-]{0,62}[a-z0-9])?$/;

export function loadPluginSurface(paths: RuntimePaths): { plugins: PluginItem[]; marketplaces: MarketplaceItem[]; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	const userPlugins = readPluginScope("user", paths.pluginsDir, diagnostics);
	const projectPlugins = paths.projectOmpDir ? readPluginScope("project", path.join(paths.projectOmpDir, "plugins"), diagnostics) : [];
	const marketplaces = readMarketplaces(paths.marketplacesRegistry, diagnostics);
	const projectIds = new Set(projectPlugins.map((item) => item.id));
	for (const item of projectPlugins) {
		if (userPlugins.some((candidate) => candidate.id === item.id)) diagnostics.push({ code: "PLUGIN_SHADOWED", severity: "warning", message: `Project plugin shadows user plugin ${item.id}`, scope: "project", path: item.path, target: item.id, fixable: false });
	}
	return { plugins: [...userPlugins.filter((item) => !projectIds.has(item.id)), ...projectPlugins].sort((a, b) => a.id.localeCompare(b.id)), marketplaces, diagnostics };
}

function readPluginScope(scope: "user" | "project", pluginsDir: string, diagnostics: Diagnostic[]): PluginItem[] {
	const items: PluginItem[] = [];
	const installedPath = path.join(pluginsDir, "installed_plugins.json");
	const installed = readJsonFile<{ version?: unknown; plugins?: unknown }>(installedPath, scope);
	diagnostics.push(...installed.diagnostics.map((item) => ({ ...item, code: "PLUGIN_REGISTRY_INVALID" })));
	if (installed.value) {
		if (typeof installed.value.version !== "number" || !Array.isArray(installed.value.plugins)) {
			const item: Diagnostic = { code: "PLUGIN_REGISTRY_INVALID", severity: "error", message: `Invalid plugin registry ${installedPath}`, scope, path: installedPath, fixable: false };
			if (typeof installed.value.version !== "number") item.target = "version";
			diagnostics.push(item);
		} else {
			for (const raw of installed.value.plugins) {
				if (!raw || typeof raw !== "object") continue;
				const record = raw as Record<string, unknown>;
				const id = typeof record.id === "string" ? record.id : "";
				const packageName = typeof record.packageName === "string" ? record.packageName : id;
				if (!pluginIdPattern.test(id)) diagnostics.push({ code: "PLUGIN_REGISTRY_INVALID", severity: "error", message: `Invalid plugin id ${id}`, scope, path: installedPath, target: id, fixable: false });
				items.push({ id, packageName, scope, enabled: record.enabled !== false, path: installedPath, source: "installed" });
			}
		}
	}
	const packageJsonPath = path.join(pluginsDir, "package.json");
	const packageJson = readJsonFile<{ dependencies?: unknown }>(packageJsonPath, scope);
	diagnostics.push(...packageJson.diagnostics.map((item) => ({ ...item, code: "PLUGIN_PACKAGE_JSON_INVALID" })));
	if (packageJson.value) {
		if (packageJson.value.dependencies !== undefined && (typeof packageJson.value.dependencies !== "object" || Array.isArray(packageJson.value.dependencies) || packageJson.value.dependencies === null)) diagnostics.push({ code: "PLUGIN_PACKAGE_JSON_INVALID", severity: "error", message: `Invalid plugin package.json ${packageJsonPath}`, scope, path: packageJsonPath, fixable: false });
		else for (const name of Object.keys((packageJson.value.dependencies as Record<string, unknown>) ?? {})) items.push({ id: name, packageName: name, scope, enabled: null, path: packageJsonPath, source: "package" });
	}
	const lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
	const lock = readJsonFile<{ plugins?: unknown }>(lockPath, scope);
	diagnostics.push(...lock.diagnostics.map((item) => ({ ...item, code: "PLUGIN_LOCK_INVALID" })));
	if (lock.value) {
		if (typeof lock.value.plugins !== "object" || lock.value.plugins === null || Array.isArray(lock.value.plugins)) diagnostics.push({ code: "PLUGIN_LOCK_INVALID", severity: "error", message: `Invalid plugin lockfile ${lockPath}`, scope, path: lockPath, fixable: false });
		else for (const [id, value] of Object.entries(lock.value.plugins as Record<string, unknown>)) {
			const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
			items.push({ id, packageName: typeof record.packageName === "string" ? record.packageName : id, scope, enabled: null, path: lockPath, source: "lock" });
		}
	}
	const nodeModules = path.join(pluginsDir, "node_modules");
	try {
		for (const entry of fs.readdirSync(nodeModules, { withFileTypes: true })) {
			const entryPath = path.join(nodeModules, entry.name);
			if (entry.isSymbolicLink()) try { fs.statSync(entryPath); } catch { diagnostics.push({ code: "PLUGIN_BROKEN_SYMLINK", severity: "warning", message: `Broken plugin symlink ${entryPath}`, scope, path: entryPath, fixable: false }); }
		}
	} catch {}
	return items;
}

function readMarketplaces(file: string, diagnostics: Diagnostic[]): MarketplaceItem[] {
	const result = readJsonFile<{ version?: unknown; marketplaces?: unknown }>(file, "user");
	diagnostics.push(...result.diagnostics.map((item) => ({ ...item, code: "MARKETPLACE_REGISTRY_INVALID" })));
	if (!result.value) return [];
	if (result.value.version !== 1 || !Array.isArray(result.value.marketplaces)) {
		diagnostics.push({ code: "MARKETPLACE_REGISTRY_INVALID", severity: "error", message: `Invalid marketplace registry ${file}`, scope: "user", path: file, fixable: false });
		return [];
	}
	return result.value.marketplaces.map((raw, index) => {
		const record = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
		const id = String(record.id ?? record.name ?? `marketplace-${index}`);
		const item: MarketplaceItem = { id, name: String(record.name ?? id), path: file, scope: "user" };
		if (typeof record.url === "string") item.summary = record.url;
		return item;
	});
}

export function readLocalPluginPackage(pluginDir: string): { packageName: string; id: string } {
	const parsed = JSON.parse(fs.readFileSync(path.join(pluginDir, "package.json"), "utf8")) as Record<string, unknown>;
	const packageName = typeof parsed.name === "string" ? parsed.name : path.basename(pluginDir);
	const manifest = (parsed.omp && typeof parsed.omp === "object" ? parsed.omp : parsed.pi && typeof parsed.pi === "object" ? parsed.pi : {}) as Record<string, unknown>;
	return { packageName, id: typeof manifest.id === "string" ? manifest.id : `${packageName}@local` };
}
