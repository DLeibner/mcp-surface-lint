import Anthropic from "@anthropic-ai/sdk";

/**
 * The slice of the Anthropic API the eval layer uses. The runner depends on
 * this rather than on the SDK client, so tests drive it with a scripted fake
 * and never spend a cent.
 */
export interface EvalClient {
  countTokens(params: Anthropic.MessageCountTokensParams): Promise<number>;
  createMessage(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  createBatch(requests: Anthropic.Messages.BatchCreateParams.Request[]): Promise<string>;
  batchStatus(id: string): Promise<Anthropic.Messages.MessageBatch["processing_status"]>;
  batchResults(id: string): AsyncIterable<Anthropic.Messages.MessageBatchIndividualResponse>;
}

/**
 * The real client. The SDK retries rate limits, overloads and connection
 * errors; it is allowed one retry, after which the job waits for the next run.
 */
export function sdkClient(apiKey = process.env.ANTHROPIC_API_KEY): EvalClient {
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY is not set.");
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  return {
    async countTokens(params) {
      return (await client.messages.countTokens(params)).input_tokens;
    },
    createMessage(params) {
      return client.messages.create(params);
    },
    async createBatch(requests) {
      return (await client.messages.batches.create({ requests })).id;
    },
    async batchStatus(id) {
      return (await client.messages.batches.retrieve(id)).processing_status;
    },
    async *batchResults(id) {
      for await (const result of await client.messages.batches.results(id)) yield result;
    }
  };
}

/**
 * The documented message when an organization has no credit left, and the one
 * a workspace spend limit returns. Both arrive as plain request errors, so the
 * message is the only signal that tells them apart from a malformed request.
 */
const EXHAUSTED = /credit balance is too low|reached your specified (workspace )?API usage limits/i;

/** An expected state, not a failure: the credit is gone until the cycle refreshes. */
export function isCreditExhausted(error: unknown): boolean {
  if (error instanceof Anthropic.APIError) {
    return error.type === "billing_error" || EXHAUSTED.test(error.message);
  }
  return false;
}

/** The same check for an `errored` result inside a collected batch. */
export function isCreditExhaustedResponse(response: Anthropic.ErrorResponse): boolean {
  return response.error.type === "billing_error" || EXHAUSTED.test(response.error.message);
}

export function errorMessage(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
