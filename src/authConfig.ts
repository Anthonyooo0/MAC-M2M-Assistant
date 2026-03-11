import type { Configuration } from "@azure/msal-browser";

export const msalConfig: Configuration = {
  auth: {
    clientId: "77841c45-4e58-458c-87b3-43a5b6556811",
    authority: "https://login.microsoftonline.com/422e0e56-e8fe-4fc5-8554-b9b89f3cadac",
    redirectUri: window.location.origin,
    postLogoutRedirectUri: window.location.origin,
  },
  cache: { cacheLocation: "sessionStorage" },
};

export const loginRequest = { scopes: [] };
export const ALLOWED_DOMAIN = "macproducts.net";
