/** Booking tools. The type is always "booking"; the tool name is only a label hint. */
import type { Adapter } from "./types.ts";
import { toolAdapter, type ToolSpec } from "./embed.ts";
import { safeUrl } from "./hosts.ts";

const booking = (s: Omit<ToolSpec, "type" | "noun" | "links">): ToolSpec => ({ ...s, type: "booking", noun: "booking", links: true });

export const SCHEDULER_SPECS: ToolSpec[] = [
  booking({ id: "calendly", name: "Calendly", domains: ["calendly.com"], markers: [".calendly-inline-widget", "[data-url*='calendly.com']", ".calendly-badge-widget"], globals: ["Calendly"] }),
  booking({ id: "cal_com", name: "Cal.com", domains: ["cal.com"], markers: ["[data-cal-link]", "cal-inline"] }),
  booking({ id: "savvycal", name: "SavvyCal", domains: ["savvycal.com"], globals: ["SavvyCal"] }),
  booking({ id: "tidycal", name: "TidyCal", domains: ["tidycal.com"], markers: [".tidycal-embed"] }),
  booking({
    id: "hubspot_meetings",
    name: "HubSpot Meetings",
    domains: [],
    urlTest: (href) => {
      const u = safeUrl(href);
      return !!u && /^meetings(-[a-z0-9]+)?\.hubspot\.com$/i.test(u.hostname);
    },
    markers: [".meetings-iframe-container"],
  }),
  booking({ id: "acuity", name: "Acuity Scheduling", domains: ["acuityscheduling.com", "as.me"] }),
  booking({ id: "setmore", name: "Setmore", domains: ["setmore.com"] }),
  booking({ id: "simplybook", name: "SimplyBook.me", domains: ["simplybook.me", "simplybook.it", "simplybook.asia"] }),
  booking({ id: "youcanbookme", name: "YouCanBook.me", domains: ["youcanbook.me"] }),
  booking({ id: "zcal", name: "zcal", domains: ["zcal.co"] }),
];

export const schedulerAdapters: Adapter[] = SCHEDULER_SPECS.map(toolAdapter);
