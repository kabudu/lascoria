import { tokenFacts } from './model';

const n = (value: number) => value.toLocaleString();

/**
 * T1 token visibility, collapsed by default. Token counts, Muse's API cost estimate and context
 * occupancy are model-call facts; they are not the subscription allowance in Account & usage.
 */
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
        Token use
        {facts.session ? ` · ${n(facts.session.totalTokens)} this session` : ' · not reported yet'}
        {facts.context?.percent != null ? ` · context ${facts.context.percent}% full` : ''}
      </summary>
      <dl>
        <dt>This session</dt>
        <dd>
          {facts.session
            ? `${n(facts.session.totalTokens)} tokens (${n(facts.session.promptTokens)} prompt, ${n(facts.session.outputTokens)} output${facts.session.cacheReadTokens != null ? `, ${n(facts.session.cacheReadTokens)} read from cache` : ''})`
            : 'Muse has not reported token use for this session yet.'}
        </dd>
        {turnId && (
          <>
            <dt>This task</dt>
            <dd>
              {facts.task
                ? `${n(facts.task.totalTokens)} tokens over ${facts.task.calls} model ${facts.task.calls === 1 ? 'call' : 'calls'}${facts.task.reasoningTokens ? `, ${n(facts.task.reasoningTokens)} of them reasoning` : ''}`
                : 'Not reported for this task.'}
            </dd>
          </>
        )}
        {facts.subagents && (
          <>
            <dt>Subagents</dt>
            <dd>
              {n(facts.subagents.tokens)} tokens across {facts.subagents.count}{' '}
              {facts.subagents.count === 1 ? 'subagent' : 'subagents'}, reported separately and not
              included above.
            </dd>
          </>
        )}
        {facts.context && (
          <>
            <dt>Context</dt>
            <dd>
              {n(facts.context.usedTokens)}
              {facts.context.windowTokens
                ? ` of ${n(facts.context.windowTokens)} tokens (${facts.context.percent}%)`
                : ' tokens; Muse reports no limit'}
              {facts.context.pressure === 'warning'
                ? '. Getting full: Muse may compact older messages.'
                : facts.context.pressure === 'blocked'
                  ? '. Full: compact or start a new session before continuing.'
                  : ''}
            </dd>
          </>
        )}
        {models.length > 1 && (
          <>
            <dt>By model</dt>
            <dd>
              {models.map(([model, totals]) => `${model}: ${n(totals.totalTokens)}`).join(' · ')}
            </dd>
          </>
        )}
        {facts.session?.costUsd != null && (
          <>
            <dt>Estimated API cost</dt>
            <dd>
              ${facts.session.costUsd.toFixed(2)}
              {facts.session.costPartial ? ' (partial: some calls had no price)' : ''}. Muse&apos;s
              estimate at API prices; with a subscription you are not billed this amount.
            </dd>
          </>
        )}
      </dl>
      <p className="hint">
        Per-task and per-model figures cover the model calls this session&apos;s Muse host reported.
        Your subscription allowance is in Account &amp; usage.
      </p>
    </details>
  );
}
