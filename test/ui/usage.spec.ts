import { test, expect, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

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

async function open(page: Page, account: unknown, legacy = false, cache: unknown = reading) {
  const calls: string[] = [];
  await page.clock.install({ time: T });
  await page.exposeFunction('usageBridge', async (command: string, args: any) => {
    const status: any = {
      pid: 1,
      features: ['usage', 'usageLatest', ...(account ? ['accounts'] : [])],
      commands: [],
      sessions: [],
    };
    if (legacy) {
      delete status.features;
      status.sessions = [
        {
          id: 'legacy-session',
          workspace: '/repo',
          generation: 1,
          lifecycle: 'connected',
          interruptions: [],
          state: {
            current: true,
            activeTurnId: 'running-task',
            items: [],
            totalItems: 0,
            turns: [],
            approvals: [],
            userInputs: [],
          },
        },
      ];
    }
    if (command === 'connect_supervisor') return status;
    if (command === 'update_status') return { configured: false };
    if (command.startsWith('plugin:event|')) return 1;
    calls.push(args.operation);
    switch (args.operation) {
      case 'status':
        return status;
      case 'account/status':
        return account;
      case 'presentation/get':
        return { revision: 0, value: {} };
      case 'presentation/save':
        return { revision: args.params.expectedRevision + 1, value: args.params.value };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      case 'usage/latest':
        return cache;
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

  // The optional toolbar figure is off until chosen, then reads only Lascoria's cache.
  await expect(page.getByRole('button', { name: /^Weekly .* left$/ })).toHaveCount(0);
  await panel.getByLabel('Show the weekly allowance in the toolbar').check();
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await expect(page.getByRole('button', { name: 'Weekly 80% left' })).toBeVisible();
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
  await expect(page.getByRole('button', { name: 'Subscription usage', exact: true })).toHaveCount(
    0,
  );
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: /^Account & usage/ }).click();
  const panel = page.getByRole('region', { name: 'Account and usage' });
  await expect(panel.getByText(/You are using an API key/)).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Refresh usage' })).toHaveCount(0);
  expect(calls.filter((c) => c.startsWith('usage'))).toEqual([]);
});

test('subscription usage has a default header shortcut with a quiet, accessible popover', async ({
  page,
}) => {
  const calls = await open(page, {
    managed: true,
    mode: 'subscription',
    authenticated: true,
    keyConfigured: false,
    subscription: { state: 'signedIn' },
    pending: false,
  });
  await expect(page.getByRole('button', { name: 'Muse subscription', exact: true })).toBeVisible();
  const shortcut = page.getByRole('button', { name: 'Subscription usage', exact: true });
  await expect(shortcut).toBeVisible();
  expect(calls.filter((c) => c.startsWith('usage'))).toEqual([]);
  await shortcut.click();
  const popover = page.getByRole('dialog', { name: 'Subscription usage', exact: true });
  await expect(popover.getByText('80% left', { exact: true })).toBeVisible();
  await expect(popover.getByText('65% left', { exact: true })).toBeVisible();
  const footer = await popover
    .getByRole('button', { name: 'Account & usage' })
    .evaluate((node) => ({
      border: getComputedStyle(node).borderTopWidth,
      padding: getComputedStyle(node).paddingLeft,
    }));
  expect(footer).toEqual({ border: '1px', padding: '0px' });
  expect(calls.filter((c) => c === 'usage')).toEqual([]);
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.theme = theme;
    }, theme);
    for (const width of [1440, 820]) {
      await page.setViewportSize({ width, height: 940 });
      const bounds = await popover.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.x).toBeGreaterThanOrEqual(16);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(width - 16);
      expect(
        (await new AxeBuilder({ page }).include('#subscription-usage-popover').analyze())
          .violations,
      ).toEqual([]);
      await page.screenshot({ path: `.dev/usage-shortcut-${theme}-${width}.png` });
    }
  }
  await page.keyboard.press('Escape');
  await expect(popover).not.toBeVisible();
  await expect(shortcut).toBeFocused();
  const before = calls.filter((c) => c === 'usage/latest').length;
  await page.clock.fastForward(2 * 60_000);
  expect(calls.filter((c) => c === 'usage/latest')).toHaveLength(before);
  await shortcut.click();
  await expect(popover).toBeVisible();
  await page.clock.fastForward(4 * 86_400_000);
  await expect(popover.getByText('Awaiting update', { exact: true })).toHaveCount(2);
  await expect(popover).toContainText('May be out of date');
  await popover.getByRole('button', { name: 'Account & usage' }).click();
  await expect(page.getByRole('region', { name: 'Account and usage' })).toBeVisible();
  expect(calls.filter((c) => ['stop', 'cancel', 'turn'].includes(c))).toEqual([]);
});

test('an unversioned legacy service explains unavailable usage without interrupting active work', async ({
  page,
}) => {
  const calls = await open(page, null, true);
  await expect(page.getByRole('status', { name: 'Finish updating' })).toContainText(
    'enable account and usage',
  );
  await page.getByRole('button', { name: 'Subscription usage', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Subscription usage', exact: true });
  await expect(popover).toContainText('does not provide account and usage');
  await expect(popover.getByRole('button', { name: 'Restart when work finishes' })).toBeVisible();
  await expect(
    popover.getByRole('button', { name: 'Pause work and restart', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByLabel('Workspace menu', { exact: true }).click();
  const entry = page.getByRole('button', { name: 'Account & usage', exact: true });
  await expect(entry).toBeEnabled();
  await entry.click();
  await expect(page.getByRole('region', { name: 'Background service update' })).toContainText(
    'Saved conversations and drafts are retained',
  );
  await page.getByRole('button', { name: 'Close dialog' }).click();
  await page.getByRole('button', { name: 'Muse account', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Background service update' })).toBeVisible();
  expect(
    calls.filter((c) =>
      ['stop', 'cancel', 'turn', 'account/status', 'usage', 'usage/latest'].includes(c),
    ),
  ).toEqual([]);
});

test('the header shortcut keeps missing subscription figures unknown', async ({ page }) => {
  const calls = await open(
    page,
    {
      managed: true,
      mode: 'subscription',
      authenticated: true,
      keyConfigured: false,
      subscription: { state: 'signedIn' },
      pending: false,
    },
    false,
    { usage: null },
  );
  await expect(page.getByRole('button', { name: 'Muse subscription', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Subscription usage', exact: true }).click();
  const popover = page.getByRole('dialog', { name: 'Subscription usage', exact: true });
  await expect(popover).toContainText('Muse has not reported usage yet');
  await expect(popover.getByText(/0% left/)).toHaveCount(0);
  expect(calls.filter((c) => c === 'usage')).toEqual([]);
});
