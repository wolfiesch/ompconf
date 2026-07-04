import * as blessed from "blessed";
import type { Widgets } from "blessed";
import * as fs from "node:fs";
import * as path from "node:path";
import type { GlobalOptions } from "../core/schema";
import { printJson, printText } from "../core/output";
import { loadModel, countSnapshots, type LoadedModel } from "../core/model";
import { redactJson, redactPath, redactText } from "../core/redaction";
import { blessedToneTag, statusMarker, statusTone, tuiTheme } from "../tui/theme";
import { runMcp } from "./mcp";

type ScreenKey = "overview" | "doctor" | "mcp" | "skills" | "plugins" | "snapshots";

interface TuiCounts {
	mcpServers: number;
	skills: number;
	plugins: number;
	marketplaces: number;
	diagnostics: number;
	snapshots: number;
}

interface TuiRow {
	name: string;
	status: string;
	scope: string;
	summary: string;
	path: string | null;
	actionable: boolean;
}

interface TuiScreen {
	key: ScreenKey;
	name: string;
	count: number | null;
	rows: TuiRow[];
	counts?: TuiCounts;
}

interface TuiState {
	screens: TuiScreen[];
	activeIndex: number;
	selectedIndex: number;
	query: string;
}

const screenOrder: ScreenKey[] = ["overview", "doctor", "mcp", "skills", "plugins", "snapshots"];
const maxRenderedRows = 20;

export function runTui(options: GlobalOptions, args: string[]): void {
	const model = loadModel(options);
	let state = buildTuiState(model, options, args);
	if (args.includes("--smoke")) {
		const smokeScreens = state.screens.map((screen) => ({
			name: screen.name,
			count: screen.count,
			...(screen.counts ? { counts: screen.counts } : {}),
		}));
		printJson(redactJson({ mode: "smoke", counts: state.screens[0]?.counts, screens: smokeScreens }, model.paths.home, options.redact));
		return;
	}

	const replayKeys = readOption(args, "--keys");
	if (replayKeys) {
		for (const key of replayKeys) state = handleTuiKey(options, state, key);
	}

	if (args.includes("--render") || !process.stdin.isTTY) {
		printText(renderTui(state));
		return;
	}

	startInteractiveTui(options, state);
}

function buildTuiState(model: LoadedModel, options: GlobalOptions, args: string[]): TuiState {
	const counts = {
		mcpServers: model.mcpServers.filter((server) => server.enabled).length,
		skills: model.skills.length,
		plugins: model.plugins.length,
		marketplaces: model.marketplaces.length,
		diagnostics: model.diagnostics.length,
		snapshots: countSnapshots(model.paths.stateDir),
	};
	const screens: TuiScreen[] = [
		{
			key: "overview",
			name: "Overview",
			count: null,
			counts,
			rows: [
				{ name: "Doctor", status: `${counts.diagnostics} findings`, scope: "all", summary: "Run ompconf doctor for detailed diagnostics", path: null, actionable: false },
				{ name: "MCP", status: `${counts.mcpServers} enabled`, scope: "user/project", summary: "Browse configured MCP servers and toggle the selected server", path: null, actionable: false },
				{ name: "Skills", status: `${counts.skills} installed`, scope: "all", summary: "Browse global, project, managed, and external skills", path: null, actionable: false },
				{ name: "Plugins", status: `${counts.plugins} installed`, scope: "user/project", summary: "Browse package, lockfile, and registry plugin surfaces", path: null, actionable: false },
				{ name: "Snapshots", status: `${counts.snapshots} saved`, scope: "state", summary: "Rollback points created before mutations", path: null, actionable: false },
			],
		},
		{
			key: "doctor",
			name: "Doctor",
			count: counts.diagnostics,
			rows: model.diagnostics.map((diagnostic) => ({
				name: diagnostic.code,
				status: diagnostic.severity,
				scope: diagnostic.scope,
				summary: diagnostic.message,
				path: diagnostic.path ? redactPath(diagnostic.path, model.paths.home, options.redact) : null,
				actionable: false,
			})),
		},
		{
			key: "mcp",
			name: "MCP",
			count: counts.mcpServers,
			rows: model.mcpServers.map((server) => ({
				name: server.name,
				status: server.enabled ? "enabled" : "disabled",
				scope: server.scope,
				summary: redactText(server.url ?? server.command ?? server.transport, model.paths.home, options.redact),
				path: redactPath(server.file, model.paths.home, options.redact),
				actionable: true,
			})),
		},
		{
			key: "skills",
			name: "Skills",
			count: counts.skills,
			rows: model.skills.map((skill) => ({
				name: skill.name,
				status: skill.valid ? "valid" : "invalid",
				scope: skill.scope,
				summary: skill.description || "(no description)",
				path: redactPath(skill.path, model.paths.home, options.redact),
				actionable: false,
			})),
		},
		{
			key: "plugins",
			name: "Plugins",
			count: counts.plugins,
			rows: model.plugins.map((plugin) => ({
				name: plugin.id,
				status: plugin.enabled === false ? "disabled" : plugin.enabled === true ? "enabled" : plugin.source,
				scope: plugin.scope,
				summary: plugin.packageName,
				path: redactPath(plugin.path, model.paths.home, options.redact),
				actionable: false,
			})),
		},
		{
			key: "snapshots",
			name: "Snapshots",
			count: counts.snapshots,
			rows: listSnapshots(model.paths.stateDir).map((snapshot) => ({
				name: snapshot,
				status: "saved",
				scope: "state",
				summary: "Rollback snapshot",
				path: redactPath(path.join(model.paths.stateDir, "snapshots", snapshot), model.paths.home, options.redact),
				actionable: false,
			})),
		},
	];
	return {
		screens,
		activeIndex: screenIndex(readOption(args, "--screen")),
		selectedIndex: 0,
		query: readOption(args, "--query") ?? "",
	};
}

