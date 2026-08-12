import { AgentId } from "@/lib/agents";

interface AgentBackend {
  apiUrl: string;
  apiKey: string;
}

export function getAgentBackend(agentId: AgentId): AgentBackend | null {
  switch (agentId) {
    case "jarvis":
    case "writing":
    case "rag":
      if (!process.env.HERMES_API_URL || !process.env.HERMES_API_KEY) return null;
      return { apiUrl: process.env.HERMES_API_URL, apiKey: process.env.HERMES_API_KEY };
    case "email":
      if (!process.env.HERMES_EMAIL_API_URL || !process.env.HERMES_EMAIL_API_KEY) return null;
      return { apiUrl: process.env.HERMES_EMAIL_API_URL, apiKey: process.env.HERMES_EMAIL_API_KEY };
    case "graphic":
      if (!process.env.HERMES_RESEARCH_API_URL || !process.env.HERMES_RESEARCH_API_KEY) return null;
      return { apiUrl: process.env.HERMES_RESEARCH_API_URL, apiKey: process.env.HERMES_RESEARCH_API_KEY };
    default:
      return null;
  }
}