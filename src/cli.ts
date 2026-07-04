#!/usr/bin/env bun
import * as os from "node:os";
import * as path from "node:path";
import { printError, printText } from "./core/output";
import type { GlobalOptions } from "./core/schema";
import { runStatus } from "./commands/status";
import { runDoctor } from "./commands/doctor";
import { runList } from "./commands/list";
import { runMcp } from "./commands/mcp";
import { runSkill } from "./commands/skill";
import { runPluginLink, runPluginRegistryMutation } from "./commands/install";
import { runSnapshot } from "./commands/snapshot";
import { runRollback } from "./commands/rollback";
import { runTui } from "./commands/tui";

const commands = [
	"status",
	"doctor",
	"list",
	"snapshot",
	"mcp",
	"skill",
	"install",
	"link",
	"remove",
	"enable",
	"disable",
	"rollback",
	"tui",
] as const;

type Command = (typeof commands)[number];

interface ParsedArgs {
	command: Command | null;
	options: GlobalOptions;
	rest: string[];
	help: boolean;
}

try {
	const parsed = parseArgs(Bun.argv.slice(2));
	if (parsed.help) {
		printHelp();
		process.exit(0);
	}
	if (!parsed.command) {
		runTui(parsed.options, parsed.rest);
	} else {
		switch (parsed.command) {
			case "status":
				runStatus(parsed.options);
				break;
			case "doctor":
				runDoctor(parsed.options);
				break;
			case "list":
				runList(parsed.options, parsed.rest);
				break;
			case "mcp":
				runMcp(parsed.options, parsed.rest);
				break;
			case "skill":
				runSkill(parsed.options, parsed.rest);
				break;
			case "install":
			case "link":
				runPluginLink(parsed.options, parsed.rest, parsed.command);
				break;
			case "snapshot":
				runSnapshot(parsed.options, parsed.rest);
				break;
			case "rollback":
				runRollback(parsed.options, parsed.rest);
				break;
			case "tui":
				runTui(parsed.options, parsed.rest);
				break;
			case "remove":
			case "enable":
			case "disable":
				runPluginRegistryMutation(parsed.options, parsed.rest, parsed.command);
				break;
		}
	}
} catch (error) {
	printError(error instanceof Error ? error.message : String(error));
	process.exit(1);
}

function parseArgs(args: string[]): ParsedArgs {
	let command: Command | null = null;
	const rest: string[] = [];
	let help = false;
	let agentDirFromFlag = false;
	let restMode = false;
	const options: GlobalOptions = {
		home: os.homedir(),
		cwd: process.cwd(),
		profile: Bun.env.OMP_PROFILE || Bun.env.PI_PROFILE || null,
		agentDir: null,
		stateDir: Bun.env.OMPCONF_HOME || null,
		json: false,
		redact: true,
		strict: false,
	};

	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (!arg) continue;
		if (restMode) {
			rest.push(arg);
			continue;
		}
		if (arg === "--help" || arg === "-h") {
			help = true;
			continue;
		}
		if (arg === "--json") {
			options.json = true;
			continue;
		}
		if (arg === "--no-redact") {
			options.redact = false;
			continue;
		}
		if (arg === "--strict") {
			options.strict = true;
			continue;
		}
		if (arg === "--home") {
			options.home = path.resolve(readOptionValue(args, index, arg));
			index += 1;
			continue;
		}
		if (arg === "--cwd") {
			options.cwd = path.resolve(readOptionValue(args, index, arg));
			index += 1;
			continue;
		}
		if (arg === "--profile") {
			options.profile = readOptionValue(args, index, arg);
			index += 1;
			continue;
		}
		if (arg === "--agent-dir") {
			options.agentDir = path.resolve(readOptionValue(args, index, arg));
			agentDirFromFlag = true;
			index += 1;
			continue;
		}
		if (arg === "--state-dir") {
			options.stateDir = path.resolve(readOptionValue(args, index, arg));
			index += 1;
			continue;
		}
		if (command && arg === "--") {
			restMode = true;
			rest.push(arg);
			continue;
		}
		if (!command && isCommand(arg)) {
			command = arg;
			continue;
		}
		if (command) {
			rest.push(arg);
			continue;
		}
		throw new Error(`Unknown argument: ${arg}`);
	}

	const hasNamedProfile = options.profile !== null && options.profile !== "default";
	if (!agentDirFromFlag && !hasNamedProfile && Bun.env.PI_CODING_AGENT_DIR) {
		options.agentDir = path.resolve(Bun.env.PI_CODING_AGENT_DIR);
	}

	return { command, options, rest, help };
}

function readOptionValue(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value) throw new Error(`${option} requires a value`);
	return value;
}

function isCommand(value: string): value is Command {
	return commands.includes(value as Command);
}

function printHelp(): void {
	printText(`ompconf - Standalone OMP config and extension manager

Usage:
  ompconf <command> [options]

Commands:
  ${commands.join("\n  ")}

Global options:
  --home <path>        User home to inspect
  --cwd <path>         Project/current directory to inspect
  --profile <name>     OMP profile name
  --agent-dir <path>   Override default-profile OMP agent directory
  --state-dir <path>   ompconf state directory
  --json               Emit stable JSON
  --strict             Exit nonzero on warnings
  --help               Show this help`);
}
