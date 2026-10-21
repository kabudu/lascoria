/** Savings require complete, correct and measured runs on both sides. */
export function canCompare(baseline, efficient) {
  return [baseline, efficient].every(
    (row) =>
      row.runs > 0 &&
      row.correct === row.runs &&
      row.tokensReported === row.runs &&
      Number.isFinite(row.meanTokens) &&
      row.meanTokens > 0,
  );
}
