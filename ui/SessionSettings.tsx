import { useState } from 'react';
import type { Json } from './types';

type Props = {
  catalog: Json;
  model?: string;
  effort?: string;
  ready: boolean;
  apply: (operation: string, params: Json) => Promise<void>;
};
export function SessionSettings({ catalog, model, effort, ready, apply }: Props) {
  const models = catalog.models ?? [];
  const active = model ?? models.find((entry: Json) => entry.isActive)?.modelId;
  const [selection, setSelection] = useState(
    models.some((entry: Json) => entry.modelId === active)
      ? active!
      : (models.find((entry: Json) => entry.isDefault)?.modelId ?? models[0]?.modelId ?? ''),
  );
  const selected = models.find((entry: Json) => entry.modelId === selection);
  const variants: string[] = selected?.variants ?? [];
  const recommended = variants.includes(selected?.defaultReasoningEffort)
    ? selected.defaultReasoningEffort
    : variants.includes('medium')
      ? 'medium'
      : variants[Math.floor((variants.length - 1) / 2)];
  const [draft, setDraft] = useState<string | undefined>(undefined);
  const value =
    draft ?? (selection === active && variants.includes(effort ?? '') ? effort : recommended);
  const index = Math.max(0, variants.indexOf(value ?? ''));
  if (!models.length)
    return (
      <div className="settings-empty">
        This session has no selectable models. Model and effort controls are unavailable for this
        provider.
      </div>
    );
  return (
    <div className="session-settings">
      <section className="setting-card">
        <label htmlFor="change-model">Session model</label>
        <div className="setting-row">
          <select
            id="change-model"
            value={selection}
            disabled={!ready}
            onChange={(event) => {
              setSelection(event.target.value);
              setDraft(undefined);
            }}
          >
            {models.map((entry: Json) => (
              <option key={entry.modelId} value={entry.modelId}>
                {entry.displayLabel ?? entry.modelId}
              </option>
            ))}
          </select>
          <button
            disabled={!ready || selection === active}
            onClick={() => {
              // Retain the previewed effort across the model acknowledgement. Muse may
              // keep the previous model's standing effort until explicitly changed.
              setDraft(value);
              void apply('setModel', { modelId: selection });
            }}
          >
            Apply model
          </button>
        </div>
        <p className="setting-help">
          Takes effect at the next model call, including within a running turn.
        </p>
      </section>
      <section className="setting-card">
        <div className="effort-heading">
          <label htmlFor="change-effort">Reasoning effort</label>
          <output htmlFor="change-effort">{value ?? 'Unavailable'}</output>
        </div>
        {variants.length ? (
          <>
            <input
              id="change-effort"
              type="range"
              min={0}
              max={Math.max(1, variants.length - 1)}
              step={1}
              value={index}
              aria-valuetext={value}
              disabled={!ready || variants.length === 1}
              onChange={(event) => setDraft(variants[Number(event.target.value)])}
            />
            <div className="effort-stops" aria-hidden="true">
              {variants.map((tier) => (
                <span key={tier} className={tier === value ? 'selected' : ''}>
                  {tier}
                </span>
              ))}
            </div>
            <div className="effort-footer">
              <p className="setting-help">
                {selection !== active
                  ? 'Apply this model before saving its effort.'
                  : 'Applies to subsequent turns.'}
                <br />
                {selected?.defaultReasoningEffort
                  ? `Model default: ${recommended}`
                  : `Suggested starting level: ${recommended}`}
              </p>
              <button
                disabled={!ready || selection !== active || !value || value === effort}
                onClick={() => void apply('setEffort', { reasoningEffort: value })}
              >
                Apply effort
              </button>
            </div>
          </>
        ) : (
          <p className="setting-help">This model does not offer adjustable reasoning effort.</p>
        )}
      </section>
    </div>
  );
}
