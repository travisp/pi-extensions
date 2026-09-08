import { StateStore } from "../src/state-store.ts";

const [sharedProject, ownProject, index] = process.argv.slice(2);
const changes = [{ command: "npm run dev" }, { paneId: "w1:p2" }, { toolEnabled: true }];
process.once("message", async () => {
	try {
		const store = new StateStore();
		await Promise.all([
			store.update(sharedProject, changes[Number(index) % changes.length]),
			store.update(ownProject, { command: `worker-${index}` }),
		]);
		process.disconnect();
	} catch (error) {
		console.error(error);
		process.exit(1);
	}
});
process.send("ready");
