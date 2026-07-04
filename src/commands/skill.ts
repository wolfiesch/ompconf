import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalOptions } from "../core/schema";
import { printJson } from "../core/output";
import { loadModel } from "../core/model";
import { deriveRuntimePaths } from "../core/paths";
import { redactJson } from "../core/redaction";
import { createSnapshot } from "../core/snapshots";
import { readSkillFile, renderSkillMarkdown } from "../omp/skills";

export function runSkill(options: GlobalOptions, args: string[]): void {
	const subcommand = args[0] ?? "list";
	if (subcommand === "list") return runSkillList(options, args.slice(1));
	if (subcommand === "import") return runSkillImport(options, args.slice(1));
	if (subcommand === "link") return runSkillLink(options, args.slice(1));
	if (subcommand === "remove") return runSkillRemove(options, args.slice(1));
	throw new Error(`Unknown skill subcommand: ${subcommand}`);
}

function runSkillList(options: GlobalOptions, args: string[]): void {
	const scope = readOption(args, "--scope") ?? "all";
	const provider = readOption(args, "--provider") ?? "all";
	const model = loadModel(options);
	let skills = model.skills;
	if (scope !== "all") skills = skills.filter((skill) => skill.scope === scope);
	if (provider !== "all") skills = skills.filter((skill) => skill.provider === provider);
	printJson(redactJson({ skills }, model.paths.home, options.redact));
}

function runSkillImport(options: GlobalOptions, args: string[]): void {
	const sourcePath = path.resolve(args[0] ?? "");
	if (!args[0]) throw new Error("skill import requires a source path");
	const scope = (readOption(args, "--scope") ?? "user") as "user" | "project";
	const nameOverride = readOption(args, "--name") ?? undefined;
	const dryRun = args.includes("--dry-run");
	const paths = deriveRuntimePaths(options);
	const source = readSkillFile(sourcePath, nameOverride);
	const name = nameOverride ?? source.name;
	const description = source.description;
	const targetPath = targetSkillFile(paths, scope, name);
	if (dryRun) {
		printJson(redactJson({
			action: "import",
			dryRun: true,
			scope,
			sourcePath,
			targetPath,
			skill: { name, description },
			confidence: { sourceFormat: source.format, targetFormat: "omp-skill", safeToImport: true, score: description ? 1 : 0.5 },
			writes: [],
		}, paths.home, options.redact));
		return;
	}
	if (fs.existsSync(targetPath)) throw new Error(`${targetPath} already exists`);
	const snapshot = createSnapshot(paths, { redact: options.redact });
	fs.mkdirSync(path.dirname(targetPath), { recursive: true });
	if (source.format === "cursor-mdc") fs.writeFileSync(targetPath, renderSkillMarkdown(name, description, source.content));
	else fs.copyFileSync(sourcePath, targetPath);
	printJson(redactJson({ action: "import", scope, name, targetPath, dryRun: false, snapshotId: snapshot.id }, paths.home, options.redact));
}

function runSkillLink(options: GlobalOptions, args: string[]): void {
	const sourceDir = path.resolve(args[0] ?? "");
	if (!args[0]) throw new Error("skill link requires a source dir");
	const scope = (readOption(args, "--scope") ?? "user") as "user" | "project";
	const paths = deriveRuntimePaths(options);
	const source = readSkillFile(path.join(sourceDir, "SKILL.md"));
	const targetDir = targetSkillDir(paths, scope, source.name);
	if (fs.existsSync(targetDir)) throw new Error(`${targetDir} already exists`);
	const snapshot = createSnapshot(paths, { redact: options.redact });
	fs.mkdirSync(path.dirname(targetDir), { recursive: true });
	fs.symlinkSync(sourceDir, targetDir, "dir");
	printJson(redactJson({ action: "link", scope, name: source.name, targetPath: targetDir, dryRun: false, snapshotId: snapshot.id }, paths.home, options.redact));
}

function runSkillRemove(options: GlobalOptions, args: string[]): void {
	const name = args[0];
	if (!name) throw new Error("skill remove requires a name");
	const scope = (readOption(args, "--scope") ?? "user") as "user" | "project";
	const paths = deriveRuntimePaths(options);
	const targetDir = targetSkillDir(paths, scope, name);
	const snapshot = createSnapshot(paths, { redact: options.redact });
	fs.rmSync(targetDir, { recursive: true, force: true });
	printJson(redactJson({ action: "remove", scope, name, targetPath: targetDir, dryRun: false, snapshotId: snapshot.id }, paths.home, options.redact));
}

function targetSkillFile(paths: ReturnSafePaths, scope: "user" | "project", name: string): string {
	return path.join(targetSkillDir(paths, scope, name), "SKILL.md");
}

function targetSkillDir(paths: ReturnSafePaths, scope: "user" | "project", name: string): string {
	validateSkillName(name);
	const root = scope === "project" ? projectSkillsRoot(paths) : path.join(paths.agentDir, "skills");
	const target = path.resolve(root, name);
	if (!isInside(root, target)) throw new Error(`Invalid skill name: ${name}`);
	return target;
}

function projectSkillsRoot(paths: ReturnSafePaths): string {
	if (!paths.projectOmpDir) throw new Error("Project scope requires a detected project root");
	return path.join(paths.projectOmpDir, "skills");
}

function validateSkillName(name: string): void {
	if (!name.trim() || name.includes("\0") || path.isAbsolute(name) || name.includes("/") || name.includes("\\")) {
		throw new Error(`Invalid skill name: ${name}`);
	}
}

function isInside(root: string, target: string): boolean {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface ReturnSafePaths {
	agentDir: string;
	projectOmpDir: string | null;
}

function readOption(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? null : null;
}
