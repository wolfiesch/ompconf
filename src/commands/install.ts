import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalOptions } from "../core/schema";
import { deriveRuntimePaths } from "../core/paths";
import { printJson } from "../core/output";
import { redactJson } from "../core/redaction";
import { createSnapshot } from "../core/snapshots";
import { writeJsonAtomic } from "../core/write-json";
import { readLocalPluginPackage } from "../omp/plugins";

export function runPluginLink(options: GlobalOptions, args: string[], action: "link" | "install"): void {
	const pluginDir = path.resolve(args[0] ?? "");
	if (!args[0]) throw new Error(`${action} requires a plugin path`);
	const scope = (readOption(args, "--scope") ?? "user") as "user" | "project";
	const paths = deriveRuntimePaths(options);
	const pluginsDir = scope === "project" ? projectPluginsDir(paths) : paths.pluginsDir;
	const plugin = readLocalPluginPackage(pluginDir);
	const linkPath = pluginLinkPath(pluginsDir, plugin.packageName);
	if (args.includes("--dry-run")) {
		printJson(redactJson({ action, dryRun: true, scope, id: plugin.id, packageName: plugin.packageName, targetPath: linkPath, writes: [] }, paths.home, options.redact));
		return;
	}
	createSnapshot(paths, { redact: options.redact });
	fs.mkdirSync(path.dirname(linkPath), { recursive: true });
	fs.rmSync(linkPath, { recursive: true, force: true });
	fs.symlinkSync(pluginDir, linkPath, "dir");
	const lockPath = path.join(pluginsDir, "omp-plugins.lock.json");
	const lock = readLock(lockPath);
	lock.version = 2;
	lock.plugins ??= {};
	lock.plugins[plugin.id] = { packageName: plugin.packageName, path: pluginDir, linked: true };
	writeJsonAtomic(lockPath, lock);
	printJson(redactJson({ action, scope, id: plugin.id, packageName: plugin.packageName, targetPath: linkPath }, paths.home, options.redact));
}

export function runPluginRegistryMutation(options: GlobalOptions, args: string[], action: "remove" | "enable" | "disable"): void {
	const idOrPackage = args[0];
	if (!idOrPackage) throw new Error(`${action} requires a plugin id or package name`);
	const scope = (readOption(args, "--scope") ?? "user") as "user" | "project";
	const paths = deriveRuntimePaths(options);
	const pluginsDir = scope === "project" ? projectPluginsDir(paths) : paths.pluginsDir;
	const registryPath = path.join(pluginsDir, "installed_plugins.json");
	const registry = readRegistry(registryPath);
	createSnapshot(paths, { redact: options.redact });
	const before = registry.plugins.length;
	if (action === "remove") {
		registry.plugins = registry.plugins.filter((plugin) => plugin.id !== idOrPackage && plugin.packageName !== idOrPackage);
	} else {
		registry.plugins = registry.plugins.map((plugin) => plugin.id === idOrPackage || plugin.packageName === idOrPackage ? { ...plugin, enabled: action === "enable" } : plugin);
	}
	writeJsonAtomic(registryPath, registry);
	printJson(redactJson({ action, scope, target: idOrPackage, path: registryPath, changed: before !== registry.plugins.length || action !== "remove" }, paths.home, options.redact));
}

interface PluginRegistry {
	version: number;
	plugins: Array<{ id: string; packageName?: string; enabled?: boolean }>;
}

function readRegistry(file: string): PluginRegistry {
	try {
		const value = JSON.parse(fs.readFileSync(file, "utf8")) as PluginRegistry;
		return { version: typeof value.version === "number" ? value.version : 2, plugins: Array.isArray(value.plugins) ? value.plugins : [] };
	} catch {
		return { version: 2, plugins: [] };
	}
}

function projectPluginsDir(paths: { projectOmpDir: string | null }): string {
	if (!paths.projectOmpDir) throw new Error("Project scope requires a detected project root");
	return path.join(paths.projectOmpDir, "plugins");
}

function readLock(file: string): { version?: number; plugins?: Record<string, unknown> } {
	try { return JSON.parse(fs.readFileSync(file, "utf8")) as { version?: number; plugins?: Record<string, unknown> }; } catch { return {}; }
}

function readOption(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? null : null;
}


function pluginLinkPath(pluginsDir: string, packageName: string): string {
	validatePackageName(packageName);
	const nodeModules = path.resolve(pluginsDir, "node_modules");
	const target = path.resolve(nodeModules, ...packageName.split("/"));
	if (!isInside(nodeModules, target)) throw new Error(`Invalid plugin package name: ${packageName}`);
	return target;
}

function validatePackageName(packageName: string): void {
	if (!packageName.trim() || packageName.includes("\0") || packageName.includes("\\") || path.isAbsolute(packageName)) {
		throw new Error(`Invalid plugin package name: ${packageName}`);
	}
	const parts = packageName.split("/");
	const validParts = packageName.startsWith("@") ? parts.length === 2 && parts[0] !== "@" && parts[1] !== "" : parts.length === 1;
	if (!validParts || parts.some((part) => part === "." || part === ".." || part === "")) {
		throw new Error(`Invalid plugin package name: ${packageName}`);
	}
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}