import type { GlobalOptions, StatusJson } from "../core/schema";
import { printJson, printText } from "../core/output";
import { loadModel, countSnapshots } from "../core/model";
import { redactJson, redactPath } from "../core/redaction";

const version = "0.1.0";

export function runStatus(options: GlobalOptions): void {
	const model = loadModel(options);
	const paths = model.paths;
	const status: StatusJson = {
		version,
		profile: options.profile,
		paths: {
			home: paths.home,
			cwd: paths.cwd,
			configRoot: paths.configRoot,
			agentDir: paths.agentDir,
			pluginsDir: paths.pluginsDir,
			projectRoot: paths.projectRoot,
			projectOmpDir: paths.projectOmpDir,
			stateDir: paths.stateDir,
		},
		counts: {
			mcpServers: model.mcpServers.filter((server) => server.enabled).length,
			skills: model.skills.length,
			plugins: model.plugins.length,
			marketplaces: model.marketplaces.length,
			diagnostics: model.diagnostics.length,
			snapshots: countSnapshots(paths.stateDir),
		},
		warnings: [],
	};

	if (options.json) {
		printJson(redactJson(status, paths.home, options.redact));
		return;
	}

	printText([
		`ompconf ${version}`,
		`Profile: ${status.profile ?? "default"}`,
		`Home: ${redactPath(status.paths.home, paths.home, options.redact)}`,
		`Config: ${redactPath(status.paths.configRoot, paths.home, options.redact)}`,
		`Agent: ${redactPath(status.paths.agentDir, paths.home, options.redact)}`,
		`Plugins: ${redactPath(status.paths.pluginsDir, paths.home, options.redact)}`,
		`Project: ${status.paths.projectRoot ? redactPath(status.paths.projectRoot, paths.home, options.redact) : "none"}`,
	].join("\n"));
}

