import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RuntimePaths } from "./schema";
import { redactPath } from "./redaction";

export interface SnapshotManifest {
	id: string;
	createdAt: string;
	label?: string;
	tool: { name: "ompconf"; version: string };
	roots: Record<string, { originalPath: string; redactedPath: string }>;
	files: SnapshotFile[];
}

export interface SnapshotFile {
	root: string;
	relativePath: string;
	originalPath: string;
	redactedPath: string;
	kind: "file" | "symlink";
	mode: number;
	size: number;
	sha256: string;
	snapshotPath: string;
}

const version = "0.1.0";

export function createSnapshot(paths: RuntimePaths, options: { label?: string; redact: boolean }): SnapshotManifest {
	const id = snapshotId();
	const stateDir = paths.stateDir;
	const snapshotDir = path.join(stateDir, "snapshots", id);
	fs.mkdirSync(snapshotDir, { recursive: true, mode: 0o700 });
	try { fs.chmodSync(stateDir, 0o700); } catch {}
	try { fs.chmodSync(path.join(stateDir, "snapshots"), 0o700); } catch {}
	try { fs.chmodSync(snapshotDir, 0o700); } catch {}

	const roots = snapshotRoots(paths, options.redact);
	const files: SnapshotFile[] = [];
	for (const [rootName, rootInfo] of Object.entries(roots)) {
		for (const relativePath of snapshotRelativePaths(rootName, rootInfo.originalPath)) {
			const originalPath = path.join(rootInfo.originalPath, relativePath);
			if (!existsFile(originalPath)) continue;
			const destination = path.join(snapshotDir, "files", rootName, relativePath);
			fs.mkdirSync(path.dirname(destination), { recursive: true });
			const stat = fs.lstatSync(originalPath);
			if (stat.isSymbolicLink()) {
				fs.symlinkSync(fs.readlinkSync(originalPath), destination);
			} else {
				fs.copyFileSync(originalPath, destination);
			}
			if (!stat.isSymbolicLink()) {
				try { fs.chmodSync(destination, stat.mode & 0o777); } catch {}
			}
			files.push({
				root: rootName,
				relativePath,
				originalPath,
				redactedPath: redactPath(originalPath, paths.home, options.redact),
				kind: stat.isSymbolicLink() ? "symlink" : "file",
				mode: stat.mode & 0o777,
				size: stat.size,
				sha256: stat.isSymbolicLink() ? sha256Text(fs.readlinkSync(originalPath)) : sha256File(originalPath),
				snapshotPath: destination,
			});
		}
	}
	const manifest: SnapshotManifest = {
		id,
		createdAt: new Date().toISOString(),
		...(options.label ? { label: options.label } : {}),
		tool: { name: "ompconf", version },
		roots,
		files,
	};
	fs.writeFileSync(path.join(snapshotDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
	return manifest;
}

export function readSnapshotManifest(stateDir: string, id: string): SnapshotManifest {
	return JSON.parse(fs.readFileSync(path.join(stateDir, "snapshots", id, "manifest.json"), "utf8")) as SnapshotManifest;
}

export function snapshotDirectory(stateDir: string, id: string): string {
	return path.join(stateDir, "snapshots", id);
}

function snapshotRoots(paths: RuntimePaths, redact: boolean): Record<string, { originalPath: string; redactedPath: string }> {
	const roots: Record<string, { originalPath: string; redactedPath: string }> = {
		"user-agent": { originalPath: paths.agentDir, redactedPath: redactPath(paths.agentDir, paths.home, redact) },
		"user-root": { originalPath: paths.configRoot, redactedPath: redactPath(paths.configRoot, paths.home, redact) },
		"user-plugins": { originalPath: paths.pluginsDir, redactedPath: redactPath(paths.pluginsDir, paths.home, redact) },
	};
	if (paths.projectOmpDir && paths.projectRoot) {
		roots.project = { originalPath: paths.projectRoot, redactedPath: redactPath(paths.projectRoot, paths.home, redact) };
	}
	return roots;
}

function snapshotRelativePaths(rootName: string, root: string): string[] {
	if (rootName === "user-agent") {
		return [
			"mcp.json",
			".mcp.json",
			...skillPaths(path.join(root, "skills"), "skills"),
			...skillPaths(path.join(root, "managed-skills"), "managed-skills"),
		];
	}
	if (rootName === "user-root") return ["marketplaces.json"];
	if (rootName === "user-plugins") return ["package.json", "omp-plugins.lock.json", "installed_plugins.json"];
	if (rootName === "project") {
		return [
			".omp/mcp.json",
			".omp/.mcp.json",
			".omp/plugin-overrides.json",
			".omp/plugins/installed_plugins.json",
		];
	}
	return [];
}

function skillPaths(root: string, prefix: string): string[] {
	try {
		return fs.readdirSync(root, { withFileTypes: true })
			.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
			.map((entry) => entry.isSymbolicLink() ? path.join(prefix, entry.name) : path.join(prefix, entry.name, "SKILL.md"));
	} catch {
		return [];
	}
}

function existsFile(file: string): boolean {
	try { return fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink(); } catch { return false; }
}

function sha256Text(text: string): string {
	return crypto.createHash("sha256").update(text).digest("hex");
}

function sha256File(file: string): string {
	return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function snapshotId(): string {
	const now = new Date();
	const pad = (value: number) => String(value).padStart(2, "0");
	const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
	const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
	const suffix = crypto.randomBytes(3).toString("hex");
	return `${date}-${time}-${suffix}`;
}
