import { createRelay, parseList } from './relay.js';

const relay = createRelay({
  x32Host: process.env.X32_HOST,
  x32Port: Number(process.env.X32_PORT || 10023),
  token: process.env.RELAY_TOKEN,
  bind: process.env.BIND || '0.0.0.0',
  port: Number(process.env.PORT || 8080),
  mics: parseList(process.env.MIC_CHANNELS, [5, 6, 7]),
  players: { 1: parseList(process.env.P1_CHANNELS, [1, 2]), 2: parseList(process.env.P2_CHANNELS, [3, 4]) },
  micThreshold: Number(process.env.MIC_THRESHOLD || 0.03),
});
relay.start().then((p) => console.log(`[relay] HTTP ${relay.cfg.bind}:${p} -> X32 ${relay.cfg.x32Host}:${relay.cfg.x32Port}`)).catch((e) => { console.error(e.message); process.exit(1); });
process.on('SIGTERM', () => relay.stop().finally(() => process.exit(0)));
