import { tokenFacts } from './model';

const n = (value: number) => value.toLocaleString();

/** Model-call facts, separate from the subscription allowance in Account & usage. */
export function TokenUse({
  state,
  turnId,
}: {
  state: Record<string, any> | undefined;
  turnId?: string;
}) {
  const facts = tokenFacts(state, turnId);
  const models = Object.entries(facts.byModel);
  return (
    <details className="token-use">
      <summary>
        <span>Token use</span>
        <span className="token-summary-value">
          {facts.session ? `${n(facts.session.totalTokens)} this session` : 'Not reported yet'}
        </span>
      </summary>
      <div className="token-use-body">
        <dl className="token-metrics">
          <div>
            <dt>This session</dt>
            <dd>
              <strong>{facts.session ? n(facts.session.totalTokens) : 'Not reported'}</strong>
              <span>tokens used</span>
            </dd>
          </div>
          {turnId && (
            <div>
              <dt>This task</dt>
              <dd>
                <strong>{facts.task ? n(facts.task.totalTokens) : 'Not reported'}</strong>
                <span>
                  {facts.task
                    ? `tokens · ${n(facts.task.calls)} model ${facts.task.calls === 1 ? 'call' : 'calls'}`
                    : 'No task usage from Muse yet'}
                </span>
              </dd>
            </div>
          )}
          {facts.context && (
            <div className="token-context" data-pressure={facts.context.pressure}>
              <dt>Context</dt>
              <dd>
                <strong>
                  {facts.context.percent != null
                    ? `${facts.context.percent}%`
                    : n(facts.context.usedTokens)}
                </strong>
                <span>
                  {facts.context.windowTokens
                    ? `${n(facts.context.usedTokens)} of ${n(facts.context.windowTokens)} tokens`
                    : 'tokens · limit not reported'}
                </span>
                {facts.context.percent != null && (
                  <progress aria-label="Context used" max={100} value={facts.context.percent} />
                )}
              </dd>
            </div>
          )}
        </dl>
        {facts.context?.pressure === 'warning' && (
          <p className="token-context-note">
            Context is getting full. Muse may summarise older messages.
          </p>
        )}
        {facts.context?.pressure === 'blocked' && (
          <p className="token-context-note">
            Context is full. Compact the conversation or start a new session before continuing.
          </p>
        )}
        <details className="token-breakdown">
          <summary>Token breakdown</summary>
          <dl>
            {facts.session && (
              <>
                <dt>Prompt</dt>
                <dd>{n(facts.session.promptTokens)}</dd>
                <dt>Output</dt>
                <dd>{n(facts.session.outputTokens)}</dd>
                {facts.session.cacheReadTokens != null && (
                  <>
                    <dt>Read from cache</dt>
                    <dd>{n(facts.session.cacheReadTokens)}</dd>
                  </>
                )}
              </>
            )}
            {!!facts.task?.reasoningTokens && (
              <>
                <dt>Task reasoning</dt>
                <dd>{n(facts.task.reasoningTokens)} tokens</dd>
              </>
            )}
            {facts.subagents && (
              <>
                <dt>Subagents</dt>
                <dd>
                  {n(facts.subagents.tokens)} tokens across {n(facts.subagents.count)}{' '}
                  {facts.subagents.count === 1 ? 'subagent' : 'subagents'}. Reported separately;
                  excluded from the totals above.
                </dd>
              </>
            )}
            {models.length > 1 &&
              models.map(([model, totals]) => (
                <div className="token-model" key={model}>
                  <dt>{model}</dt>
                  <dd>{n(totals.totalTokens)} tokens</dd>
                </div>
              ))}
            {facts.session?.costUsd != null && (
              <>
                <dt>Estimated API cost</dt>
                <dd>
                  ${facts.session.costUsd.toFixed(2)}
                  {facts.session.costPartial ? ' (partial estimate)' : ''}. Muse’s API-price
                  estimate; this is not a subscription charge.
                </dd>
              </>
            )}
          </dl>
          {!facts.session &&
            !facts.task?.reasoningTokens &&
            !facts.subagents &&
            models.length <= 1 && <p>Muse has not reported a breakdown yet.</p>}
        </details>
        <p className="token-use-help">
          Reported by Muse. Subscription allowance is in Account &amp; usage.
        </p>
      </div>
    </details>
  );
}
