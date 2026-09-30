import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { openrouterProvider } from "@earendil-works/pi-ai/providers/openrouter";
import { jevOnlyProvider } from "./provider.ts";

export default function (pi: ExtensionAPI) {
	pi.registerProvider(jevOnlyProvider(openrouterProvider()));
}
