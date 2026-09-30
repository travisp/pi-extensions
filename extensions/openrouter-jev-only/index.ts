import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import { jevOnlyProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
	const provider = builtinModels().getProvider("openrouter")!;
	pi.registerProvider(jevOnlyProvider(provider));
}
