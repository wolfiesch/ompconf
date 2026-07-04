import * as fs from "node:fs/promises";
import * as path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const demoRoot = path.join(root, "demo", "fixtures");
const home = path.join(demoRoot, "home");
const project = path.join(home, "workspace", "example-project");
const state = path.join(home, ".ompconf");

await fs.rm(demoRoot, { recursive: true, force: true });
await fs.mkdir(path.join(home, ".omp", "agent", "skills"), { recursive: true });
await fs.mkdir(path.join(home, ".omp", "plugins"), { recursive: true });
await fs.mkdir(path.join(project, ".omp", "skills"), { recursive: true });
await fs.mkdir(path.join(state, "snapshots", "20260101-090000-demo-a"), { recursive: true });
await fs.mkdir(path.join(state, "snapshots", "20260102-140000-demo-b"), { recursive: true });

await writeJson(path.join(home, ".omp", "agent", "mcp.json"), {
  mcpServers: {
    "github-tools": { type: "http", url: "https://mcp.example.com/github" },
    "browser-lab": { command: "browser-lab", args: ["--safe-demo"] },
    "workspace-index": { command: "workspace-index", enabled: false },
    "docs-search": { type: "sse", url: "https://mcp.example.com/docs" },
  },
  disabledServers: ["workspace-index"],
});

await writeJson(path.join(home, ".omp", "plugins", "package.json"), {
  dependencies: {
    "@ompconf/plugin-marketplace": "1.0.0",
    "@ompconf/plugin-team-presets": "1.0.0",
  },
});
await writeJson(path.join(home, ".omp", "plugins", "installed_plugins.json"), {
  version: 2,
  plugins: [
    { id: "marketplace@demo", packageName: "@ompconf/plugin-marketplace", enabled: true },
    { id: "team-presets@demo", packageName: "@ompconf/plugin-team-presets", enabled: false },
  ],
});
await writeJson(path.join(home, ".omp", "marketplaces.json"), {
  version: 1,
  marketplaces: [{ id: "demo", name: "Demo Marketplace", url: "https://marketplace.example.com" }],
});

const skills = [
  ["release-checklist", "Prepare release notes, screenshots, changelog checks, and final verification."],
  ["mcp-debugger", "Inspect MCP server health, transport type, config source, and enablement state."],
  ["skill-curator", "Find duplicate, stale, invalid, or shadowed skills before publishing configs."],
  ["workspace-doctor", "Audit user and project OMP config paths for portable team setups."],
  ["screenshot-studio", "Capture polished terminal screenshots from sanitized demo fixtures."],
  ["plugin-builder", "Package reusable skills, commands, and MCP defaults into a plugin bundle."],
];
for (const [name, description] of skills) {
  await writeSkill(path.join(home, ".omp", "agent", "skills", name, "SKILL.md"), name, description);
}
await writeSkill(
  path.join(project, ".omp", "skills", "project-onboarding", "SKILL.md"),
  "project-onboarding",
  "Explain project-specific commands, MCP servers, and conventions for new contributors.",
);

await fs.writeFile(
  path.join(state, "snapshots", "20260101-090000-demo-a", "manifest.json"),
  `${JSON.stringify({ id: "20260101-090000-demo-a", label: "before MCP cleanup" }, null, 2)}\n`,
);
await fs.writeFile(
  path.join(state, "snapshots", "20260102-140000-demo-b", "manifest.json"),
  `${JSON.stringify({ id: "20260102-140000-demo-b", label: "before plugin install" }, null, 2)}\n`,
);

async function writeSkill(file, name, description) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `---\nname: ${name}\ndescription: ${description}\n---\n\n${description}\n`);
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

console.log(JSON.stringify({ home, project, state }, null, 2));
