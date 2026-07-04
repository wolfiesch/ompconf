import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";

interface SkillSummary {
	name: string;
	description: string;
	scope: "user" | "project" | "managed" | "external";
	provider: "omp" | "managed" | "claude" | "codex" | "cursor" | "github" | "custom";
	path: string;
	hidden: boolean;
	valid: boolean;
	diagnostics: string[];
}

interface SkillListJson {
	skills: SkillSummary[];
}

interface DoctorJson {
	ok: boolean;
	summary: { errors: number; warnings: number; info: number };
	diagnostics: Array<{
		code: string;
		severity: "error" | "warning" | "info";
		message: string;
		scope: "user" | "project" | "managed" | "external" | "state";
		path?: string;
		target?: string;
		fixable: boolean;
	}>;
}

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
	tempRoots = [];
});

describe("skill discovery contract", () => {
	test("skill list discovers user, project, managed, and external SKILL.md files with frontmatter", async () => {
		const { home, project, cwd } = await createSkillWorkspace("discovery");
		const userSkillPath = await writeSkill(
			join(home, ".omp", "agent", "skills", "user-writer"),
			{
				name: "user-writer",
				description: "Writes user-scoped runbooks from local context.",
			},
		);
		const shadowingUserPath = await writeSkill(
			join(home, ".omp", "agent", "skills", "managed-shadow"),
			{
				name: "shared-boundary",
				description: "User-authored skill wins over generated managed state.",
			},
		);
		await writeSkill(join(home, ".omp", "agent", "managed-skills", "managed-shadow"), {
			name: "shared-boundary",
			description: "Generated managed copy must not replace authored skills.",
		});
		const managedSkillPath = await writeSkill(
			join(home, ".omp", "agent", "managed-skills", "auto-cache"),
			{
				name: "auto-cache",
				description: "Generated skill visible for diagnosis but not write targets.",
			},
		);
		const projectSkillPath = await writeSkill(join(project, ".omp", "skills", "project-review"), {
			name: "project-review",
			description: "Reviews repository-specific project contracts.",
			hidden: true,
		});
		const claudeSkillPath = await writeSkill(join(home, ".claude", "skills", "claude-bridge"), {
			name: "claude-bridge",
			description: "Imports external Claude skill guidance as read-only context.",
		});
		const githubSkillPath = await writeSkill(join(project, ".github", "skills", "github-review"), {
			name: "github-review",
			description: "Reads repository-hosted GitHub skill guidance.",
		});

		const result = await runOmpconf([
			"skill",
			"list",
			"--scope",
			"all",
			"--provider",
			"all",
			"--json",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			cwd,
		]);

		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");
		const body = parseStdoutJson<SkillListJson>(result);
		expect(body.skills).toHaveLength(6);
		expect(skillByName(body, "user-writer")).toEqual({
			name: "user-writer",
			description: "Writes user-scoped runbooks from local context.",
			scope: "user",
			provider: "omp",
			path: userSkillPath,
			hidden: false,
			valid: true,
			diagnostics: [],
		});
		expect(skillByName(body, "shared-boundary")).toEqual({
			name: "shared-boundary",
			description: "User-authored skill wins over generated managed state.",
			scope: "user",
			provider: "omp",
			path: shadowingUserPath,
			hidden: false,
			valid: true,
			diagnostics: [],
		});
		expect(body.skills.filter((skill) => skill.name === "shared-boundary")).toHaveLength(1);
		expect(skillByName(body, "auto-cache")).toEqual({
			name: "auto-cache",
			description: "Generated skill visible for diagnosis but not write targets.",
			scope: "managed",
			provider: "managed",
			path: managedSkillPath,
			hidden: false,
			valid: true,
			diagnostics: [],
		});
		expect(skillByName(body, "project-review")).toEqual({
			name: "project-review",
			description: "Reviews repository-specific project contracts.",
			scope: "project",
			provider: "omp",
			path: projectSkillPath,
			hidden: true,
			valid: true,
			diagnostics: [],
		});
		expect(skillByName(body, "claude-bridge")).toEqual({
			name: "claude-bridge",
			description: "Imports external Claude skill guidance as read-only context.",
			scope: "external",
			provider: "claude",
			path: claudeSkillPath,
			hidden: false,
			valid: true,
			diagnostics: [],
		});
		expect(skillByName(body, "github-review")).toEqual({
			name: "github-review",
			description: "Reads repository-hosted GitHub skill guidance.",
			scope: "external",
			provider: "github",
			path: githubSkillPath,
			hidden: false,
			valid: true,
			diagnostics: [],
		});
	});

	test("doctor reports missing descriptions, duplicate names, and broken skill symlinks", async () => {
		const { home, project, cwd } = await createSkillWorkspace("diagnostics");
		const missingDescriptionPath = await writeSkill(
			join(home, ".omp", "agent", "skills", "missing-description"),
			{ name: "missing-description" },
		);
		const duplicateUserPath = await writeSkill(join(home, ".omp", "agent", "skills", "dupe-user"), {
			name: "duplicate-skill",
			description: "User duplicate candidate.",
		});
		const duplicateProjectPath = await writeSkill(join(project, ".omp", "skills", "dupe-project"), {
			name: "duplicate-skill",
			description: "Project duplicate candidate.",
		});
		const brokenSymlinkPath = join(home, ".omp", "agent", "skills", "ghost-skill");
		await symlink(join(home, "missing-symlink-target"), brokenSymlinkPath, "dir");

		const result = await runOmpconf([
			"doctor",
			"--json",
			"--strict",
			"--no-redact",
			"--home",
			home,
			"--cwd",
			cwd,
		]);

		expect(result.exitCode).toBe(1);
		const body = parseStdoutJson<DoctorJson>(result);
		expect(body.ok).toBe(false);
		expect(findDiagnostic(body, "SKILL_DESCRIPTION_MISSING")).toMatchObject({
			code: "SKILL_DESCRIPTION_MISSING",
			scope: "user",
			path: missingDescriptionPath,
			fixable: false,
		});
		expect(findDiagnostic(body, "SKILL_DUPLICATE_NAME")).toMatchObject({
			code: "SKILL_DUPLICATE_NAME",
			target: "duplicate-skill",
			fixable: false,
		});
		expect(
			body.diagnostics
				.filter((diagnostic) => diagnostic.code === "SKILL_DUPLICATE_NAME")
				.some((diagnostic) => diagnostic.path === duplicateUserPath || diagnostic.path === duplicateProjectPath),
		).toBe(true);
		expect(findDiagnostic(body, "SKILL_BROKEN_SYMLINK")).toMatchObject({
			code: "SKILL_BROKEN_SYMLINK",
			scope: "user",
			path: brokenSymlinkPath,
			fixable: false,
		});
		expect(body.summary.warnings + body.summary.errors).toBeGreaterThanOrEqual(3);
	});
});

