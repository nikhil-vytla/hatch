import * as z from "zod";
import { compile, decode } from "./index";
import { Ticket } from "./demo";
const input = JSON.parse(await Bun.stdin.text());
const schema = z.toJSONSchema(Ticket);
console.log(
  JSON.stringify({
    value: Ticket.parse(decode(schema, input.answers)),
    answers: input.answers,
    questions: compile(schema),
  }),
);
