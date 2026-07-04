import * as fs from "node:fs";
import type { Diagnostic, DiagnosticScope } from "./diagnostics";

export interface JsonReadResult<T> {
	value: T | null;
	diagnostics: Diagnostic[];
	exists: boolean;
}

export function readJsonFile<T>(file: string, scope: DiagnosticScope): JsonReadResult<T> {
	try {
		const text = fs.readFileSync(file, "utf8");
		return { value: JSON.parse(text) as T, diagnostics: [], exists: true };
	} catch (error) {
		if (isEnoent(error)) return { value: null, diagnostics: [], exists: false };
		return {
			value: null,
			exists: true,
			diagnostics: [{
				code: "JSON_INVALID",
				severity: "error",
				message: `Invalid JSON in ${file}`,
				scope,
				path: file,
				fixable: false,
			}],
		};
	}
}

export function isEnoent(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
