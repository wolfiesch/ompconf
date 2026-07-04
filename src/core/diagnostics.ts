export type DiagnosticSeverity = "error" | "warning" | "info";
export type DiagnosticScope = "user" | "project" | "managed" | "external" | "state";

export interface Diagnostic {
	code: string;
	severity: DiagnosticSeverity;
	message: string;
	scope: DiagnosticScope;
	path?: string;
	target?: string;
	fixable: boolean;
}

export interface DoctorJson {
	ok: boolean;
	summary: { errors: number; warnings: number; info: number };
	diagnostics: Diagnostic[];
}

export function diagnostic(input: Diagnostic): Diagnostic {
	return input;
}

export function buildDoctorJson(diagnostics: Diagnostic[]): DoctorJson {
	const summary = { errors: 0, warnings: 0, info: 0 };
	for (const item of diagnostics) {
		if (item.severity === "error") summary.errors += 1;
		else if (item.severity === "warning") summary.warnings += 1;
		else summary.info += 1;
	}
	return { ok: summary.errors === 0, summary, diagnostics };
}
