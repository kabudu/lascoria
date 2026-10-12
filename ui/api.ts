import { invoke } from '@tauri-apps/api/core';
import type { Json, Status } from './types';
export const connect = () => invoke<Status>('connect_supervisor');
export function request<T = Json>(
  operation: string,
  params: Json = {},
  id: string = crypto.randomUUID(),
): Promise<T> {
  return invoke<T>('supervisor_request', { operation, params, id });
}
