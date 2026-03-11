import type { Configuration } from "@azure/msal-browser";

export const msalConfig: Configuration = {
  auth: {
    clientId: "4263a523-e6e0-4e47-ad03-c71ff904a856",
    authority: "https://login.microsoftonline.com/422e0e56-e8fe-4fc5-8554-b9b89f3cadac",
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: { cacheLocation: "sessionStorage" },
};

export const loginRequest = { scopes: [] };
export const ALLOWED_DOMAIN = "macproducts.net";
