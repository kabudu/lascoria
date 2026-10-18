import { test, expect } from '@playwright/test';

// R10 interaction models (b) and (c) in Settings, the usage summary, agree/disagree overrides
// and the quiet triage note. Spending, consent and replay rules are proven by Rust tests.
test('triage and Muse tool settings, metrics, overrides and the triage note', async ({ page }) => {
  const session = {
    id: 'session-a',
    workspace: '/fixture/repo',
    generation: 1,
    lifecycle: 'connected',
    interruptions: [],
    state: {
      current: true,
      items: [
        {
          itemId: 'm',
          kind: 'userMessage',
          revision: 1,
          turnId: 't1',
          status: 'completed',
          text: 'Fix it',
        },
      ],
      turns: [{ turnId: 't1', terminal: 'completed' }],
      approvals: [],
      userInputs: [],
      totalItems: 1,
    },
  };
  const status = {
    pid: 1,
    version: 'e:1',
    features: ['decisionAssistance', 'decisionTriage', 'decisionTool'],
    sessions: [session],
    commands: [],
  };
  const provider = (id: string, name: string, enabled: boolean) => ({
    id,
    name,
    endpoint: `https://${id}.example/v1`,
    policyUrl: `https://${id}.example/policy`,
    model: `${id}-model`,
    enabled,
    keySaved: enabled,
    workspaces: [],
  });
  const settings: any = {
    revision: 3,
    admissionEpoch: 'epoch',
    workspace: 'scope-a',
    providers: [
      provider('jev', 'Jev / TypeSafe', true),
      provider('subq', 'SubQ', false),
      provider('openai', 'OpenAI', false),
    ],
    modes: {
      triage: {
        provider: null,
        workspaces: [],
        share: ['request', 'reply', 'question'],
        dailyLimit: 50,
      },
      tool: { provider: null, workspaces: [], dailyLimit: 50 },
    },
    recent: [
      {
        id: 'eval-1',
        purpose: 'manual',
        provider: 'jev',
        model: 'jev-latest',
        status: 'completed',
        createdAtMillis: Date.now(),
        question: { type: 'predicate', prompt: 'Ready?' },
        result: { model: 'jev-1', answer: { type: 'noul', noul: 0.8 }, usage: {} },
      },
    ],
  };
  const calls: any[] = [];
  await page.exposeFunction('modesBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    const op = args?.operation;
    if (op?.startsWith('decision/')) calls.push(args);
    switch (op) {
      case 'status':
        return args.params?.since === status.version
          ? { unchanged: true, version: status.version, pid: 1 }
          : status;
      case 'presentation/get':
        return { revision: 0, value: { sessionId: 'session-a' } };
      case 'review/list':
        return { artifacts: [], evidence: [] };
      case 'decision/status':
        return settings;
      case 'decision/configureMode': {
        if (args.params.expectedRevision !== settings.revision) throw Error('changed');
        const mode = settings.modes[args.params.mode];
        if ('provider' in args.params) {
          if (args.params.provider !== mode.provider) mode.workspaces = [];
          mode.provider = args.params.provider;
        }
        if ('workspaceEnabled' in args.params)
          mode.workspaces = args.params.workspaceEnabled ? ['scope-a'] : [];
        if (args.params.share) mode.share = args.params.share;
        if (args.params.dailyLimit) mode.dailyLimit = args.params.dailyLimit;
        settings.revision++;
        return { revision: settings.revision };
      }
      case 'decision/metrics':
        return {
          providers: {
            jev: {
              requests: 4,
              last24h: 2,
              byPurpose: { manual: 1, triage: 3 },
              inputTokens: 480,
              tokensReported: 4,
              latencyP50Ms: 900,
              latencyP95Ms: 2100,
              agreed: 0,
              disagreed: 1,
            },
          },
        };
      case 'decision/feedback':
        settings.recent[0].userVerdict = args.params.verdict;
        return settings.recent[0];
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (command: string, args: any) => (window as any).modesBridge(command, args),
    };
  });
  await page.goto('/');
  // Triage is off, so no note even with a matching answer in history.
  await expect(page.getByText(/Likely needs you/)).toHaveCount(0);
  await page.getByLabel('Workspace menu', { exact: true }).click();
  await page.getByRole('button', { name: 'Settings…', exact: true }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Decision assistance' })
    .click();
  const panel = page.getByRole('region', { name: 'Decision assistance settings' });
  const triage = panel.getByRole('group', { name: 'Background triage' });
  await expect(triage).toContainText('This sends data without asking each time');
  await triage.getByLabel('Provider').selectOption('jev');
  await expect.poll(() => settings.modes.triage.provider).toBe('jev');
  await triage.getByRole('checkbox', { name: /this session's workspace/ }).click();
  await expect.poll(() => settings.modes.triage.workspaces).toEqual(['scope-a']);
  await triage.getByRole('checkbox', { name: "Muse's latest reply and the task outcome" }).click();
  await expect.poll(() => settings.modes.triage.share).toEqual(['request', 'question']);
  const tool = panel.getByRole('group', { name: 'Muse can ask' });
  await expect(tool.getByLabel('Provider').locator('option')).toHaveText(['Off', 'Jev / TypeSafe']);
  await tool.getByLabel('Provider').selectOption('jev');
  await tool.getByRole('checkbox', { name: /this session's workspace/ }).click();
  await expect.poll(() => settings.modes.tool.workspaces).toEqual(['scope-a']);
  // Every change was saved against the latest revision.
  const saves = calls.filter((c) => c.operation === 'decision/configureMode');
  expect(saves.map((c) => c.params.expectedRevision)).toEqual([3, 4, 5, 6, 7]);

  await panel.getByText('Usage summary').click();
  await expect(panel.getByRole('table')).toContainText('1 reviews, 3 triage');
  await expect(panel.getByRole('table')).toContainText('480');
  await expect(panel.getByRole('table')).toContainText('1 of 1 marked');
  await panel.getByText('Recent requests and metrics').click();
  await panel.getByText(/jev · completed/).click();
  await panel.getByRole('button', { name: 'Seems wrong' }).click();
  await expect(panel.getByText('You marked this answer as wrong.')).toBeVisible();
  expect(calls.find((c) => c.operation === 'decision/feedback').params).toEqual({
    requestId: 'eval-1',
    verdict: 'disagree',
  });
  await page.getByRole('button', { name: 'Close dialog' }).click();

  // A triage answer for the latest task appears as a quiet note beside the session name.
  settings.recent.unshift({
    id: 'tri',
    purpose: 'triage',
    provider: 'jev',
    status: 'completed',
    createdAtMillis: Date.now(),
    source: { kind: 'triage', sessionId: 'session-a', turnId: 't1', waiting: false },
    result: { answer: { type: 'noul', noul: 0.9 } },
  });
  await page.reload();
  await expect(page.getByText('Likely needs you (90%)')).toBeVisible();
});
