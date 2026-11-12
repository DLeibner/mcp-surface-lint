import { errorMessage } from "./client";

/**
 * Things a human should hear about. Each alert has a scoped key ("hard-stop:
 * 2026-10-01", "regression:<result key>") claimed in the ledger, so it goes
 * out once however many runs see the condition.
 */
export interface Alert {
  key: string;
  kind: "hard-stop" | "credit-exhausted" | "regression";
  subject: string;
  body: string;
}

export type Notifier = (alert: Alert) => Promise<void>;

/**
 * Email through Resend, when RESEND_API_KEY and ALERT_EMAIL_TO are set. Its
 * default sender (onboarding@resend.dev) may only write to the account's own
 * address, which is all an admin alert needs. Unset, alerts still reach the
 * workflow summary.
 */
export function resendNotifier(env: Record<string, string | undefined> = process.env): Notifier | undefined {
  const apiKey = env.RESEND_API_KEY;
  const to = env.ALERT_EMAIL_TO;
  if (!apiKey || !to) return undefined;
  const from = env.ALERT_EMAIL_FROM || "MCP Surface Lint <onboarding@resend.dev>";
  return async (alert) => {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: alert.subject, text: alert.body })
    });
    if (!response.ok) {
      throw new Error(`Resend answered ${response.status}: ${(await response.text()).slice(0, 200)}`);
    }
  };
}

export interface AlertSink {
  claimEvent(key: string, kind: string, detail?: unknown): Promise<boolean>;
  notify?: Notifier;
  log: (line: string) => void;
  raised: Alert[];
}

/** Raises an alert at most once. A failed email is logged, never fatal: the run has work to finish. */
export async function raise(sink: AlertSink, alert: Alert): Promise<void> {
  if (!(await sink.claimEvent(alert.key, alert.kind, { subject: alert.subject }))) return;
  sink.raised.push(alert);
  if (!sink.notify) return;
  try {
    await sink.notify(alert);
  } catch (caught) {
    sink.log(`Could not send the "${alert.kind}" alert: ${errorMessage(caught)}`);
  }
}
