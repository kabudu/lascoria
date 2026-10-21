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
  status.storage = null;
  status.version = 'v2';
  await expect(alert).toHaveCount(0, { timeout: 6000 });
});
