import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { GlobalOptions, RuntimePaths } from "./schema";

export function deriveRuntimePaths(options: GlobalOptions): RuntimePaths {
	const home = path.resolve(options.home);
	const cwd = path.resolve(options.cwd);
	const configDirName = Bun.env.PI_CONFIG_DIR || ".omp";
	const baseConfigRoot = path.join(home, configDirName);
	const profile = options.profile;
	const hasNamedProfile = profile !== null && profile !== "default";

	if (hasNamedProfile && options.agentDir) {
		throw new Error("--profile cannot be combined with --agent-dir for named profiles");
	}

	const configRoot = hasNamedProfile
		? path.join(baseConfigRoot, "profiles", profile)
		: baseConfigRoot;
	const defaultAgentDir = path.join(configRoot, "agent");
	const agentDir = options.agentDir && !hasNamedProfile ? path.resolve(options.agentDir) : defaultAgentDir;
	const usingDerivedAgentDir = agentDir === defaultAgentDir;
	const dataRoot = resolveXdgRoot("XDG_DATA_HOME", configRoot, profile, usingDerivedAgentDir);
	const pluginsDir = path.join(dataRoot, "plugins");
	const stateDir = options.stateDir
		? path.resolve(options.stateDir)
		: path.join(home, ".ompconf");
	const projectRoot = findProjectRoot(cwd, home);

	return {
		home,
		cwd,
		configRoot,
		agentDir,
		pluginsDir,
		projectRoot,
		projectOmpDir: projectRoot ? path.join(projectRoot, ".omp") : null,
		stateDir,
		marketplacesRegistry: path.join(configRoot, "marketplaces.json"),
	};
}

function resolveXdgRoot(
	envName: "XDG_DATA_HOME" | "XDG_STATE_HOME" | "XDG_CACHE_HOME",
	configRoot: string,
	profile: string | null,
	usingDerivedAgentDir: boolean,
): string {
	if (!usingDerivedAgentDir) return configRoot;
	if (os.platform() !== "darwin" && os.platform() !== "linux") return configRoot;
	const envValue = Bun.env[envName];
	if (!envValue) return configRoot;
	const appRoot = profile && profile !== "default"
		? path.join(path.resolve(envValue), "omp", "profiles", profile)
		: path.join(path.resolve(envValue), "omp");
	return existsDirectory(appRoot) ? appRoot : configRoot;
}

function findProjectRoot(start: string, home: string): string | null {
	let current = path.resolve(start);
	const resolvedHome = path.resolve(home);
	while (true) {
		if (current !== resolvedHome && existsDirectory(path.join(current, ".omp"))) return current;
		if (current !== resolvedHome && existsDirectory(path.join(current, ".git"))) return current;
		const parent = path.dirname(current);
		if (parent === current) return null;
		current = parent;
	}
}

function existsDirectory(candidate: string): boolean {
	try {
		return fs.statSync(candidate).isDirectory();
	} catch {
		return false;
	}
}
