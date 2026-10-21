import { test, expect } from '@playwright/test';

// R7/R13: a failed task says what happened and what to do, with Muse's own wording kept
// under Details rather than as the headline.
test('a task that could not reach the model says to check the connection', async ({ page }) => {
  const status = {
    pid: 1,
    version: 'v1',
    features: [],
    commands: [],
    sessions: [
      {
        id: 'session-a',
        workspace: '/repo',
        generation: 1,
        lifecycle: 'connected',
        interruptions: [],
        state: {
          current: true,
          items: [
            {
              itemId: 'u1',
              kind: 'userMessage',
              status: 'completed',
              revision: 1,
              turnId: 't1',
              text: 'Fix the tests',
            },
          ],
          turns: [
            {
              turnId: 't1',
              commandId: 'c1',
              state: 'settled',
              terminal: 'failed',
              error: {
                kind: 'modelError',
                message:
                  'transport error: error sending request for url (http://127.0.0.1:1/responses) (after 4 provider attempts)',
                retryable: false,
              },
            },
          ],
          approvals: [],
          userInputs: [],
        },
      },
    ],
  };
  await page.exposeFunction('failureBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (args.operation === 'status')
      return args.params?.since === status.version
        ? { unchanged: true, version: status.version, pid: 1 }
        : status;
    if (args.operation === 'presentation/get')
      return { revision: 0, value: { sessionId: 'session-a' } };
    if (args.operation === 'review/list') return { artifacts: [], evidence: [] };
    return {};
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).failureBridge(command, args),
    };
  });
  await page.goto('/');
  const failure = page.getByRole('region', { name: 'Native task failure' });
  await expect(failure.getByText('Muse could not reach the model')).toBeVisible();
  await expect(failure).toContainText('Check your internet connection');
  await expect(failure.getByText(/transport error/)).toBeHidden();
  await failure.getByText('Details from Muse').click();
  await expect(failure.getByText(/modelError: transport error/)).toBeVisible();
});
