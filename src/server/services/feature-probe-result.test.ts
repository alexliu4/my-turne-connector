import { test, expect } from "bun:test";
import {
  markFeatureProbeFailure,
  didFeatureProbeFail,
} from "./feature-probe-result";
test("concurrent successful replies cannot erase another probe's failure or add wire data", () => {
  const failure = markFeatureProbeFailure({ status: "unsupported" });
  const unsupported = markFeatureProbeFailure({ status: "unsupported" }, false);
  const success = markFeatureProbeFailure({ status: "ok" }, false);
  expect(didFeatureProbeFail(failure)).toBe(true);
  expect(didFeatureProbeFail(unsupported)).toBe(false);
  expect(didFeatureProbeFail(success)).toBe(false);
  expect(JSON.stringify(failure)).toBe('{"status":"unsupported"}');
});
