import { buildDoctorJson, type Diagnostic, type DoctorJson } from "./diagnostics";
import { deriveRuntimePaths } from "./paths";
import type { GlobalOptions, RuntimePaths } from "./schema";
import { loadMcp, type McpServerSummary } from "../omp/mcp";
import { loadPluginSurface, type MarketplaceItem, type PluginItem } from "../omp/plugins";
import { loadSkills, type SkillSummary } from "../omp/skills";
import * as path from "node:path";
import * as fs from "node:fs";

export interface LoadedModel {
	paths: RuntimePaths;
	mcpServers: McpServerSummary[];
	skills: SkillSummary[];
	plugins: PluginItem[];
	marketplaces: MarketplaceItem[];
	diagnostics: Diagnostic[];
	doctor: DoctorJson;
}

export function loadModel(options: GlobalOptions): LoadedModel {
	const paths = deriveRuntimePaths(options);
	const mcp = loadMcp(paths);
	const skills = loadSkills(paths);
	const pluginSurface = loadPluginSurface(paths);
	const diagnostics = [...mcp.diagnostics, ...skills.diagnostics, ...pluginSurface.diagnostics];
	const doctor = buildDoctorJson(diagnostics);
	return {
		paths,
		mcpServers: mcp.servers,
		skills: skills.skills,
		plugins: pluginSurface.plugins,
		marketplaces: pluginSurface.marketplaces,
		diagnostics,
		doctor,
	};
}

export function countSnapshots(stateDir: string): number {
	const snapshotsDir = path.join(stateDir, "snapshots");
	try {
		return fs.readdirSync(snapshotsDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).length;
	} catch {
		return 0;
	}
}
