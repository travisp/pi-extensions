import assert from "node:assert/strict";
import test from "node:test";
import { jevOnlyProvider } from "../extensions/openrouter-jev-only/provider.ts";

test("OpenRouter discovery exposes only Jev classifiers and preserves request implementations", () => {
	const models = [
		{ type: "chat", id: "mistralai/mistral-small" },
		{ type: "image", id: "image-model" },
		{ type: "classifier", id: "typesafe/jev-1.13" },
		{ type: "classifier", id: "~typesafe/jev-latest" },
		{ type: "classifier", id: "another-classifier" },
		{ type: "chat", id: "typesafe/jev-1.13" },
	];
	const unexpectedRequest = () => { throw new Error("Unexpected provider request"); };
	const original = {
		id: "openrouter", name: "OpenRouter", auth: { apiKey: {} },
		getModels: () => models.filter(m => m.type === "chat"),
		getAllModels: () => models,
		stream: unexpectedRequest, streamSimple: unexpectedRequest,
		classify: unexpectedRequest, generateImages: unexpectedRequest,
	};
	const filtered = jevOnlyProvider(original);
	const expected = models.slice(2, 4);
	assert.deepEqual(filtered.getModels(), []);
	assert.deepEqual(filtered.getAllModels(), expected);
	assert.deepEqual(filtered.filterModels(original.getModels()), []);
	assert.deepEqual(filtered.filterAllModels(models), expected);
	for (const key of ["auth", "stream", "streamSimple", "classify", "generateImages"]) {
		assert.equal(filtered[key], original[key]);
	}
	assert.equal(original.getAllModels(), models);
	// Catalog changes stay filtered rather than reintroducing chat models.
	models.push({ type: "chat", id: "new-chat-model" });
	assert.deepEqual(filtered.getAllModels(), expected);
});
