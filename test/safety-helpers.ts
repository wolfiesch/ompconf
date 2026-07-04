import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseStdoutJson, runOmpconf, type CliResult } from "./helpers";

export interface DoctorJson {
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

export interface SnapshotJson {
	id: string;
	manifestPath: string;
	snapshotPath: string;
	files: Array<{
		root: string;
		relativePath: string;
		originalPath: string;
		redactedPath: string;
		sha256: string;
		snapshotPath: string;
	}>;
}

export interface SnapshotManifest {
	id: string;
	createdAt: string;
	label?: string;
	tool: { name: "ompconf"; version: string };
	roots: Record<string, { originalPath: string; redactedPath: string }>;
	files: Array<{
		root: string;
		relativePath: string;
		originalPath: string;
		redactedPath: string;
		kind: "file" | "symlink";
		mode: number;
		size: number;
		sha256: string;
		snapshotPath: string;
	}>;
}

export interface RollbackJson {
	id: string;
	dryRun: boolean;
	preRollbackSnapshotId?: string;
	restored: Array<{
		root: string;
		relativePath: string;
		targetPath: string;
		sha256: string;
		written: boolean;
	}>;
	refused?: Array<{ targetPath: string; reason: string }>;
}

const tempRoots: string[] = [];

export async function createTempRoot(name: string): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), `ompconf-safety-${name}-`));
	tempRoots.push(root);
	return root;
}

export async function cleanupTempRoots(): Promise<void> {
	await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
	tempRoots.length = 0;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
	await writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeText(path: string, value: string): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	await writeFile(path, value);
}

export async function makeProject(root: string): Promise<string> {
	const project = join(root, "project");
	await mkdir(join(project, ".git"), { recursive: true });
	return project;
}

export async function makeBrokenSymlink(linkPath: string, targetPath: string): Promise<void> {
	await mkdir(dirname(linkPath), { recursive: true });
	await symlink(targetPath, linkPath);
}

export async function runDoctorJson(
	args: string[],
	expectedExitCode: number,
	env: Record<string, string> = {},
): Promise<{ result: CliResult; doctor: DoctorJson }> {
	const result = await runOmpconf(["doctor", "--json", ...args], { env });
	expect(result.exitCode).toBe(expectedExitCode);
	expect(result.stderr).toBe("");
	const doctor = parseStdoutJson<DoctorJson>(result);
	expectDoctorJsonShape(doctor);
	return { result, doctor };
}

export function expectDoctorJsonShape(doctor: DoctorJson): void {
	expect(Object.keys(doctor).sort()).toEqual(["diagnostics", "ok", "summary"]);
	expect(Object.keys(doctor.summary).sort()).toEqual(["errors", "info", "warnings"]);
	for (const diagnostic of doctor.diagnostics) {
		expect(Object.keys(diagnostic).sort()).toEqual(
			expect.arrayContaining(["code", "fixable", "message", "scope", "severity"]),
		);
	}
}

export function diagnosticCodes(doctor: DoctorJson): string[] {
	return doctor.diagnostics.map((diagnostic) => diagnostic.code).sort();
}

export function diagnosticsByCode(doctor: DoctorJson, code: string): DoctorJson["diagnostics"] {
	return doctor.diagnostics.filter((diagnostic) => diagnostic.code === code);
}

export async function readJson<T>(path: string): Promise<T> {
	return JSON.parse(await readFile(path, "utf8")) as T;
}

export async function sha256(path: string): Promise<string> {
	return createHash("sha256").update(await readFile(path)).digest("hex");
}

export async function modeBits(path: string): Promise<number> {
	return (await stat(path)).mode & 0o777;
}

export function expectNoRawHome(output: string, home: string): void {
	expect(output).not.toContain(resolve(home));
	expect(output).not.toContain(home);
}

export function expectFileExists(path: string): void {
	expect(existsSync(path)).toBe(true);
}
