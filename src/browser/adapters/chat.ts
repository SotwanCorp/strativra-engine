/** Chat widgets: one contact_click point per vendor (channel "chat"). */
import type { Adapter } from "./types.ts";
import { toolAdapter, type ToolSpec } from "./embed.ts";

const chat = (s: Omit<ToolSpec, "type" | "noun" | "channel">): ToolSpec => ({ ...s, type: "contact_click", noun: "chat", channel: "chat" });

export const CHAT_SPECS: ToolSpec[] = [
  chat({ id: "intercom", name: "Intercom", domains: ["widget.intercom.io", "js.intercomcdn.com"], markers: [".intercom-launcher", "#intercom-container", ".intercom-lightweight-app"], globals: ["Intercom"] }),
  chat({ id: "crisp", name: "Crisp", domains: ["client.crisp.chat"], markers: ["#crisp-chatbox"], globals: ["$crisp"] }),
  chat({ id: "tidio", name: "Tidio", domains: ["code.tidio.co"], markers: ["#tidio-chat"], globals: ["tidioChatApi"] }),
  chat({ id: "drift", name: "Drift", domains: ["js.driftt.com", "js.drift.com"], markers: ["#drift-widget", "#drift-frame-controller"], globals: ["drift"] }),
  chat({ id: "tawk", name: "tawk.to", domains: ["embed.tawk.to"], globals: ["Tawk_API"] }),
  chat({ id: "hubspot_chat", name: "HubSpot chat", domains: ["js.usemessages.com"], markers: ["#hubspot-messages-iframe-container"], globals: ["HubSpotConversations"] }),
  chat({ id: "zendesk_chat", name: "Zendesk", domains: ["static.zdassets.com", "ekr.zdassets.com"], globals: ["zE", "$zopim"] }),
];

export const chatAdapters: Adapter[] = CHAT_SPECS.map(toolAdapter);
