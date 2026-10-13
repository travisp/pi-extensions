// Record session cleanup calls without opening real provider connections.
export const cleanups = [];

export function cleanupSessionResources(sessionId) {
	cleanups.push(sessionId);
}