function renderTui(state: TuiState): string {
	const active = activeScreen(state);
	const rows = visibleRows(active, state.query);
	const selectedIndex = clampSelection(state.selectedIndex, rows.length);
	const tabs = state.screens.map((screen, index) => {
		const label = `${screen.name}${typeof screen.count === "number" ? ` (${screen.count})` : ""}`;
		return index === state.activeIndex ? `[${label}]` : label;
	}).join("  ");
	const lines = [
		"OMP Config Browser",
		tabs,
		"",
		`Screen: ${active.name}`,
		`Search: ${state.query || "(none)"}`,
		"Controls: / to search, j/k move, click select, wheel scroll, double-click/e/d toggles selected MCP server, q quit.",
		"",
	];
	if (rows.length === 0) {
		lines.push("No rows match the current screen/search.");
		return lines.join("\n");
	}
	const firstRow = visibleWindowStart(selectedIndex, rows.length);
	const renderedRows = rows.slice(firstRow, firstRow + maxRenderedRows);
	for (const [offset, row] of renderedRows.entries()) {
		const index = firstRow + offset;
		const marker = index === selectedIndex ? ">" : " ";
		const pathText = row.path ? `  ${row.path}` : "";
		lines.push(`${marker} ${statusMarker(row.status)} ${row.name}  ${row.status}  ${row.scope}  ${row.summary}${pathText}`);
	}
	if (rows.length > maxRenderedRows) {
		lines.push("");
		lines.push(`Showing ${firstRow + 1}-${firstRow + renderedRows.length} of ${rows.length}. Refine with --query or navigate with j/k.`);
	}
	return lines.join("\n");
}

