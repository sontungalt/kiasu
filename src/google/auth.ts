import { google } from "googleapis";
import type { Config } from "../config.js";
import type { AccountId } from "../types.js";

export const GOOGLE_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/classroom.courses.readonly",
  "https://www.googleapis.com/auth/classroom.coursework.me.readonly",
  "https://www.googleapis.com/auth/classroom.announcements.readonly",
];

export type GoogleAuth = InstanceType<typeof google.auth.OAuth2>;

export function googleAuthFor(account: AccountId, config: Config): GoogleAuth | null {
  const refreshToken = account === "personal" ? config.GOOGLE_REFRESH_TOKEN_PERSONAL : config.GOOGLE_REFRESH_TOKEN_SCHOOL;
  if (!refreshToken) return null;
  const client = new google.auth.OAuth2(config.GOOGLE_OAUTH_CLIENT_ID, config.GOOGLE_OAUTH_CLIENT_SECRET);
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export function isInvalidGrant(err: unknown): boolean {
  const e = err as { response?: { data?: { error?: string } }; message?: string } | null;
  if (e?.response?.data?.error === "invalid_grant") return true;
  return typeof e?.message === "string" && e.message.includes("invalid_grant");
}
