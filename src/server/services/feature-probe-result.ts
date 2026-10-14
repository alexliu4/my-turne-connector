// Local result identity only: no new wire fields or error text are exposed.
const failedResults = new WeakSet<object>();
export function markFeatureProbeFailure<T extends object>(
  result: T,
  failed = true,
): T {
  if (failed) failedResults.add(result);
  return result;
}
export function didFeatureProbeFail(result: unknown): boolean {
  return (
    result !== null && typeof result === "object" && failedResults.has(result)
  );
}
