import { recordTiming } from './diagnostics';
import { invoke } from '@tauri-apps/api/core';
import type { Json, Status } from './types';
export const connect = () => measured('connect', () => invoke<Status>('connect_supervisor'));
async function measured<T>(name: string, action: () => Promise<T>): Promise<T> {
  const start = performance.now();
  try {
    return await action();
  } finally {
    recordTiming(name, performance.now() - start);
  }
}
export function request<T = Json>(
  operation: string,
  params: Json = {},
  id: string = crypto.randomUUID(),
): Promise<T> {
  return measured(`ipc:${operation}`, () =>
    invoke<T>('supervisor_request', { operation, params, id }),
  );
}
