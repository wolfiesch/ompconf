const secretKeyPattern = /(token|secret|password|apiKey|authorization|cookie|credential)/i;

export function redactPath(pathValue: string, home: string, redact: boolean): string {
	if (!redact) return pathValue;
	if (pathValue === home) return "~";
	const prefix = `${home}/`;
	if (pathValue.startsWith(prefix)) return `~/${pathValue.slice(prefix.length)}`;
	return pathValue;
}

export function redactText(value: string, home: string, redact: boolean): string {
	if (!redact) return value;
	return redactPath(redactUrlSecrets(value), home, true);
}

export function redactJson(value: unknown, home: string, redact: boolean): unknown {
	if (!redact) return value;
	if (typeof value === "string") return redactPath(redactUrlSecrets(value), home, true);
	if (Array.isArray(value)) return value.map((item) => redactJson(item, home, true));
	if (!value || typeof value !== "object") return value;

	const out: Record<string, unknown> = {};
	for (const [key, child] of Object.entries(value)) {
		out[key] = secretKeyPattern.test(key) ? "[REDACTED]" : redactJson(child, home, true);
	}
	return out;
}

function redactUrlSecrets(value: string): string {
	const queryIndex = value.indexOf("?");
	if (queryIndex === -1) return value;
	const hashIndex = value.indexOf("#", queryIndex);
	const queryEnd = hashIndex === -1 ? value.length : hashIndex;
	const prefix = value.slice(0, queryIndex + 1);
	const query = value.slice(queryIndex + 1, queryEnd);
	const suffix = value.slice(queryEnd);
	let changed = false;
	const parts = query.split("&").map((part) => {
		const equalsIndex = part.indexOf("=");
		const rawKey = equalsIndex === -1 ? part : part.slice(0, equalsIndex);
		const key = safeDecode(rawKey);
		if (!secretKeyPattern.test(key)) return part;
		changed = true;
		return `${rawKey}=[REDACTED]`;
	});
	return changed ? `${prefix}${parts.join("&")}${suffix}` : value;
}

function safeDecode(value: string): string {
	try {
		return decodeURIComponent(value.replaceAll("+", " "));
	} catch {
		return value;
	}
}
