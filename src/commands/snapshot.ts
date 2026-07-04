import type { GlobalOptions } from "../core/schema";
import { deriveRuntimePaths } from "../core/paths";
import { printJson, printText } from "../core/output";
import { redactJson, redactPath } from "../core/redaction";
import { createSnapshot, snapshotDirectory } from "../core/snapshots";

export function runSnapshot(options: GlobalOptions, args: string[]): void {
	const label = readOption(args, "--label") ?? undefined;
	const paths = deriveRuntimePaths(options);
	const snapshotOptions = label === undefined ? { redact: options.redact } : { label, redact: options.redact };
	const manifest = createSnapshot(paths, snapshotOptions);
	const snapshotPath = snapshotDirectory(paths.stateDir, manifest.id);
	const body = { id: manifest.id, manifestPath: `${snapshotPath}/manifest.json`, snapshotPath, files: manifest.files };
	if (options.json) printJson(redactJson(body, paths.home, options.redact));
	else printText(`Snapshot ${manifest.id} created at ${redactPath(snapshotPath, paths.home, options.redact)}`);
}

function readOption(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? null : null;
}
