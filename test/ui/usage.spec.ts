import { test, expect, type Page } from '@playwright/test';

// R8 Account & usage: account-scoped readings without a session, readable countdowns and local
// reset times, honest stale and reset-passed states, and no subscription view for API keys.
const T = Date.parse('2026-10-18T09:00:00Z');
const reading = {
  usage: {
    tier: 'tier_opaque_7',
    observedAtMs: T - 2 * 60_000,
    window: { usedPercent: 35, resetsAtMs: T + 125 * 60_000, windowDurationMins: 300 },
    weekly: { usedPercent: 20, resetsAtMs: T + 3 * 86_400_000 },
  },
  receivedAtMs: T - 2 * 60_000,
};

async function open(page: Page, account: unknown) {
  const calls: string[] = [];
  await page.clock.install({ time: T });
  await page.exposeFunction('usageBridge', async (command: string, args: any) => {
    const status = {
      pid: 1,
      features: ['usage', 'usageLatest', ...(account ? ['accounts'] : [])],
      commands: [],
      sessions: [],
    };
    if (command === 'connect_supervisor') return status;
    calls.push(args.operation);
    switch (args.operation) {
      case 'status':
        return status;
      case 'account/status':
        return account;
      case 'presentation/get':
        return { revision: 0, value: {} };
      case 'usage/latest':
        return reading;
      case 'usage':
        throw Error('No session to ask');
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).usageBridge(command, args),
    };
  });
  await page.goto('/');
  return calls;
}

test('Account & usage works without a session and stays honest as time passes', async ({
  page,
}) => {
  const calls = await open(page, null);
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await expect(page.getByText('· 80% weekly left')).toBeVisible();
  await page.getByRole('button', { name: /^Account & usage/ }).click();
  const panel = page.getByRole('region', { name: 'Account and usage' });
  await expect(page.getByRole('heading', { name: 'Account & usage' })).toBeVisible();
  await expect(panel.getByText('35% used · 65% remaining')).toBeVisible();
  await expect(panel.getByText(/Resets in 2 hours 5 minutes \(/)).toBeVisible();
  await expect(panel.getByText(/Resets in 3 days \(/)).toBeVisible();
  await expect(panel.getByText(/5-hour window/)).toBeVisible();
  await expect(panel.getByText(/last reported these figures 2 minutes ago/)).toBeVisible();
  await expect(panel.getByText(/May be out of date/)).toHaveCount(0);
  await panel.getByText('About these numbers').click();
  await expect(panel.getByText('tier_opaque_7')).toBeVisible();
  // Without a connected session nothing asks a Muse host, and nothing polls.
  expect(calls).not.toContain('usage');
  const reads = calls.filter((c) => c === 'usage/latest').length;

  // Three hours later the current window has reset since Muse reported: unknown, not 0%.
  await page.clock.fastForward(3 * 60 * 60_000);
  await expect(panel.getByText('Not known yet')).toBeVisible();
  await expect(panel.getByText(/after Muse last reported \(35% used then\)/)).toBeVisible();
  await expect(panel.getByText(/May be out of date: Muse last reported/)).toBeVisible();
  await expect(panel.getByText('20% used · 80% remaining')).toBeVisible();
  expect(calls.filter((c) => c === 'usage/latest').length).toBe(reads);
  await panel.getByRole('button', { name: 'Refresh usage' }).click();
  await expect.poll(() => calls.filter((c) => c === 'usage/latest').length).toBe(reads + 1);
  expect(calls).not.toContain('usage');
});

test('Account & usage does not show a subscription allowance for API-key billing', async ({
  page,
}) => {
  const calls = await open(page, {
    managed: true,
    mode: 'apiKey',
    authenticated: true,
    keyConfigured: true,
    keyStorageAvailable: true,
    subscription: { state: 'loggedOut' },
    pending: false,
    outcome: null,
    reconnectRequired: false,
    logoutPending: false,
  });
  await expect(page.getByRole('button', { name: 'API billing' })).toBeVisible();
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: /^Account & usage/ }).click();
  const panel = page.getByRole('region', { name: 'Account and usage' });
  await expect(panel.getByText(/You are using an API key/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Refresh usage' })).toHaveCount(0);
  expect(calls.filter((c) => c.startsWith('usage'))).toEqual([]);
});
