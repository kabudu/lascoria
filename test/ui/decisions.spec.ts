import { test, expect } from '@playwright/test';

// R10 presentation contract. Real HTTP/provider shapes and durable identities are covered by
// Rust tests; this bridge deliberately loses the paid-request reply after storing its result.
test('decision settings and snapshot disclosure require explicit opt-in and never retry a paid call', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
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
          itemId: 'message-1',
          kind: 'userMessage',
          revision: 1,
          turnId: 'turn-1',
          status: 'completed',
          text: 'Review fixture',
        },
      ],
      turns: [{ turnId: 'turn-1', terminal: 'completed' }],
      approvals: [],
      userInputs: [],
      totalItems: 1,
    },
  };
  const status = {
    pid: 1,
    version: 'fixture-1',
    features: ['decisionAssistance'],
    sessions: [session],
    commands: [],
  };
  const artifact = {
    id: 'capture-a',
    sessionId: 'session-a',
    taskId: 'turn-1',
    fingerprint: 'sha256:fixture',
    base: 'base',
    head: 'head',
    patch: '-before\n+after',
    untracked: [],
    capturedAtMillis: Date.now(),
    provenance: 'userAsserted',
  };
  const settings: any = {
    revision: 0,
    workspace: 'scope-a',
    recent: [],
    providers: [
      {
        id: 'jev',
        name: 'Jev / TypeSafe',
        endpoint: 'https://api.typesafe.ai/v1/systemone',
        policyUrl: 'https://docs.typesafe.ai/api',
        model: 'jev-latest',
        enabled: false,
        keySaved: false,
        workspaces: [],
      },
      {
        id: 'subq',
        name: 'SubQ',
        endpoint: 'https://api.subq.ai/v1/systemone',
        policyUrl: 'https://docs.subq.ai/',
        model: 'subq-snap-preview',
        enabled: false,
        keySaved: false,
        workspaces: [],
      },
      {
        id: 'openai',
        name: 'OpenAI',
        endpoint: 'https://api.openai.com/v1/decisions',
        policyUrl: 'https://developers.openai.com/',
        model: 'gpt-6-luna',
        enabled: false,
        keySaved: false,
        workspaces: [],
      },
    ],
  };
  const calls: { operation: string; params: any; id: string }[] = [];
  let outcome: any;
  await page.exposeFunction('decisionBridge', async (command: string, args: any) => {
    if (command === 'connect_supervisor') return status;
    if (command === 'update_status') return { configured: false };
    if (command.startsWith('plugin:event|')) return 1;
    calls.push(args);
    switch (args.operation) {
      case 'status':
        return { unchanged: true, version: status.version, pid: 1 };
      case 'presentation/get':
        return {
          revision: 0,
          value: {
            sessionId: 'session-a',
            panels: {
              sessions: { x: 16, y: 150, collapsed: true },
              attention: { x: 16, y: 460, collapsed: true },
              inspector: { x: 700, y: 150, collapsed: false },
            },
          },
        };
      case 'presentation/save':
        return { revision: 1, value: args.params.value };
      case 'review/list':
        return { artifacts: [artifact], evidence: [] };
      case 'artifact/read':
        return artifact;
      case 'artifact/check':
        return { fresh: true };
      case 'decision/status':
        return settings;
      case 'decision/setKey':
        expect(args.params.apiKey).toBe('fixture-decision-credential');
        settings.providers[0].keySaved = true;
        settings.revision++;
        return { revision: settings.revision };
      case 'decision/configure':
        expect(args.params.expectedRevision).toBe(settings.revision);
        settings.providers[0].enabled = args.params.enabled;
        settings.providers[0].workspaces = args.params.workspaceEnabled ? ['scope-a'] : [];
        settings.revision++;
        return { revision: settings.revision };
      case 'decision/preview':
        return {
          input: artifact.patch,
          payload: {
            model: 'jev-latest',
            state: artifact.patch,
            questions: {
              review: {
                type: 'noul',
                instructions: args.params.question.prompt,
                criteria: {
                  true: 'The supplied evidence supports yes',
                  false: 'The supplied evidence supports no',
                },
              },
            },
          },
          bytes: 14,
          source: { artifactId: artifact.id, fingerprint: artifact.fingerprint },
          fingerprint: 'disclosure-1',
          model: 'jev-latest',
          endpoint: settings.providers[0].endpoint,
          question: args.params.question,
        };
      case 'decision/evaluate':
        outcome = {
          id: args.id,
          provider: 'jev',
          model: 'jev-latest',
          status: 'completed',
          createdAtMillis: Date.now(),
          checkedAtMillis: Date.now(),
          latencyMs: 12,
          source: { artifactId: artifact.id },
          fingerprint: 'disclosure-1',
          rubricVersion: 'manual-review-v1',
          question: args.params.question,
          result: {
            model: 'jev-resolved',
            answer: { type: 'noul', noul: 0.9 },
            usage: { input_tokens: 12 },
            cost: null,
          },
        };
        throw Error('Lost reply after the original request completed');
      case 'decision/result':
        expect(args.params.requestId).toBe(outcome.id);
        return { ...outcome, reused: true };
      default:
        return {};
    }
  });
  await page.addInitScript(() => {
    (window as any).__TAURI_INTERNALS__ = {
      invoke: (c: string, a: any) => (window as any).decisionBridge(c, a),
      transformCallback: () => 1,
    };
  });
  await page.goto('/');
  await page.getByRole('tab', { name: /^diff$/i }).click();
  await page.locator('.decision-review > summary').click();
  await page.getByRole('button', { name: 'Configure decision assistance' }).click();
  await page
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Decision assistance', exact: true })
    .click();
  const panel = page.getByRole('region', { name: 'Decision assistance settings' });
  await expect(panel).toContainText('Nothing is sent in the background');
  await panel.locator('summary').filter({ hasText: 'Jev / TypeSafe' }).click();
  await panel.getByLabel('API key for Jev / TypeSafe').fill('fixture-decision-credential');
  await panel.getByRole('button', { name: 'Save key securely' }).first().click();
  await expect(panel.locator('summary').filter({ hasText: 'Jev / TypeSafe' })).toContainText(
    'Key saved',
  );
  // The provider stays open after saving, with the key field cleared.
  await expect(panel.getByLabel('API key for Jev / TypeSafe')).toHaveValue('');
  await panel
    .getByRole('checkbox', { name: 'Enable manual reviews with this provider' })
    .first()
    .check();
  await panel
    .getByRole('checkbox', { name: 'Allow sending selected snapshots from this workspace' })
    .first()
    .check();
  await panel.getByRole('button', { name: 'Save provider settings' }).first().click();
  await expect(panel.locator('summary').filter({ hasText: 'Jev / TypeSafe' })).toContainText(
    'Enabled',
  );
  expect(
    calls.filter((c) => ['decision/test', 'decision/evaluate'].includes(c.operation)),
  ).toHaveLength(0);
  await page.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await page.getByRole('tab', { name: /^diff$/i }).click();
  const assistance = page.locator('.decision-review');
  await expect(assistance).not.toHaveAttribute('open');
  await assistance.locator('summary').first().click();
  await assistance.getByRole('button', { name: 'Preview exactly what will be sent' }).click();
  const preview = page.getByRole('region', { name: 'Decision disclosure preview' });
  await expect(preview).toContainText('https://api.typesafe.ai/v1/systemone');
  await expect(preview.locator('pre')).toHaveText(
    JSON.stringify(
      {
        model: 'jev-latest',
        state: artifact.patch,
        questions: {
          review: {
            type: 'noul',
            instructions: 'Does this change show a concrete correctness defect?',
            criteria: {
              true: 'The supplied evidence supports yes',
              false: 'The supplied evidence supports no',
            },
          },
        },
      },
      null,
      2,
    ),
  );
  expect(calls.filter((c) => c.operation === 'decision/evaluate')).toHaveLength(0);
  await preview.getByRole('button', { name: 'Send this snapshot for advice' }).click();
  await expect(assistance.getByRole('alert')).toContainText('Lost reply');
  await assistance
    .getByRole('button', { name: 'Retrieve original request (never sends twice)' })
    .click();
  await expect(assistance.getByRole('article', { name: 'Decision result' })).toContainText(
    '90% provider-estimated probability of yes',
  );
  await expect(assistance).toContainText('No second call was sent');
  expect(calls.filter((c) => c.operation === 'decision/evaluate')).toHaveLength(1);
  expect(
    calls.filter((c) => ['turn', 'decide', 'evidence/record'].includes(c.operation)),
  ).toHaveLength(0);
  expect(errors).toEqual([]);
});
