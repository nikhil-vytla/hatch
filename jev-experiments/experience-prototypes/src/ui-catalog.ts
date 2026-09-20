import {
  defineCatalog,
  type Experimental_CompositionCandidate,
} from "@json-render/core";
import { schema } from "@json-render/react/schema";
import { z } from "zod";
export const uiCatalog = defineCatalog(schema, {
  components: {
    Stack: {
      props: z.object({
        direction: z.enum(["vertical", "horizontal"]),
        gap: z.enum(["small", "medium", "large"]),
      }),
      slots: ["default"],
      description: "A flexible layout",
    },
    Card: {
      props: z.object({ title: z.string(), subtitle: z.string() }),
      slots: ["default"],
      description: "A panel grouping related content",
    },
    Heading: {
      props: z.object({ text: z.string() }),
      description: "A section heading",
    },
    Text: {
      props: z.object({ text: z.string() }),
      description: "A description or contextual note",
    },
    Input: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        placeholder: z.string(),
      }),
      description: "An editable text field",
    },
    Toggle: {
      props: z.object({ label: z.string(), checked: z.boolean() }),
      description: "A boolean preference",
    },
    Metric: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        detail: z.string(),
      }),
      description: "A prominent value",
    },
    Button: {
      props: z.object({
        label: z.string(),
        variant: z.enum(["primary", "secondary"]),
      }),
      events: ["press"],
      description: "Run a local action",
    },
    Choice: {
      props: z.object({
        label: z.string(),
        value: z.string(),
        options: z.array(z.string()),
      }),
      description: "Choose an option",
    },
    Apartment: {
      props: z.object({
        name: z.string(),
        rent: z.string(),
        details: z.string(),
      }),
      events: ["press"],
      description:
        "A complete apartment card with rent, details, and a shortlist action",
    },
    Progress: { props: z.object({ label: z.string(), value: z.number() }) },
  },
  actions: {
    save: {
      params: z.object({}),
      description: "Show a local saved confirmation",
    },
    reset: { params: z.object({}), description: "Reset this demo" },
    shortlist: {
      params: z.object({ name: z.string() }),
      description: "Add the apartment to a local shortlist",
    },
  },
});
export const uiInitial = {
  name: "Alex Morgan",
  email: "alex@example.com",
  city: "San Francisco",
  notifications: true,
  budget: "2400",
  commute: "30 minutes",
  guests: "24",
  event: "Dinner in the garden",
  dietary: "Vegetarian",
};
const c = (
  id: string,
  type: string,
  description: string,
  props: Record<string, unknown>,
  extra: Partial<Experimental_CompositionCandidate> = {},
): Experimental_CompositionCandidate => ({
  id,
  description,
  root: false,
  element: { type, props },
  ...extra,
});
export function uiCandidates(
  domain: string,
): Experimental_CompositionCandidate[] {
  const common = [
    c(
      "canvas",
      "Stack",
      "The root vertical page layout",
      { direction: "vertical", gap: "large" },
      { root: true, maxUses: 1 },
    ),
    c(
      "row",
      "Stack",
      "A horizontal row of related content",
      { direction: "horizontal", gap: "medium" },
      { maxUses: 1 },
    ),
    c(
      "column",
      "Stack",
      "A vertical group of related content",
      { direction: "vertical", gap: "small" },
      { maxUses: 1 },
    ),
  ];
  if (domain === "apartments")
    return [
      ...common,
      c("title", "Heading", "Title for comparing apartments", {
        text: "Find a place to call home",
      }),
      c("intro", "Text", "Explain comparison task", {
        text: "Compare the things that make everyday life better.",
      }),
      c("budget", "Input", "Editable maximum monthly rent budget", {
        label: "Monthly budget",
        value: { $bindState: "/budget" },
        placeholder: "2400",
      }),
      c("commute", "Choice", "Preferred maximum commute", {
        label: "Commute limit",
        value: { $bindState: "/commute" },
        options: ["15 minutes", "30 minutes", "45 minutes"],
      }),
      ...[
        {
          name: "Sunlit studio",
          rent: "$2,150",
          detail: "18 min commute · laundry · 520 sq ft",
        },
        {
          name: "Garden apartment",
          rent: "$2,350",
          detail: "26 min commute · patio · 690 sq ft",
        },
        {
          name: "Corner loft",
          rent: "$2,600",
          detail: "12 min commute · elevator · 740 sq ft",
        },
      ].map((a, i) => ({
        ...c(
          "apt" + i,
          "Apartment",
          `Complete apartment card: ${a.name}, ${a.rent}, ${a.detail}`,
          { name: a.name, rent: a.rent, details: a.detail },
        ),
        element: {
          type: "Apartment",
          props: { name: a.name, rent: a.rent, details: a.detail },
          on: { press: { action: "shortlist", params: { name: a.name } } },
        },
      })),
    ];
  const event = domain === "event";
  return [
    ...common,
    c(
      "form",
      "Card",
      event ? "Event planning form" : "Account preferences form",
      {
        title: event ? "A night to remember" : "Make yourself at home",
        subtitle: event
          ? "A small gathering, thoughtfully planned."
          : "Your profile and preferences, in one place.",
      },
    ),
    c("name", "Input", "Editable name field", {
      label: event ? "Event name" : "Your name",
      value: { $bindState: event ? "/event" : "/name" },
      placeholder: "Your name",
    }),
    c("email", "Input", "Editable email address", {
      label: "Email address",
      value: { $bindState: "/email" },
      placeholder: "you@example.com",
    }),
    c("city", "Input", "City field", {
      label: event ? "Where" : "City",
      value: { $bindState: "/city" },
      placeholder: "San Francisco",
    }),
    c("notifications", "Toggle", "Email notifications preference", {
      label: "Email notifications",
      checked: { $bindState: "/notifications" },
    }),
    ...(event
      ? [
          c("guests", "Input", "Number of guests", {
            label: "Guests",
            value: { $bindState: "/guests" },
            placeholder: "24",
          }),
          c("diet", "Choice", "Dietary preferences", {
            label: "Menu preference",
            value: { $bindState: "/dietary" },
            options: ["Vegetarian", "Vegan", "No preference"],
          }),
        ]
      : []),
    {
      ...c("save", "Button", "Save changes locally", {
        label: event ? "Save the plan" : "Save changes",
        variant: "primary",
      }),
      element: {
        type: "Button",
        props: {
          label: event ? "Save the plan" : "Save changes",
          variant: "primary",
        },
        on: { press: { action: "save", params: {} } },
      },
    },
    c("note", "Text", "Explain that this form is a local interactive demo", {
      text: "Your edits stay in this preview.",
    }),
  ];
}
export const exampleSpec: any = {
  root: "canvas",
  elements: {
    canvas: {
      type: "Stack",
      props: { direction: "vertical", gap: "large" },
      children: ["form"],
    },
    form: {
      type: "Card",
      props: {
        title: "Make yourself at home",
        subtitle: "Your profile and preferences, in one place.",
      },
      children: ["name", "email", "notifications", "save"],
    },
    name: {
      type: "Input",
      props: {
        label: "Your name",
        value: { $bindState: "/name" },
        placeholder: "Your name",
      },
      children: [],
    },
    email: {
      type: "Input",
      props: {
        label: "Email address",
        value: { $bindState: "/email" },
        placeholder: "you@example.com",
      },
      children: [],
    },
    notifications: {
      type: "Toggle",
      props: {
        label: "Email notifications",
        checked: { $bindState: "/notifications" },
      },
      children: [],
    },
    save: {
      type: "Button",
      props: { label: "Save changes", variant: "primary" },
      on: { press: { action: "save", params: {} } },
      children: [],
    },
  },
  state: uiInitial,
};
