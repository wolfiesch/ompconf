import * as fs from "node:fs";
import * as path from "node:path";

export function writeJsonAtomic(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = path.join(path.dirname(file), `.${path.basename(file)}.${Date.now()}.tmp`);
	fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`);
	fs.renameSync(temp, file);
}
