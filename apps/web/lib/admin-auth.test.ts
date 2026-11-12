import { describe, expect, it } from "vitest";
import { checkAdminAuth } from "./admin-auth";

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`, "utf8").toString("base64")}`;

describe("checkAdminAuth", () => {
  it("does not exist in production without a password", () => {
    expect(checkAdminAuth(null, undefined, true)).toBe("not-configured");
    expect(checkAdminAuth(basic("a", "b"), "", true)).toBe("not-configured");
  });

  it("is open in development without a password", () => {
    expect(checkAdminAuth(null, undefined, false)).toBe("allow");
  });

  it("accepts the password under any username", () => {
    expect(checkAdminAuth(basic("admin", "s3cret"), "s3cret", true)).toBe("allow");
    expect(checkAdminAuth(basic("", "s3cret"), "s3cret", true)).toBe("allow");
    expect(checkAdminAuth(basic("x", "pässwörd:with:colons"), "pässwörd:with:colons", true)).toBe(
      "allow"
    );
  });

  it("challenges anything else", () => {
    expect(checkAdminAuth(null, "s3cret", true)).toBe("challenge");
    expect(checkAdminAuth("Bearer s3cret", "s3cret", true)).toBe("challenge");
    expect(checkAdminAuth("Basic not-base64!", "s3cret", true)).toBe("challenge");
    expect(checkAdminAuth(basic("admin", "s3cre"), "s3cret", true)).toBe("challenge");
    expect(checkAdminAuth(basic("admin", "s3crett"), "s3cret", true)).toBe("challenge");
  });
});
