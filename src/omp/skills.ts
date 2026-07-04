import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "../core/diagnostics";
import { readYamlFrontmatter } from "../core/read-yaml-frontmatter";
import type { RuntimePaths } from "../core/schema";

export interface SkillSummary {
	name: string;
	description: string;
	scope: "user" | "project" | "managed" | "external";
	provider: "omp" | "managed" | "claude" | "codex" | "cursor" | "github" | "custom";
	path: string;
	hidden: boolean;
	valid: boolean;
	diagnostics: string[];
}

interface SkillRoot {
	dir: string;
	scope: SkillSummary["scope"];
	provider: SkillSummary["provider"];
	requiredDescription: boolean;
}

export function loadSkills(paths: RuntimePaths): { skills: SkillSummary[]; diagnostics: Diagnostic[] } {
	const diagnostics: Diagnostic[] = [];
	const roots: SkillRoot[] = [
		{ dir: path.join(paths.agentDir, "skills"), scope: "user", provider: "omp", requiredDescription: true },
		{ dir: path.join(paths.agentDir, "managed-skills"), scope: "managed", provider: "managed", requiredDescription: false },
		{ dir: path.join(paths.home, ".claude", "skills"), scope: "external", provider: "claude", requiredDescription: false },
		{ dir: path.join(paths.home, ".codex", "skills"), scope: "external", provider: "codex", requiredDescription: false },
	];
	if (paths.projectRoot) {
		roots.push(
			{ dir: path.join(paths.projectRoot, ".omp", "skills"), scope: "project", provider: "omp", requiredDescription: true },
			{ dir: path.join(paths.projectRoot, ".codex", "skills"), scope: "external", provider: "codex", requiredDescription: false },
			{ dir: path.join(paths.projectRoot, ".github", "skills"), scope: "external", provider: "github", requiredDescription: false },
		);
	}
	const raw: SkillSummary[] = [];
	for (const root of roots) raw.push(...scanSkillRoot(root, diagnostics));

	const byRealpath = new Set<string>();
	const dedupedReal: SkillSummary[] = [];
	for (const skill of raw) {
		let real = skill.path;
		try { real = fs.realpathSync(skill.path); } catch {}
		if (byRealpath.has(real)) continue;
		byRealpath.add(real);
		dedupedReal.push(skill);
	}

	const byName = new Map<string, SkillSummary>();
	for (const skill of dedupedReal) {
		const existing = byName.get(skill.name);
		if (existing) {
			diagnostics.push({ code: "SKILL_DUPLICATE_NAME", severity: "warning", message: `Duplicate skill ${skill.name}`, scope: skill.scope, path: skill.path, target: skill.name, fixable: false });
			if (rankSkill(skill) < rankSkill(existing)) byName.set(skill.name, skill);
		} else {
			byName.set(skill.name, skill);
		}
	}
	return { skills: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)), diagnostics };
}

function scanSkillRoot(root: SkillRoot, diagnostics: Diagnostic[]): SkillSummary[] {
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(root.dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const skills: SkillSummary[] = [];
	for (const entry of entries) {
		const entryPath = path.join(root.dir, entry.name);
		if (entry.isSymbolicLink()) {
			try { fs.statSync(entryPath); } catch {
				diagnostics.push({ code: "SKILL_BROKEN_SYMLINK", severity: "warning", message: `Broken skill symlink ${entryPath}`, scope: root.scope, path: entryPath, fixable: false });
				continue;
			}
		}
		const skillPath = path.join(entryPath, "SKILL.md");
		let text: string;
		try { text = fs.readFileSync(skillPath, "utf8"); } catch { continue; }
		const parsed = readYamlFrontmatter(text);
		const localDiagnostics: string[] = [];
		if (!parsed.valid) {
			localDiagnostics.push("YAML_FRONTMATTER_INVALID");
			diagnostics.push({ code: "YAML_FRONTMATTER_INVALID", severity: "error", message: `Invalid YAML frontmatter in ${skillPath}`, scope: root.scope, path: skillPath, fixable: false });
		}
		const name = stringField(parsed.frontmatter.name) || entry.name;
		const description = stringField(parsed.frontmatter.description);
		if (root.requiredDescription && !description) {
			localDiagnostics.push("SKILL_DESCRIPTION_MISSING");
			diagnostics.push({ code: "SKILL_DESCRIPTION_MISSING", severity: "error", message: `Skill ${name} is missing description`, scope: root.scope, path: skillPath, target: name, fixable: false });
		}
		skills.push({
			name,
			description,
			scope: root.scope,
			provider: root.provider,
			path: skillPath,
			hidden: parsed.frontmatter.hidden === true,
			valid: localDiagnostics.length === 0,
			diagnostics: localDiagnostics,
		});
	}
	return skills;
}

function stringField(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function rankSkill(skill: SkillSummary): number {
	if (skill.scope === "project") return 0;
	if (skill.scope === "user") return 1;
	if (skill.scope === "external") return 2;
	return 3;
}

export function readSkillFile(file: string, fallbackName?: string): { name: string; description: string; content: string; valid: boolean; format: "omp-skill" | "cursor-mdc" } {
	const content = fs.readFileSync(file, "utf8");
	const parsed = readYamlFrontmatter(content);
	const isCursor = file.endsWith(".mdc");
	const base = fallbackName || path.basename(path.dirname(file));
	return {
		name: stringField(parsed.frontmatter.name) || (isCursor ? path.basename(file, ".mdc") : base),
		description: stringField(parsed.frontmatter.description),
		content,
		valid: parsed.valid,
		format: isCursor ? "cursor-mdc" : "omp-skill",
	};
}

export function renderSkillMarkdown(name: string, description: string, body: string): string {
	return ["---", `name: ${name}`, `description: ${description}`, "---", "", body.trim(), ""].join("\n");
}
