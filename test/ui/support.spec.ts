import { test, expect } from '@playwright/test';

// R7: the support report is shown in full before saving, cancelling the chooser saves nothing,
// and saving names the previewed report rather than sending new content.
test('support report previews exact text and saves only after the chooser', async ({ page }) => {
  const calls: { command: string; operation?: string; params?: any }[] = [];
  let pick: string | null = null;
  await page.exposeFunction('supportBridge', async (command: string, args: any) => {
    const status = { pid: 1, features: ['supportReport'], commands: [], sessions: [] };
    if (command === 'connect_supervisor') return status;
    calls.push({ command, operation: args?.operation, params: args?.params });
    if (command === 'pick_support_report_destination') return pick;
    switch (args.operation) {
      case 'status':
        return status;
      case 'presentation/get':
        return { revision: 0, value: {} };
      case 'support/preview':
        return { reportId: 'r-1', text: '{\n  "report": "Lascoria support report"\n}\n' };
      case 'support/save':
        return { path: args.params.path, bytes: 40 };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).supportBridge(command, args),
    };
  });
  await page.goto('/');
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Support report' }).click();
  const panel = page.getByRole('region', { name: 'Support report' });
  await expect(panel.getByRole('button', { name: 'Save report…' })).toBeDisabled();
  await panel.getByRole('button', { name: 'Prepare report' }).click();
  await expect(panel.getByLabel('Report contents')).toContainText(
    '"report": "Lascoria support report"',
  );
  await panel.getByRole('button', { name: 'Save report…' }).click();
  await expect
    .poll(() => calls.filter((c) => c.command === 'pick_support_report_destination').length)
    .toBe(1);
  expect(calls.some((c) => c.operation === 'support/save')).toBe(false);
  pick = '/tmp/report.json';
  await panel.getByRole('button', { name: 'Save report…' }).click();
  await expect(panel.getByRole('status')).toContainText('Support report saved');
  expect(calls.find((c) => c.operation === 'support/save')?.params).toEqual({
    reportId: 'r-1',
    path: '/tmp/report.json',
  });
});