async function createSkillWorkspace(name: string): Promise<{ home: string; project: string; cwd: string }> {
	const root = await createTempRoot(name);
	const home = join(root, "home");
	const project = join(root, "project");
	const cwd = join(project, "packages", "app");
	await mkdir(join(home, ".omp", "agent", "skills"), { recursive: true });
	await mkdir(join(project, ".omp"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	return { home: resolve(home), project: resolve(project), cwd: resolve(cwd) };
}

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-skill-${name}-`));
	tempRoots.push(root);
	return root;
}

async function writeSkill(
	dir: string,
	frontmatter: { name?: string; description?: string; hidden?: boolean },
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const skillPath = join(dir, "SKILL.md");
	const lines = ["---"];
	if (frontmatter.name !== undefined) lines.push(`name: ${frontmatter.name}`);
	if (frontmatter.description !== undefined) lines.push(`description: ${frontmatter.description}`);
	if (frontmatter.hidden !== undefined) lines.push(`hidden: ${frontmatter.hidden}`);
	lines.push("---", "", `# ${frontmatter.name ?? "Unnamed skill"}`, "", "Use this skill when its contract applies.", "");
	await writeFile(skillPath, lines.join("\n"));
	return resolve(skillPath);
}

function skillByName(body: SkillListJson, name: string): SkillSummary {
	const skill = body.skills.find((candidate) => candidate.name === name);
	if (!skill) {
		throw new Error(`Expected skill ${name}, got ${body.skills.map((candidate) => candidate.name).join(", ")}`);
	}
	return skill;
}

function findDiagnostic(body: DoctorJson, code: string): DoctorJson["diagnostics"][number] {
	const diagnostic = body.diagnostics.find((candidate) => candidate.code === code);
	if (!diagnostic) {
		throw new Error(
			`Expected diagnostic ${code}, got ${body.diagnostics.map((candidate) => candidate.code).join(", ")}`,
		);
	}
	return diagnostic;
}
