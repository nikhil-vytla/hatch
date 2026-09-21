export const emailLabels = [
  "action",
  "receipt",
  "newsletter",
  "other",
] as const;
export function classifyEml(eml: string) {
  const identity = {
    adapter: "email-lexical-baseline",
    model: "rules-v1",
    local: true,
  };
  const unsupported = (message: string) => ({
    status: "unsupported" as const,
    execution: identity,
    issues: [{ code: "unsupported_email", message }],
    labels: [],
    uncertainty: null,
  });
  if (typeof eml !== "string" || new TextEncoder().encode(eml).length > 100_000)
    return unsupported("Supply one .eml text below 100 KB.");
  const parts = eml.split(/\r?\n\r?\n/);
  if (parts.length < 2)
    return unsupported(
      "The message needs RFC 5322 headers and a blank line before its body.",
    );
  const headers = parts.shift()!.replace(/\r?\n[ \t]+/g, " "),
    body = parts.join("\n\n");
  const contentType =
    /^content-type:\s*(.*)$/im.exec(headers)?.[1] ?? "text/plain";
  const encoding =
    /^content-transfer-encoding:\s*(.*)$/im.exec(headers)?.[1] ?? "7bit";
  if (
    !/^text\/plain\b/i.test(contentType) ||
    !/^(7bit|8bit|binary)\s*$/i.test(encoding)
  )
    return unsupported(
      "This baseline accepts unencoded text/plain messages only. MIME attachments, HTML, base64 and quoted-printable require a separate parser.",
    );
  const subject = /^subject:\s*(.*)$/im.exec(headers)?.[1] ?? "";
  if (/=\?[^?]+\?[bq]\?/i.test(subject))
    return unsupported(
      "Encoded-word subjects are unsupported by this baseline.",
    );
  const text = `${subject}\n${body}`.toLowerCase();
  const scores = [
    1 +
      Number(
        /\b(reply|respond|please review|deadline|approval|action required)\b/.test(
          text,
        ),
      ) *
        4,
    1 +
      Number(
        /\b(receipt|invoice|paid|payment received|order confirmation)\b/.test(
          text,
        ),
      ) *
        4,
    1 +
      Number(
        /\b(unsubscribe|newsletter|weekly digest|subscription preferences)\b/.test(
          text,
        ),
      ) *
        4,
    1,
  ];
  const total = scores.reduce((a, b) => a + b, 0),
    labels = emailLabels
      .map((label, i) => ({ label, probability: scores[i] / total }))
      .sort((a, b) => b.probability - a.probability);
  return {
    status: "ok" as const,
    execution: identity,
    issues: [],
    labels,
    selected: labels[0].label,
    uncertainty: 1 - labels[0].probability,
    calibrated: false,
    explanation:
      "Local lexical demonstration. Probabilities are normalized rule weights, not calibrated model confidence. No mailbox was read or modified.",
  };
}
