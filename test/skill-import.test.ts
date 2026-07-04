import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf } from "./helpers";

interface SkillImportDryRunJson {
	action: "import";
	dryRun: true;
	scope: "user" | "project";
	sourcePath: string;
	targetPath: string;
	skill: {
		name: string;
		description: string;
	};
	confidence: {
		sourceFormat: "omp-skill" | "cursor-mdc";
		targetFormat: "omp-skill";
		safeToImport: boolean;
		score: number;
	};
	writes: [];
}

interface SkillMutationJson {
	action: "import" | "link" | "remove";
	scope: "user" | "project";
	name: string;
	targetPath: string;
	dryRun: false;
	snapshotId: string;
}

let tempRoots: string[] = [];

afterEach(async () => {
	await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
	tempRoots = [];
});

describe("skill import dry-run contract", () => {
	const cases = [
		{
			name: "SKILL.md",
			scope: "user" as const,
			skillName: "imported-planner",
			description: "Plans skill migrations without mutating user configuration.",
			sourceFormat: "omp-skill" as const,
			writeSource: async (root: string) => {
				const sourceDir = join(root, "sources", "imported-planner");
				return writeSkillFile(sourceDir, {
					name: "imported-planner",
					description: "Plans skill migrations without mutating user configuration.",
				});
			},
		},
		{
			name: "Cursor .mdc",
			scope: "project" as const,
			skillName: "cursor-review",
			description: "Review TypeScript changes against Cursor project rules.",
			sourceFormat: "cursor-mdc" as const,
			writeSource: async (root: string) => {
				const sourcePath = join(root, "project", ".cursor", "rules", "cursor-review.mdc");
				await mkdir(dirname(sourcePath), { recursive: true });
				await writeFile(
					sourcePath,
					[
						"---",
						"description: Review TypeScript changes against Cursor project rules.",
						"globs:",
						"  - '**/*.ts'",
						"alwaysApply: false",
						"---",
						"# Cursor review",
						"",
						"Check exported CLI behavior before editing implementation details.",
						"",
					].join("\n"),
				);
				return resolve(sourcePath);
			},
		},
	];

	for (const scenario of cases) {
		test(`skill import --dry-run reports confidence and writes nothing for ${scenario.name}`, async () => {
			const workspace = await createSkillWorkspace(`dry-run-${scenario.sourceFormat}`);
			const sourcePath = await scenario.writeSource(workspace.root);
			const targetPath = targetSkillFile(workspace, scenario.scope, scenario.skillName);

			const result = await runOmpconf([
				"skill",
				"import",
				sourcePath,
				"--scope",
				scenario.scope,
				"--name",
				scenario.skillName,
				"--dry-run",
				"--json",
				"--no-redact",
				"--home",
				workspace.home,
				"--cwd",
				workspace.cwd,
			]);

			expect(result.exitCode).toBe(0);
			expect(result.stderr).toBe("");
			const body = parseStdoutJson<SkillImportDryRunJson>(result);
			expect(body).toMatchObject({
				action: "import",
				dryRun: true,
				scope: scenario.scope,
				sourcePath,
				targetPath,
				skill: {
					name: scenario.skillName,
					description: scenario.description,
				},
				confidence: {
					sourceFormat: scenario.sourceFormat,
					targetFormat: "omp-skill",
					safeToImport: true,
				},
				writes: [],
			});
			expect(body.confidence.score).toBeGreaterThan(0);
			expect(body.confidence.score).toBeLessThanOrEqual(1);
			expect(existsSync(targetPath)).toBe(false);
		});
	}
});