function startInteractiveTui(options: GlobalOptions, initialState: TuiState): void {
	let state = initialState;
	let currentRows: TuiRow[] = [];
	let searchPromptOpen = false;
	let closeSearchOverlay: (() => void) | null = null;
	let renderingProgrammatically = false;
	const screen = blessed.screen({
		smartCSR: true,
		fullUnicode: true,
		dockBorders: true,
		title: "ompconf",
	});
	screen.program.enableMouse();
	const baseStyle = tuiTheme.styles.base;

	const header = blessed.box({
		top: 0,
		left: 0,
		width: "100%",
		height: 3,
		tags: true,
		content: `{bold} ompconf{/bold}  {${blessedToneTag("accent")}}OMP config, skill, plugin, and MCP browser{/${blessedToneTag("accent")}}`,
		style: { ...baseStyle },
		padding: { left: 1, right: 1 },
	});
	const sidebar = blessed.list({
		top: 3,
		left: 0,
		width: 26,
		bottom: 2,
		mouse: true,
		keys: false,
		interactive: true,
		tags: true,
		border: { type: "line" },
		label: " Sections ",
		style: {
			...baseStyle,
			border: { fg: tuiTheme.tones.accent.fg },
			selected: { fg: tuiTheme.tones.accent.bg ?? "black", bg: tuiTheme.tones.accent.fg, bold: true },
			item: { fg: baseStyle.fg },
		},
	});
	const rowList = blessed.list({
		top: 3,
		left: 26,
		right: 0,
		height: "60%",
		mouse: true,
		keys: false,
		interactive: true,
		scrollable: true,
		alwaysScroll: true,
		tags: true,
		border: { type: "line" },
		label: " Items ",
		style: {
			...baseStyle,
			border: { fg: tuiTheme.tones.info.fg },
			selected: { fg: tuiTheme.tones.good.bg ?? "black", bg: tuiTheme.tones.good.fg, bold: true },
			item: { fg: baseStyle.fg },
			scrollbar: { bg: tuiTheme.tones.info.fg },
		},
		scrollbar: { ch: " ", track: { bg: baseStyle.bg ?? "black" }, style: { bg: tuiTheme.tones.info.fg } },
	});
	const details = blessed.box({
		top: "60%+3",
		left: 26,
		right: 0,
		bottom: 2,
		mouse: true,
		scrollable: true,
		alwaysScroll: true,
		tags: true,
		border: { type: "line" },
		label: " Details ",
		padding: { left: 1, right: 1 },
		style: {
			...baseStyle,
			border: { fg: tuiTheme.tones.accent.fg },
			scrollbar: { bg: tuiTheme.tones.accent.fg },
		},
		scrollbar: { ch: " ", track: { bg: baseStyle.bg ?? "black" }, style: { bg: tuiTheme.tones.accent.fg } },
	});
	const enableButton = blessed.button({
		top: "60%",
		left: 28,
		width: 14,
		height: 1,
		mouse: true,
		keys: false,
		tags: true,
		content: "{bold} Enable {/bold}",
		style: {
			...baseStyle,
			fg: tuiTheme.tones.good.fg,
			focus: { fg: tuiTheme.tones.good.bg ?? "black", bg: tuiTheme.tones.good.fg },
			hover: { fg: tuiTheme.tones.good.bg ?? "black", bg: tuiTheme.tones.good.fg },
		},
	});
	const disableButton = blessed.button({
		top: "60%",
		left: 44,
		width: 14,
		height: 1,
		mouse: true,
		keys: false,
		tags: true,
		content: "{bold} Disable {/bold}",
		style: {
			...baseStyle,
			fg: tuiTheme.tones.bad.fg,
			focus: { fg: tuiTheme.tones.bad.bg ?? "black", bg: tuiTheme.tones.bad.fg },
			hover: { fg: tuiTheme.tones.bad.bg ?? "black", bg: tuiTheme.tones.bad.fg },
		},
	});
	const footer = blessed.box({
		left: 0,
		bottom: 0,
		width: "100%",
		height: 2,
		tags: true,
		content: " {bold}/{/bold} search  {bold}click{/bold} select  {bold}wheel{/bold} scroll  {bold}double-click/e/d{/bold} MCP toggle  {bold}q{/bold} quit",
		style: { ...baseStyle },
	});

	screen.append(header);
	screen.append(sidebar);
	screen.append(rowList);
	screen.append(details);
	screen.append(enableButton);
	screen.append(disableButton);
	screen.append(footer);

	const renderAll = (): void => {
		const active = activeScreen(state);
		currentRows = visibleRows(active, state.query);
		state.selectedIndex = clampSelection(state.selectedIndex, currentRows.length);
		renderingProgrammatically = true;
		try {
			sidebar.setItems(state.screens.map(formatSidebarItem));
			sidebar.select(state.activeIndex);
			rowList.setItems(currentRows.length > 0 ? currentRows.map(formatBlessedRow) : ["No rows match the current screen/search."]);
			rowList.select(currentRows.length > 0 ? state.selectedIndex : 0);
		} finally {
			renderingProgrammatically = false;
		}
		details.setContent(formatDetails(active, currentRows[state.selectedIndex] ?? null, state.query));
		const actionable = isSelectedMcpActionable(state, currentRows);
		enableButton.hidden = !actionable;
		disableButton.hidden = !actionable;
		screen.render();
	};
	const switchSection = (delta: number): void => {
		state.activeIndex = (state.activeIndex + state.screens.length + delta) % state.screens.length;
		state.selectedIndex = 0;
		renderAll();
	};
	const moveSelection = (delta: number): void => {
		state.selectedIndex = clampSelection(state.selectedIndex + delta, currentRows.length);
		renderAll();
	};
	const mutateSelected = (key: "e" | "d"): void => {
		if (!isSelectedMcpActionable(state, currentRows)) return;
		state = toggleSelectedMcp(options, state, key);
		renderAll();
	};
	const openSearchOverlay = (): void => {
		if (searchPromptOpen) return;
		searchPromptOpen = true;
		const priorQuery = state.query;
		const overlay = blessed.box({
			top: "center",
			left: "center",
			width: "70%",
			height: 5,
			tags: true,
			border: { type: "line" },
			label: " Search ",
			padding: { left: 1, right: 1 },
			style: {
				...baseStyle,
				border: { fg: tuiTheme.tones.accent.fg },
			},
		});
		const prompt = blessed.textbox({
			parent: overlay,
			top: 1,
			left: 1,
			right: 1,
			height: 1,
			inputOnFocus: true,
			tags: false,
			value: priorQuery,
			style: { ...baseStyle },
		});
		const closeOverlay = (): void => {
			searchPromptOpen = false;
			closeSearchOverlay = null;
			overlay.destroy();
			rowList.focus();
			screen.render();
		};
		prompt.once("submit", (value: string) => {
			state.query = value;
			state.selectedIndex = 0;
			closeOverlay();
			renderAll();
		});
		prompt.key("escape", () => {
			state.query = priorQuery;
			closeOverlay();
		});
		closeSearchOverlay = closeOverlay;
		screen.append(overlay);
		prompt.focus();
		screen.render();
	};
	const runIfNotSearching = (action: () => void): void => {
		if (searchPromptOpen) return;
		action();
	};

	const cleanup = (): void => {
		screen.destroy();
	};
	const quit = (): void => {
		cleanup();
		process.exit(0);
	};


	screen.key(["escape", "C-c"], (_ch: string, key: Widgets.Events.IKeyEventArg) => {
		if (searchPromptOpen) {
			if (key.name === "escape") closeSearchOverlay?.();
			if (key.ctrl && key.name === "c") quit();
			return;
		}
		quit();
	});
	const hotkeyTargets: Widgets.BlessedElement[] = [rowList, sidebar, details, enableButton, disableButton];
	const bindHotkey = (keys: string | string[], action: () => void): void => {
		for (const target of hotkeyTargets) {
			target.key(keys, () => runIfNotSearching(action));
		}
	};
	bindHotkey("q", quit);
	bindHotkey("/", openSearchOverlay);
	bindHotkey(["tab", "]"], () => switchSection(1));
	bindHotkey("[", () => switchSection(-1));
	bindHotkey(["j", "down"], () => moveSelection(1));
	bindHotkey(["k", "up"], () => moveSelection(-1));
	bindHotkey("e", () => mutateSelected("e"));
	bindHotkey("d", () => mutateSelected("d"));
	rowList.on("select item", (_item: Widgets.BlessedElement, index: number) => {
		if (renderingProgrammatically || searchPromptOpen || currentRows.length === 0) return;
		state.selectedIndex = clampSelection(index, currentRows.length);
		renderAll();
	});
	sidebar.on("select item", (_item: Widgets.BlessedElement, index: number) => {
		if (renderingProgrammatically || searchPromptOpen) return;
		state.activeIndex = clampSelection(index, state.screens.length);
		state.selectedIndex = 0;
		renderAll();
	});
	rowList.on("doubleclick", () => runIfNotSearching(() => {
		const row = currentRows[state.selectedIndex] ?? null;
		mutateSelected(row?.status === "enabled" ? "d" : "e");
	}));
	rowList.on("dblclick", () => runIfNotSearching(() => {
		const row = currentRows[state.selectedIndex] ?? null;
		mutateSelected(row?.status === "enabled" ? "d" : "e");
	}));
	enableButton.on("press", () => runIfNotSearching(() => mutateSelected("e")));
	enableButton.on("click", () => runIfNotSearching(() => mutateSelected("e")));
	disableButton.on("press", () => runIfNotSearching(() => mutateSelected("d")));
	disableButton.on("click", () => runIfNotSearching(() => mutateSelected("d")));
	rowList.on("wheeldown", () => runIfNotSearching(() => moveSelection(3)));
	rowList.on("wheelup", () => runIfNotSearching(() => moveSelection(-3)));
	details.on("wheeldown", () => runIfNotSearching(() => {
		details.scroll(3);
		screen.render();
	}));
	details.on("wheelup", () => runIfNotSearching(() => {
		details.scroll(-3);
		screen.render();
	}));

	rowList.focus();
	renderAll();
}

