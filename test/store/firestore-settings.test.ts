import { describe, it, expect } from "vitest";
import { createFirestore, firestoreSettings } from "../../src/store/firestore.js";

const KEY = "-----BEGIN PRIVATE KEY-----\nMIIfake\n-----END PRIVATE KEY-----\n";
const SA_JSON = JSON.stringify({
  type: "service_account",
  project_id: "demo-inbox",
  private_key_id: "abc",
  private_key: KEY,
  client_email: "firebase-adminsdk@demo-inbox.iam.gserviceaccount.com",
});

describe("firestoreSettings", () => {
  it("without credentials uses Application Default Credentials", () => {
    expect(firestoreSettings("demo-inbox")).toEqual({ projectId: "demo-inbox", ignoreUndefinedProperties: true });
  });

  it("with a service-account JSON passes only client_email and private_key", () => {
    expect(firestoreSettings("demo-inbox", SA_JSON)).toEqual({
      projectId: "demo-inbox",
      ignoreUndefinedProperties: true,
      credentials: { client_email: "firebase-adminsdk@demo-inbox.iam.gserviceaccount.com", private_key: KEY },
    });
  });

  it("throws a clear error on invalid JSON without echoing it", () => {
    const bad = `{"private_key": "${"x".repeat(20)}SECRET-PART"`;
    let message = "";
    try {
      firestoreSettings("demo-inbox", bad);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/FIRESTORE_CREDENTIALS_JSON is not valid JSON/);
    expect(message).not.toContain("SECRET-PART");
  });

  it("throws when client_email or private_key is missing", () => {
    expect(() => firestoreSettings("demo-inbox", JSON.stringify({ client_email: "a@b.c" }))).toThrow(
      /FIRESTORE_CREDENTIALS_JSON.*client_email and private_key/,
    );
    expect(() => firestoreSettings("demo-inbox", "[]")).toThrow(/FIRESTORE_CREDENTIALS_JSON/);
  });

  it("createFirestore accepts the credentials without connecting", () => {
    expect(createFirestore("demo-inbox", SA_JSON)).toBeDefined();
    expect(() => createFirestore("demo-inbox", "nope")).toThrow(/FIRESTORE_CREDENTIALS_JSON/);
  });
});
