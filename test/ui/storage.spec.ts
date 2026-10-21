import AxeBuilder from '@axe-core/playwright';
import { test, expect } from '@playwright/test';

// R7: while the data folder refuses writes (a full disk), the background service keeps Muse
// running and says so; the warning goes away once the waiting updates are saved.
test('a full data disk is explained and clears once updates are saved', async ({ page }) => {
  const status: any = {
    pid: 1,
    version: 'v1',
    features: [],
    commands: [],
    sessions: [],
    storage: {
      unsaved: 1,
      message:
        'Lascoria could not save to its data folder because the disk is full. Free some space, then check the session before trying again.',
      sinceMillis: 1,
    },
  };
  await page.exposeFunction('storageBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (args.operation === 'status')
      return args.params?.since === status.version && !status.storage
        ? { unchanged: true, version: status.version, pid: 1 }
        : status;
    if (args.operation === 'presentation/get') return { revision: 0, value: {} };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).storageBridge(command, args),
    };
  });
  await page.goto('/');
  const alert = page.getByRole('alert', { name: 'Changes not saved' });
  await expect(alert).toContainText('the disk is full. Free some space');
  await expect(alert).toContainText('One session is waiting to be saved');
  // Both themes and a narrow window keep the notice readable (WCAG 2.1 AA).
  for (const theme of ['light', 'dark']) {
    await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
    for (const width of [1280, 820]) {
      await page.setViewportSize({ width, height: 800 });
      const audit = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
        .analyze();
      expect(audit.violations.map((v) => `${theme} ${width}: ${v.id}`)).toEqual([]);
    }
  }
  await page.evaluate(() => (document.documentElement.dataset.theme = 'light'));
  status.storage = null;
  status.version = 'v2';
  await expect(alert).toHaveCount(0, { timeout: 6000 });
});

// R7: a damaged data file was set aside at startup; the app says so once, offers the newest
// backup through Data & backups, and Dismiss removes the notice.
test('a damaged data file is explained with the backup to restore', async ({ page }) => {
  const calls: string[] = [];
  const status: any = {
    pid: 1,
    version: 'v1',
    features: ['dataLifecycle'],
    commands: [],
    sessions: [],
    dataRecovery: {
      keptAs: 'damaged/state-1.sqlite',
      atMillis: 1,
      latestBackup: { id: 'b1', createdAtMillis: Date.UTC(2026, 9, 20, 9, 30) },
    },
  };
  await page.exposeFunction('recoveryBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    calls.push(args.operation);
    if (args.operation === 'data/dismissRecovery') {
      status.dataRecovery = null;
      status.version = 'v2';
      return { dismissed: true };
    }
    if (args.operation === 'status')
      return args.params?.since === status.version
        ? { unchanged: true, version: status.version, pid: 1 }
        : status;
    if (args.operation === 'presentation/get') return { revision: 0, value: {} };
    if (args.operation === 'data/summary')
      return {
        backups: [{ id: 'b1', createdAtMillis: 1, reason: 'manual', bytes: 1 }],
        archived: [],
        sessions: 0,
        sessionLimit: 100,
        archivedSessions: 0,
        journalEntries: 0,
        journalLimit: 2000,
        databaseBytes: 4096,
      };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).recoveryBridge(command, args),
    };
  });
  await page.goto('/');
  const alert = page.getByRole('alert', { name: 'Data could not be read' });
  await expect(alert).toContainText('started with empty data');
  await expect(alert).toContainText('damaged/state-1.sqlite');
  await expect(alert).toContainText('can be restored');
  await alert.getByRole('button', { name: 'Open Data & backups' }).click();
  await expect(page.getByRole('button', { name: /^Restore backup from/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await alert.getByRole('button', { name: 'Dismiss' }).click();
  await expect(alert).toHaveCount(0);
  expect(calls).toContain('data/dismissRecovery');
});
