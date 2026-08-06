import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const MODEL_PROVIDER = "openai-codex";
const MODEL_ID = "gpt-5.4-mini";
const MAX_NAME_CHARS = 60;

const SYSTEM_PROMPT = `Create a concise, searchable title for this Pi coding session.
Return exactly one title.

Rules:
- 2 to 6 words
- Title Case
- Prefer specific nouns from the request
- No quotes, markdown, labels, or trailing punctuation
- Maximum ${MAX_NAME_CHARS} characters`;

export default function autoSessionName(pi: ExtensionAPI): void {
	let shouldNameNextUserMessage = false;

	pi.on("session_start", (_event, ctx) => {
		const isFreshUnnamedSession =
			!pi.getSessionName() &&
			!ctx.sessionManager
				.getBranch()
				.some((entry) => entry.type === "message" && entry.message.role === "user");

		shouldNameNextUserMessage = isFreshUnnamedSession;
	});

	pi.on("message_end", async (event, ctx) => {
		if (!shouldNameNextUserMessage || event.message.role !== "user") return;
		shouldNameNextUserMessage = false;

		try {
			const prompt = textContent(event.message.content);
			if (!prompt) return;

			const name = await generateName(prompt, ctx.modelRegistry);
			if (name) {
				pi.setSessionName(name);
				ctx.ui.notify(`✨ SESSION AUTO-NAMED ✨\n${name}`, "warning");
			}
		} catch (error) {
			console.error("[pi-auto-session-name] Failed to generate session name:", error);
		}
	});
}

async function generateName(
	prompt: string,
	modelRegistry: ExtensionContext["modelRegistry"],
): Promise<string | undefined> {
	const model = modelRegistry.find(MODEL_PROVIDER, MODEL_ID);
	if (!model) throw new Error(`Model not found: ${MODEL_PROVIDER}/${MODEL_ID}`);

	if (!modelRegistry.hasConfiguredAuth(model)) throw new Error(`Model auth not configured: ${MODEL_PROVIDER}/${MODEL_ID}`);

	const response = await modelRegistry.complete(
		model,
		{
			systemPrompt: SYSTEM_PROMPT,
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: prompt }],
					timestamp: Date.now(),
				},
			],
		},
		{ maxTokens: 64 },
	);

	if (response.stopReason === "error") throw new Error(response.errorMessage);

	return cleanName(textContent(response.content));
}

type TextPart = { type: "text"; text: string };

function textContent(content: string | ReadonlyArray<{ type: string }>): string {
	if (typeof content === "string") return content.trim();
	return content.filter(isTextPart).map((part) => part.text).join("\n").trim();
}

function isTextPart(part: { type: string }): part is TextPart {
	return part.type === "text";
}

function cleanName(text: string): string | undefined {
	const name = text.trim().split(/\r?\n/, 1)[0].slice(0, MAX_NAME_CHARS).trim();
	return name || undefined;
}
