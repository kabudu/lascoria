// Process-local, bounded timings. No prompts, paths, IDs or provider credentials.
const limit = 256;
const samples = new Map<string, number[]>();
const counts = new Map<string, number>();
export function recordTiming(name: string, ms: number) {
  if (!Number.isFinite(ms) || ms < 0 || (!samples.has(name) && samples.size >= 32)) return;
  const values = samples.get(name) ?? [];
  if (values.length === limit) values.shift();
  values.push(ms);
  samples.set(name, values);
  counts.set(name, (counts.get(name) ?? 0) + 1);
}
export function timingSnapshot() {
  return Object.fromEntries(
    [...samples].map(([name, values]) => {
      const sorted = [...values].sort((a, b) => a - b);
      return [
        name,
        {
          count: counts.get(name),
          samples: values.length,
          p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1],
          maxMs: sorted.at(-1),
        },
      ];
    }),
  );
}