function formatSidebarItem(screen: TuiScreen): string {
	const count = typeof screen.count === "number" ? ` {${blessedToneTag("muted")}}${screen.count}{/${blessedToneTag("muted")}}` : "";
	return ` ${blessed.escape(screen.name)}${count}`;
}

function formatBlessedRow(row: TuiRow): string {
	const tone = statusTone(row.status);
	const toneTag = blessedToneTag(tone);
	const marker = statusMarker(row.status);
	const name = formatBlessedCell(row.name, 24);
	const status = formatBlessedCell(row.status, 10);
	const scope = formatBlessedCell(row.scope, 9);
	const summary = formatBlessedCell(row.summary, 86);
	const pathText = row.path ? `  {${blessedToneTag("muted")}}${formatBlessedCell(row.path, 120)}{/${blessedToneTag("muted")}}` : "";
	return `{${toneTag}}${marker}{/${toneTag}} ${name} {${toneTag}}${status}{/${toneTag}} {${blessedToneTag("muted")}}${scope}{/${blessedToneTag("muted")}} ${summary}${pathText}`;
}

function formatDetails(screen: TuiScreen, row: TuiRow | null, query: string): string {
	const heading = `{bold}${blessed.escape(screen.name)}{/bold}`;
	const search = query ? `\n{${blessedToneTag("info")}}Filter{/${blessedToneTag("info")}}: ${blessed.escape(query)}` : "";
	if (!row) return `${heading}${search}\n\nNo matching rows.`;
	const tone = statusTone(row.status);
	const action = row.actionable
		? `\n\n{${blessedToneTag("good")}}Actions{/${blessedToneTag("good")}}: press {bold}e{/bold}/{bold}d{/bold}, double-click the row, or click the action buttons to toggle this MCP server.`
		: "";
	const pathText = row.path ? `\n{${blessedToneTag("muted")}}Path{/${blessedToneTag("muted")}}: ${blessed.escape(row.path)}` : "";
	return [
		heading,
		search,
		"",
		`{${blessedToneTag("accent")}}Name{/${blessedToneTag("accent")}}: ${blessed.escape(row.name)}`,
		`{${blessedToneTag(tone)}}Status{/${blessedToneTag(tone)}}: ${blessed.escape(row.status)}`,
		`{${blessedToneTag("accent")}}Scope{/${blessedToneTag("accent")}}: ${blessed.escape(row.scope)}`,
		`{${blessedToneTag("accent")}}Summary{/${blessedToneTag("accent")}}: ${blessed.escape(row.summary)}`,
		pathText,
		action,
	].join("\n");
}

