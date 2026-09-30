import type { Provider } from "@earendil-works/pi-ai";

const JEV_IDS = new Set(["typesafe/jev-1.13", "~typesafe/jev-latest"]);

/** Restrict discovery, not requests made with a previously captured model definition. */
export function jevOnlyProvider(provider: Provider): Provider {
	return {
		...provider,
		getModels: () => [],
		getAllModels: () => (provider.getAllModels?.() ?? []).filter(
			(model) => model.type === "classifier" && JEV_IDS.has(model.id),
		),
		filterModels: () => [],
		filterAllModels: (models) => models.filter(
			(model) => model.type === "classifier" && JEV_IDS.has(model.id),
		),
	};
}