describe("skill import/link/remove write contract", () => {
	for (const scope of ["user", "project"] as const) {
		test(`skill import writes ${scope} scope, shadows managed state, and refuses overwrites`, async () => {
			const workspace = await createSkillWorkspace(`import-${scope}`);
			const sourcePath = await writeSkillFile(join(workspace.root, "sources", `${scope}-auditor`), {
				name: `${scope}-auditor`,
				description: `Audits ${scope} skill installation behavior.`,
			});
			const managedPath = await writeSkillFile(
				join(workspace.home, ".omp", "agent", "managed-skills", `${scope}-auditor`),
				{
					name: `${scope}-auditor`,
					description: "Generated managed skill with the same name must remain read-only.",
				},
			);
			const targetPath = targetSkillFile(workspace, scope, `${scope}-auditor`);

			const createResult = await runOmpconf([
				"skill",
				"import",
				sourcePath,
				"--scope",
				scope,
				"--json",
				"--no-redact",
				"--home",
				workspace.home,
				"--cwd",
				workspace.cwd,
			]);

			expect(createResult.exitCode).toBe(0);
			const createBody = parseStdoutJson<SkillMutationJson>(createResult);
			expect(createBody).toMatchObject({
				action: "import",
				scope,
				name: `${scope}-auditor`,
				targetPath,
				dryRun: false,
			});
			expect(createBody.snapshotId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
			expect(await readFile(targetPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
			expect(await readFile(managedPath, "utf8")).toContain("Generated managed skill");

			const replacementSource = await writeSkillFile(join(workspace.root, "sources", `${scope}-replacement`), {
				name: `${scope}-auditor`,
				description: "This replacement must not overwrite an existing authored skill.",
			});
			const overwriteResult = await runOmpconf([
				"skill",
				"import",
				replacementSource,
				"--scope",
				scope,
				"--json",
				"--no-redact",
				"--home",
				workspace.home,
				"--cwd",
				workspace.cwd,
			]);

			expect(overwriteResult.exitCode).toBe(1);
			expect(`${overwriteResult.stdout}\n${overwriteResult.stderr}`).toContain("already exists");
			expect(await readFile(targetPath, "utf8")).toBe(await readFile(sourcePath, "utf8"));
			expect(await readFile(managedPath, "utf8")).toContain("Generated managed skill");
		});

		test(`skill link and remove operate only on ${scope} authored targets`, async () => {
			const workspace = await createSkillWorkspace(`link-${scope}`);
			const sourceDir = join(workspace.root, "linked-source", `${scope}-linked`);
			await writeSkillFile(sourceDir, {
				name: `${scope}-linked`,
				description: `Linked source for ${scope} scope skill management.`,
			});
			const managedPath = await writeSkillFile(
				join(workspace.home, ".omp", "agent", "managed-skills", `${scope}-linked`),
				{
					name: `${scope}-linked`,
					description: "Managed copy must survive authored link removal.",
				},
			);
			const targetDir = targetSkillDir(workspace, scope, `${scope}-linked`);

			const linkResult = await runOmpconf([
				"skill",
				"link",
				sourceDir,
				"--scope",
				scope,
				"--json",
				"--no-redact",
				"--home",
				workspace.home,
				"--cwd",
				workspace.cwd,
			]);

			expect(linkResult.exitCode).toBe(0);
			const linkBody = parseStdoutJson<SkillMutationJson>(linkResult);
			expect(linkBody).toMatchObject({
				action: "link",
				scope,
				name: `${scope}-linked`,
				targetPath: targetDir,
				dryRun: false,
			});
			expect(linkBody.snapshotId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
			const linkStat = await lstat(targetDir);
			expect(linkStat.isSymbolicLink()).toBe(true);
			expect(resolve(dirname(targetDir), await readlink(targetDir))).toBe(resolve(sourceDir));

			const replacementDir = join(workspace.root, "linked-source", `${scope}-replacement`);
			await writeSkillFile(replacementDir, {
				name: `${scope}-linked`,
				description: "Replacement link must not displace an existing authored link.",
			});
			const overwriteResult = await runOmpconf([
				"skill",
				"link",
				replacementDir,
				"--scope",
				scope,
				"--json",
				"--no-redact",
				"--home",
				workspace.home,
				"--cwd",
				workspace.cwd,
			]);
			expect(overwriteResult.exitCode).toBe(1);
			expect(`${overwriteResult.stdout}\n${overwriteResult.stderr}`).toContain("already exists");
			expect(resolve(dirname(targetDir), await readlink(targetDir))).toBe(resolve(sourceDir));

			const removeResult = await runOmpconf([
				"skill",
				"remove",
				`${scope}-linked`,
				"--scope",
				scope,
				"--json",
				"--no-redact",
				"--home",
				workspace.home,
				"--cwd",
				workspace.cwd,
			]);

			expect(removeResult.exitCode).toBe(0);
			const removeBody = parseStdoutJson<SkillMutationJson>(removeResult);
			expect(removeBody).toMatchObject({
				action: "remove",
				scope,
				name: `${scope}-linked`,
				targetPath: targetDir,
				dryRun: false,
			});
			expect(removeBody.snapshotId).toMatch(/^\d{8}-\d{6}-[0-9a-f]{6}$/);
			expect(existsSync(targetDir)).toBe(false);
			expect(existsSync(join(sourceDir, "SKILL.md"))).toBe(true);
			expect(await readFile(managedPath, "utf8")).toContain("Managed copy must survive");
		});
	}

	test("skill import and remove reject traversal names before touching managed or outside paths", async () => {
		const workspace = await createSkillWorkspace("traversal");
		const sourcePath = await writeSkillFile(join(workspace.root, "sources", "evil"), {
			name: "../managed-skills/generated",
			description: "Traversal must be rejected before writing.",
		});
		const managedTarget = join(workspace.home, ".omp", "agent", "managed-skills", "generated", "SKILL.md");

		const importResult = await runOmpconf([
			"skill",
			"import",
			sourcePath,
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			workspace.home,
			"--cwd",
			workspace.cwd,
		]);
		expect(importResult.exitCode).toBe(1);
		expect(existsSync(managedTarget)).toBe(false);

		const removeResult = await runOmpconf([
			"skill",
			"remove",
			"../managed-skills/generated",
			"--scope",
			"user",
			"--json",
			"--no-redact",
			"--home",
			workspace.home,
			"--cwd",
			workspace.cwd,
		]);
		expect(removeResult.exitCode).toBe(1);
		expect(existsSync(managedTarget)).toBe(false);
	});
});

interface SkillWorkspace {
	root: string;
	home: string;
	project: string;
	cwd: string;
}

async function createSkillWorkspace(name: string): Promise<SkillWorkspace> {
	const root = await createTempRoot(name);
	const home = join(root, "home");
	const project = join(root, "project");
	const cwd = join(project, "packages", "app");
	await mkdir(join(home, ".omp", "agent", "skills"), { recursive: true });
	await mkdir(join(home, ".omp", "agent", "managed-skills"), { recursive: true });
	await mkdir(join(project, ".omp"), { recursive: true });
	await mkdir(cwd, { recursive: true });
	return {
		root: resolve(root),
		home: resolve(home),
		project: resolve(project),
		cwd: resolve(cwd),
	};
}

async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-skill-import-${name}-`));
	tempRoots.push(root);
	return root;
}

async function writeSkillFile(
	dir: string,
	frontmatter: { name: string; description: string },
): Promise<string> {
	await mkdir(dir, { recursive: true });
	const skillPath = join(dir, "SKILL.md");
	await writeFile(
		skillPath,
		[
			"---",
			`name: ${frontmatter.name}`,
			`description: ${frontmatter.description}`,
			"---",
			"",
			`# ${frontmatter.name}`,
			"",
			"Use this skill when its import contract applies.",
			"",
		].join("\n"),
	);
	return resolve(skillPath);
}

function targetSkillFile(workspace: SkillWorkspace, scope: "user" | "project", name: string): string {
	return join(targetSkillDir(workspace, scope, name), "SKILL.md");
}

function targetSkillDir(workspace: SkillWorkspace, scope: "user" | "project", name: string): string {
	if (scope === "user") {
		return join(workspace.home, ".omp", "agent", "skills", name);
	}
	return join(workspace.project, ".omp", "skills", name);
}
