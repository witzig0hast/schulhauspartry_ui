import { config } from './config.js';
import { createApp } from './app.js';

const { server } = createApp();
server.listen(config.port, () => console.log(`[server] läuft auf Port ${config.port}`));

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
