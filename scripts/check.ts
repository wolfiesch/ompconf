import * as ts from "typescript";

const configPath = ts.findConfigFile(process.cwd(), ts.sys.fileExists, "tsconfig.json");
if (!configPath) {
	console.error("tsconfig.json not found");
	process.exit(1);
}

const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
if (configFile.error) {
	reportDiagnostics([configFile.error]);
	process.exit(1);
}

const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, process.cwd());
if (parsed.errors.length > 0) {
	reportDiagnostics(parsed.errors);
	process.exit(1);
}

const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length > 0) {
	reportDiagnostics(diagnostics);
	process.exit(1);
}

function reportDiagnostics(diagnostics: readonly ts.Diagnostic[]): void {
	const host: ts.FormatDiagnosticsHost = {
		getCanonicalFileName: (fileName) => fileName,
		getCurrentDirectory: () => process.cwd(),
		getNewLine: () => "\n",
	};
	console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, host));
}
