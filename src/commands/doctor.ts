import type { GlobalOptions } from "../core/schema";
import { printJson, printText } from "../core/output";
import { loadModel } from "../core/model";
import { redactJson } from "../core/redaction";

export function runDoctor(options: GlobalOptions): void {
	const model = loadModel(options);
	const doctor = model.doctor;
	if (options.json) {
		printJson(redactJson(doctor, model.paths.home, options.redact));
	} else {
		const body = {
			doctor,
			mcpServers: model.mcpServers.map((server) => ({
				name: server.name,
				file: server.file,
				config: server.config,
			})),
		};
		printText(JSON.stringify(redactJson(body, model.paths.home, options.redact), null, 2));
	}
	if (doctor.summary.errors > 0 || (options.strict && doctor.summary.warnings > 0)) process.exitCode = 1;
}
