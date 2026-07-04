import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalOptions } from "../core/schema";
import { deriveRuntimePaths } from "../core/paths";
import { printJson } from "../core/output";
import { redactJson } from "../core/redaction";
import { createSnapshot, readSnapshotManifest, snapshotDirectory } from "../core/snapshots";

export function runRollback(options: GlobalOptions, args: string[]): void {
	const id = args.find((arg) => !arg.startsWith("--"));
	if (!id) throw new Error("rollback requires a snapshot id");
	const dryRun = args.includes("--dry-run");
	const paths = deriveRuntimePaths(options);
	const manifest = readSnapshotManifest(paths.stateDir, id);
	const restored: Array<{ root: string; relativePath: string; targetPath: string; sha256: string; written: boolean }> = [];
	const refused: Array<{ targetPath: string; reason: string }> = [];
	const snapshotDir = snapshotDirectory(paths.stateDir, id);
	const expectedRoots = rollbackRoots(paths);
	for (const file of manifest.files) {
		const root = manifest.roots[file.root];
		const expectedRoot = expectedRoots[file.root];
		const targetPath = file.originalPath;
		const expectedSnapshotPath = path.resolve(snapshotDir, "files", file.root, file.relativePath);
		if (!root || !expectedRoot || path.resolve(root.originalPath) !== path.resolve(expectedRoot)) {
			refused.push({ targetPath, reason: "snapshot root does not match current derived root" });
			continue;
		}
		if (!isInside(root.originalPath, targetPath) || !isInside(expectedRoot, targetPath)) {
			refused.push({ targetPath, reason: "target outside recorded root" });
			continue;
		}
		if (!realParentInside(expectedRoot, targetPath)) {
			refused.push({ targetPath, reason: "target parent escapes derived root" });
			continue;
		}
		if (path.resolve(file.snapshotPath) !== expectedSnapshotPath || !isInside(snapshotDir, expectedSnapshotPath)) {
			refused.push({ targetPath, reason: "snapshot source outside selected snapshot" });
			continue;
		}
		if (snapshotHash(expectedSnapshotPath, file.kind) !== file.sha256) {
			refused.push({ targetPath, reason: "snapshot checksum mismatch" });
			continue;
		}
		restored.push({ root: file.root, relativePath: file.relativePath, targetPath, sha256: file.sha256, written: !dryRun });
	}
	if (refused.length > 0) {
		printJson(redactJson({ id, dryRun, restored: [], refused }, paths.home, options.redact));
		process.exitCode = 1;
		return;
	}
	let preRollbackSnapshotId: string | undefined;
	if (!dryRun) {
		preRollbackSnapshotId = createSnapshot(paths, { redact: options.redact }).id;
		for (const file of manifest.files) {
			const snapshotPath = path.resolve(snapshotDir, "files", file.root, file.relativePath);
			fs.mkdirSync(path.dirname(file.originalPath), { recursive: true });
			fs.rmSync(file.originalPath, { recursive: true, force: true });
			if (file.kind === "symlink") fs.symlinkSync(fs.readlinkSync(snapshotPath), file.originalPath);
			else fs.copyFileSync(snapshotPath, file.originalPath);
			if (file.kind !== "symlink") {
				try { fs.chmodSync(file.originalPath, file.mode); } catch {}
			}
		}
	}
	printJson(redactJson({ id, dryRun, ...(preRollbackSnapshotId ? { preRollbackSnapshotId } : {}), restored }, paths.home, options.redact));
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(root, target);
	return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function realParentInside(root: string, target: string): boolean {
	try {
		const realRoot = fs.realpathSync.native(existingAncestor(root));
		const realParent = fs.realpathSync.native(existingAncestor(path.dirname(target)));
		return isInside(realRoot, realParent);
	} catch {
		return false;
	}
}

function existingAncestor(candidate: string): string {
	let current = path.resolve(candidate);
	while (!fs.existsSync(current)) {
		const parent = path.dirname(current);
		if (parent === current) return current;
		current = parent;
	}
	return current;
}

function snapshotHash(file: string, kind: "file" | "symlink"): string {
	return crypto.createHash("sha256").update(kind === "symlink" ? fs.readlinkSync(file) : fs.readFileSync(file)).digest("hex");
}


function rollbackRoots(paths: { agentDir: string; configRoot: string; pluginsDir: string; projectRoot: string | null }): Record<string, string> {
	const roots: Record<string, string> = {
		"user-agent": paths.agentDir,
		"user-root": paths.configRoot,
		"user-plugins": paths.pluginsDir,
	};
	if (paths.projectRoot) roots.project = paths.projectRoot;
	return roots;
}