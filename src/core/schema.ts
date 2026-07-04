export interface GlobalOptions {
	home: string;
	cwd: string;
	profile: string | null;
	agentDir: string | null;
	stateDir: string | null;
	json: boolean;
	redact: boolean;
	strict: boolean;
}

export interface RuntimePaths {
	home: string;
	cwd: string;
	configRoot: string;
	agentDir: string;
	pluginsDir: string;
	projectRoot: string | null;
	projectOmpDir: string | null;
	stateDir: string;
	marketplacesRegistry: string;
}

export interface WarningJson {
	code: string;
	message: string;
}

export interface StatusJson {
	version: string;
	profile: string | null;
	paths: Pick<RuntimePaths, "home" | "cwd" | "configRoot" | "agentDir" | "pluginsDir" | "projectRoot" | "projectOmpDir" | "stateDir">;
	counts: {
		mcpServers: number;
		skills: number;
		plugins: number;
		marketplaces: number;
		diagnostics: number;
		snapshots: number;
	};
	warnings: WarningJson[];
}