function truncatePlain(value: string, maxLength: number): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength - 1)}…`;
}

function formatBlessedCell(value: string, maxLength: number): string {
	const normalized = value.replace(/[\r\n\t]/g, " ");
	return blessed.escape(truncatePlain(normalized, maxLength));
}

function handleTuiKey(options: GlobalOptions, state: TuiState, key: string): TuiState {
	const active = activeScreen(state);
	const selected = visibleRows(active, state.query)[state.selectedIndex];
	if ((key === "e" || key === "d") && active.key === "mcp" && selected?.actionable) {
		return toggleSelectedMcp(options, state, key);
	}
	applyTuiKey(state, key);
	return state;
}

function toggleSelectedMcp(options: GlobalOptions, state: TuiState, key: "e" | "d"): TuiState {
	const active = activeScreen(state);
	const selected = visibleRows(active, state.query)[state.selectedIndex];
	if (active.key !== "mcp" || !selected?.actionable) return state;
	runMcp(options, [key === "e" ? "enable" : "disable", selected.name, "--scope", "user"]);
	const nextState = buildTuiState(loadModel(options), options, [`--screen`, active.key, "--query", state.query]);
	const nextRows = visibleRows(activeScreen(nextState), nextState.query);
	nextState.selectedIndex = clampSelection(nextRows.findIndex((row) => row.name === selected.name), nextRows.length);
	return nextState;
}

function isSelectedMcpActionable(state: TuiState, rows: TuiRow[]): boolean {
	return activeScreen(state).key === "mcp" && rows[state.selectedIndex]?.actionable === true;
}


function applyTuiKey(state: TuiState, key: string): void {
	const activeRows = visibleRows(activeScreen(state), state.query);
	if (key === "j" || key === "\u001b[B") {
		state.selectedIndex = clampSelection(state.selectedIndex + 1, activeRows.length);
		return;
	}
	if (key === "k" || key === "\u001b[A") {
		state.selectedIndex = clampSelection(state.selectedIndex - 1, activeRows.length);
		return;
	}
	if (key === "]" || key === "\t") {
		state.activeIndex = (state.activeIndex + 1) % state.screens.length;
		state.selectedIndex = 0;
		return;
	}
	if (key === "[") {
		state.activeIndex = (state.activeIndex + state.screens.length - 1) % state.screens.length;
		state.selectedIndex = 0;
	}
}

function activeScreen(state: TuiState): TuiScreen {
	return state.screens[state.activeIndex] ?? state.screens[0] ?? {
		key: "overview",
		name: "Overview",
		count: null,
		rows: [],
	};
}

function visibleRows(screen: TuiScreen, query: string): TuiRow[] {
	const normalized = query.trim().toLowerCase();
	if (!normalized) return screen.rows;
	return screen.rows.filter((row) => {
		const haystack = [row.name, row.status, row.scope, row.summary, row.path ?? ""].join("\n").toLowerCase();
		return haystack.includes(normalized);
	});
}

function visibleWindowStart(selectedIndex: number, length: number): number {
	if (length <= maxRenderedRows) return 0;
	const halfWindow = Math.floor(maxRenderedRows / 2);
	const centered = selectedIndex - halfWindow;
	if (centered <= 0) return 0;
	const maxStart = length - maxRenderedRows;
	return centered > maxStart ? maxStart : centered;
}

function clampSelection(index: number, length: number): number {
	if (length <= 0) return 0;
	if (index < 0) return 0;
	if (index >= length) return length - 1;
	return index;
}

function screenIndex(value: string | null): number {
	if (!value) return 0;
	const normalized = value.toLowerCase() as ScreenKey;
	const index = screenOrder.indexOf(normalized);
	return index === -1 ? 0 : index;
}

function listSnapshots(stateDir: string): string[] {
	const snapshotsDir = path.join(stateDir, "snapshots");
	try {
		return fs.readdirSync(snapshotsDir, { withFileTypes: true })
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
			.sort();
	} catch {
		return [];
	}
}

function readOption(args: string[], name: string): string | null {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] ?? null : null;
}
