export function printJson(value: unknown): void {
	Bun.write(Bun.stdout, `${JSON.stringify(value, null, 2)}\n`);
}

export function printText(value: string): void {
	Bun.write(Bun.stdout, value.endsWith("\n") ? value : `${value}\n`);
}

export function printError(value: string): void {
	Bun.write(Bun.stderr, value.endsWith("\n") ? value : `${value}\n`);
}
