import { describe, it } from "vitest";
import { createFirestore, FirestoreStore } from "../../src/store/firestore.js";
import { runStoreContract } from "./contract.js";

const host = process.env.FIRESTORE_EMULATOR_HOST;

if (!host) {
  describe.skip("Store contract: firestore (set FIRESTORE_EMULATOR_HOST to run)", () => {
    it("skipped", () => {});
  });
} else {
  const db = createFirestore("demo-inbox");
  runStoreContract("firestore", async () => {
    // Clear all data in the emulator between tests.
    await fetch(`http://${host}/emulator/v1/projects/demo-inbox/databases/(default)/documents`, { method: "DELETE" });
    return new FirestoreStore(db);
  });
}
