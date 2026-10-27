import { Collector } from "./collector.js";
import { loadLocations, loadSettings } from "./config.js";
import { Store } from "./db.js";
import { createApp } from "./server.js";

const settings = loadSettings();
const locations = loadLocations(settings.locationsFile);
const store = new Store(settings.dbPath);
const collector = new Collector(store, locations, settings);
const server = createApp(store, locations, collector);

server.listen(settings.port, () => {
  console.log(`[server] listening on :${settings.port} with ${locations.length} location(s): ${locations.map((l) => l.id).join(", ")}`);
});
collector.start();

function shutdown(signal: string) {
  console.log(`[server] ${signal}, shutting down`);
  collector.stop();
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
