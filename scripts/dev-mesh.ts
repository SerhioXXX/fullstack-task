/**
 * Stretch setup (stage 9): one simulator, two gateways that hear overlapping device sets, one web client.
 *   npm run dev:mesh                    # everything
 *   npm run dev:mesh -- --only gw-a     # just one process again, e.g. after killing gateway A
 * Gateway A: dev-1..dev-6 on :8080; gateway B: dev-3..dev-8 on :8081, slower link. Shared: dev-3..dev-6.
 * Per-process values here override the repo-root .env (shell environment wins over the file).
 * Gateways run without watch mode, so a killed one stays down until started again.
 */
import concurrently from 'concurrently';

const SIM_PORT = '8079';
const SIM_URL = `ws://localhost:${SIM_PORT}/devices`;
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `dev-${from + i}`).join(',');

const processes = [
  { name: 'sim', prefixColor: 'magenta', command: 'npm run sim -w @app/server', env: { SIM_PORT } },
  {
    name: 'gw-a',
    prefixColor: 'blue',
    command: 'npm run start -w @app/server',
    env: { PORT: '8080', GATEWAY_ID: 'gw-a', SIM_URL, DEVICE_FILTER: range(1, 6), LINK_LATENCY_MS: '0' },
  },
  {
    name: 'gw-b',
    prefixColor: 'cyan',
    command: 'npm run start -w @app/server',
    env: { PORT: '8081', GATEWAY_ID: 'gw-b', SIM_URL, DEVICE_FILTER: range(3, 8), LINK_LATENCY_MS: '300' },
  },
  {
    name: 'web',
    prefixColor: 'green',
    command: 'npm run dev -w @app/web',
    env: { VITE_WS_URLS: 'ws://localhost:8080/ws,ws://localhost:8081/ws' },
  },
];

const onlyIndex = process.argv.indexOf('--only');
const only = onlyIndex >= 0 ? process.argv[onlyIndex + 1] : undefined;
const selected = only ? processes.filter((p) => p.name === only) : processes;
if (selected.length === 0) {
  console.error(`unknown process "${only}", expected one of: ${processes.map((p) => p.name).join(', ')}`);
  process.exit(1);
}

// No killOthersOn: a gateway may be killed on purpose to test failover, the rest must keep running.
const { result } = concurrently(selected, { prefix: 'name' });
result.catch(() => process.exit(1));
