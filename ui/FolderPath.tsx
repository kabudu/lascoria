import { useEffect, useId, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

export function FolderPath({
  label,
  browseLabel,
  name,
  value,
  onChange,
  disabled = false,
  onPicking,
}: {
  label: string;
  browseLabel: string;
  name?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  onPicking: (busy: boolean) => void;
}) {
  const id = useId();
  const [picking, setPicking] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onPicking(false);
    };
  }, [onPicking]);
  async function browse() {
    if (disabled || active.current) return;
    active.current = true;
    setPicking(true);
    onPicking(true);
    setError('');
    try {
      const path = await invoke<string | null>('pick_workspace_folder');
      if (mounted.current && path !== null) onChange(path);
    } catch {
      if (mounted.current)
        setError('The folder chooser could not open. Try again, or enter the full path.');
    } finally {
      active.current = false;
      if (mounted.current) {
        setPicking(false);
        onPicking(false);
      }
    }
  }
  return (
    <div className="folder-path-field">
      <label htmlFor={id}>{label}</label>
      <div className="folder-path-control">
        <input
          id={id}
          name={name}
          value={value}
          required
          maxLength={4096}
          disabled={disabled || picking}
          placeholder="Choose a folder or enter its full path"
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setError('');
            onChange(event.target.value);
          }}
        />
        <button
          type="button"
          aria-label={browseLabel}
          disabled={disabled || picking}
          onClick={() => void browse()}
        >
          {picking ? 'Choosing…' : 'Browse…'}
        </button>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
