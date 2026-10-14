import http from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// A scripted loopback model, exercising the real Muse execution and permission boundary.
export async function provider(root, options = {}) {
  let releaseBurst;
  const burstGate = new Promise((resolve) => {
    releaseBurst = resolve;
  });
  let finishBurst;
  const burstFinished = new Promise((resolve) => {
    finishBurst = resolve;
  });
  const stageBSent = new Set();
  let tools = 0;
  let asked = false;
  let produced = 0;
  let finishBatch;
  const batchFinished = new Promise((resolve) => {
    finishBatch = resolve;
  });
  const timers = new Set();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    request.on('error', () => {});
    response.on('error', () => {});
    let body = '';
    for await (const chunk of request) body += chunk;
    if (request.method === 'GET') {
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          object: 'list',
          data: [
            {
              id: 'stage-a-fixture',
              object: 'model',
              metadata: {
                'muse-code': {
                  release_date: '2026-01-01',
                  is_hidden: false,
                  limit: { context: 1000000, output: 1024 },
                },
              },
            },
          ],
        }),
      );
      return;
    }
    requests.push(body);
    if (options.saturation && produced >= (options.batchSize ?? 1536)) finishBatch();
    const input = body.includes('STAGE_A_INPUT') && !asked;
    if (input) asked = true;
    const stageB =
      options.stageB &&
      ['STAGE_B_IMPLEMENT', 'STAGE_B_TEST', 'STAGE_B_DELEGATE'].find(
        (marker) => body.includes(marker) && !stageBSent.has(marker),
      );
    if (stageB) stageBSent.add(stageB);
    const childResult =
      options.stageB &&
      !stageBSent.has('child-result') &&
      JSON.parse(body)
        .tools?.flatMap((t) => t.tools ?? [t])
        .some((t) => t.name === 'submit_result');
    if (childResult) stageBSent.add('child-result');
    const tool =
      !!childResult ||
      !!stageB ||
      (body.includes('STAGE_A_APPROVAL') && tools === 0) ||
      (body.includes('STAGE_A_APPROVAL_2') && tools === 1);
    if (tool) tools++;
    const id = 'resp_' + requests.length;
    const frame = (status) => ({
      id,
      object: 'response',
      model: 'stage-a-fixture',
      status,
      output: [],
    });
    const emit = (event) => response.write('data: ' + JSON.stringify(event) + '\n\n');
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    emit({ type: 'response.created', sequence_number: 1, response: frame('in_progress') });
    if (input)
      emit({
        type: 'response.function_call_arguments.done',
        sequence_number: 2,
        output_index: 0,
        item_id: 'fc_input',
        name: 'request_user_input',
        call_id: 'call_input',
        arguments: JSON.stringify({
          questions: [
            {
              id: 'choice',
              header: 'Choice',
              question: 'Choose a test value',
              options: [
                { label: 'Alpha', description: 'First value' },
                { label: 'Beta', description: 'Second value' },
              ],
            },
          ],
        }),
      });
    else if (tool)
      emit({
        type: 'response.function_call_arguments.done',
        sequence_number: 2,
        output_index: 0,
        item_id: 'fc_stage_a',
        name: childResult ? 'submit_result' : stageB === 'STAGE_B_DELEGATE' ? 'workflow' : 'bash',
        call_id: 'call_stage_a',
        arguments: JSON.stringify(
          childResult
            ? {
                text: 'Addition reviewer completed the read-only review.',
                notes: 'Scripted loopback child result',
              }
            : stageB === 'STAGE_B_DELEGATE'
              ? {
                  name: 'Addition review',
                  script:
                    "export default async function workflow(host) { return await host.agent({ input: 'STAGE_B_CHILD read-only addition review', label: 'Addition reviewer' }); }",
                }
              : {
                  command:
                    stageB === 'STAGE_B_IMPLEMENT'
                      ? 'printf "export const sum = (a, b) => a + b;\\n" > sum.mjs'
                      : stageB === 'STAGE_B_TEST'
                        ? `node --input-type=module -e "import {sum} from './sum.mjs'; if(sum(2,3)!==5) process.exit(1); console.log('PASS sum(2,3)=5')"`
                        : 'printf approved >> approval-count.txt',
                  description: 'Write a lifecycle test artifact once',
                },
        ),
      });
    else
      emit({
        type: 'response.output_text.delta',
        sequence_number: 2,
        output_index: 0,
        item_id: 'msg_stage_a',
        content_index: 0,
        delta: 'stage-a reply',
      });
    if (
      options.saturation &&
      produced < (options.batchSize ?? 1536) &&
      body.includes('STAGE_A_SATURATION')
    ) {
      await burstGate;
      const end = Math.min(produced + 64, options.batchSize ?? 1536);
      for (let index = produced; index < end; index++) {
        emit({
          type: 'response.function_call_arguments.done',
          sequence_number: index - produced + 3,
          output_index: index - produced + 1,
          item_id: `fc_plan_${index}`,
          name: options.tool === 'bash' ? 'bash' : 'update_plan',
          call_id: `call_plan_${index}`,
          arguments: JSON.stringify(
            options.tool === 'bash'
              ? { command: 'pwd', description: `Read the test workspace ${index}` }
              : {
                  plan: [{ step: `saturation-${index}`, status: 'completed' }],
                },
          ),
        });
      }
      emit({
        type: 'response.completed',
        sequence_number: end - produced + 3,
        response: {
          ...frame('completed'),
          usage: {
            input_tokens: 1,
            output_tokens: end - produced,
            total_tokens: end - produced + 1,
          },
        },
      });
      produced = end;
      response.end();
      finishBurst();
      return;
    }
    const timer = setTimeout(
      () => {
        timers.delete(timer);
        if (!response.destroyed) {
          emit({
            type: 'response.completed',
            sequence_number: 3,
            response: {
              ...frame('completed'),
              usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
            },
          });
          response.end();
        }
      },
      tool || input ? 100 : 2000,
    );
    timers.add(timer);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = join(root, 'config', 'muse');
  await mkdir(config, { recursive: true });
  await writeFile(
    join(config, 'settings.json'),
    JSON.stringify({
      schema_version: 1,
      endpoint_transport: { base_url: `http://127.0.0.1:${server.address().port}`, auth: 'bearer' },
      permissions: { schema_version: 1, default_profile: ':ask-me' },
      run: { reminder_roster: { agents: [] }, approval_judge: 'off' },
    }),
  );
  await writeFile(
    join(config, 'auth.json'),
    JSON.stringify({
      schema_version: 1,
      providers: { meta: { api_key: 'stage-a-loopback-only' } },
    }),
  );
  return {
    requests,
    beginBurst: releaseBurst,
    burstFinished,
    batchFinished,
    close: async () => {
      for (const timer of timers) clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
