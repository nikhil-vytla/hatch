import * as z from "zod";
import { decide, loopback } from "./index";
export const Ticket = z.object({
  area: z
    .enum(["billing", "technical", "account", "other"])
    .describe("Which support area applies?"),
  refund: z.boolean().describe("Is a refund requested?"),
  missing_context: z
    .number()
    .min(0)
    .max(1)
    .describe("Is essential context missing?"),
});
if (import.meta.main)
  console.log(
    JSON.stringify(
      await decide(
        Ticket,
        "I was charged twice. Please return the extra payment.",
        loopback,
      ),
      null,
      2,
    ),
  );
