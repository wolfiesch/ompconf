import * as path from "node:path";

export const repoRoot = path.resolve(import.meta.dir, "..");

const isolatedEnvKeys = [
	"PI_CONFIG_DIR",
	"PI_CODING_AGENT_DIR",
	"OMP_PROFILE",
	"PI_PROFILE",
	"OMPCONF_HOME",
	"XDG_DATA_HOME",
	"XDG_STATE_HOME",
	"XDG_CACHE_HOME",
];

export interface CliResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export async function runOmpconf(
	args: string[],
	options: { env?: Record<string, string>; cwd?: string } = {},
): Promise<CliResult> {
	const env = cleanEnv(options.env);
	const proc = Bun.spawn(["bun", "src/cli.ts", ...args], {
		cwd: options.cwd ?? repoRoot,
		env,
		stdout: "pipe",
		stderr: "pipe",
	});

	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);

	return { exitCode, stdout, stderr };
}

export function parseStdoutJson<T>(result: CliResult): T {
	try {
		return JSON.parse(result.stdout) as T;
	} catch (error) {
		throw new Error(
			`Expected stdout to be JSON, got:\n${result.stdout}\nstderr:\n${result.stderr}`,
			{ cause: error },
		);
	}
}


function cleanEnv(overrides: Record<string, string> = {}): Record<string, string> {
	const env: Record<string, string> = {};

	for (const [key, value] of Object.entries(process.env)) {
		if (typeof value === "string") {
			env[key] = value;
		}
	}

	for (const key of isolatedEnvKeys) {
		delete env[key];
	}

	env.NO_COLOR = "1";
	env.FORCE_COLOR = "0";

	return { ...env, ...overrides };
}
