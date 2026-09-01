import assert from "node:assert/strict";
import test from "node:test";

import { dogfoodCheckoutPreferenceKey } from "./dogfoodCheckoutPreference.ts";

test("Dogfood checkout preferences cannot leak an absolute path between boxes", () => {
  assert.notEqual(
    dogfoodCheckoutPreferenceKey("macbook-air"),
    dogfoodCheckoutPreferenceKey("ubuntu-4gb"),
  );
  assert.match(dogfoodCheckoutPreferenceKey("box/a"), /box%2Fa$/);
});
