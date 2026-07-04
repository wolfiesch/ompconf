export interface FrontmatterResult {
	frontmatter: Record<string, unknown>;
	body: string;
	valid: boolean;
}

export function readYamlFrontmatter(text: string): FrontmatterResult {
	if (!text.startsWith("---\n")) return { frontmatter: {}, body: text, valid: true };
	const end = text.indexOf("\n---", 4);
	if (end === -1) return { frontmatter: {}, body: text, valid: false };
	const raw = text.slice(4, end);
	const body = text.slice(end + 4).replace(/^\n/, "");
	const frontmatter: Record<string, unknown> = {};
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const colon = trimmed.indexOf(":");
		if (colon <= 0) return { frontmatter, body, valid: false };
		const key = trimmed.slice(0, colon).trim();
		const rawValue = trimmed.slice(colon + 1).trim();
		if (rawValue.includes("[") && !rawValue.includes("]")) return { frontmatter, body, valid: false };
		if (rawValue === "true") frontmatter[key] = true;
		else if (rawValue === "false") frontmatter[key] = false;
		else if (rawValue.startsWith('"') && rawValue.endsWith('"')) frontmatter[key] = rawValue.slice(1, -1);
		else frontmatter[key] = rawValue;
	}
	return { frontmatter, body, valid: true };
}
