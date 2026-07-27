import { describe, expect, it } from "vitest";
import { humanizeCaptureError } from "./capture-error";

describe("humanizeCaptureError", () => {
  it("explains OAuth invalid_token from the target MCP server", () => {
    const message = humanizeCaptureError(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_token","error_description":"Missing or invalid access token"}'
      )
    );
    expect(message).toContain("requires authentication");
    expect(message).toContain("Optional request headers");
    expect(message).toContain("Cursor session");
    expect(message).toContain("audit API");
    expect(message).not.toContain("Streamable HTTP error");
    expect(message).not.toContain("/api/lint");
  });

  it("explains plain unauthorized responses (user-reported case)", () => {
    const message = humanizeCaptureError(
      new Error("Streamable HTTP error: Error POSTing to endpoint: unauthorized")
    );
    expect(message).toContain("requires authentication");
    expect(message).toContain("Optional request headers");
    expect(message).not.toContain("Error POSTing to endpoint: unauthorized");
    expect(message).not.toContain("/api/lint");
  });

  it("explains unauthorized without Streamable HTTP prefix", () => {
    const message = humanizeCaptureError(new Error("Error POSTing to endpoint: unauthorized"));
    expect(message).toContain("requires authentication");
  });

  it("explains OAuth invalid_client JSON errors", () => {
    const message = humanizeCaptureError(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"error":"invalid_client","error_description":"Client authentication failed"}'
      )
    );
    expect(message).toContain("requires authentication");
    expect(message).toContain("Paste tools/list");
  });

  it("explains Hotel Universe style auth errors", () => {
    const message = humanizeCaptureError(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: {"object":"error","name":"AuthenticationRequiredError","message":"Authentication required"}'
      )
    );
    expect(message).toContain("requires authentication");
  });

  it("detects 401 status text in transport errors", () => {
    const message = humanizeCaptureError(
      new Error("Streamable HTTP error: Error POSTing to endpoint: HTTP 401 Unauthorized")
    );
    expect(message).toContain("requires authentication");
  });

  it("detects WWW-Authenticate challenges", () => {
    const message = humanizeCaptureError(
      new Error(
        'Streamable HTTP error: Error POSTing to endpoint: Bearer realm="api", error="invalid_token"'
      )
    );
    expect(message).toContain("requires authentication");
  });

  it("passes through non-auth Streamable HTTP errors with source note", () => {
    const message = humanizeCaptureError(
      new Error("Streamable HTTP error: Error POSTing to endpoint: not found")
    );
    expect(message).toContain("not found");
    expect(message).toContain("audit API");
    expect(message).not.toContain("/api/lint");
  });

  it("passes through non-transport errors unchanged", () => {
    expect(humanizeCaptureError(new Error("Only https:// endpoints are supported."))).toBe(
      "Only https:// endpoints are supported."
    );
  });

  it("explains SSRF DNS resolution failures", () => {
    const message = humanizeCaptureError(new Error("Could not resolve mcp.vybenetwork.com."));
    expect(message).toContain("DNS does not list");
    expect(message).toContain("mcp.vybenetwork.com");
    expect(message).toContain("audit API");
  });
});
