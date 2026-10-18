import { test, expect } from '@playwright/test';

// T3/T4 in the app: settings, budget warnings with an optional automatic stop, repeated-call
// warnings, an explicit compaction action and a soft limit on concurrent tasks.
test('token efficiency warnings, budget stop, compaction and concurrency', async ({ page }) => {
  const busy = (id: string, turn?: string, extra: any = {}) => ({
    id,
    workspace: `/repo/${id}`,
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: {
      current: true,
      activeTurnId: turn,
      items: [],
      totalItems: 0,
      turns: turn ? [{ turnId: turn }] : [],
      approvals: [],
      userInputs: [],
      ...extra,
    },
  });
  const status: any = {
    pid: 1,
    version: 'e:1',
    features: ['compaction', 'effortPresets'],
    commands: [],
    sessions: [
      busy('a', 't-a', {
        tokens: { byTurn: { 't-a': { totalTokens: 60_000, calls: 3 } } },
        sessionState: {
          'session/contextUsage': { usedTokens: 900, windowTokens: 1000, pressure: 'warning' },
        },
        items: [1, 2, 3].map((n) => ({
          itemId: `c${n}`,
          kind: 'toolCall',
          turnId: 't-a',
          tool: 'bash',
          args: '{"cmd":"npm test"}',
          status: 'completed',
          revision: 1,
        })),
      }),
      busy('b', 't-b'),
      busy('c'),
    ],
  };
  let value: any = { sessionId: 'a' };
  let revision = 0;
  const calls: { operation: string; params: any; id: string }[] = [];
  await page.exposeFunction('efficiencyBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (args?.operation && args.operation !== 'status') calls.push(args);
    switch (args?.operation) {
      case 'status':
        return args.params?.since === status.version
          ? { unchanged: true, version: status.version, pid: 1 }
          : status;
      case 'presentation/get':
        return { revision, value };
      case 'presentation/save':
        revision++;
        value = args.params.value;
        return { revision, value };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      case 'cancel':
      case 'turn':
      case 'compact':
        return { status: 'applied', commandId: args.id };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).efficiencyBridge(command, args),
    };
  });
  await page.goto('/');
  const alerts = page.getByRole('region', { name: 'Token efficiency' });
  // Defaults: repeated calls and context pressure are warned about; there is no budget.
  await expect(alerts).toContainText('same bash call 3 times');
  await expect(alerts).toContainText('close to the model’s context limit');
  await expect(alerts).not.toContainText('budget');
  // Compaction waits for the running task.
  await expect(alerts.getByRole('button', { name: 'Compact conversation' })).toBeDisabled();

  // Settings: set a 50,000-token budget with the automatic stop and a concurrency limit.
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Token efficiency', exact: true })
    .click();
  const settings = page.getByRole('region', { name: 'Token efficiency settings' });
  await expect(
    settings.getByRole('checkbox', { name: 'Stop a task when it goes over' }),
  ).toBeDisabled();
  await settings.getByLabel('Warn when one task uses more than').selectOption('50000');
  await settings.getByRole('checkbox', { name: 'Stop a task when it goes over' }).check();
  await settings.getByLabel(/Ask before starting a task when/).selectOption('2');
  await page.getByRole('button', { name: 'Close dialog' }).click();

  // The running task is over budget: it is stopped once, with a stable request ID.
  await expect.poll(() => calls.filter((c) => c.operation === 'cancel').length).toBe(1);
  expect(calls.find((c) => c.operation === 'cancel')).toMatchObject({
    params: { sessionId: 'a', turnId: 't-a' },
    id: 'budget-stop-t-a',
  });
  await expect(alerts).toContainText('over your 50,000-token budget');
  await expect(page.getByRole('status').filter({ hasText: 'because it went over' })).toBeVisible();

  // Session c is idle while two other tasks run: starting asks first.
  await page
    .getByRole('button', { name: /^c\b/ })
    .first()
    .click()
    .catch(() => {});
  value = { ...value, sessionId: 'c' };
  status.version = 'e:2';
  status.sessions = [...status.sessions];
  await page.reload();
  const composer = page.getByRole('textbox', { name: 'New task for this session', exact: true });
  await composer.fill('Another task');
  await page.getByRole('button', { name: 'Start turn', exact: true }).click();
  const ask = page.getByRole('region', { name: 'Token efficiency' });
  await expect(ask).toContainText('2 tasks are already running');
  expect(calls.filter((c) => c.operation === 'turn')).toHaveLength(0);
  await ask.getByRole('button', { name: 'Start anyway' }).click();
  await expect.poll(() => calls.filter((c) => c.operation === 'turn').length).toBe(1);
});
